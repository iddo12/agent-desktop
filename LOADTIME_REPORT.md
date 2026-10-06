# Agent Desktop startup and conversation-load time - findings and fixes (v1.76.0)

Date: 2026-10-06. Branch `perf/startup-and-conversation-load` in the worktree `E:\Claude work\Security\ad-loadtime` (based on main at v1.75.15, commit 30ee45c). Live app untouched. Not deployed.

## 1. What was measured, and how

Two sources, both real:

1. **The live app's own log** (`%APPDATA%\agent-desktop\stuck-turn-watchdog.log`, `startup-timing.json`) for today's nine restarts (03:58Z .. 13:03Z, 22 agents, v1.75.5-v1.75.14).
2. **A sandbox run of each code version** with copies of the real data: 22 agent folders, their 563 transcript files (2.2 GB) copied under a private HOME, private userData, test mode (no `claude` process is started, no sweep, no reaper), window never shown (`AGENT_DESKTOP_HIDDEN=1`). Driven by Playwright (`E:\Claude work\Security\ad-loadtime-sandbox\tools\launch_sb.mjs`): it polls the renderer every 250 ms (agent rows, startup overlay, chat items), measures IPC round-trip latency every 250 ms (a direct reading of how blocked the main thread is), opens four heavy conversations and times each, and records a V8 CPU profile of the main process for the first 127 s (`--inspect`, CDP `Profiler`). Results: `result-before.json`, `result-after.json`, `result-after-warm.json`, `profile-*.cpuprofile` in that folder.
3. **Node micro-benchmarks** of `archive.js` against the real folders (`parse_bench.js` in the session scratchpad; `tools/compare-archive-readers.js` in the repo).

"Usable" = window painted, agent list populated, startup overlay gone, a chat renders when clicked.

## 2. Timeline BEFORE (live app, v1.75.13, restart 12:45:14Z - typical of all nine)

| t (s) | Event (from the live log) | Note |
|---|---|---|
| 0.0 | `started v1.75.13` (main.js module loaded) | Electron boot before this is ~1 s |
| ~1 | window created; `reapOrphanedBackgroundAgentProcesses` runs a **synchronous** PowerShell listing | 1.4 s main-thread block (measured) |
| ~2-20 | renderer loads; its first calls (list-agents, overview, 22x context-usage, get-usage-windows) hit the main thread, which **parses every transcript of every agent in full** | sandbox: first IPC answered after **17.7 s**; renderer's load event seen at **19.9 s** |
| 10 (timer) | first keep-alive sweep due | fired late: first dispatch logged at +18..+32 s in the live runs because the main thread was busy |
| 28.6 | `limit warning` (guards poll) | |
| 31.6 | `keepgoing-attach` of Software Engineering | |
| 45 (timer) | `cpuguard: ensure` due | fired at +46.5 s |
| 10 .. 78 | sweep walks 22 agents: `claude agents --json` (1.4 s, cached 8 s), then **sleeps 2 s after every agent**, dispatch or not | 21 x 2 s = **42 s of pure sleep**; ~6 listings = ~8 s |
| 78.5 | `startup: first sweep done after 78s (22/22)` -> overlay released, app usable | the countdown overlay waits for exactly this |
| 100 | `overlay released after 90 s` safety line (no-op here) | |

Nine restarts today: 78, 79, 80, 82, 84, 85, 85, 91, 97 s (97 s = 4 dispatches). `startup-timing.json` since 10-04: 66-97 s.

Opening a conversation (live): `start-terminal` = `claude agents --json` (1.4 s unless cached) + `claude attach` pty spawn + 1.5 s login/resume peek; in parallel `get-live-transcript` + `get-session-activity` + `get-context-usage` for that agent - cold, these parsed the whole folder (Video Editing: 63 files, 283 MB, 2.1 + 1.9 + 2.0 s). Sandbox before: **7.1 s** (Video Editing), **6.2 s** (Trade Show), 1.1 s, 1.2 s.

## 3. Top 10 costs, ranked (before)

| # | Cost | Where | Size |
|---|---|---|---|
| 1 | Cold full parse of EVERY transcript file per agent by the three live readers (chat blocks, session activity, latest usage), triggered for all 22 agents in the first seconds by the 10 s overview poll, the auto-handoff sweep and the chat open | `archive.js` `computeLiveTranscriptBlocks` / `readActivitySummary` / `computeLatestUsage` | **51.7 s** of main-thread time (18.5 + 16.2 + 17.0 s; 2.2 GB, 563 files) - sandbox profile: main busy 34 s in the first 127 s, first IPC waited 17.7 s |
| 2 | The keep-alive sweep's 2 s stagger after every agent, dispatch or not | `main.js` `ensureAllAgentsBackgroundedImpl` | **42 s** of the 78 s countdown |
| 3 | Account-wide usage scan (`getUsageWindows`) reading every project's transcripts (3+ GB, including non-agent folders such as Security's 1.3 GB session folder) on the main thread, first call at renderer load and again on every agent switch (memoised afterwards) | `archive.js` `getUsageWindows` | **21-40 s** cold (4.9 s of it landed inside the first 25 s in the sandbox profile) |
| 4 | 10 s fixed delay before the first sweep | `main.js` whenReady | 10 s |
| 5 | Repeated `claude agents --json --all` listings during the sweep (8 s cache TTL, 263 KB, 948 entries, 1.36 s each) | `main.js` `listBackgroundAgents` | ~6 listings = ~8 s |
| 6 | Synchronous PowerShell `Get-CimInstance` in the orphan reaper right after the window is created | `main.js` `listClaudeProcessesWindows` | 1.4 s block |
| 7 | Synchronous CLI probes before the window: `where claude.cmd` (`resolveClaudeExecutable`), `checkInterferingServices`, `getInstalledClaudeCodeVersion`, and the pty spawn for `claude --version` in `checkClaudeExecutableHealth` | `main.js` | ~1.2 s of the first second (profile: 289 + 317 + 155 + 475 ms) |
| 8 | `countCliClaudeProcesses` PowerShell at the start of every sweep | `main.js` | 1.1 s (async, but it is on the countdown's path) |
| 9 | `memoByFiles` stat of all 563 files on every poll (overview 10 s, chat 4 s, guards 10 s) | `archive.js` | ~0.9 s per 127 s of `stat` self time; cheap but constant |
| 10 | 1.5 s login/resume peek + listing before an attach on every tab open | `main.js` `startTerminalSessionInner` | 1.5-3 s per first open of an agent |

Everything else (renderer script parsing 1.5 MB JS, avatar data URLs, xterm) is under 0.5 s.

## 4. What changed (file, why, before -> after)

| Change | File | Before -> after |
|---|---|---|
| **Tail-ranked file selection.** `tailLatestTs()` reads a file's last 64 KB (x8 when the tail has no timestamped line, e.g. only `custom-title`/`agent-name` records) to get its newest timestamp, memoised per (path, size, inode). The three readers rank files by it and parse only what they need: chat blocks the top two, activity the top one (stops when the parsed file's latest timestamp is >= the next file's tail timestamp), usage newest-first with the same exact stop rule. The parse of a chosen file is unchanged. | `src/archive.js` | cold sum over 22 agents **51.7 s -> 2.7 s**; conversation open (sandbox) 7126 -> 783 ms, 6178 -> 711 ms, 1118 -> 236 ms, 1224 -> 762 ms; output identical on all 22 real folders (`tools/compare-archive-readers.js`: "all 22 agents identical") |
| **Usage scan in a worker thread + persisted per-file records.** `get-usage-windows` is answered by `src/usageWorker.js` (own copy of archive.js); records are saved to `<userData>\usage-scan-cache.json` (atomic rename, at most once a minute, inode-checked on reload). Main-thread fallback if the worker cannot start. | `src/main.js`, `src/usageWorker.js`, `src/archive.js` (`loadUsageFileCache`/`saveUsageFileCache`, inode check) | main thread: 21-40 s cold -> 0; warm launch answer **35 ms** ("563 file records restored"); numbers identical (test) |
| **Sweep sleeps only after a dispatch** (`dispatchedThisAgent`). | `src/main.js` | no-dispatch sweep: 42 s of sleep -> 0; expected startup countdown ~78 s -> ~10 s (4 s delay + listing 1.4 s + PowerShell count 1.1 s + 22 cached checks); each dispatch still adds 2 s + the limiter's 4 s spacing |
| **First sweep after 4 s** instead of 10 s (`STARTUP_SWEEP_DELAY_MS`). | `src/main.js` | -6 s on the countdown |
| **Orphan reaper's PowerShell listing is async** (`runPowerShellJsonAsync`; the sync `runPowerShellJson` is gone, it had one caller). | `src/main.js` | 1.4 s main-thread block at +1 s -> 0 |
| **Startup timeline + stall monitor**: `startup: window shown / renderer loaded / first agent list answered / first chat transcript answered / ready (overlay released)` lines and, at +120 s, `startup: main thread blocked X s in the first 120s (N stalls, worst M ms)`; first worker answer logged with its ms and restored-record count. | `src/main.js` | sandbox after: "main thread blocked 1.5 s in the first 120 s" (before, by the same yardstick: first IPC waited 17.7 s, profile busy 34 s) |
| `AGENT_DESKTOP_HIDDEN=1` keeps a test-mode window unshown (measurement runs). | `src/main.js` | - |
| Tests and tools: `tests/archiveTailRank.test.js` (ranking, exactness vs the full parse, old file read only in its tail, re-entry of an old file, cache round trip with zero bytes re-read); `tools/compare-archive-readers.js` (new readers vs full-parse reference on real folders). `npm test` now runs the new test. | `tests/`, `tools/`, `package.json` | - |
| Version 1.76.0, changelog entry appended to the worktree's CLAUDE.md (gitignored - see deploy). | `package.json`, `CLAUDE.md` | - |

### Sandbox before/after (same data, same machine, cold caches; `--warm` = usage-scan cache present)

| Metric | before (v1.75.15) | after (cold) | after (warm cache) |
|---|---|---|---|
| renderer load event seen / agent list populated | 19.9 s | **2.9 s** | 3.5 s |
| startup overlay gone (test mode: no sweep) | 20.7 s | **3.7 s** | 4.6 s |
| main process busy in first 127 s (CPU profile) | 34.3 s | **3.2 s** | - |
| IPC round-trip max / avg | 17,724 ms / 56 ms | 1,717 ms (once, at +0.9 s) / 6 ms | **12 ms / 2 ms** |
| open Video Editing (283 MB folder) | 7,126 ms | **783 ms** | 796 ms |
| open Trade Show (258 MB) | 6,178 ms | **711 ms** | 485 ms |
| open Software Engineering (236 MB) | 1,118 ms | **236 ms** | 440 ms |
| open COO (66 MB) | 1,224 ms | **762 ms** | 583 ms |
| first usage scan (worker) | 21-40 s on main | off main | 35 ms |

The remaining ~0.7 s per conversation open is the parse of that agent's newest file (0.25-6 MB) plus `renderChatBlocks`; the live app adds the attach (listing + pty + 1.5 s peek), which the sandbox cannot run.

### Full test run
`npm test` stops at `tests/noUndef.test.js` because **`eslint` is not installed in node_modules** (it is in devDependencies; `npm install` was not run, the worktree junctions the live `node_modules`). Every other test in the chain was run individually: handoffDelivery, libraryState, startLimiter, cpuGuardInstall, cpuGuardGlue, connectionHealth, deliveryScreen, handoffLogic, keepGoing, keepGoingGlue, unsentLedger, topbar, memoryData, daily, daily-hardening, mailfeed, ics, calendar, gmail, dailyRenderer, agentDocs, keepGoingAttach, archiveTailRank, check-changelog: **all PASS**. Also run: iris.test.js, voiceSplit.test.js: PASS. `node --check` on the three changed/new source files: OK.

## 5. What was NOT changed, and why

- **Agent dispatch semantics, message delivery, keep-going, IRIS, auto-handoff**: untouched. The sweep still checks every agent in the same order, with the same cache, cap, breaker and grace rules; only the sleep after a non-dispatch is gone.
- **Windowed rendering of long chats**: not needed. The chat shows only the newest file (plus one hop after a handoff), 26-240 items per agent in practice; `renderChatBlocks` already reconciles instead of rebuilding. The cost was the parse, not the DOM.
- **Tail-only parse of the newest file itself** (reading only the last N MB of the live file): would change what the chat shows for very long sessions; the newest files are 0.25-6 MB today, so the gain is small and the behaviour change is not worth it.
- **The 1.5 s login/resume peek and the pre-attach `claude agents` listing on tab open**: real per-open cost (2-3 s live), but it is the protection against the expired-login and resume-dialog dead ends; changing it needs a live agent to test against.
- **Synchronous CLI probes in the first second** (`where claude.cmd`, `checkInterferingServices`, version check, the pty `claude --version`): ~1.2 s before the window; the fix is to defer them to after `did-finish-load` or make them async, but they feed the health banner and update checks, so it belongs in its own small change with a live check.
- **`countCliClaudeProcesses` (1.1 s PowerShell) at the start of every sweep**: it is the circuit breaker's input; left alone.
- **The startup overlay itself**: unchanged; its countdown will self-correct after three launches (average of the last three real runs).
- **Renderer polling cadence** (overview 10 s, chat 4 s, guards 10 s, library 30 s): unchanged; with the readers fixed these are cheap.
- **Dropping the live app's CLAUDE.md "noUndef" check**: not touched; it just cannot run without eslint.

## 6. Remaining ideas, ranked by gain

1. **Persist the per-file state of the three live readers too** (newest-file offsets + slim entries are small): would make the first chat open of each agent ~instant instead of ~0.5 s. Gain: ~0.5 s per first open, ~10 s total across 22 agents of background polling after launch.
2. **Defer or async the pre-window CLI probes** (item 7 above): ~1.2 s earlier first paint. Low risk, needs a live check of the health banner.
3. **One listing per sweep, taken fresh at the start** instead of the 8 s TTL cache: saves ~1-2 extra `claude agents` calls when a dispatch happens; ~2-3 s per dispatching sweep.
4. **Skip the 1.5 s peek on a re-attach to an agent that was alive and healthy a moment ago** (e.g. seen in the last listing with no dialog): ~1.5 s per tab open. Needs a live agent to test.
5. **Stat fewer files per poll**: `memoByFiles` stats all 563 files every 4-10 s from three pollers; a per-folder `readdir` mtime check (or ranking only the newest few) would cut ~1 s of CPU per 2 min. Small.
6. **Batch the 22 `get-context-usage` calls of the auto-handoff sweep into one IPC** (noted open since v1.68.0): fewer round trips; now that each call is ~10 ms it is cosmetic.
7. **Move the live readers to the worker as well**: would take the remaining ~3 s of parse off the main thread entirely; more plumbing (the readers' results are consumed synchronously in several main.js paths).

## 7. Exact deploy steps (for Security, after a second reviewer's GO)

1. Review: `git -C "E:\Claude work\Security\ad-loadtime" log --oneline main..perf/startup-and-conversation-load` and `git diff main..perf/startup-and-conversation-load` (files: `src/archive.js`, `src/main.js`, `src/usageWorker.js` (new), `src/renderer/startup-overlay.js` (comment), `tests/archiveTailRank.test.js` (new), `tools/compare-archive-readers.js` (new), `package.json`).
2. Sanity on the real data (read-only, ~1 min): `cd "E:\Claude work\Security\ad-loadtime" && set AGENT_DESKTOP_ROOT=D:\Dropbox\Claude stuff && node tools/compare-archive-readers.js` -> expect "all 22 agents identical". And `node tests/archiveTailRank.test.js`.
3. Optional sandbox re-run (no screen, no claude processes): `cd "E:\Claude work\Security\ad-loadtime-sandbox\tools" && node launch_sb.mjs "E:\Claude work\Security\ad-loadtime" loadtime check` (2 min; prints the timeline and IPC latency; `--profile` adds the CPU profile).
4. Merge: in the live repo (`D:\Dropbox\Claude stuff\agent-desktop`, branch main): `git merge --ff-only perf/startup-and-conversation-load` (the branch is rebased on main 30ee45c / v1.75.15; if main moved again, rebase the branch first in the worktree: `git -C "E:\Claude work\Security\ad-loadtime" rebase main`).
5. Changelog: CLAUDE.md is gitignored, so append the v1.76.0 entry to the LIVE `D:\Dropbox\Claude stuff\agent-desktop\CLAUDE.md` by hand - the exact text is in `E:\Claude work\Security\ad-loadtime-sandbox\changelog_v1.76.0.md` (also already in the worktree's CLAUDE.md). Then `node tools/check-changelog.js` in the live repo must print "changelog entry for v1.76.0 present".
6. Restart Agent Desktop the usual way (stop the live electron main by PID, `Start-ScheduledTask AD_LaunchAgentDesktop`). Pre-authorised for fixes.
7. Verify live, from `%APPDATA%\agent-desktop\stuck-turn-watchdog.log`: `startup: renderer loaded at +~2s`, `startup: first sweep done after ~10-20s (22/22 agents)` (longer only when agents actually get dispatched), `startup: ready (overlay released) after ...`, `startup: first usage scan answered by the worker in N ms` (first launch: a cold scan of 20-40 s in the worker, then `usage-scan-cache.json` ~0.3 MB appears in userData; second launch: ~35 ms, "563 file records restored"), and at +120 s `startup: main thread blocked X s` (expect ~1-3 s; before this change it would have read 20-35 s). Open two heavy agents (Video Editing, Trade Show) and confirm the chat appears in ~1-3 s including the attach.
8. After three launches `startup-timing.json` averages the new figure and the countdown starts from it. If anything misbehaves: `git revert` the merge commit, delete `usage-scan-cache.json`, restart.
9. Push to GitHub per the usual release procedure (memory `agent-desktop-github-push-procedure`).

Cleanup afterwards (optional): the sandbox data in `E:\Claude work\Security\ad-loadtime-sandbox` (2.2 GB of transcript copies) can be deleted once the review is done.

## 8. Summary (10 lines)

1. The 70-100 s startup was two things stacked: the countdown overlay waits for the keep-alive sweep, and that sweep slept 2 s after every one of the 22 agents (42 s) on top of a 10 s delay and ~8 s of CLI listings.
2. Underneath, the main thread was blocked ~20-35 s in the first minute parsing 2.2 GB of transcripts in full - every file of every agent, three times over - which is why the first paint came at 20 s and clicks were unreliable (the reason the overlay was built).
3. A fourth hidden cost: the account-wide usage scan (3+ GB) ran cold on the main thread for 21-40 s at renderer load.
4. Fix 1: readers rank files by a 64 KB tail read and parse only the newest one or two - 51.7 s -> 2.7 s cold, output identical on all 22 real folders.
5. Fix 2: usage scan in a worker thread with its records persisted - 0 s on the main thread, 35 ms warm.
6. Fix 3: the sweep sleeps only after a real dispatch; first sweep at 4 s; reaper PowerShell async.
7. Sandbox with real data: usable at 3.7 s instead of 20.7 s; main busy 3.2 s instead of 34 s; conversation opens 0.2-0.8 s instead of 1.1-7.1 s; IPC max 12 ms warm instead of 17.7 s.
8. Expected live countdown after deploy: ~10-20 s on a quiet start (more only when agents are actually dispatched), and the chat usable at once.
9. Every launch now logs its own timeline and a main-thread-blocked total, so the next regression is measurable from the log.
10. Tests pass (eslint-dependent noUndef could not run: eslint not installed); nothing deployed; deploy steps above.

**Single biggest finding:** the three live transcript readers parsed every .jsonl in an agent's folder in full - 2.2 GB, 52 s of main-thread time - only to discover which file was newest, while the newest file per agent is 0.25-6 MB; reading each file's last 64 KB instead gives the same answer and removes ~95% of the startup and conversation-load cost.
