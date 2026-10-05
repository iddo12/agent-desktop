const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listAgents: () => ipcRenderer.invoke("list-agents"),
  setAgentPaused: (agentPath, paused) => ipcRenderer.invoke("set-agent-paused", { agentPath, paused }),
  listGroups: () => ipcRenderer.invoke("list-groups"),
  saveGroups: (doc) => ipcRenderer.invoke("save-groups", { doc }),
  // Dropped File objects don't carry their real filesystem path directly in a
  // contextIsolation:true renderer - webUtils.getPathForFile is the modern
  // (Electron 32+) replacement for the old File.path, only callable from the
  // preload/main side.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  savePastedImage: (base64, ext) => ipcRenderer.invoke("save-pasted-image", { base64, ext }),
  saveLongMessage: (text) => ipcRenderer.invoke("save-long-message", { text }),
  readLongMessage: (filePath) => ipcRenderer.invoke("read-long-message", { filePath }),
  createAgent: (payload) => ipcRenderer.invoke("create-agent", payload),
  updateAgent: (payload) => ipcRenderer.invoke("update-agent", payload),
  readInstructions: (agentPath) => ipcRenderer.invoke("read-instructions", { agentPath }),
  writeInstructions: (payload) => ipcRenderer.invoke("write-instructions", payload),
  deleteAgent: (agentPath) => ipcRenderer.invoke("delete-agent", { agentPath }),
  pickAvatar: () => ipcRenderer.invoke("pick-avatar"),

  startTerminal: (agentPath, cols, rows, knownAgentId) => ipcRenderer.invoke("start-terminal", { agentPath, cols, rows, knownAgentId }),
  transcribeAudio: (wavBase64, file) => ipcRenderer.invoke("voice-transcribe", { wavBase64, file }),
  voiceEngine: () => ipcRenderer.invoke("voice-engine"),
  voiceWarm: () => ipcRenderer.invoke("voice-warm"),
  voiceSave: (wavBase64) => ipcRenderer.invoke("voice-save", { wavBase64 }),
  logGuard: (line) => ipcRenderer.send("guard-log", { line }),
  sendInput: (agentPath, data, opts) => ipcRenderer.send("terminal-input", { agentPath, data, app: !!(opts && opts.app) }),
  onPressEnter: (callback) => { ipcRenderer.on("press-enter", (event, payload) => callback(payload)); },
  terminalBlankCheck: (agentPath, blank) => ipcRenderer.invoke("terminal-blank-check", { agentPath, blank: !!blank }), // v1.69.4
  canSendCtrlC: (agentPath, snippet) => ipcRenderer.invoke("can-send-ctrlc", { agentPath, text: snippet }), // v1.69.4
  onSendKeys: (callback) => { ipcRenderer.on("send-keys", (event, payload) => callback(payload)); }, // v1.69.4 recovery ladder
  resizeTerminal: (agentPath, cols, rows) => ipcRenderer.send("terminal-resize", { agentPath, cols, rows }),

  listArchivedDays: (agentPath) => ipcRenderer.invoke("list-archived-days", { agentPath }),
  readArchivedDay: (agentPath, dateKey) => ipcRenderer.invoke("read-archived-day", { agentPath, dateKey }),

  listConversations: (agentPath) => ipcRenderer.invoke("list-conversations", { agentPath }),
  renameConversation: (agentPath, sessionId, title) => ipcRenderer.invoke("rename-conversation", { agentPath, sessionId, title }),
  switchConversation: (agentPath, opts) => ipcRenderer.invoke("switch-conversation", { agentPath, ...opts }),
  getContextUsage: (agentPath) => ipcRenderer.invoke("get-context-usage", { agentPath }),
  getUsageWindows: () => ipcRenderer.invoke("get-usage-windows"),
  getInferredPlanId: () => ipcRenderer.invoke("get-inferred-plan-id"),
  notifySendFailed: (agentPath, text, info) => ipcRenderer.invoke("notify-send-failed", { agentPath, text, info }),
  clearStaleInput: (agentPath, text) => ipcRenderer.invoke("clear-stale-input", { agentPath, text }),
  getLiveTranscript: (agentPath, ifChanged) => ipcRenderer.invoke("get-live-transcript", { agentPath, ifChanged: !!ifChanged }),
  perfLog: (lines) => ipcRenderer.send("perf-log", { lines }),
  getSessionActivity: (agentPath) => ipcRenderer.invoke("get-session-activity", { agentPath }),
  agentInputHoldsText: (agentPath, snippet) => ipcRenderer.invoke("agent-input-holds-text", { agentPath, snippet }),
  agentDialogOpen: (agentPath) => ipcRenderer.invoke("agent-dialog-open", { agentPath }),
  approvalPending: (agentPath) => ipcRenderer.invoke("approval-pending-get", { agentPath }),
  approvalAnswer: (agentPath, answer, since) => ipcRenderer.invoke("approval-answer", { agentPath, answer, since }),
  getTranscriptQuietMs: (agentPath) => ipcRenderer.invoke("get-transcript-quiet-ms", { agentPath }),
  getAgentOverview: () => ipcRenderer.invoke("get-agent-overview"),
  registryList: () => ipcRenderer.invoke("registry-list"),
  argusData: (opts) => ipcRenderer.invoke("argus-data", opts),
  argusDecisionCount: () => ipcRenderer.invoke("argus-decision-count"),
  memoryData: () => ipcRenderer.invoke("memory-data"),
  memoryOpenFolder: (key) => ipcRenderer.invoke("memory-open-folder", key),
  argusOpenSource: (file) => ipcRenderer.invoke("argus-open-source", { file }),
  argusSetIdeaDecision: (payload) => ipcRenderer.invoke("argus-set-idea-decision", payload),
  libraryStateGet: () => ipcRenderer.invoke("library-state-get"),
  libraryStateOp: (op) => ipcRenderer.invoke("library-state-op", op),
  registryAction: (id, action) => ipcRenderer.invoke("registry-action", { id, action }),
  openLocalPdf: (filePath) => ipcRenderer.invoke("open-local-pdf", { filePath }),
  approveTelegramTasks: (ids) => ipcRenderer.invoke("approve-telegram-tasks", { ids }),
  heldSave: (json) => ipcRenderer.invoke("guard-held-save", { json }),
  heldLoad: () => ipcRenderer.invoke("guard-held-load"),
  ledgerSave: (json) => ipcRenderer.invoke("ledger-save", { json }),
  ledgerLoad: () => ipcRenderer.invoke("ledger-load"),
  channelSend: (agentPath, text) => ipcRenderer.invoke("guard-channel-send", { agentPath, text }),
  channelCancel: (id) => ipcRenderer.invoke("guard-channel-cancel", { id }),
  getHandoffInfo: (agentPath) => ipcRenderer.invoke("guard-handoff-info", { agentPath }),
  archiveHandoff: (agentPath) => ipcRenderer.invoke("guard-archive-handoff", { agentPath }),
  transcriptHas: (agentPath, needle) => ipcRenderer.invoke("guard-transcript-has", { agentPath, needle }),
  getLimitStatus: (agentPath) => ipcRenderer.invoke("guard-limit-status", { agentPath }),
  triggerClaudeLogin: () => ipcRenderer.invoke("guard-trigger-login"),

  getUiFlags: () => ipcRenderer.invoke("ui-flags-get"),
  setUiFlag: (key, value) => ipcRenderer.invoke("ui-flag-set", { key, value }),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  // Update & restart (v1.58.0) - see src/app-update.js.
  getAppUpdateStatus: (opts) => ipcRenderer.invoke("app-update-status", opts),
  applyAppUpdate: () => ipcRenderer.invoke("app-update-apply"),
  openAppRelease: (url) => ipcRenderer.invoke("app-update-open-release", url),
  checkClaudeCodeUpdate: () => ipcRenderer.invoke("check-claude-code-update"),
  updateClaudeCode: () => ipcRenderer.invoke("update-claude-code"),
  updateClaudeCli: () => ipcRenderer.invoke("update-claude-cli"),
  onCliUpdateProgress: (cb) => ipcRenderer.on("cli-update-progress", (_e, d) => cb(d)),

  checkInterferingServices: () => ipcRenderer.invoke("check-interfering-services"),
  disableInterferingService: (serviceName) => ipcRenderer.invoke("disable-interfering-service", { serviceName }),
  checkClaudeExecutableHealth: () => ipcRenderer.invoke("check-claude-executable-health"),

  // Startup countdown overlay (v1.53.0) - see startupState in main.js.
  getStartupState: () => ipcRenderer.invoke("get-startup-state"),
  dismissStartup: () => ipcRenderer.send("startup-dismiss"),
  onStartupProgress: (callback) => {
    ipcRenderer.on("startup-progress", (event, payload) => callback(payload));
  },
  onStartupReady: (callback) => {
    ipcRenderer.on("startup-ready", (event, payload) => callback(payload));
  },

  // Untrusted agents (v1.54.0) - see untrustedAgents in main.js.
  getUntrustedAgents: () => ipcRenderer.invoke("get-untrusted-agents"),
  trustAgentFolders: (agentPaths) => ipcRenderer.invoke("trust-agent-folders", { agentPaths }),
  onUntrustedAgents: (callback) => {
    ipcRenderer.on("untrusted-agents", (event, list) => callback(list));
  },

  // CPU guard + start limiter (v1.66.0) - see src/cpuGuardGlue.js.
  getCpuGuardState: () => ipcRenderer.invoke("cpuguard-state"),
  cpuGuardAction: (action) => ipcRenderer.invoke("cpuguard-action", { action }),
  onCpuGuardState: (callback) => {
    ipcRenderer.on("cpuguard-state", (event, state) => callback(state));
  },

  onTerminalData: (callback) => {
    ipcRenderer.on("terminal-data", (event, payload) => callback(payload));
  },
  onConnectionState: (callback) => {
    ipcRenderer.on("connection-state", (event, payload) => callback(payload));
  },
  getConnectionStates: () => ipcRenderer.invoke("get-connection-states"),
  // v1.69.0 Keep going (see src/keepGoing.js)
  keepGoingGet: () => ipcRenderer.invoke("keepgoing-get"),
  keepGoingSet: (agentPath, enabled) => ipcRenderer.invoke("keepgoing-set", { agentPath, enabled }),
  keepGoingHandoffActive: (agents) => ipcRenderer.send("keepgoing-handoff-active", { agents }),
  keepGoingResumePrompt: (agentPath, archivedPath) => ipcRenderer.invoke("keepgoing-resume-prompt", { agentPath, archivedPath }),
  onKeepGoingState: (callback) => {
    ipcRenderer.on("keepgoing-state", (event, payload) => callback(payload));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on("terminal-exit", (event, payload) => callback(payload));
  },

  // v1.72.0 My Daily (renderer/daily.js)
  daily: {
    load: (force) => ipcRenderer.invoke("daily-load", { force: !!force }),
    setSettings: (patch) => ipcRenderer.invoke("daily-settings-set", patch),
    createShoppingList: (name) => ipcRenderer.invoke("daily-shopping-create-list", { name }),
    shopping: (args) => ipcRenderer.invoke("daily-shopping", args),
    thumbs: (names) => ipcRenderer.invoke("daily-thumbs", names),
    editTask: (args) => ipcRenderer.invoke("daily-task-edit", args),
    addTask: (task) => ipcRenderer.invoke("daily-task-add", task),
    saveDate: (item) => ipcRenderer.invoke("daily-dates-save", item),
    deleteDate: (id) => ipcRenderer.invoke("daily-dates-delete", { id }),
    saveAppointment: (item) => ipcRenderer.invoke("daily-appointment-save", item),
    deleteAppointment: (id) => ipcRenderer.invoke("daily-appointment-delete", { id }),
    clearNotices: () => ipcRenderer.invoke("daily-notices-clear"),
  },
  // v1.55.0 IRIS (renderer/iris.js)
  iris: {
    status: () => ipcRenderer.invoke("iris-status"),
    setEnabled: (on) => ipcRenderer.invoke("iris-set-enabled", { on }),
    setName: (name) => ipcRenderer.invoke("iris-set-name", { name }),
    createInvite: () => ipcRenderer.invoke("iris-create-invite"),
    cancelInvite: () => ipcRenderer.invoke("iris-cancel-invite"),
    join: (invite) => ipcRenderer.invoke("iris-join", { invite }),
    setPeer: (peerId, patch) => ipcRenderer.invoke("iris-set-peer", { peerId, patch }),
    unpair: (peerId) => ipcRenderer.invoke("iris-unpair", { peerId }),
    send: (peerId, text, type, replyTo) => ipcRenderer.invoke("iris-send", { peerId, text, type, replyTo }),
    approveSend: (id) => ipcRenderer.invoke("iris-approve-send", { id }),
    rejectSend: (id) => ipcRenderer.invoke("iris-reject-send", { id }),
    log: (limit) => ipcRenderer.invoke("iris-log", { limit }),
    pending: () => ipcRenderer.invoke("iris-pending"),
    prepareDelivery: (id, agentPath) => ipcRenderer.invoke("iris-prepare-delivery", { id, agentPath }),
    delivered: (id, to) => ipcRenderer.invoke("iris-delivered", { id, to }),
    onChanged: (cb) => ipcRenderer.on("iris-changed", () => cb()),
    onIncoming: (cb) => ipcRenderer.on("iris-incoming", (e, p) => cb(p)),
  },
});
