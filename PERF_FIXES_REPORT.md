# Agent Desktop v1.77.3 - idle CPU fixes (perf review items 1-5, 10)

Branch `perf/overview-polling` in `E:\Claude work\Security\ad-loadtime`, stacked on 1.77.0 (load time), 1.77.1 (hard stop), 1.77.2 (test isolation). Commits A-F (one each) plus this report, package.json 1.77.3, CLAUDE.md changelog heading added (BOM+CRLF), `node tools/check-changelog.js` passes. Nothing pushed, deployed or launched; live checkout untouched. Needs a full restart to take effect.

Numbers: node micro-benchmarks on this PC against the real data (22 agents, 589 transcripts, 448 registry entries, 958 job dirs). "Before" = the 1.77.2 tree (copy in `ad-perf-review\fx\base`), "after" = this branch. Scripts: `ad-perf-review\fx\bench_poll.js`, `bench_reg.js`, `bench_conv.js`, `bench_conv2.js`, `jobs_after.js` (plus the review's `jobs.js`). The review's `bench.js` loops 5 passes back to back, so a 1.5 s cache would flatter it; `bench_poll.js` spaces passes 2.1 s apart (more than the TTL), like the real 10 s poll.

## Per item

| Item | Before | After | Files |
|---|---|---|---|
| A. approval scan (BUG + cost) | 51-155 ms per 60 s pass (3 runs: 155/51/71) | 18 ms warm passes (157 ms first pass); the dirs older than 36 h (most of the 958) are never stat-ed again, unchanged files are not re-read | `src/approvalScan.js` (new), `src/main.js` checkApprovalBlocked |
| B. overview 10 s pass | 148 ms median (145-165) | 54 ms median (50-60); cold first pass 819 -> 669 ms | `src/archive.js`, `src/overview.js`, `src/agents.js` |
| C. registry-list | 171-181 ms warm per call (review measured 551 ms with cold file cache) | 21 ms while unchanged (readdir + 448 stats for the signature) | `src/registry.js`, `src/renderer/library.js` |
| D. conversations | Video Editing 4.0 s, Software Engineering 2.0 s, COO 0.53 s per call, repeats the same | Restart Session / auto-title: 112 / 145 / 92 ms cold, ~1 ms warm; History panel 2nd open 5 / 4 / 2 ms | `src/archive.js`, `src/main.js` |
| E. header-tasks DOM, repin log | DOM rebuild every 10 s; 5,673 of 11,834 log lines were "renamed back" | rebuild only when the panel is open or when it opens; log once per agent per hour with "(+N more renames)" | `src/renderer/header-tasks.js`, `src/main.js`, `src/logThrottle.js` (new) |
| F. hidden pollers | polls ran while minimized | skipped while `document.hidden`, one catch-up on `visibilitychange` | `renderer.js`, `argus.js`, `approval-banner.js`, `header-tasks.js`, `library.js` |

### A. Bug fix details
Cause confirmed in the code: the per-job loop deleted `approvalBlockedSince` for a non-blocked job file of the same agent, either after the blocked one was set (that case was guarded) or on the next pass when the stale file sorted first (not guarded), so the 90 s threshold was never reached and "first seen waiting" re-logged every minute. Now the scan collects one entry per agent (newest-mtime blocked job wins) and the timer is deleted only when no job of that agent is blocked. Test `approvalScan.test.js` covers a stale file before and after the blocked one over 3 passes, newest blocked wins, non-approval blocks, the accept() filter, the 36 h skip and no re-read of unchanged files.

### B. Cache semantics
- `cachedStat` / `cachedJsonlNames`: per-file stat and per-folder readdir cached 1.5 s (`setStatCacheTtl`, 0 = uncached, `invalidateStatCache()`). Used by `findJsonlFiles`, `memoByFiles`, `getLatestTranscriptSizeBytes/MtimeMs`, `newestTranscript`, `getHaltInfo`. Errors are never cached. A real change is visible within 1.5 s plus the caller's own poll interval. `setConversationTitle` invalidates after its append (repin's re-stamp depends on it).
- `getHaltInfo` memoized by (newest path, size, mtime); a failed read is not memoized. `readOpenItems` memoized by size/mtime of the task store, Active_Tasks.md and master_state.md (3 stats per agent instead of reads + parse). `listAgents` memoizes the parsed master_state.md and agent_config.json per agent (2 stats); entries are fresh objects, `tasks` copied.
- Existing test `archiveTailRank.test.js` appends and re-reads at once, so it now calls `setStatCacheTtl(0)`.

### C. Deviation to note
The task said "poll only while the Library view is open". The nav badge (unread count) is visible while the Library is closed and would go stale, so the poll still runs every 30 s while closed, but main answers it from the cache (21 ms, no per-entry fs work) and it is skipped while hidden. The view also refreshes when opened (it already did). The strict version (no poll while closed) is a one-line change in `library.js` if wanted.
Freshness: a registry entry change shows at once (signature); a linked file that appears or vanishes on its own shows within 60 s.

### D. Equivalence
`getCurrentConversation` ranks files by tail timestamp (the existing `rankFilesByTail`, same rule as `lastActivityAt`), parses the top one (memoized) and falls back to the full `listConversations()` when no ranked file yields a meta. The test checks it equals `listConversations()[0]`, including a newest-by-mtime file with no timestamps, replayed history (mtime newer, timestamps older) and a renamed title. On the real data it is identical to the full-list current for the three biggest agents.

### F. What stays running while hidden
Guards sweep and auto-handoff, unsent-ledger, keep-going, trust banner, and IRIS `deliverPending` (the review listed iris.js:309 as cosmetic, but it delivers messages, so it is NOT gated). The IRIS view render timer only runs while the view is open anyway.

## Tests
Every file in the `npm test` chain run one by one plus `iris.test.js`, `iris-review.test.js`, `voiceSplit.test.js`: all pass. `noUndef` run with eslint from a scratch location via `NODE_PATH=E:\Claude work\Security\ad-topbar\node_modules` (nothing installed into the repo). New tests, wired into `npm test`: `approvalScan`, `statCache`, `registryCache`, `convMemo`, `perfRenderer` (log throttle logic plus source-level guard-presence checks for the renderer pollers). `node --check src/main.js` ok.

## Risks
- B: up to 1.5 s extra staleness for the watchdogs, chat poll and overview (they poll every 4-30 s). A transcript file created within 1.5 s of a cached read is seen on the next pass; `getCurrentConversation` and `setConversationTitle` invalidate, other session-start paths do not.
- A: the "older than 36 h, never again" set assumes a job dir's state.json is not revived (the review's assumption); it resets on app restart.
- C: up to 60 s staleness of file-existence flags.
- E/F: while the Tasks panel is closed its DOM is stale until opened; it is rebuilt from the latest data on open (MutationObserver on the body class), so nothing shown is older than the last poll. Sidebar rings still update every 10 s.

## Unverified live (no Electron was started)
- Real-app idle CPU (review: 3.0% of a core idle). Expected from the numbers: overview 380 -> ~55-100 ms per 10 s pass, approval -50 ms per minute, registry -0.15 to -0.5 s per 30 s, nothing while minimized. Needs a 30 s CPU sample after restart.
- The Approve/Deny banner actually appearing for an agent with stale job files (logic proven by unit test only).
- Panel open-after-closed render, visibilitychange catch-ups, and Restart Session / fresh-session auto-title in the real UI (sandbox pass recommended; second reviewer per guardrail 1).
- Windows mtime granularity on Dropbox files for the memo signatures (size + sub-ms mtime; same approach the existing memos use).

## Not done (as instructed)
Items 6-9 (scrollback, lazy loading, CLI listing, merge and `where` probes).
