# Test-mode isolation report (v1.77.2, branch fix/test-mode-isolation, 2026-10-06)

Problem: a sandbox instance (AGENT_DESKTOP_TEST_MODE=1) tried to write into the REAL
`D:\Dropbox\Claude stuff\Analytics Agent\.claude-session` (Defender blocked it).

## The fix in one paragraph
New `src/testGuard.js`, required and `install()`ed as the first lines of `src/main.js`.
In test mode only, it wraps fs write APIs (writeFile, appendFile, mkdir, unlink, rm, rmdir, rename, copyFile, cp,
truncate, utimes, chmod, chown, symlink, link, mkdtemp, createWriteStream, open/openSync/promises.open with a write flag;
sync, callback and promises forms) and child_process `cwd` (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork).
A write whose resolved path is not under the sandbox root (`AGENT_DESKTOP_ROOT`, or a private tmp dir if unset),
the sandbox userData (`%APPDATA%\agent-desktop-test*`), `os.tmpdir()`, or `AGENT_DESKTOP_TEST_ALLOW_WRITE`
(`;`-separated opt-in) is refused with EACCES and a `[testGuard] REFUSED ...` line on stderr. Reads are never blocked.
Helpers: `isTestMode()`, `sandboxRoot()`, `workspaceRoot()`, `usageNowPath()`, `flowsEnabled()`, `isWritable(p)`, `assertWritable(p)`.
Without AGENT_DESKTOP_TEST_MODE=1, `install()` returns false and replaces nothing; `workspaceRoot()` and `usageNowPath()` return exactly the old values (proved by a test comparing function identities).

## Every path found, and how it is handled
| Where | Path | Handling |
|---|---|---|
| main.js `ARGUS_WORKSPACE` (ARGUS, MEMORY data, open-source, set-idea-decision, registry loadEntries, PDF/file link roots) | `D:\Dropbox\Claude stuff` | `testGuard.workspaceRoot()`: sandbox root in test mode, unchanged live |
| overview.js `TASK_STORE_DIR` | `D:\Dropbox\Claude stuff\shared_reports\tasks` | `workspaceRoot()` (read) |
| main.js usageHardStop, archive.js usageModelFallback | `__dirname\..\..\System Optimization...\usage_now.json` | `usageNowPath()`: sandbox path (or AGENT_DESKTOP_THROTTLE_FILE) in test mode (read) |
| main.js `ensureRateLimitStatusLine`, `ensureRemoteControlEnabled` | `~/.claude/settings.json` (WRITES the real file; ran in test mode before) | skipped unless `AGENT_DESKTOP_TEST_ENABLE_FLOWS=1`; guard would refuse it anyway |
| main.js `sessionCwdFor` (mkdir `<agent>\.claude-session`) | any agent folder | covered by the fs guard: a real agent folder is refused, sandbox agents allowed. This is the path of the incident |
| main.js `spawnPtyWithRetry` (pty.spawn, node-pty not covered by child_process wrapper) | session cwd | `assertWritable(cwd)` before spawn |
| keep-going: nudge delivery (`deliver`), attach `blocked`, `kgTestPaths` (AGENT_DESKTOP_KEEPGOING_AGENTS injection) | real agents / channel / relay | dry unless live agents permitted AND `AGENT_DESKTOP_TEST_ENABLE_FLOWS=1` (before: only the live-agent opt-in) |
| auto-handoff / handoff delivery | `agentChannel` relay dir (test: userData), transcripts, agent folders | the delivery runs through keep-going `deliver`/channel (gated above); relay dir was already under sandbox userData; `AGENT_DESKTOP_RELAY_DIR` pointing at a real dir is now refused by the fs guard. Renderer-driven handoff writes (archive files under agent folders) are refused by the fs guard if the agent is real |
| overview.js `approveTelegramTasks` (runs tasks.py) | `<AGENTS_ROOT>\Security\Tools\TelegramBridge` | no-op in test mode without opt-in (child processes write wherever they like; not interceptable) |
| argus-data.js `runBuilder` (python build_status.py) | `<workspace>\shared_tools\bridge` | no-op in test mode without opt-in |
| daily/main-daily.js tasks.py runner | `<root>\shared_tools\tasks` | already: test mode keeps tasks in memory; root is sandbox. Unchanged |
| agents.js / groups.js ROOT, main.js 4776 | `AGENT_DESKTOP_ROOT` or `__dirname\..\..` | already sandbox in test mode. Unchanged |
| userData (logs, keepgoing.json, ui flags, usage cache) | `%APPDATA%\agent-desktop-test<suffix>` | already redirected in test mode; allowed by the guard |
| agentChannel relay dir | test: `<userData>\handoff_relay` | already sandbox |

## Still read-only from real (deliberately left)
- `~/.claude/projects/*` transcripts, `~/.claude/sessions`, `~/.claude/daemon/pty-pids`, `~/.claude/jobs`, `.credentials.json`, `agent-desktop-rate-limits*.json`, `~/.claude.json` (reads in archive.js, guards-main.js, overview.js, memory-data.js, workspaceTrust.js, testMode.tokensUsed). The tier-3 live-agent budget meter needs the projects dir; rate-limit reads give the sandbox a usage view.
- memory-data.js reads `~/.claude/projects/D--Dropbox-Claude-stuff-*/memory` (MEMORY tab); `memory-open-folder` only opens Explorer.
- Open/PDF link allow-lists still include `E:\Claude work`, `D:\Dropbox\MegaPixel-2` (open-only, no write).
- `AGENT_DESKTOP_DAILY_REAL_TASKS=1` reads the real task store (opt-in, read only).
- `keepGoing.js` prompt text mentions the real tasks.py path (text only).
- gmail export default `E:/Claude work/Personal Assistant Agent/mail_index/gmail_feed.json` (skipped in test mode).

## Risks and limits
1. Child processes (`claude --bg` in tier 3, python tools) can write anywhere; the guard only checks their cwd. Tier-3 live agents are therefore still bounded by the existing token budget, not by this guard; only the explicit opt-in turns them on.
2. Worker threads (`usageWorker.js`) and the renderer have their own fs module; the worker only writes its cache under userData, the renderer has no fs access. Not wrapped.
3. Modules that destructured `fs` functions before `install()` would bypass the wrap; main.js installs before any other require, and the codebase uses `fs.fn(...)` style (grep checked).
4. Chromium/Electron internals (cache, cookies, GPU) write natively under userData; unaffected.
5. A fixture that legitimately needs a write elsewhere must list it in `AGENT_DESKTOP_TEST_ALLOW_WRITE`; refusals show on stderr as `[testGuard] REFUSED write outside sandbox: <path>`.
6. Not run in the real Electron app (task rules): verified by unit tests and `noUndef` lint only. Needs a sandbox smoke run by whoever may launch it.
7. `AGENT_DESKTOP_ROOT` unset in test mode now means a private tmp root rather than `__dirname\..\..`, for the guard and helpers only (agents.js still falls back to `__dirname\..\..`; the launcher always sets the variable).

## Tests
`tests/testGuard.test.js` (in `npm test`, 5 scenarios in child processes): refusals for sync/callback/promise/mkdir/rename/open/stream and a real-workspace probe; allowed sandbox/tmp/opt-in writes and unblocked reads; child cwd refusal; helper roots; non-test mode unchanged (function identities equal, install() false, old real roots, `AGENT_DESKTOP_TEST_MODE=0` is not test mode).
Whole suite run file by file: all 33 test files pass; `noUndef` needs eslint, which is not installed in this clone (pre-existing), so it was run with eslint installed in a scratch folder via NODE_PATH: ok. `node tools/check-changelog.js`: ok.
