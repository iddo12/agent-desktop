const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listAgents: () => ipcRenderer.invoke("list-agents"),
  // Dropped File objects don't carry their real filesystem path directly in a
  // contextIsolation:true renderer - webUtils.getPathForFile is the modern
  // (Electron 32+) replacement for the old File.path, only callable from the
  // preload/main side.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  savePastedImage: (base64, ext) => ipcRenderer.invoke("save-pasted-image", { base64, ext }),
  createAgent: (payload) => ipcRenderer.invoke("create-agent", payload),
  updateAgent: (payload) => ipcRenderer.invoke("update-agent", payload),
  deleteAgent: (agentPath) => ipcRenderer.invoke("delete-agent", { agentPath }),
  pickAvatar: () => ipcRenderer.invoke("pick-avatar"),

  startTerminal: (agentPath, cols, rows) => ipcRenderer.invoke("start-terminal", { agentPath, cols, rows }),
  sendInput: (agentPath, data) => ipcRenderer.send("terminal-input", { agentPath, data }),
  resizeTerminal: (agentPath, cols, rows) => ipcRenderer.send("terminal-resize", { agentPath, cols, rows }),

  listArchivedDays: (agentPath) => ipcRenderer.invoke("list-archived-days", { agentPath }),
  readArchivedDay: (agentPath, dateKey) => ipcRenderer.invoke("read-archived-day", { agentPath, dateKey }),
  getContextUsage: (agentPath) => ipcRenderer.invoke("get-context-usage", { agentPath }),
  getUsageWindows: () => ipcRenderer.invoke("get-usage-windows"),
  getLiveTranscript: (agentPath) => ipcRenderer.invoke("get-live-transcript", { agentPath }),

  checkClaudeCodeUpdate: () => ipcRenderer.invoke("check-claude-code-update"),
  updateClaudeCode: () => ipcRenderer.invoke("update-claude-code"),

  onTerminalData: (callback) => {
    ipcRenderer.on("terminal-data", (event, payload) => callback(payload));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on("terminal-exit", (event, payload) => callback(payload));
  },
});
