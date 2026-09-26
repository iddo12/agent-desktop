# Agent Desktop

A desktop app for running and managing several [Claude Code](https://claude.com/product/claude-code) CLI sessions side by side — one dashboard, one chat-style view per agent, instead of a wall of terminal tabs.

If you've ever ended up with five terminal windows each running `claude` for a different project and lost track of which one needed your attention, this is for that.

## What it does

- **A Library of everything your agents made** — projects, documents and images in one place, with an Ideas / Researched / Active pipeline. See [The Library](#the-library-never-lose-track-of-what-your-agents-made).
- **A sidebar of agents.** Each agent is just a folder on disk. Add one, and Agent Desktop dispatches a real, native Claude Code background agent (`claude --bg`) for it — the actual CLI's own multi-agent system, not a reimplementation.
- **Groups to organize the sidebar.** Collect agents into colored, collapsible groups ("+ Group" in the sidebar), drag agents between them, and reorder groups by dragging their headers. **Groups are purely a visual aid** — they do not define reporting lines, which agent is a "manager", or any relationship between agents. What an agent does and answers to lives in that agent's own instructions (its `CLAUDE.md`), not in how it's grouped here. Group definitions live in one `agent_groups.json` file next to your agent folders; agents you haven't placed in a group show under "Ungrouped".
- **Restart an agent's process without losing the conversation.** A "Restart Session" button re-dispatches the agent's background process while resuming the same conversation — so it re-reads its `.claude/settings.local.json` and `CLAUDE.md` (which a normal app restart doesn't, since that just re-attaches to the still-running process). Distinct from "Reset Session", which clears the conversation.
- **Edit an agent's instructions in-app.** The Create/Edit Agent form has an "Instructions" field, and each agent's `⋮` menu has "Edit instructions" — both write the agent's `CLAUDE.md`, the file Claude Code loads as that agent's standing instructions every session. (This is separate from the short "Role description", which is only the sidebar blurb.) The `⋮`-menu editor adds a starter template and an overwrite-vs-reload prompt if the file changed on disk. Changes take effect on the agent's next session. An agent with no `CLAUDE.md` yet shows a one-click nudge to add one.
- **A chat view, not a raw terminal.** Messages, tool calls, and responses are parsed out of the session's own transcript and shown as a normal chat thread, with Markdown rendered — headings, bold, lists, code blocks, blockquotes, and tables — so a long answer is easy to scan. A "Raw Terminal" toggle drops back to the literal terminal when you want it.
- **Clickable PDF paths in replies.** When an agent mentions a local PDF by its full Windows path (plain text, `inline code`, a code block, or a `[text](D:\...\file.pdf)` link), the path becomes a link that opens the file in your default PDF reader. For safety the app opens only existing `.pdf` files inside the agents' workspace folder and its working-files folder (both set in `src/main.js`, `PDF_LINK_ROOTS`). Anything else is refused and logged to `pdf-links.log` in the app's data folder, and a non-PDF is never opened.
- **Status at a glance.** Each agent can maintain its own `master_state.md` (status / health / recent tasks) that shows up as a one-line summary in the sidebar, so you can tell what's going on without opening every agent.
- **Conversation archive.** Sessions get archived to per-day markdown files, browsable without digging through raw JSONL.
- **A Chats panel per agent.** Lists that agent's past conversations — the same set claude.ai/code shows under "Recents" — newest first, with titles, a preview line, and when each was last active. Rename any of them inline; the new name is written the same way the CLI's own `--name` writes it, so it also surfaces on claude.ai/code. (Resuming an older conversation in place and starting a fresh one from this panel are built but not yet enabled — see the project notes.)
- **Every agent reachable from your phone or another device, automatically.** Right after each agent's first (or first-since-restart) dispatch, Agent Desktop runs Claude Code's own `/remote-control` for it and answers the confirm prompt, so it shows up on claude.ai/code and the mobile app with no manual step. Entirely silent — you'd never see it happen.
- **Runs the real CLI, on Claude Code's own infrastructure.** No wrapper reimplementation of Claude Code — Agent Desktop dispatches each agent as a genuine Claude Code background agent and just `attach`es a [node-pty](https://github.com/microsoft/node-pty) view onto it, so anything the CLI's own background-agent system can do, an agent here can do. Because the agent is a real Anthropic-side background agent rather than a process Agent Desktop directly owns, it keeps running independent of whatever's currently attached to it - closing Agent Desktop (or losing the attach connection) doesn't kill the agent's work.
- **Tells you when the Claude Code CLI itself is outdated.** Agent Desktop depends on its own separate, npm-global Claude Code install (distinct from whatever the Claude Desktop app bundles) - a sidebar button appears only when that install is genuinely behind the latest published version, and updates it with one click.
- **Real rate-limit usage in the chat header, not a guess.** On first launch, Agent Desktop installs a small [statusLine](https://code.claude.com/docs/en/statusline) script as your global Claude Code config (only if you don't already have one configured - it never overwrites your own). From then on, any interactive `claude` session on the machine - this app's own agents included - feeds it Anthropic's actual reported 5-hour/weekly rate-limit percentages, which show up as real badges instead of an estimate. Falls back to a labeled, message-count-based estimate until that data exists (e.g. right after first install) - the sidebar's **Plan** dropdown (Pro / Max 5x / Max 20x) picks which community-sourced estimate that fallback uses.
- **A "this month" view too**, alongside the 5-hour/weekly ones - real message counts for the current calendar month, a daily average, and a plain linear projection for where that pace lands by month's end, plus a clearly-labeled *estimated* percentage (extrapolated from your real weekly rate-limit usage - Anthropic doesn't publish a monthly cap the way it does for the 5-hour and weekly windows, so this is the best available estimate, not a reported figure).

## The Library: never lose track of what your agents made

Below the agent list is a **Library** with three tabs: **Projects**, **Documents** and **Images**. It is a single place that answers "what have my agents made, and where is it?", so you don't have to remember links or ask an agent to dig one up.

The Library only *shows* things; it is only as useful as what gets registered into it. It reads a folder named `shared_registry` inside your agents root (the folder set by `AGENT_DESKTOP_ROOT`, or the parent of `agent-desktop`). **A fresh install starts with an empty Library**; it fills up when your agents write entries there. Two helper scripts ship with the app in `tools/registry/`: `registry.py` (add, update, list, confirm and remove entries from the command line, so agents don't hand-write JSON) and `registry_sync.py` (the optional nightly sweep, below). An entry is also just one small JSON file, so any agent can write one directly.

### An entry

One file per entry, `shared_registry/<id>.json`:

```json
{
  "id": "quick-cull-research",
  "type": "document",
  "title": "Quick-cull tool: market research",
  "description": "What exists, the gap, and a recommendation.",
  "agent": "Research Agent",
  "topic": "Video tools",
  "link": "C:/Projects/Research/quick_cull_research.pdf",
  "status": "active",
  "stage": "researched",
  "createdAt": "2026-09-26T10:00:00",
  "updatedAt": "2026-09-26T10:00:00",
  "confirmedAt": "2026-09-26T10:00:00"
}
```

- `type`: `project` (something you can open and use), `document` (a report or spec, ideally a PDF so it opens inside the app) or `image` (with a `thumbnail` path).
- `link`: a local file, a launcher, or a web URL. Documents open full-size inside the app with a Back button; web links open in your browser. Add `"pdf": "<path>"` to give a web page a PDF copy.
- `status`: only `active` entries are shown by default; the **Archived** checkbox reveals the rest. Use `archived` or `superseded` instead of deleting.
- `confirmedAt`: entries nobody has confirmed for 90 days get an "unconfirmed" tag, and a link to a file that no longer exists gets "file missing", so the Library does not quietly point at nothing.

### Ideas, Researched, Active: the Projects pipeline

Ideas get lost when many efforts run in parallel. The Projects tab has three buttons at the bottom, driven by the optional `"stage"` field:

| Stage | Meaning |
|---|---|
| **Ideas** | Written down, nobody has studied it yet |
| **Researched** | A research paper or brief exists |
| **Active** | Being built or in use (a project with no `stage` counts as active) |

Ideas and Researched can hold projects *and* the research documents behind them; Active holds projects only. An idea or researched item that nobody has touched for 14 days gets a red "no movement" tag, which is the cue to decide: build it, park it, or drop it.

### Making it actually useful

1. **Tell your agents to register what they make.** Put a standing line in each agent's `CLAUDE.md`, for example: *"Any document you write for me and anything I can open and use gets a JSON entry in `shared_registry`. Update the entry when the thing changes. Do not register helper scripts."*
2. **Capture ideas the moment you voice them.** Another standing line: *"When I mention a project or tool idea, write an entry with `"stage": "idea"` in that same turn."*
3. **Give one agent the weekly review.** Someone has to move ideas to Researched or Active and archive dead ones, or the Ideas list becomes a graveyard.
4. **Optionally sweep automatically.** `python tools/registry/registry_sync.py` (safe to run any time; `--dry-run` shows what it would change) registers PDFs found under a `Research` folder as *researched*, turns idea-tagged tasks from a task store into ideas, and turns headings containing "idea", "proposal" or "concept" in `*_pending_notes.md` files into ideas. Run it nightly with Windows Task Scheduler (or cron). Entries it creates are marked `"auto": true` and it never rewrites ones you registered by hand.

Both scripts find the registry the same way the app does: the `AGENT_DESKTOP_ROOT` environment variable, or the folder that contains `agent-desktop`.

Keep the registry to destinations you would actually go back to. Registering every script buries the few things you want to find again.

## Requirements

- Windows (developed and tested there; the Electron/node-pty parts are cross-platform in principle, but paths and the launch scripts currently assume Windows)
- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://claude.com/product/claude-code) installed and authenticated (`claude` on your `PATH`)

## Setup

```bash
git clone <this repo>
cd agent-desktop
npm install
npm start
```

By default, agents live as sibling folders next to `agent-desktop` itself — i.e. if you clone this into `C:\Projects\agent-desktop`, agent folders go in `C:\Projects\`. Set the `AGENT_DESKTOP_ROOT` environment variable if you'd rather keep them somewhere else. If that folder has other non-agent subfolders you don't want listed as agents, list them (comma-separated) in `AGENT_DESKTOP_EXTRA_EXCLUDE`.

## Adding an agent

Click **+ Agent** in the sidebar and give it a name. That creates a folder for it with:

- `agent_config.json` — display name, role description, avatar
- `master_state.md` — optional status doc the agent can keep updated (`## Status`, `## Health`, `## Recent Tasks` sections are parsed and surfaced in the sidebar)
- `sessions/` — where its conversation archive gets written

Selecting the agent starts a real `claude` session with that folder as its working directory — the same as running `claude` yourself in that folder, just with a UI around it.

## Architecture, briefly

- `src/main.js` — Electron main process: window management, dispatching each agent as a native Claude Code background agent (`claude --bg`) and attaching a node-pty view to it (`claude attach`), IPC handlers. One-shot CLI calls (listing agents, dispatching, stopping) go through node-pty rather than `child_process`, since the latter has proven unreliable in some launch contexts on Windows.
- `src/agents.js` — agent folder CRUD (create/list/update/delete).
- `src/groups.js` — reads/writes `agent_groups.json` (the sidebar's visual groups). Normalizes on every read and write, and falls back to "no groups" if the file is missing or corrupt, so a bad edit can never break the sidebar.
- `src/archive.js` — reads each agent's live JSONL transcript and turns it into the chat view's message blocks, plus the per-day markdown archive.
- `src/fsRetry.js` — retry-with-backoff wrapper for file operations, since cloud-synced folders (Dropbox, OneDrive, etc.) and antivirus/security software can transiently lock files mid-write.
- `src/renderer/` — the UI itself.

## Known limitations

- Windows-first: paths and the hidden-launch script (`Launch.vbs`) assume Windows conventions.
- Only one Agent Desktop window should run at a time per machine (enforced via Electron's single-instance lock) — a second launch just focuses the first.
- Deleting an agent shows a mandatory 30-second countdown before the delete button becomes clickable. This isn't just friction for its own sake: `claude --bg` dispatch spawns a separate, longer-lived daemon helper process that can keep a handle on the agent's folder for a while after the agent session itself is stopped, and deleting too soon can otherwise fail with a Windows "resource busy" error. The countdown gives that daemon time to release it.

## Troubleshooting: "File not found" / "is not recognized" launching an agent ("the 2 sec problem")

**Check this one first** if an agent won't open or respond — it's the most common cause and the fastest to rule in or out.

If opening or messaging an agent fails with an error mentioning `claude.cmd`
— e.g. `'C:\Users\<you>\AppData\Roaming\npm\claude.cmd' is not recognized as
an internal or external command` — and this keeps happening rather than
being a one-off blip, the real cause on a machine with the Claude Desktop
app installed is almost always this: **`%APPDATA%\npm\claude.cmd` is not an
independent file, it's a symlink into Claude Desktop's own packaged app
storage**, and that symlink is not reliably resolvable from every process's
security context. Confirm it in one command:
```powershell
Get-Item "$env:APPDATA\npm\claude.cmd" | Select-Object LinkType, Target
```
If `LinkType` shows anything (e.g. `SymbolicLink`) and `Target` points into
`...\Packages\Claude_<id>\LocalCache\...`, that's it — some processes will
be able to resolve that target reliably and others won't, depending on
their own relationship to Claude Desktop's app-package identity, which
produces exactly this kind of "works sometimes, fails other times, no
obvious pattern" symptom.

This app's own `resolveClaudeExecutable()` (`src/main.js`) already works
around it by resolving straight to the real target path instead of through
the symlink — if you're hitting this in your own tooling that shells out to
`claude`, the fix is the same: resolve
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\npm\claude.cmd`
directly (glob for the `Claude_*` folder, since the exact suffix is
per-install) rather than trusting the PATH/`%APPDATA%`-based symlink.

## Troubleshooting: Windows Defender Controlled Folder Access

If file edits or agent sessions fail or hang for no visible reason on Windows, check whether Controlled Folder Access is silently blocking Node, git, or `claude.exe` itself from writing to your agents' folder:
```powershell
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1123} -MaxEvents 10
```
If it's blocking something, allow-list the specific executable named in the event (an admin PowerShell is required):
```powershell
Add-MpPreference -ControlledFolderAccessAllowedApplications "<path to the .exe>"
```
Wildcards are supported in the *folder* portion of the path (not the filename) — useful for auto-updating apps whose install path includes a version number, e.g. `...\claude-code\*\claude.exe`.

## Contributing

Issues and PRs welcome — this is an early, actively-used personal tool being shared in case it's useful to others, not a finished product. Bug reports with repro steps are especially appreciated, since a lot of the trickier issues so far have been Windows/filesystem-specific and hard to hit by just reading the code.

## License

MIT — see [LICENSE](LICENSE).
