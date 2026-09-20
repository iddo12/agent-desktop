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
  getLiveTranscript: (agentPath) => ipcRenderer.invoke("get-live-transcript", { agentPath }),
  getSessionActivity: (agentPath) => ipcRenderer.invoke("get-session-activity", { agentPath }),
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
