# PHEME delivery through Agent Desktop (v1.77.4, branch feat/pheme-delivery, 2026-10-06)

## Problem
PHEME pasted dictations by clicking a guessed spot in the Agent Desktop window, then Ctrl+V and Enter. Two dictations were
silently lost (2026-10-05 19:02, 2026-10-06 20:14: sent-messages.jsonl had no entry). A blind click cannot know which agent is
selected, whether the chat input exists, or whether the window geometry changed.

## Design
A small local command inside Agent Desktop; PHEME calls it instead of clicking.

- `src/phemeDelivery.js`: pure handler (all I/O injected) plus the named-pipe server. `src/phemeMain.js`: wiring (loaded from
  `main.js` in try/catch, like IRIS, so a fault can only disable the pipe). `src/renderer/renderer.js`: `phemeSelected()` /
  `phemeSend()`; `src/preload.js`: `onPhemeRequest` / `phemeReply`.
- Commands (one JSON line in, one out, token first):
  - `selected-agent` -> `{ok:true, agent}` or `{ok:false, reason}`
  - `send-to-selected {text, source}` -> `{ok:true, agent, verified, written}`, `{ok:true, queued:true}` (agent busy, held in the
    app's own queue, sends when ready), or `{ok:false, reason}`
- Selected = the renderer's `activeAgentPath` with the chat visible and its session started. Refused with a reason when: no agent
  selected; My Daily / ARGUS / Links / Library / Memory is showing; chat not started; pty not attached or still starting (main
  side); text empty or over 20000 characters (refused, never truncated); the selection changed between the check and the send.
- Delivery is the SAME path as the Send button: `sendOrHold()` -> `submitToAgent()` = bracketed paste, a gap, end marker, a gap,
  Enter; text over 500 characters goes through the file hand-off exactly like the UI; the pending bubble is drawn; the
  `sent-messages.jsonl` write happens in `terminal-input`. Dictations are serialised (no overlap).
- Acknowledgement: `written` = main's pty write happened after the request (`lastSentAt`, set where `sent-messages.jsonl` is
  appended); `verified` = `transcriptTailHasText()` finds the sent text (or, for long text, the file reference) in the newest
  transcript within 15 s. `ok:true, verified:false, written:true` = handed over, transcript not yet confirming: the caller must NOT
  resend (the CLI may just be mid-turn). `ok:false, reason:"not-written"` = nothing reached the terminal.
- PHEME side (`tools/pheme_ad_delivery.py`, deployable as `Tools\Pheme\pheme_ad_delivery.py`): `deliver()` returns `ok`,
  `refused` (AD answered no, or no answer in 60 s: state unknown) or `unavailable` (no pipe files / dead pipe: older AD). Only
  `unavailable` falls back to the click method; a refusal keeps the text on the clipboard and gives the error beep, because
  clicking after a refusal or a timeout could paste into the wrong place or duplicate. `pheme.py where` prints the target agent.

## Security notes (who can connect)
- Pipe `\.\pipe\agent-desktop-pheme-<16 random hex>` (sandbox: `-test-`), new name at every start, published only in
  `%APPDATA%\agent-desktop\pheme\pipe-name`. Node cannot set a pipe DACL, so Windows' default applies (other local accounts could
  open the pipe); therefore every request needs the 192-bit random token from `local-token` (mode 0600, in the user's own profile
  folder, same model as the IRIS pipe). Constant-time comparison, wrong token gets `bad-token` and never reaches the handler.
- Limits: 96 KB per request, one command per connection, 90 s socket timeout, text 20000 characters, no shell or file path is ever
  built from the text, `source` is reduced to `[\w.-]{0,24}`. The reply channel (`pheme-reply`) only accepts the app window's own
  webContents. Anyone who can read the user's profile files (same user, or an admin) can use it: they could equally type into the
  app. It can only send text to the already selected agent, same as the keyboard.
- The sandbox cannot reach the live pipe (different name pattern and userData).

## Tests
`tests/phemeDelivery.test.js` (28 checks, added to `npm test`): handler (agent present/absent, My Daily/ARGUS refusal, unattached
and starting pty, oversize and empty text, verified, long-text file reference verified, verification timeout with and without a
pty write, busy queue, renderer refusing / unreachable, serialisation, unknown command), the real pipe server (bad or missing
token, garbage, oversize), and the Python client against a fake pipe server (ok, Hebrew text, refused, unverified, selected-agent,
no files, stale pipe name, stale name plus live pipe found by scan and token still checked, timeout is `refused` not
`unavailable`, oversize/empty refused locally). All 41 test files run one by one: pass (noUndef with
NODE_PATH=E:\Claude work\Security\ad-topbar\node_modules). `pheme.py.proposed` was also exercised against the fake pipe (ok, refused,
unavailable paths).

## Unverified live (needs the deployed app)
- `phemeSelected()` / `phemeSend()` in the real renderer (no Electron was launched): the overlay class list (`argus-open`,
  `daily-open`, `iris-open`, `library-open`, `memory-open`) was read from the source; any other full-screen view not on that list
  would not be refused. The renderer glue has no automated test beyond syntax and the no-undef lint.
- Windows' real pipe DACL, and the actual latency of `transcriptTailHasText` for a just-sent message (verification may report
  `verified:false, written:true` for a slow CLI; that is by design not an error).
- A message that goes through the busy-agent queue reports `queued`; its later delivery is the app's normal queue behaviour.
- The agent-name `displayName` used in replies is the sidebar name.

## Switch PHEME on after the next AD deploy
1. Deploy v1.77.4 as usual and restart Agent Desktop (Iddo's go; not done here). Check
   `%APPDATA%\agent-desktop\pheme\` has `local-token` and `pipe-name`, and `stuck-scan watchdog` log has `pheme local pipe`.
2. `copy "Tools\Pheme\pheme_ad_delivery.py.proposed" "Tools\Pheme\pheme_ad_delivery.py"`.
3. Back up and switch: `copy pheme.py pheme.py.bak_before_ad_pipe_<date>`, then `copy pheme.py.proposed pheme.py`
   (or `patch` with `pheme_ad_delivery.patch`).
4. Test: select an agent (e.g. Testing) in AD, `python pheme.py where` should print its name; dictate with the agent key and read
   `state\pheme.log` for `DELIVERY: pipe -> <agent>: VERIFIED`. Then select My Daily and dictate: expect `pipe REFUSED`, error beep, text on the clipboard.
5. Rollback: restore the backup `pheme.py` (the module is ignored when `pheme_ad_delivery.py` is absent), or set `"ad_pipe": false` in `config.json`.
