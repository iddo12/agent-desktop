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
  transcribeAudio: (wavBase64) => ipcRenderer.invoke("voice-transcribe", { wavBase64 }),
  sendInput: (agentPath, data) => ipcRenderer.send("terminal-input", { agentPath, data }),
  resizeTerminal: (agentPath, cols, rows) => ipcRenderer.send("terminal-resize", { agentPath, cols, rows }),

  listArchivedDays: (agentPath) => ipcRenderer.invoke("list-archived-days", { agentPath }),
  readArchivedDay: (agentPath, dateKey) => ipcRenderer.invoke("read-archived-day", { agentPath, dateKey }),

  listConversations: (agentPath) => ipcRenderer.invoke("list-conversations", { agentPath }),
  renameConversation: (agentPath, sessionId, title) => ipcRenderer.invoke("rename-conversation", { agentPath, sessionId, title }),
  switchConversation: (agentPath, opts) => ipcRenderer.invoke("switch-conversation", { agentPath, ...opts }),
  getContextUsage: (agentPath) => ipcRenderer.invoke("get-context-usage", { agentPath }),
  getUsageWindows: () => ipcRenderer.invoke("get-usage-windows"),
  getInferredPlanId: () => ipcRenderer.invoke("get-inferred-plan-id"),
  notifySendFailed: (agentPath, text) => ipcRenderer.invoke("notify-send-failed", { agentPath, text }),
  getLiveTranscript: (agentPath) => ipcRenderer.invoke("get-live-transcript", { agentPath }),
  getSessionActivity: (agentPath) => ipcRenderer.invoke("get-session-activity", { agentPath }),
  getTranscriptQuietMs: (agentPath) => ipcRenderer.invoke("get-transcript-quiet-ms", { agentPath }),
  getAgentOverview: () => ipcRenderer.invoke("get-agent-overview"),
  registryList: () => ipcRenderer.invoke("registry-list"),
  argusData: (opts) => ipcRenderer.invoke("argus-data", opts),
  argusDecisionCount: () => ipcRenderer.invoke("argus-decision-count"),
  argusOpenSource: (file) => ipcRenderer.invoke("argus-open-source", { file }),
  argusSetIdeaDecision: (payload) => ipcRenderer.invoke("argus-set-idea-decision", payload),
  registryAction: (id, action) => ipcRenderer.invoke("registry-action", { id, action }),
  approveTelegramTasks: (ids) => ipcRenderer.invoke("approve-telegram-tasks", { ids }),
  getHandoffInfo: (agentPath) => ipcRenderer.invoke("guard-handoff-info", { agentPath }),
  archiveHandoff: (agentPath) => ipcRenderer.invoke("guard-archive-handoff", { agentPath }),
  transcriptHas: (agentPath, needle) => ipcRenderer.invoke("guard-transcript-has", { agentPath, needle }),
  getLimitStatus: (agentPath) => ipcRenderer.invoke("guard-limit-status", { agentPath }),
  triggerClaudeLogin: () => ipcRenderer.invoke("guard-trigger-login"),

  getUiFlags: () => ipcRenderer.invoke("ui-flags-get"),
  setUiFlag: (key, value) => ipcRenderer.invoke("ui-flag-set", { key, value }),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkClaudeCodeUpdate: () => ipcRenderer.invoke("check-claude-code-update"),
  updateClaudeCode: () => ipcRenderer.invoke("update-claude-code"),
  updateClaudeCli: () => ipcRenderer.invoke("update-claude-cli"),

  checkInterferingServices: () => ipcRenderer.invoke("check-interfering-services"),
  disableInterferingService: (serviceName) => ipcRenderer.invoke("disable-interfering-service", { serviceName }),
  checkClaudeExecutableHealth: () => ipcRenderer.invoke("check-claude-executable-health"),

  onTerminalData: (callback) => {
    ipcRenderer.on("terminal-data", (event, payload) => callback(payload));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on("terminal-exit", (event, payload) => callback(payload));
  },
});
