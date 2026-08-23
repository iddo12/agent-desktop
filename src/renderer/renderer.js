const AVATAR_PALETTE = ["#6366f1", "#0ea5e9", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6", "#22c55e"];

let agents = [];
let activeAgentPath = null;
let selectedAvatarPath = null;

const terminals = new Map(); // agentPath -> { term, fitAddon, started }

const agentListEl = document.getElementById("agent-list");
const emptyStateEl = document.getElementById("empty-state");
const chatViewEl = document.getElementById("chat-view");
const chatAvatarSlotEl = document.getElementById("chat-avatar-slot");
const chatNameEl = document.getElementById("chat-name");
const chatRoleEl = document.getElementById("chat-role");
const terminalContainerEl = document.getElementById("terminal-container");
const chatInputEl = document.getElementById("chat-input");
const sendInputBtn = document.getElementById("send-input-btn");
const resizeHandleEl = document.getElementById("chat-input-resize-handle");
const saveToMasterBtn = document.getElementById("save-to-master-btn");
const historyToggleBtn = document.getElementById("history-toggle-btn");
const modelPickerBtn = document.getElementById("model-picker-btn");
const rawTerminalToggleBtn = document.getElementById("raw-terminal-toggle-btn");
const resetSessionBtn = document.getElementById("reset-session-btn");
const chatMessagesViewEl = document.getElementById("chat-messages-view");
const chatBodyEl = document.getElementById("chat-body");
const historyViewEl = document.getElementById("history-view");
const historyDayListEl = document.getElementById("history-day-list");
const historyContentEl = document.getElementById("history-content");
const terminalWrapperEl = document.getElementById("terminal-wrapper");
const chatInputBarEl = document.getElementById("chat-input-bar");
const chatAttachmentsEl = document.getElementById("chat-attachments");
const chatQueueEl = document.getElementById("chat-queue");
const chatThinkingIndicatorEl = document.getElementById("chat-thinking-indicator");
const contextUsageEl = document.getElementById("context-usage");
const planTokensRemainingEl = document.getElementById("plan-tokens-remaining");
const fiveHourUsageEl = document.getElementById("five-hour-usage");
const weeklyUsageEl = document.getElementById("weekly-usage");

const modalEl = document.getElementById("new-agent-modal");
const nameInput = document.getElementById("new-agent-name");
const roleInput = document.getElementById("new-agent-role");
const avatarPreview = document.getElementById("avatar-preview");

function avatarColor(name) {
  let sum = 0;
  for (const c of name) sum += c.charCodeAt(0);
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
}

// Requested directly: a long role/description (LensVid Business Context's
// own is a good example) was wrapping across several lines in the chat
// header, pushing the actual action buttons down and making the header
// look broken rather than just descriptive. Truncates to a single
// readable line instead - the full text is never lost, just moved to the
// title tooltip, so hovering still shows it in full.
const CHAT_ROLE_MAX_CHARS = 48;

function setChatRoleText(el, role) {
  const text = role || "";
  if (text.length <= CHAT_ROLE_MAX_CHARS) {
    el.textContent = text;
    el.removeAttribute("title");
  } else {
    el.textContent = text.slice(0, CHAT_ROLE_MAX_CHARS).trimEnd() + "...";
    el.title = text;
  }
}

function initials(name) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join("") || "?";
}

function renderAvatarEl(agent) {
  if (agent.avatar) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = agent.avatar;
    return img;
  }
  const div = document.createElement("div");
  div.className = "avatar-fallback";
  div.style.background = avatarColor(agent.displayName);
  div.textContent = initials(agent.displayName);
  return div;
}

async function loadAgents() {
  agents = await window.api.listAgents();
  renderAgentList();
}

function renderAgentList() {
  agentListEl.innerHTML = "";
  for (const agent of agents) {
    const item = document.createElement("div");
    item.className = "agent-item" + (agent.path === activeAgentPath ? " active" : "");
    item.appendChild(renderAvatarEl(agent));

    const textWrap = document.createElement("div");
    textWrap.className = "agent-item-text";
    const nameEl = document.createElement("div");
    nameEl.className = "agent-item-name";
    nameEl.textContent = agent.displayName;
    const roleEl = document.createElement("div");
    roleEl.className = "agent-item-role";
    roleEl.textContent = agent.role || agent.status;
    textWrap.appendChild(nameEl);
    textWrap.appendChild(roleEl);
    item.appendChild(textWrap);

    const dot = document.createElement("div");
    dot.className = "health-dot " + agent.healthLabel;
    dot.title = agent.healthLabel;
    item.appendChild(dot);

    const menuBtn = document.createElement("button");
    menuBtn.className = "agent-item-menu-btn";
    menuBtn.title = "Agent options";
    menuBtn.textContent = "⋮";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also select the agent
      openAgentItemMenu(agent, menuBtn);
    });
    item.appendChild(menuBtn);

    item.addEventListener("click", () => selectAgent(agent));
    agentListEl.appendChild(item);
  }
}

// -------------------------------------------------- agent edit / delete --

let openAgentMenuEl = null;

function closeAgentItemMenu() {
  if (openAgentMenuEl) {
    openAgentMenuEl.remove();
    openAgentMenuEl = null;
  }
  document.querySelectorAll(".agent-item-menu-btn.open").forEach((b) => b.classList.remove("open"));
}

function openAgentItemMenu(agent, buttonEl) {
  if (openAgentMenuEl) {
    const wasThisOne = openAgentMenuEl.dataset.forAgent === agent.path;
    closeAgentItemMenu();
    if (wasThisOne) return; // clicking the same button again just closes it
  }

  const rect = buttonEl.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "agent-item-menu";
  menu.dataset.forAgent = agent.path;
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = Math.max(8, rect.right - 140) + "px";

  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => {
    closeAgentItemMenu();
    openEditAgentModal(agent);
  });
  menu.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "danger-text";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    closeAgentItemMenu();
    openDeleteAgentModal(agent);
  });
  menu.appendChild(deleteBtn);

  document.body.appendChild(menu);
  openAgentMenuEl = menu;
  buttonEl.classList.add("open");
}

document.addEventListener("click", (e) => {
  if (openAgentMenuEl && !openAgentMenuEl.contains(e.target)) closeAgentItemMenu();
});

function selectAgent(agent) {
  activeAgentPath = agent.path;
  localStorage.setItem("lastSelectedAgentPath", agent.path);
  renderAgentList();

  emptyStateEl.classList.add("hidden");
  chatViewEl.classList.remove("hidden");

  chatAvatarSlotEl.innerHTML = "";
  chatAvatarSlotEl.appendChild(renderAvatarEl(agent));
  chatNameEl.textContent = agent.displayName;
  setChatRoleText(chatRoleEl, agent.role);

  setHistoryMode(false);
  showTerminalFor(agent);
  updateComposeAvailability();
  updateThinkingIndicator();
  renderQueue(agent.path);
  refreshContextUsage(agent.path);
  refreshUsageWindows();
}

// A resize call reaches the underlying Claude Code process as a real pty
// resize (node-pty's ConPTY resize on Windows) - the same effect a terminal
// emulator's SIGWINCH has. Confirmed independently on a public bug report
// (anthropics/claude-code#25286): Claude Code's renderer does a full
// screen repaint on every resize signal it receives, and a burst of
// redundant ones (dragging a window, a resize event that doesn't actually
// change the computed cols/rows) can push it into a stuck 100%-writes
// render loop it never recovers from - exactly the failure mode this app's
// own drag-to-resize compose box and window-resize listener could trigger,
// since neither previously checked whether the size had actually changed
// before sending. Only sending when cols/rows genuinely differ from the
// last value actually sent closes that gap.
function sendResizeIfChanged(session, agentPath, cols, rows) {
  if (session.lastSentCols === cols && session.lastSentRows === rows) return;
  session.lastSentCols = cols;
  session.lastSentRows = rows;
  window.api.resizeTerminal(agentPath, cols, rows);
}

function showTerminalFor(agent) {
  terminalContainerEl.innerHTML = "";

  let session = terminals.get(agent.path);
  if (!session) {
    const term = new Terminal({
      theme: {
        background: "#1a1e26",
        foreground: "#e6e8ec",
        cursor: "#6366f1",
      },
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      convertEol: true,
      // Only affects Raw Terminal mode now - the Chat View used to be
      // rebuilt by scraping this exact buffer, which is why this was
      // originally widened from xterm's ~1000-line default (that scraping
      // approach had a real, if less dire, scrollback-eviction bug on long
      // sessions before it was replaced with JSONL-tailing - see
      // agent-desktop\CLAUDE.md). Still widened, since Raw Terminal is a
      // real fallback view the user actually scrolls through by hand.
      scrollback: 10000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    session = {
      term,
      fitAddon,
      started: false,
      busy: false,
      busyStartedAt: null,
      idleTimer: null,
      chatRebuildTimer: null,
      sendQueue: [],
      pendingSent: [],
      // Separate from busy/busyStartedAt on purpose - see updateThinkingIndicator()
      // for why the twitchy 900ms busy flag is wrong for a display meant to
      // survive normal ~1s gaps between a CLI spinner's own redraws.
      turnStartedAt: null,
      thinkingQuietTimer: null,
      // Guards against rebuildChatView() wiping a real, already-shown
      // conversation down to nothing on a bad read - see the comment there.
      hasShownRealContent: false,
      // Cache of the last successful rebuildChatView() read, reused by
      // submitToAgent() for its synchronous optimistic render (see there).
      lastBlocks: [],
      // Last cols/rows actually sent to the pty - see sendResizeIfChanged().
      lastSentCols: null,
      lastSentRows: null,
    };
    terminals.set(agent.path, session);

    term.onData((data) => {
      window.api.sendInput(agent.path, data);
    });
  }

  session.term.open(terminalContainerEl);

  // Fitting immediately after open() can measure a zero-size container if the
  // parent was just unhidden this same tick (display:none -> flex hasn't been
  // painted yet) - defer to the next animation frame so layout has settled.
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    const { cols, rows } = session.term;

    if (!session.started) {
      session.started = true;
      session.lastSentCols = cols;
      session.lastSentRows = rows;
      window.api
        .startTerminal(agent.path, cols, rows)
        .catch((err) => {
          session.term.writeln(`\r\n[failed to start session: ${err.message}]`);
          session.started = false;
        });
    } else {
      sendResizeIfChanged(session, agent.path, cols, rows);
    }

    // Populate the chat view immediately rather than waiting for the next
    // terminal-data event, so switching to an agent shows whatever's
    // already in its buffer (e.g. this session's activity so far) right away.
    rebuildChatView(agent.path);

    // The chat textarea is the primary way to compose a message; the terminal
    // itself is still directly focusable by clicking into it (e.g. for quick
    // menu/keystroke interactions like the theme picker or y/n prompts).
    chatInputEl.focus();
  });
}

function refitActiveTerminal() {
  if (!activeAgentPath) return;
  const session = terminals.get(activeAgentPath);
  if (!session) return;
  session.fitAddon.fit();
  const { cols, rows } = session.term;
  sendResizeIfChanged(session, activeAgentPath, cols, rows);
}

window.addEventListener("resize", refitActiveTerminal);

// Drag-to-resize the sidebar - same pattern as the chat-input resize handle
// above, but horizontal. Reported live: longer agent names/descriptions get
// cut off at the fixed 280px width with no way to see more.
const sidebarEl = document.getElementById("sidebar");
const sidebarResizeHandleEl = document.getElementById("sidebar-resize-handle");
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 560;
let sidebarDragStartX = null;
let sidebarDragStartWidth = null;

function setSidebarWidth(px) {
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(px, SIDEBAR_MAX_WIDTH));
  sidebarEl.style.width = clamped + "px";
  // Same reasoning as setChatInputHeight() above - the terminal doesn't
  // redraw on its own just because a neighboring element resized.
  refitActiveTerminal();
}

sidebarResizeHandleEl.addEventListener("mousedown", (e) => {
  sidebarDragStartX = e.clientX;
  sidebarDragStartWidth = sidebarEl.getBoundingClientRect().width;
  sidebarResizeHandleEl.classList.add("dragging");
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (sidebarDragStartX === null) return;
  const delta = e.clientX - sidebarDragStartX;
  setSidebarWidth(sidebarDragStartWidth + delta);
});

window.addEventListener("mouseup", () => {
  if (sidebarDragStartX === null) return;
  sidebarDragStartX = null;
  sidebarDragStartWidth = null;
  sidebarResizeHandleEl.classList.remove("dragging");
});

// ---------------------------------------------------- chat message view --

// The live chat view is built from Claude Code's own JSONL transcript file
// (window.api.getLiveTranscript(), see getLiveTranscriptBlocks() in
// archive.js for the full reasoning) - the same reliable source History
// already reads, rather than scraping xterm's live terminal buffer the way
// this used to work. That switch happened after a real incident (see
// agent-desktop\CLAUDE.md, "Chat View went completely blank mid-
// conversation") where a bad buffer read wiped a real conversation down to
// nothing in the live view, while History - unaffected, different data
// source - still had everything. Each JSONL entry already arrives
// classified with a role ("user"/"agent"/"status" for a tool call) and its
// text, so there's no more prefix-sniffing (no more "> " / "●" / "✳"
// heuristics, no native-input-box row exclusion, no decorative-border
// filtering) - all of that was specific to reading a live terminal screen
// and none of it applies to structured JSONL.

// Agents are instructed (see root CLAUDE.md, "[[DETAILS]] / [[WARNING]] /
// [[KEY]] markers") to flag which part of a long or dense answer is
// supporting detail, which part is a risk/live-change caution, and which
// small part is what the user actually needs to read - a result, a decision,
// an open question. Marker lines are stripped from what's displayed; they
// exist only to tell this renderer where to split the bubble, not to be
// read verbatim. Content before any marker defaults to "details" so an
// agent that forgets the opening marker still renders sensibly instead of
// silently losing text. Exactly these three kinds are recognized on
// purpose - an agent inventing a fourth marker name would just render as
// stray plain text, which is the intended failure mode (fail visible, not
// silently mis-colored).
const ANSWER_SECTION_MARKER_RE = /^\[\[(DETAILS|WARNING|KEY)\]\]$/;
const HAS_ANSWER_SECTION_MARKER_RE = /^\[\[(DETAILS|WARNING|KEY)\]\]$/m;
function splitAnnotatedSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let currentKind = "details";
  let buf = [];
  const flush = () => {
    const joined = buf.join("\n").trim();
    if (joined) sections.push({ kind: currentKind, text: joined });
    buf = [];
  };
  for (const line of lines) {
    const m = ANSWER_SECTION_MARKER_RE.exec(line.trim());
    if (m) {
      flush();
      currentKind = m[1].toLowerCase();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

// the user asked for this directly after repeatedly needing to ask Claude to go
// check raw JSONL timestamps to tell whether a session was genuinely stuck
// or just slow - showing the real time on each block lets him judge
// staleness himself at a glance, without that round-trip. Local time only
// (not a full date) - this view is the live current conversation, not the
// dated History archive, so same-day precision is what's actually useful.
function formatBlockTime(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// A pasted/attached image isn't a distinct structured block in Claude
// Code's own JSONL transcript - the CLI substitutes it with a quoted local
// file path (saved to a temp file) embedded right in the message's plain
// text, for the agent to Read like any other file. Rendering that quoted
// path as an actual inline image - rather than leaving it as raw path text
// - matches how images the user shares elsewhere in this app's own
// ecosystem already display, and was reported live as looking wrong
// (tiny/unrendered) by comparison. Only matches an absolute Windows path
// (drive letter + backslashes) ending in a known image extension, quoted -
// deliberately narrow so a message that just happens to mention an
// unrelated file path isn't misrendered.
const IMAGE_PATH_RE = /"([A-Za-z]:\\[^"]+\.(?:png|jpe?g|gif|webp|bmp))"/gi;

function renderTextWithImages(container, text) {
  IMAGE_PATH_RE.lastIndex = 0;
  let lastIndex = 0;
  let match;
  let foundAny = false;
  while ((match = IMAGE_PATH_RE.exec(text))) {
    foundAny = true;
    const before = text.slice(lastIndex, match.index).trim();
    if (before) {
      const p = document.createElement("div");
      p.className = "chat-bubble-text";
      p.textContent = before;
      container.appendChild(p);
    }
    const img = document.createElement("img");
    img.className = "chat-bubble-image";
    img.src = "file:///" + encodeURI(match[1].replace(/\\/g, "/"));
    img.alt = match[1].split(/[\\/]/).pop();
    container.appendChild(img);
    lastIndex = IMAGE_PATH_RE.lastIndex;
  }
  if (!foundAny) {
    container.textContent = text; // textContent, not innerHTML - inherently safe against injection
    return;
  }
  const after = text.slice(lastIndex).trim();
  if (after) {
    const p = document.createElement("div");
    p.className = "chat-bubble-text";
    p.textContent = after;
    container.appendChild(p);
  }
}

function renderChatBlocks(blocks, pendingSent) {
  chatMessagesViewEl.innerHTML = "";
  for (const block of blocks) {
    const text = block.lines.join("\n").trim();
    if (!text) continue;
    if (block.role === "agent" && HAS_ANSWER_SECTION_MARKER_RE.test(text)) {
      const wrapper = document.createElement("div");
      wrapper.className = "chat-bubble chat-bubble-agent chat-bubble-annotated";
      for (const section of splitAnnotatedSections(text)) {
        const sectionEl = document.createElement("div");
        sectionEl.className = "chat-answer-section chat-answer-" + section.kind;
        sectionEl.textContent = section.text; // textContent, not innerHTML - inherently safe against injection
        wrapper.appendChild(sectionEl);
      }
      if (block.timestamp) {
        const timeEl = document.createElement("span");
        timeEl.className = "chat-block-time";
        timeEl.textContent = formatBlockTime(block.timestamp);
        wrapper.appendChild(timeEl);
      }
      chatMessagesViewEl.appendChild(wrapper);
      continue;
    }
    const el = document.createElement("div");
    el.className = block.role === "status" ? "chat-status-line" : "chat-bubble chat-bubble-" + block.role;
    renderTextWithImages(el, text);
    if (block.timestamp) {
      const timeEl = document.createElement("span");
      timeEl.className = "chat-block-time";
      timeEl.textContent = formatBlockTime(block.timestamp);
      el.appendChild(timeEl);
    }
    chatMessagesViewEl.appendChild(el);
  }
  // Messages shown immediately at send time, before a real matching entry
  // has shown up in the transcript yet (see submitToAgent) - a lighter
  // visual treatment (pulsing) marks them as "sending", not a normal
  // confirmed message, so it's never ambiguous which is which. Each entry
  // is {text, addedAt} now, not a bare string - see PENDING_SENT_TIMEOUT_MS
  // in rebuildChatView() for why.
  for (const pending of pendingSent || []) {
    const el = document.createElement("div");
    el.className = "chat-bubble chat-bubble-user chat-bubble-pending";
    renderTextWithImages(el, pending.text);
    chatMessagesViewEl.appendChild(el);
  }
  chatMessagesViewEl.scrollTop = chatMessagesViewEl.scrollHeight;
}

// Whitespace-normalized for comparison only (not for display) - guards
// against a pending optimistic bubble (see submitToAgent) somehow not
// exactly string-matching its own confirmed transcript entry (incidental
// whitespace differences) and getting stuck showing twice.
function normalizeForMatch(s) {
  return s.replace(/\s+/g, " ").trim();
}

// See rebuildChatView()'s pendingSent-filtering comment for why this
// exists - a safety net against a pending bubble that never finds a
// matching transcript entry and would otherwise pulse "sending" forever.
const PENDING_SENT_TIMEOUT_MS = 45000;

// Reads live from Claude Code's own JSONL transcript (see
// getLiveTranscriptBlocks() in archive.js) rather than the terminal buffer
// - async now because that's a real IPC round-trip to the main process, not
// a synchronous in-memory read the way the old buffer scrape was. All call
// sites below fire this without awaiting it (a rebuild still in flight when
// the next one is scheduled just resolves and renders somewhat later -
// fine, since renderChatBlocks() always renders the full latest state, not
// a delta).
async function rebuildChatView(agentPath) {
  const session = terminals.get(agentPath);
  if (!session) return;
  const blocks = await window.api.getLiveTranscript(agentPath);
  if (agentPath !== activeAgentPath || terminals.get(agentPath) !== session) return; // stale by the time the IPC round-trip finished

  // the user hit a real incident where the old terminal-buffer-scraping version
  // of this rendered a whole real conversation as a totally blank view -
  // History (built from this exact same JSONL file, just via a different
  // code path) still had everything, confirming it was the live read that
  // went wrong, not the underlying data. JSONL-tailing is a fundamentally
  // more reliable source (a real persisted file, not a transient terminal
  // screen that can mid-redraw or hit a bounded scrollback), so this
  // specific failure mode shouldn't recur - kept as a defensive guard
  // anyway (cheap, and the failure mode it prevents - a real conversation
  // silently vanishing - is bad enough to guard against even if unlikely
  // now). Reset Session explicitly clears hasShownRealContent itself (see
  // its click handler) so a deliberate /clear can still blank the view -
  // this guard is only for accidental, unrequested blanking.
  const hasRealContentNow = blocks.some((b) => b.role === "user" || b.role === "agent");
  if (!hasRealContentNow && session.hasShownRealContent) {
    console.warn(`[agent-desktop] rebuildChatView(${agentPath}) read no content from the transcript despite a real prior conversation - keeping the last good render rather than blanking it.`);
    return;
  }
  if (hasRealContentNow) session.hasShownRealContent = true;

  session.lastBlocks = blocks; // cached for submitToAgent()'s synchronous optimistic render

  // A message optimistically shown at send time (see submitToAgent) is only
  // still "pending" until it actually shows up as a real entry in the
  // transcript - once a real user block matches it, drop it from the
  // pending list so it isn't shown twice.
  //
  // Caught live (2026-08-19): a pending bubble can end up never matching
  // anything - not confirmed why for that specific case (possibly a text
  // fragment that never lines up exactly against normalizeForMatch(), or
  // some other edge case never pinned down) - and with no expiry, it just
  // pulsed as "sending" forever, permanently, long after the real
  // conversation had clearly moved on. Rather than chase that exact trigger
  // blind, added a timeout as a general safety net: past
  // PENDING_SENT_TIMEOUT_MS with still no match, drop it regardless - by
  // then it either succeeded (and matching just failed to notice) or
  // something else happened, but either way an indefinitely-pulsing "still
  // sending" bubble is a worse, more misleading UI state than the bubble
  // just quietly disappearing.
  const now = Date.now();
  session.pendingSent = session.pendingSent.filter((pending) => {
    const stillUnmatched = !blocks.some(
      (b) => b.role === "user" && normalizeForMatch(b.lines.join(" ")) === normalizeForMatch(pending.text)
    );
    const notExpired = now - pending.addedAt < PENDING_SENT_TIMEOUT_MS;
    return stillUnmatched && notExpired;
  });
  renderChatBlocks(blocks, session.pendingSent);
}

// Originally tuned (widened from 120ms) to dodge a mid-redraw terminal read
// from the old buffer-scraping version of this view - that specific failure
// mode doesn't apply to reading a JSONL file (a half-written last line just
// fails its own JSON.parse and gets silently skipped for one cycle, picked
// up clean on the next - see getLiveTranscriptBlocks() in archive.js). Kept
// at the same value anyway: pty output can arrive in a rapid burst during
// active generation, and debouncing still avoids re-reading and re-parsing
// the whole transcript file on every single byte.
const CHAT_VIEW_REBUILD_DEBOUNCE_MS = 400;

function scheduleRebuildChatView(agentPath) {
  const session = terminals.get(agentPath);
  if (!session) return;
  clearTimeout(session.chatRebuildTimer);
  session.chatRebuildTimer = setTimeout(() => {
    if (agentPath === activeAgentPath) rebuildChatView(agentPath);
  }, CHAT_VIEW_REBUILD_DEBOUNCE_MS);
}

// Diagnosed 2026-08-22: scheduleRebuildChatView() above is the *only*
// thing that ever triggers a rebuild, and it only ever fires from real pty
// output (onTerminalData below). That's fine as long as this agent's own
// attach is actually alive and streaming - but separately confirmed live
// the same day that main.js's ptySessions entry for an agent can go stale
// (its stored pty handle no longer corresponds to the session's real
// current background process - e.g. after that session was stopped and
// redispatched from outside this app's own IPC flow, which is genuinely
// how it happened live: `claude stop <id>` run directly from a terminal,
// bypassing this app's own stop-and-redispatch flow entirely) without any
// onExit ever firing to signal it - confirmed directly that zero live
// `claude attach` processes existed system-wide for an agent Agent Desktop
// still showed as active. When that happens, no more onTerminalData events
// arrive for that agent, so no more rebuilds ever happen - the Chat View
// would freeze on its last render forever even once new content exists.
// (Note: the specific blank-Chat-View incident that prompted this same
// day turned out to have a different, unrelated root cause - a project-
// directory encoding bug, see archive.js's encodeProjectPath() comment -
// so this exact poll wasn't what fixed that one. Kept anyway as a real,
// independently-confirmed gap worth covering.) A slow periodic poll for
// the active agent only is a low-risk, purely additive safety net for
// that stale-attach gap specifically - rebuildChatView()
// already no-ops cheaply when there's nothing new to show, so polling
// something that hasn't changed costs one IPC round-trip, not a visible
// re-render.
const CHAT_VIEW_STALE_POLL_MS = 4000;
setInterval(() => {
  if (activeAgentPath && !rawTerminalMode) rebuildChatView(activeAgentPath);
}, CHAT_VIEW_STALE_POLL_MS);

// Raw terminal is the fallback/advanced view for anything that genuinely
// needs real keystroke-level interaction (the Model picker's arrow keys, a
// first-run theme picker, any future y/n prompt) - both views always occupy
// the same real layout space (see #chat-body in styles.css) so xterm never
// loses its real column width while the chat view is what's showing.
let rawTerminalMode = false;

function setRawTerminalMode(on) {
  rawTerminalMode = on;
  chatMessagesViewEl.classList.toggle("view-hidden", on);
  terminalWrapperEl.classList.toggle("view-hidden", !on);
  rawTerminalToggleBtn.classList.toggle("active", on);
  if (on) {
    requestAnimationFrame(refitActiveTerminal);
    // Confirmed live the same night as the compose-box version of this bug:
    // switching to Raw Terminal moves the *view* but not keyboard focus -
    // xterm needs an explicit term.focus() call, same as clicking directly
    // into its content did. Without this, typing (including Enter) looked
    // like it was going nowhere when it was really just never reaching the
    // terminal at all.
    const session = activeAgentPath && terminals.get(activeAgentPath);
    if (session) session.term.focus();
  } else if (activeAgentPath) {
    rebuildChatView(activeAgentPath);
    // Previously only Reset Session's own handler refocused the compose
    // box after leaving raw mode - toggling this button by hand left focus
    // wherever it was (often still on the now-hidden terminal element),
    // making the textarea look unresponsive to typing until clicked
    // directly. the user hit exactly this - typing "did nothing" until he
    // clicked into the box himself.
    chatInputEl.focus();
  }
}

rawTerminalToggleBtn.addEventListener("click", () => setRawTerminalMode(!rawTerminalMode));

// Claude Code's CLI does not queue input sent while it's still generating a
// response - it silently drops it instead (confirmed directly: sendInput was
// called and reached window.api fine, but the message never appeared in the
// session's own JSONL transcript at all). Track "busy" per session from the
// pty's own output activity - a steady stream of data means it's actively
// responding, and a pause of IDLE_TIMEOUT_MS with nothing new means it's
// back at its prompt. Earlier version of this disabled the compose box
// while busy to prevent that silent loss - the user explicitly wanted to stay
// typeable at all times instead, like a normal chat interface, so a message
// sent while busy is queued (session.sendQueue) and auto-submitted (one at
// a time, in order) the next time the session goes idle, rather than being
// blocked from typing at all.
const IDLE_TIMEOUT_MS = 900;

// Approximated from the session's own JSONL usage data against an ASSUMED
// 200K context window - not a confirmed figure for this specific model,
// just the long-standing typical Claude context size, so treat this as a
// rough indicator, not an exact one. Tooltip always shows the raw numbers
// so the approximation is never silently hidden.
const ASSUMED_CONTEXT_WINDOW = 200000;

async function refreshContextUsage(agentPath) {
  const usage = await window.api.getContextUsage(agentPath);
  if (agentPath !== activeAgentPath) return; // user may have switched agents while this was in flight

  if (usage && typeof usage.contextTokens === "number") {
    const pct = Math.min(100, Math.round((usage.contextTokens / ASSUMED_CONTEXT_WINDOW) * 100));
    contextUsageEl.textContent = `${pct}% context`;
    contextUsageEl.title = `~${usage.contextTokens.toLocaleString()} tokens of an assumed ${ASSUMED_CONTEXT_WINDOW.toLocaleString()}-token context window (approximate - not a confirmed figure for this model). Scoped to just this agent's own conversation - grows as this specific conversation grows, resets on /clear or a fresh session.`;
    contextUsageEl.classList.remove("hidden", "warning", "critical");
    if (pct >= 90) contextUsageEl.classList.add("critical");
    else if (pct >= 70) contextUsageEl.classList.add("warning");
  } else {
    contextUsageEl.classList.add("hidden");
  }
}

// Unofficial, community-sourced estimate for Claude Pro specifically
// (confirmed as the user's plan) - Anthropic does not publish this figure, and
// it's known to vary by message complexity, model, and demand. Treat as a
// rough compass, not a precise reading - see agent-desktop\CLAUDE.md for
// where this number came from. No equivalent estimate is applied to the
// 7-day figure - the real weekly cap is measured in compute-hours, not
// messages, so a percentage there would mix two different units together
// rather than give a meaningful reading.
const PRO_FIVE_HOUR_MESSAGE_ESTIMATE = 45;

async function refreshUsageWindows() {
  const windows = await window.api.getUsageWindows();
  if (!activeAgentPath) {
    fiveHourUsageEl.classList.add("hidden");
    weeklyUsageEl.classList.add("hidden");
    planTokensRemainingEl.classList.add("hidden");
    return;
  }

  // Moved here from refreshContextUsage() the same day the user asked "this
  // buffer, is that the specific agent's buffer?" - it was, and shouldn't
  // have been. The underlying throttle is realistically account-wide
  // (Claude's rate limiting operates per account, not per conversation),
  // so it belongs in the same account-wide scan as the message counts
  // below, not scoped to one agent's own files. planTokenBufferPct
  // compares the current value against the highest value ever observed
  // (the empirical ceiling, not an officially documented one) - "how full
  // is the buffer right now," not a claim about plan-wide budget. Because
  // it refills within minutes of a burst, it reads at-or-near 100% almost
  // all the time by design - the "at rest" state says so directly in the
  // badge text (not just a tooltip), since the user reasonably asked whether a
  // steady 100% meant it was stuck.
  if (typeof windows.planTokenBufferPct === "number") {
    planTokensRemainingEl.textContent =
      windows.planTokenBufferPct >= 99 ? "Buffer: full" : `Buffer: ${windows.planTokenBufferPct}%`;
    planTokensRemainingEl.title =
      `${windows.planTokenBufferRemaining.toLocaleString()} of an observed ceiling of ` +
      `${windows.planTokenBufferCeiling.toLocaleString()} (highest value ever seen across ALL Claude Code ` +
      `sessions on this machine, not an officially documented limit). Account-wide, not scoped to this agent - a ` +
      `burst in a different agent's conversation affects this too. Refills within minutes of a heavy burst, so it ` +
      `reads "full" almost all the time by design - that's expected, not a sign it's stuck. Not your overall plan budget.`;
    planTokensRemainingEl.classList.remove("hidden");
  } else {
    planTokensRemainingEl.classList.add("hidden");
  }

  // Prefer windows.fiveHourConfirmed/sevenDayConfirmed - Anthropic's own
  // reported rate_limits.*.used_percentage, sourced via the statusLine hook
  // ensureRateLimitStatusLine() installs (see main.js and statusline.cjs) -
  // over the message-count heuristic below. Falls back to the heuristic
  // whenever confirmed data isn't available yet: right after this feature's
  // first install (no interactive session has completed a turn yet to
  // populate the cache), on a plan the rate_limits field isn't reported for,
  // or once a window has genuinely reset (statusline.cjs's cache write and
  // archive.js's getConfirmedRateLimits() both treat an elapsed resets_at as
  // "no data," not stale data, since a leftover pre-reset percentage would
  // be actively wrong, not just imprecise).
  if (windows.fiveHourConfirmed) {
    const pct = Math.round(windows.fiveHourConfirmed.usedPct);
    fiveHourUsageEl.textContent = `${pct}% (5h)`;
    fiveHourUsageEl.title =
      `${pct}% of your 5-hour rate limit window used, reported directly by Anthropic (rate_limits.five_hour), ` +
      `not estimated. Resets ${windows.fiveHourConfirmed.resetsAt ? new Date(windows.fiveHourConfirmed.resetsAt * 1000).toLocaleString() : "at an unknown time"}.`;
    fiveHourUsageEl.classList.remove("hidden", "warning", "critical");
    if (pct >= 90) fiveHourUsageEl.classList.add("critical");
    else if (pct >= 70) fiveHourUsageEl.classList.add("warning");
  } else {
    const fivePct = Math.min(100, Math.round((windows.messagesInLast5h / PRO_FIVE_HOUR_MESSAGE_ESTIMATE) * 100));
    fiveHourUsageEl.textContent = `${windows.messagesInLast5h} msgs (~${fivePct}%, 5h)`;
    fiveHourUsageEl.title =
      `${windows.messagesInLast5h} messages sent across ALL Claude Code sessions on this machine in the trailing 5 hours, ` +
      `against an unofficial community estimate of ~${PRO_FIVE_HOUR_MESSAGE_ESTIMATE} messages/5h for Claude Pro. ` +
      `Not published by Anthropic and known to vary by message complexity/model/demand - a rough compass, not a precise reading. ` +
      `This estimate is used because no confirmed rate_limits figure is available yet (no interactive Claude Code ` +
      `session has completed a turn since the statusLine integration was installed, or this account/plan doesn't report it).`;
    fiveHourUsageEl.classList.remove("hidden", "warning", "critical");
    if (fivePct >= 90) fiveHourUsageEl.classList.add("critical");
    else if (fivePct >= 70) fiveHourUsageEl.classList.add("warning");
  }

  const dailyAvg = (windows.messagesInLast7d / 7).toFixed(1);
  if (windows.sevenDayConfirmed) {
    const pct = Math.round(windows.sevenDayConfirmed.usedPct);
    weeklyUsageEl.textContent = `${pct}% (7d)`;
    weeklyUsageEl.title =
      `${pct}% of your weekly rate limit used, reported directly by Anthropic (rate_limits.seven_day), not estimated. ` +
      `Resets ${windows.sevenDayConfirmed.resetsAt ? new Date(windows.sevenDayConfirmed.resetsAt * 1000).toLocaleString() : "at an unknown time"}. ` +
      `For reference, ${windows.messagesInLast7d} messages sent across all sessions on this machine in the trailing 7 days (~${dailyAvg}/day).`;
    weeklyUsageEl.classList.remove("hidden", "warning", "critical");
    if (pct >= 90) weeklyUsageEl.classList.add("critical");
    else if (pct >= 70) weeklyUsageEl.classList.add("warning");
  } else {
    // Deliberately no percentage against Claude's real weekly cap in this
    // fallback path - it's measured in "active compute hours," not messages,
    // and there's no reliable way to convert between the two (see
    // getUsageWindows() in archive.js). A bare count had no context to judge
    // it by though (the user's reasonable follow-up: "I don't have any
    // indication about the 7 day number") - a daily average, computed from
    // the same real count, gives a genuine reference point without
    // inventing a ceiling to compare against.
    weeklyUsageEl.textContent = `${windows.messagesInLast7d} msgs (7d, ~${dailyAvg}/day)`;
    weeklyUsageEl.title =
      `${windows.messagesInLast7d} messages sent across ALL Claude Code sessions on this machine in the trailing 7 days ` +
      `(~${dailyAvg}/day average). No percentage shown against a ceiling - Claude's real weekly cap is measured in ` +
      `"active compute hours," not messages, and there's no reliable way to convert between the two, so a percentage ` +
      `would be a guess dressed up as a number. This fallback is used because no confirmed rate_limits figure is ` +
      `available yet - see the 5h badge's tooltip for why.`;
    weeklyUsageEl.classList.remove("hidden", "warning", "critical");
  }
}

// Some genuinely long waits aren't the agent "thinking" - Claude Code's own
// browser-automation skill, for example, can sit busy for a long time
// waiting on an external action (installing a browser extension, finishing
// a setup flow) while periodically redrawing a status screen, which keeps
// this app's activity-based busy-detection true the whole time. Rather than
// leave that looking identical to "still generating a normal response" and
// confusing, the Send/Queue button's tooltip says more once it's been busy
// a while.
const LONG_BUSY_HINT_MS = 20000;

function setBusy(agentPath, session, busy) {
  if (busy && !session.busy) session.busyStartedAt = Date.now();
  session.busy = busy;
  if (!busy) {
    refreshContextUsage(agentPath);
    refreshUsageWindows();
  }
  if (!busy && session.sendQueue.length > 0) {
    // Dequeue exactly one - sending it will make the session busy again
    // once its own response starts streaming, which naturally serializes
    // the rest of the queue through this same idle-transition path rather
    // than firing them all at once.
    const next = session.sendQueue.shift();
    submitToAgent(agentPath, next);
    renderQueue(agentPath);
  }
  if (agentPath === activeAgentPath) {
    updateComposeAvailability();
    updateThinkingIndicator();
  }
}

// the user asked for visible confirmation something's actually happening during
// a long wait, not just silence until the reply appears - a live seconds
// count. First version anchored this to session.busy/busyStartedAt (the
// same flag that gates the Send/Queue button) and it didn't work: busy is
// deliberately twitchy (IDLE_TIMEOUT_MS = 900ms, tuned for a coarse
// send-vs-queue decision where brief flicker doesn't matter), and a CLI
// spinner that redraws roughly once a second can easily leave gaps longer
// than 900ms between bytes - busy would flicker false/true continuously
// during completely normal thinking, resetting busyStartedAt every flicker
// and making the counter never visibly progress. Tracked separately instead
// via session.turnStartedAt (set once per real user send, in
// submitToAgent()) and session.thinkingQuietTimer (a longer, dedicated
// THINKING_INDICATOR_QUIET_MS silence window, reset on every real byte of
// pty activity in markActivity() below) - deliberately NOT reusing
// IDLE_TIMEOUT_MS, so this fix can't regress the already-proven Send/Queue
// behavior. Still honest about liveness, just on its own clock: if the pty
// genuinely wedges (see the "/compact hung the session" incident this same
// day) or a turn simply finishes, real output stops, the quiet timer
// expires, and the indicator disappears - it does not count forever against
// a process that's stopped producing anything.
const THINKING_INDICATOR_QUIET_MS = 3000;
let thinkingIndicatorInterval = null;
function updateThinkingIndicator() {
  const session = activeAgentPath && terminals.get(activeAgentPath);
  if (!session || !session.turnStartedAt) {
    chatThinkingIndicatorEl.classList.add("hidden");
    return;
  }
  const elapsedMs = Date.now() - session.turnStartedAt;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  chatThinkingIndicatorEl.textContent =
    elapsedMs > LONG_BUSY_HINT_MS
      ? `● Thinking… ${elapsedSec}s (taking a while - still receiving output, so it's alive; check Raw Terminal if you want to see it directly)`
      : `● Thinking… ${elapsedSec}s`;
  chatThinkingIndicatorEl.classList.remove("hidden");
  chatThinkingIndicatorEl.classList.toggle("long", elapsedMs > LONG_BUSY_HINT_MS);
}
if (!thinkingIndicatorInterval) thinkingIndicatorInterval = setInterval(updateThinkingIndicator, 1000);

function markActivity(agentPath, session) {
  setBusy(agentPath, session, true);
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => setBusy(agentPath, session, false), IDLE_TIMEOUT_MS);

  clearTimeout(session.thinkingQuietTimer);
  session.thinkingQuietTimer = setTimeout(() => {
    session.turnStartedAt = null;
    if (agentPath === activeAgentPath) updateThinkingIndicator();
  }, THINKING_INDICATOR_QUIET_MS);
}

function renderQueue(agentPath) {
  const session = terminals.get(agentPath);
  if (!session || agentPath !== activeAgentPath) return;
  chatQueueEl.innerHTML = "";
  chatQueueEl.classList.toggle("hidden", session.sendQueue.length === 0);
  session.sendQueue.forEach((text, index) => {
    const item = document.createElement("div");
    item.className = "queue-item";

    const icon = document.createElement("div");
    icon.className = "queue-item-icon";
    item.appendChild(icon);

    const textEl = document.createElement("div");
    textEl.className = "queue-item-text";
    textEl.textContent = text;
    textEl.title = text;
    item.appendChild(textEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "queue-item-remove-btn";
    removeBtn.title = "Remove from queue";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      session.sendQueue.splice(index, 1);
      renderQueue(agentPath);
    });
    item.appendChild(removeBtn);

    chatQueueEl.appendChild(item);
  });
}

function updateComposeAvailability() {
  const session = activeAgentPath && terminals.get(activeAgentPath);
  const busy = !!(session && session.busy);
  sendInputBtn.textContent = busy ? "Queue" : "Send";
  const longBusy = busy && session.busyStartedAt && Date.now() - session.busyStartedAt > LONG_BUSY_HINT_MS;
  sendInputBtn.title = !busy
    ? "Send"
    : longBusy
    ? "Still busy a while - this may be waiting on something outside the chat (e.g. a browser step) rather than generating a response. Queued and will send once it's free."
    : "Agent is still responding - this will be queued and sent automatically";
}

window.api.onTerminalData(({ agentPath, data }) => {
  const session = terminals.get(agentPath);
  if (!session) return;
  session.term.write(data);
  markActivity(agentPath, session);
  scheduleRebuildChatView(agentPath);
});

window.api.onTerminalExit(({ agentPath }) => {
  const session = terminals.get(agentPath);
  if (session) {
    session.term.write("\r\n\r\n[session ended]\r\n");
    session.started = false;
  }
  // Caught live the same day as the pty-crash fix in main.js: this "[session
  // ended]" text only ever wrote into the raw xterm buffer, which the Chat
  // View stopped reading entirely once it switched to tailing the JSONL
  // transcript. Result: if the underlying process actually died, the normal
  // Chat View looked identical to a merely-quiet one - no visible signal at
  // all unless the user happened to be looking at Raw Terminal. A dead process
  // and a slow one are different problems needing different responses (wait
  // vs. restart), so this needs to be unmistakable in the view he actually
  // uses.
  if (agentPath === activeAgentPath) {
    const notice = document.createElement("div");
    notice.className = "chat-session-ended-notice";
    notice.textContent = "⚠ This agent's session process has ended. Select a different agent and back, or restart Agent Desktop, to start a fresh one.";
    chatMessagesViewEl.appendChild(notice);
    chatMessagesViewEl.scrollTop = chatMessagesViewEl.scrollHeight;
  }
});

// ---------------------------------------------------------- new agent modal --

// Shared modal for both create and edit - editingAgentPath tracks which
// mode is active (null = creating a new agent, otherwise the path of the
// agent being edited). Editing never renames the underlying folder (see
// agents.js updateAgent() for why) - only display_name/role/avatar change.
let editingAgentPath = null;
const agentModalTitleEl = document.getElementById("agent-modal-title");
const createAgentBtn = document.getElementById("create-agent-btn");

function openCreateAgentModal() {
  editingAgentPath = null;
  agentModalTitleEl.textContent = "Create New Agent";
  createAgentBtn.textContent = "Create Agent";
  nameInput.value = "";
  roleInput.value = "";
  avatarPreview.src = "";
  avatarPreview.style.display = "none";
  selectedAvatarPath = null;
  modalEl.classList.remove("hidden");
  nameInput.focus();
}

function openEditAgentModal(agent) {
  editingAgentPath = agent.path;
  agentModalTitleEl.textContent = "Edit Agent";
  createAgentBtn.textContent = "Save Changes";
  nameInput.value = agent.displayName;
  roleInput.value = agent.role || "";
  selectedAvatarPath = null; // only replaces the avatar if a new one is picked below
  if (agent.avatar) {
    avatarPreview.src = agent.avatar;
    avatarPreview.style.display = "block";
  } else {
    avatarPreview.src = "";
    avatarPreview.style.display = "none";
  }
  modalEl.classList.remove("hidden");
  nameInput.focus();
}

document.getElementById("new-agent-btn").addEventListener("click", openCreateAgentModal);

document.getElementById("cancel-agent-btn").addEventListener("click", () => {
  modalEl.classList.add("hidden");
});

document.getElementById("pick-avatar-btn").addEventListener("click", async () => {
  const result = await window.api.pickAvatar();
  if (result) {
    selectedAvatarPath = result.path;
    avatarPreview.src = result.dataUrl;
    avatarPreview.style.display = "block";
  }
});

createAgentBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  try {
    if (editingAgentPath) {
      await window.api.updateAgent({
        agentPath: editingAgentPath,
        name,
        role: roleInput.value.trim(),
        avatarPath: selectedAvatarPath,
      });
    } else {
      await window.api.createAgent({
        name,
        role: roleInput.value.trim(),
        avatarPath: selectedAvatarPath,
      });
    }
    modalEl.classList.add("hidden");
    const wasEditingActive = editingAgentPath && editingAgentPath === activeAgentPath;
    await loadAgents();
    if (wasEditingActive) {
      // The chat header (name/avatar shown for the currently-open agent)
      // isn't rebuilt by loadAgents() on its own - refresh it directly so
      // an edit to the active agent shows immediately, not just in the sidebar.
      const updated = agents.find((a) => a.path === activeAgentPath);
      if (updated) {
        chatNameEl.textContent = updated.displayName;
        setChatRoleText(chatRoleEl, updated.role);
        chatAvatarSlotEl.innerHTML = "";
        chatAvatarSlotEl.appendChild(renderAvatarEl(updated));
      }
    }
  } catch (e) {
    alert(`Could not ${editingAgentPath ? "update" : "create"} agent: ` + e.message);
  }
});

// ------------------------------------------------------- delete agent --

const deleteAgentModalEl = document.getElementById("delete-agent-modal");
const deleteAgentWarningEl = document.getElementById("delete-agent-warning");
const deleteAgentConfirmInputEl = document.getElementById("delete-agent-confirm-input");
const confirmDeleteAgentBtn = document.getElementById("confirm-delete-agent-btn");
let deletingAgent = null;

// A `claude --bg` dispatch also spawns a separate, longer-lived "daemon"
// helper process that can keep its own handle on the agent's folder for a
// while after the agent session itself has been stopped - confirmed
// directly, live: deleting right after actually using an agent could hit
// "EBUSY: resource busy or locked" even with main.js's own retry logic
// already widened to ~11s. Rather than keep guessing at exact timings
// server-side, this makes the wait visible and unconditional instead -
// simpler and more honest than a silent background retry that might still
// occasionally surface a scary error. 30s is a starting estimate, not a
// measured minimum - bump it if it still proves too short in practice.
const DELETE_AGENT_COUNTDOWN_SECONDS = 30;
let deleteAgentCountdownTimer = null;
let deleteAgentCountdownRemaining = 0;

function updateDeleteAgentButtonState() {
  if (deleteAgentCountdownRemaining > 0) {
    confirmDeleteAgentBtn.disabled = true;
    confirmDeleteAgentBtn.textContent = `Delete permanently (${deleteAgentCountdownRemaining}s)`;
    return;
  }
  confirmDeleteAgentBtn.textContent = "Delete permanently";
  confirmDeleteAgentBtn.disabled = !deletingAgent || deleteAgentConfirmInputEl.value.trim() !== deletingAgent.displayName;
}

function openDeleteAgentModal(agent) {
  deletingAgent = agent;
  deleteAgentWarningEl.textContent =
    `This permanently deletes "${agent.displayName}" and its entire conversation history/archive. This cannot be undone.`;
  deleteAgentConfirmInputEl.value = "";
  deleteAgentModalEl.classList.remove("hidden");
  deleteAgentConfirmInputEl.focus();

  clearInterval(deleteAgentCountdownTimer);
  deleteAgentCountdownRemaining = DELETE_AGENT_COUNTDOWN_SECONDS;
  updateDeleteAgentButtonState();
  deleteAgentCountdownTimer = setInterval(() => {
    deleteAgentCountdownRemaining -= 1;
    if (deleteAgentCountdownRemaining <= 0) clearInterval(deleteAgentCountdownTimer);
    updateDeleteAgentButtonState();
  }, 1000);
}

document.getElementById("cancel-delete-agent-btn").addEventListener("click", () => {
  clearInterval(deleteAgentCountdownTimer);
  deleteAgentModalEl.classList.add("hidden");
  deletingAgent = null;
});

// Exact-match, case-sensitive - deliberate extra friction for a genuinely
// irreversible action, not just a click-through confirm dialog.
deleteAgentConfirmInputEl.addEventListener("input", updateDeleteAgentButtonState);

confirmDeleteAgentBtn.addEventListener("click", async () => {
  if (!deletingAgent) return;
  const agentPath = deletingAgent.path;
  try {
    await window.api.deleteAgent(agentPath);
    deleteAgentModalEl.classList.add("hidden");
    deletingAgent = null;
    if (activeAgentPath === agentPath) {
      // The active session's terminal object now points at a deleted
      // folder - drop it entirely rather than leaving a dangling reference
      // that could still try to write/resize against a gone directory.
      terminals.delete(agentPath);
      activeAgentPath = null;
      chatViewEl.classList.add("hidden");
      emptyStateEl.classList.remove("hidden");
    }
    await loadAgents();
  } catch (e) {
    alert("Could not delete agent: " + e.message);
  }
});

// ------------------------------------------------------------- chat input --

const CHAT_INPUT_DEFAULT_HEIGHT = 56;
const CHAT_INPUT_MIN_HEIGHT = 44;

function setChatInputHeight(px) {
  const maxHeight = window.innerHeight * 0.7;
  const clamped = Math.max(CHAT_INPUT_MIN_HEIGHT, Math.min(px, maxHeight));
  chatInputEl.style.height = clamped + "px";
  // The terminal only redraws its canvas when explicitly told to - without
  // this, resizing the input box leaves the terminal's old, larger canvas
  // sitting there and getting visually covered rather than shrinking to fit.
  refitActiveTerminal();
}

// ---------------------------------------------------------- attachments --

// Dropped or pasted images/files show up as small removable thumbnail chips
// above the textarea, matching how a normal chat interface previews an
// attachment before send, rather than sitting in the textarea as raw quoted
// path text. Not scoped per-agent (same as chatInputEl's own text, which
// already isn't cleared on agent switch) - one compose box, one draft.
let pendingAttachments = []; // { path, previewUrl }

function mimeToExt(mime) {
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
  return map[mime] || "png";
}

function renderAttachments() {
  chatAttachmentsEl.innerHTML = "";
  chatAttachmentsEl.classList.toggle("hidden", pendingAttachments.length === 0);
  // The attachment row appearing/disappearing changes #chat-input-bar's
  // height, and the terminal never re-measures itself on its own when a
  // neighboring element resizes (same lesson as the chat-input resize
  // handle above) - without this, the terminal keeps rendering at its old,
  // taller row count and its own native status line ends up overlapping
  // this app's UI instead of staying safely behind #terminal-bottom-mask.
  // Deferred a frame, same reason showTerminalFor() defers its own fit()
  // call - calling fit() synchronously right after toggling the class can
  // still measure the pre-toggle layout, since the browser hasn't
  // necessarily applied it yet at that exact point in the script.
  requestAnimationFrame(refitActiveTerminal);
  pendingAttachments.forEach((att, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    if (att.previewUrl) {
      const img = document.createElement("img");
      img.src = att.previewUrl;
      chip.appendChild(img);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "attachment-name-fallback";
      fallback.textContent = att.path.split(/[\\/]/).pop();
      chip.appendChild(fallback);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "attachment-remove-btn";
    removeBtn.title = "Remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeAttachmentAt(index));
    chip.appendChild(removeBtn);

    chatAttachmentsEl.appendChild(chip);
  });
}

function addAttachment(filePath, previewUrl) {
  pendingAttachments.push({ path: filePath, previewUrl });
  renderAttachments();
  chatInputEl.focus();
}

function removeAttachmentAt(index) {
  const [removed] = pendingAttachments.splice(index, 1);
  if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderAttachments();
}

function clearAttachments() {
  for (const att of pendingAttachments) {
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
  }
  pendingAttachments = [];
  renderAttachments();
}

// Sending a whole composed message plus its trailing "\r" as ONE fast,
// synchronous write gets misread by Claude Code's CLI as a paste rather than
// typed text followed by a real Enter keystroke - confirmed directly against
// the session's own JSONL transcript, where a failed submission showed up as
// a single message with a literal "\r" embedded in the middle of it instead
// of actually submitting. Splitting the Enter into its own separately-timed
// write, a beat after the text, mimics a human pasting then pressing Enter
// and reliably triggers real submission instead of being swallowed as more
// pasted content.
//
// Also renders the message immediately (optimistically, before the pty has
// echoed anything back) and marks the session busy right away, rather than
// waiting for the CLI's own echo + a debounced rebuild to surface it - that
// round trip can take several real seconds, which otherwise looks exactly
// like a blank, possibly-stuck screen with no feedback at all.
function submitToAgent(agentPath, text) {
  const session = terminals.get(agentPath);
  if (session) {
    session.pendingSent.push({ text, addedAt: Date.now() });
    session.turnStartedAt = Date.now();
    markActivity(agentPath, session);
    if (agentPath === activeAgentPath) {
      // session.lastBlocks (cached by the last successful rebuildChatView())
      // rather than fetching fresh here - this needs to render synchronously,
      // instantly, at the moment Send is clicked, not after another IPC
      // round-trip. A real rebuild is already scheduled by markActivity()
      // above once the pty actually reacts, so this is just the immediate,
      // optimistic frame - it's fine if it's using a render that's a beat old.
      renderChatBlocks(session.lastBlocks || [], session.pendingSent);
      updateThinkingIndicator();
    }
  }
  window.api.sendInput(agentPath, text);
  setTimeout(() => window.api.sendInput(agentPath, "\r"), 80);
}

function sendChatInput() {
  const text = chatInputEl.value;
  const attachmentText = pendingAttachments.map((a) => `"${a.path}"`).join(" ");
  const combined = [attachmentText, text].filter(Boolean).join(" ");
  if (!combined.trim() || !activeAgentPath) return;

  const session = terminals.get(activeAgentPath);
  if (session && session.busy) {
    // Stay typeable at all times rather than blocking on a busy session -
    // queue it instead, setBusy() sends it automatically once the agent's
    // actually free (see the busy-tracking section above).
    session.sendQueue.push(combined);
    renderQueue(activeAgentPath);
  } else {
    submitToAgent(activeAgentPath, combined);
  }

  chatInputEl.value = "";
  clearAttachments();
  setChatInputHeight(CHAT_INPUT_DEFAULT_HEIGHT);
  chatInputEl.focus();
  // xterm.js does NOT auto-follow new output once the user has scrolled up -
  // it stays right where they left it. Without this, sending a message while
  // reading earlier history looks exactly like nothing happened: the reply
  // arrives for real (confirmed via the session's own JSONL transcript) but
  // silently lands below the visible viewport. Jump to the bottom on send,
  // the same "you did something, here's the result" moment any chat UI does.
  if (session) session.term.scrollToBottom();
}

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatInput();
  }
});

sendInputBtn.addEventListener("click", sendChatInput);

// Hold-to-talk drives Claude Code's own native /voice mode (Anthropic
// shipped this directly in the CLI - see "type /voice, then hold spacebar"
// in its docs) rather than a custom speech-to-text pipeline. This button
// exists only to make that gesture reachable without a physical keyboard
// (mobile is the main reason - typing is painful there), not to reimplement
// speech recognition.
//
// Diagnosed live, 2026-08-21: the first version of this sent "/voice"
// through submitToAgent(), the same path the Model-picker button uses for
// its own slash command - but that path always follows with an automatic
// \r (Enter), and confirmed live, that's wrong specifically for /voice: it
// showed up as a normal SENT CHAT MESSAGE (a yellow user bubble reading
// "/voice"), not as the CLI entering voice mode. /voice has to stay
// sitting UNCOMMITTED in the prompt line - the held spacebar that follows
// is what actually triggers it, not a completed line. So /voice itself is
// now written directly via window.api.sendInput with no trailing \r, same
// as the held-spacebar simulation that follows it - both bypass
// submitToAgent() entirely for this one gesture. The held spacebar itself
// is a raw terminal input concept with no equivalent in this app's normal
// compose-a-line-and-hit-Enter flow, so it's simulated by writing literal
// space bytes straight to the pty at roughly a physical keyboard's OS
// auto-repeat rate, for as long as the button stays held - matching what a
// real held key actually produces on the wire, character by character,
// rather than one line sent all at once.
const voiceInputBtn = document.getElementById("voice-input-btn");
const VOICE_HOLD_REPEAT_MS = 40;
// Give the CLI a moment to actually enter voice mode before the simulated
// held spacebar starts, rather than racing the two - matches the
// documented usage (type /voice, THEN hold spacebar) instead of sending
// both at once.
const VOICE_MODE_ARM_DELAY_MS = 300;
let voiceHeld = false;
let voiceHoldInterval = null;

function startVoiceHold() {
  if (!activeAgentPath || voiceHeld) return;
  voiceHeld = true;
  voiceInputBtn.classList.add("recording");
  // No trailing \r on purpose - see the comment above. Submitting /voice
  // as a complete line (Enter) sends it as a literal chat message instead
  // of arming voice mode.
  window.api.sendInput(activeAgentPath, "/voice");
  setTimeout(() => {
    if (!voiceHeld) return; // released again before /voice had time to register
    voiceHoldInterval = setInterval(() => {
      window.api.sendInput(activeAgentPath, " ");
    }, VOICE_HOLD_REPEAT_MS);
  }, VOICE_MODE_ARM_DELAY_MS);
}

function stopVoiceHold() {
  voiceHeld = false;
  voiceInputBtn.classList.remove("recording");
  if (voiceHoldInterval) {
    clearInterval(voiceHoldInterval);
    voiceHoldInterval = null;
  }
}

voiceInputBtn.addEventListener("mousedown", startVoiceHold);
voiceInputBtn.addEventListener("mouseup", stopVoiceHold);
// Dragging off the button without releasing the mouse button first (a real,
// common gesture) must still stop the hold - otherwise it silently keeps
// "talking" into the session with no visible way to stop it short of
// clicking the button again, which mouseup alone doesn't catch.
voiceInputBtn.addEventListener("mouseleave", stopVoiceHold);

// Pure visual reminder/shortcut - just prefills the compose box, doesn't
// send anything itself. Prepends rather than overwrites so it still works
// if the user already started typing what to save before remembering to
// press it. The current agent is the one that actually acts on this text -
// per the root CLAUDE.md, that means appending a dated note to
// LensVid_Master_Context\pending_updates.md, not editing the master file
// directly - the LensVid Business Context Agent is the only one that
// integrates pending updates into the real file (2026-08-20).
const SAVE_TO_MASTER_PREFIX = "Save to master file: ";
saveToMasterBtn.addEventListener("click", () => {
  const existing = chatInputEl.value;
  chatInputEl.value = existing.startsWith(SAVE_TO_MASTER_PREFIX)
    ? existing
    : SAVE_TO_MASTER_PREFIX + existing;
  chatInputEl.focus();
  const end = chatInputEl.value.length;
  chatInputEl.setSelectionRange(end, end);
});

// Drag-to-resize: grabbing the handle and moving the mouse up/down grows or
// shrinks the box from its TOP edge (the box is anchored to the bottom of the
// window, so "pulling up" is what should make it taller - native CSS resize
// only ever grows toward the bottom-right, which is why it isn't used here).
let dragStartY = null;
let dragStartHeight = null;

resizeHandleEl.addEventListener("mousedown", (e) => {
  dragStartY = e.clientY;
  dragStartHeight = chatInputEl.getBoundingClientRect().height;
  resizeHandleEl.classList.add("dragging");
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (dragStartY === null) return;
  const delta = dragStartY - e.clientY; // moving up (smaller clientY) increases height
  setChatInputHeight(dragStartHeight + delta);
});

window.addEventListener("mouseup", () => {
  if (dragStartY === null) return;
  dragStartY = null;
  dragStartHeight = null;
  resizeHandleEl.classList.remove("dragging");
});

// ---------------------------------------------------- drag-and-drop files --

// Chromium's default behavior for a drop it doesn't otherwise handle is to
// NAVIGATE THE WHOLE PAGE to the dropped file, as if opening it directly -
// silently replacing this entire app's UI. Binding drag/drop listeners only
// to the compose box (an earlier version of this code did that) means a drop
// landing even slightly outside that narrow strip hits this default behavior
// unimpeded and breaks the app until it's restarted - confirmed to actually
// happen. Every drag/drop event is therefore handled on the whole `document`
// instead, both to guarantee preventDefault() always runs (the safety net)
// and to make the drop zone the entire window rather than a thin bar at the
// bottom (much easier to hit). The compose box is a plain textarea feeding
// text keystrokes into the pty - there's no binary image channel over a
// terminal connection, so a dropped file becomes a removable thumbnail chip
// (or a filename fallback for non-images) rather than raw text - Claude Code
// itself reads the actual file content via its own Read tool once the
// message is sent, using the real path carried alongside the chip, exactly
// as if the user had typed the path himself.
let dragDepth = 0;

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  chatInputBarEl.classList.add("drag-over");
});

// preventDefault is required on dragover too, or the browser's default
// "reject the drop" behavior wins and the drop event never fires.
document.addEventListener("dragover", (e) => e.preventDefault());

document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) chatInputBarEl.classList.remove("drag-over");
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  chatInputBarEl.classList.remove("drag-over");

  const files = Array.from(e.dataTransfer.files || []);
  for (const file of files) {
    const filePath = window.api.getPathForFile(file);
    if (!filePath) continue;
    const previewUrl = file.type && file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    addAttachment(filePath, previewUrl);
  }
});

// A pasted clipboard image (Ctrl+V of a copied screenshot, for example) has
// no filesystem path at all - unlike a dropped file, it only exists as raw
// bytes in the clipboard. Only intercept when the clipboard actually
// contains image data; plain-text paste is left completely alone so it
// still lands in the textarea normally.
document.addEventListener("paste", async (e) => {
  const items = Array.from(e.clipboardData ? e.clipboardData.items : []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();

  const blob = imageItem.getAsFile();
  const previewUrl = URL.createObjectURL(blob);
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(",")[1];
    const savedPath = await window.api.savePastedImage(base64, mimeToExt(imageItem.type));
    addAttachment(savedPath, previewUrl);
  };
  reader.readAsDataURL(blob);
});

// -------------------------------------------------------------- history --

const HISTORY_DAYS_PAGE_SIZE = 7;
let historyDaysShown = HISTORY_DAYS_PAGE_SIZE;

function setHistoryMode(on) {
  historyToggleBtn.classList.toggle("active", on);
  historyViewEl.classList.toggle("hidden", !on);
  chatBodyEl.classList.toggle("hidden", on);
  chatInputBarEl.classList.toggle("hidden", on);
  if (on) {
    historyDaysShown = HISTORY_DAYS_PAGE_SIZE;
    loadHistoryDays();
  } else {
    // Coming back to the live chat may mean the panel changed size while
    // history was showing instead of it - keep the terminal's own canvas in
    // sync (only matters if raw mode is what's actually visible - refitting
    // a visibility:hidden terminal is harmless either way, just a no-op
    // it'll redo next time it's actually shown).
    requestAnimationFrame(refitActiveTerminal);
    if (activeAgentPath) rebuildChatView(activeAgentPath);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderEntryBodyHtml(bodyLines) {
  const htmlParts = [];
  let paragraphBuffer = [];
  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    htmlParts.push(`<p>${escapeHtml(paragraphBuffer.join("\n"))}</p>`);
    paragraphBuffer = [];
  }
  for (const line of bodyLines) {
    if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraphBuffer.push(line);
    }
  }
  flushParagraph();
  return htmlParts.join("\n");
}

// Renders the specific, simple markdown shape archive.js generates
// (# heading, ### subheadings, blank-line-separated paragraphs) - not a
// general-purpose parser. Escapes everything first since this is displaying
// arbitrary conversation text, not trusted markup. Entries are shown most
// recent first (reversed from the underlying file's natural chronological
// order) so the latest exchange is visible immediately without scrolling
// all the way down - the saved .md file on disk stays chronological (an
// agent reading its own history later benefits from that order), this only
// changes how the History tab displays it.
function renderHistoryMarkdown(md) {
  const lines = md.split("\n");
  let title = "";
  const entries = []; // { heading, bodyLines: [] }
  let current = null;

  for (const line of lines) {
    if (line.startsWith("### ")) {
      current = { heading: line.slice(4), bodyLines: [] };
      entries.push(current);
    } else if (line.startsWith("# ")) {
      title = line.slice(2);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }

  const htmlParts = [];
  if (title) htmlParts.push(`<h1>${escapeHtml(title)}</h1>`);
  for (const entry of entries.slice().reverse()) {
    htmlParts.push(`<h3>${escapeHtml(entry.heading)}</h3>`);
    htmlParts.push(renderEntryBodyHtml(entry.bodyLines));
  }
  return htmlParts.join("\n");
}

async function loadHistoryDays() {
  if (!activeAgentPath) return;
  const days = await window.api.listArchivedDays(activeAgentPath);

  if (days.length === 0) {
    historyDayListEl.innerHTML = "";
    historyContentEl.innerHTML =
      '<div id="history-empty">No conversation history yet for this agent.</div>';
    return;
  }

  const visibleDays = days.slice(0, historyDaysShown);
  historyDayListEl.innerHTML = "";
  for (const dateKey of visibleDays) {
    const item = document.createElement("div");
    item.className = "history-day-item";
    item.textContent = dateKey;
    item.addEventListener("click", () => loadHistoryDay(dateKey));
    historyDayListEl.appendChild(item);
  }
  if (days.length > historyDaysShown) {
    const showMoreBtn = document.createElement("button");
    showMoreBtn.id = "history-show-more-btn";
    showMoreBtn.textContent = `Show more (${days.length - historyDaysShown} older)`;
    showMoreBtn.addEventListener("click", () => {
      historyDaysShown += HISTORY_DAYS_PAGE_SIZE;
      loadHistoryDays();
    });
    historyDayListEl.appendChild(showMoreBtn);
  }

  loadHistoryDay(visibleDays[0]);
}

async function loadHistoryDay(dateKey) {
  if (!activeAgentPath) return;
  document.querySelectorAll(".history-day-item").forEach((el) => {
    el.classList.toggle("active", el.textContent === dateKey);
  });
  const content = await window.api.readArchivedDay(activeAgentPath, dateKey);
  historyContentEl.innerHTML = content
    ? renderHistoryMarkdown(content)
    : '<div id="history-empty">Could not load this day.</div>';
}

historyToggleBtn.addEventListener("click", () => {
  setHistoryMode(historyViewEl.classList.contains("hidden"));
});

// ---------------------------------------------------------- model picker --

// Claude Code's own CLI already has an interactive model picker (with
// descriptions of what each model is good for) behind the `/model` slash
// command - rather than Agent Desktop maintaining its own list of models/
// costs/speeds (which would drift out of date), this button just types that
// command into the session for you and hands focus to the terminal so the
// arrow-key picker it opens works immediately, without you ever typing
// anything yourself.
modelPickerBtn.addEventListener("click", () => {
  if (!activeAgentPath) return;
  if (!historyViewEl.classList.contains("hidden")) {
    setHistoryMode(false);
  }
  // The picker needs real arrow-key/number keystrokes, which only the raw
  // terminal can provide - the chat view has no concept of an interactive
  // in-place selector.
  setRawTerminalMode(true);
  submitToAgent(activeAgentPath, "/model");
  const session = terminals.get(activeAgentPath);
  if (session) {
    session.term.scrollToBottom();
    requestAnimationFrame(() => session.term.focus());
  }
});

// ---------------------------------------------------------- reset session --

// Sends Claude Code's own "/clear" command, which wipes the session's
// current conversation context and starts fresh - the same underlying
// mechanism as typing it directly, just one click. Confirmed first since
// it's a real loss of live context (unlike closing/reopening the app,
// which keeps it via --continue); the full conversation stays permanently
// available in History regardless; it's already built from the saved JSONL
// transcript, not from live session state. Briefly touches Raw Terminal in
// case "/clear" ever asks for a y/n confirmation, but - confirmed live,
// "/clear" is actually instant with no confirmation step, unlike the Model
// picker's genuinely ongoing arrow-key interaction - hands focus back to
// the compose box shortly after rather than leaving it stuck on the
// terminal (that stuck focus is exactly what made the user unable to type
// right after using this the first time).
const RESET_SESSION_HANDOFF_MS = 600;

resetSessionBtn.addEventListener("click", () => {
  if (!activeAgentPath) return;
  const confirmed = confirm(
    "Reset this session? This clears the agent's current conversation context and starts fresh. The full conversation stays available in History either way."
  );
  if (!confirmed) return;
  const agentPath = activeAgentPath;
  if (!historyViewEl.classList.contains("hidden")) {
    setHistoryMode(false);
  }
  setRawTerminalMode(true);
  submitToAgent(agentPath, "/clear");
  const session = terminals.get(agentPath);
  if (session) {
    session.term.scrollToBottom();
    // A deliberate /clear is the one case where the Chat View SHOULD go
    // blank - without this, rebuildChatView()'s guard against accidental
    // blanking (see its own comment) would fight this intentional reset and
    // keep showing the pre-clear conversation.
    session.hasShownRealContent = false;
  }
  setTimeout(() => {
    if (activeAgentPath !== agentPath) return; // switched agents in the meantime - leave it alone
    setRawTerminalMode(false);
    chatInputEl.focus();
  }, RESET_SESSION_HANDOFF_MS);
});

loadAgents();

window.api.getAppVersion().then((v) => {
  document.getElementById("app-version").textContent = `Agent Desktop v${v}`;
});

// --------------------------------------------------- Claude Code updates --
//
// Checked once on startup, not polled repeatedly - a stale "update
// available" state for the rest of a running session is a fine tradeoff
// against hitting the npm registry on some recurring timer, especially
// since this app already gets fully relaunched often anyway (no
// auto-reload for its own code changes either). Only shown at all when an
// update is genuinely available - stays hidden entirely otherwise.
const updateAvailableBtn = document.getElementById("update-available-btn");

async function checkForClaudeCodeUpdate() {
  const { current, latest, updateAvailable } = await window.api.checkClaudeCodeUpdate();
  if (!updateAvailable) return;
  updateAvailableBtn.textContent = `Update available: Claude Code ${current || "?"} → ${latest}`;
  updateAvailableBtn.title = "Click to update the Claude Code CLI this app dispatches agents through (npm install -g @anthropic-ai/claude-code@latest)";
  updateAvailableBtn.classList.remove("hidden");
}

updateAvailableBtn.addEventListener("click", async () => {
  updateAvailableBtn.disabled = true;
  updateAvailableBtn.textContent = "Updating Claude Code...";
  try {
    const { current } = await window.api.updateClaudeCode();
    updateAvailableBtn.textContent = `Updated to Claude Code ${current || "latest"}`;
    setTimeout(() => updateAvailableBtn.classList.add("hidden"), 4000);
  } catch (e) {
    updateAvailableBtn.disabled = false;
    updateAvailableBtn.textContent = "Update failed - click to retry";
    updateAvailableBtn.title = e.message;
  }
});

checkForClaudeCodeUpdate();

// -------------------------------------- known-interfering-software check --
//
// See KNOWN_INTERFERING_SERVICES in main.js for the full diagnosis story -
// this is the UI half: a real warning (not the neutral update-nudge look
// above) since the whole point is that this failure mode looks completely
// unrelated (a confusing "File not found"/"not recognized" error from the
// claude CLI itself) unless you already know to suspect it. textContent
// throughout, not innerHTML - the service label/explanation ultimately
// comes from this app's own source (KNOWN_INTERFERING_SERVICES), not user
// input, but there's no reason to open an injection surface for it anyway.
const interferingServiceWarningEl = document.getElementById("interfering-service-warning");

async function checkForInterferingServices() {
  let services;
  try {
    services = await window.api.checkInterferingServices();
  } catch (e) {
    return; // best-effort - never block the app opening over this check itself failing
  }
  if (!services || !services.length) return;

  interferingServiceWarningEl.innerHTML = "";
  for (const svc of services) {
    const title = document.createElement("div");
    title.className = "warning-title";
    title.textContent = "⚠ " + svc.label + " may cause failures";
    interferingServiceWarningEl.appendChild(title);

    const body = document.createElement("div");
    body.className = "warning-body";
    body.textContent = svc.explanation;
    interferingServiceWarningEl.appendChild(body);

    const fixBtn = document.createElement("button");
    fixBtn.textContent = "Disable it (asks for admin permission)";
    fixBtn.addEventListener("click", async () => {
      fixBtn.disabled = true;
      fixBtn.textContent = "Disabling (approve the Windows prompt)...";
      try {
        const result = await window.api.disableInterferingService(svc.matchedServiceName);
        if (result.ok) {
          fixBtn.textContent = "Disabled - restart Agent Desktop to confirm";
        } else {
          fixBtn.disabled = false;
          fixBtn.textContent = "Failed - click to retry";
          fixBtn.title = result.error || "";
        }
      } catch (e) {
        fixBtn.disabled = false;
        fixBtn.textContent = "Failed - click to retry";
        fixBtn.title = e.message;
      }
    });
    interferingServiceWarningEl.appendChild(fixBtn);
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "dismiss-btn";
  dismissBtn.textContent = "Dismiss for now";
  dismissBtn.addEventListener("click", () => interferingServiceWarningEl.classList.add("hidden"));
  interferingServiceWarningEl.appendChild(dismissBtn);

  interferingServiceWarningEl.classList.remove("hidden");
}

checkForInterferingServices();

// Startup health check for "the 2 sec problem" (see CLAUDE.md's own
// top-of-file section by that name) and anything else that would keep the
// `claude` CLI from actually launching - added 2026-08-23 after that exact
// failure cost a multi-hour live debugging session before being pinned
// down, precisely because nothing surfaced it until an agent was already
// being used. This runs a real `claude --version` at startup (main.js's
// checkClaudeExecutableHealth()) rather than just checking that a file
// exists, since a file existing was never the reliable signal here.
const claudeCliWarningEl = document.getElementById("claude-cli-warning");

function claudeCliWarningMessage(result) {
  if (result.viaSymlink) {
    return (
      "The resolved claude.cmd is a symlink into Claude Desktop's own package storage, and it isn't " +
      "responding right now - this is exactly \"the 2 sec problem\" (see CLAUDE.md or the README's " +
      "troubleshooting section). Run this in PowerShell to confirm: " +
      "Get-Item \"$env:APPDATA\\npm\\claude.cmd\" | Select-Object LinkType, Target"
    );
  }
  if (result.reason === "missing" || result.reason === "not-resolved") {
    return (
      "Couldn't find the Claude Code CLI" + (result.detail ? ` (looked for it at: ${result.detail})` : "") +
      ". Make sure Claude Code is installed and you've signed in at least once, then restart Agent Desktop."
    );
  }
  return (
    "Claude Code CLI was found but didn't respond to a test launch" +
    (result.detail ? ` (${result.detail})` : "") +
    ". This may be transient - try Retry below, or check the README's troubleshooting section if it keeps happening."
  );
}

async function checkClaudeCliHealth() {
  let result;
  try {
    result = await window.api.checkClaudeExecutableHealth();
  } catch (e) {
    return; // best-effort - never block the app opening over this check itself failing
  }
  if (!result || result.healthy) {
    claudeCliWarningEl.classList.add("hidden");
    return;
  }

  claudeCliWarningEl.innerHTML = "";

  const title = document.createElement("div");
  title.className = "warning-title";
  title.textContent = "⚠ Claude Code CLI isn't launching";
  claudeCliWarningEl.appendChild(title);

  const body = document.createElement("div");
  body.className = "warning-body";
  body.textContent = claudeCliWarningMessage(result);
  claudeCliWarningEl.appendChild(body);

  const retryBtn = document.createElement("button");
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = "Checking...";
    await checkClaudeCliHealth();
  });
  claudeCliWarningEl.appendChild(retryBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "dismiss-btn";
  dismissBtn.textContent = "Dismiss for now";
  dismissBtn.addEventListener("click", () => claudeCliWarningEl.classList.add("hidden"));
  claudeCliWarningEl.appendChild(dismissBtn);

  claudeCliWarningEl.classList.remove("hidden");
}

checkClaudeCliHealth();
