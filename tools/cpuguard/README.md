# CPU guard

A small background script that keeps your PC responsive when many Claude agents work at the same time.

## What it does
- Every 2 seconds it reads overall CPU and free RAM (cheap native calls, well under 1% CPU itself).
- Claude CLI processes (and what they launch) always run at *below normal* priority on all logical cores except 1-4 that are kept free for the mouse, Explorer and your own apps (1 on 4 cores or fewer, 2 on 8, 3 on 16, 4 above).
- A short 100% spike is ignored. If CPU stays high for about 20 s (or RAM is nearly full) it measures which agent sessions cause it and moves the biggest ones into a "penalty box": idle priority on 2 (small PC) or 4 cores. They keep working, only slower.
- If it is still hot, helper processes of those agents (node, python, ffmpeg...) are paused for part of every tick. If it is still hot after a minute it writes `state\fleet_hold.json`. Agent Desktop sees that file, stops starting new agents and shows a banner. The file is removed once the load is back under control; agents leave the box one at a time.
- Incident reports go to `incidents\`, a log to `cpuguard.log`, current state to `state\status.json`.

## What it never touches
It never closes or kills anything, never pauses `claude.exe` itself (so no API connection is cut), never touches Agent Desktop, Claude Desktop, or any process that is not a Claude CLI agent or its children. Paused processes are always resumed (on exit, on start, and by `-Mode Release`). It needs no administrator rights and sends no popups unless started with `-Notify`.

## Where it lives
Everything is under `%APPDATA%\agent-desktop\cpuguard` (override with `-StateDir`). Agent Desktop copies the scripts to `...\cpuguard\bin` and registers a per-user scheduled task `AgentDesktop_CpuGuard` (at logon, hidden, restarts on failure) - only after you say yes the first time.

## Manual use
`powershell -File CpuGuard.ps1 -Mode Status` shows the current state. `-Mode Release` resumes everything and clears the hold.

## Uninstall
Run:
```
schtasks /End /TN AgentDesktop_CpuGuard
schtasks /Delete /TN AgentDesktop_CpuGuard /F
powershell -File CpuGuard.ps1 -Mode Release
```
then delete `%APPDATA%\agent-desktop\cpuguard`.
