// v1.77.4 PHEME delivery - main-process wiring. Loaded from main.js inside try/catch (a fault here can only disable the
// pipe, never the app). Logic is in phemeDelivery.js; the renderer does the actual send (renderer.js: phemeRequest).
//   <userData>\pheme\local-token   random token, mode 0600
//   <userData>\pheme\pipe-name     random pipe name of this start
// The sandbox (test mode) uses its own userData and a "-test" pipe name, so it never touches the live pipe.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createHandler, startServer } = require("./phemeDelivery");

function init({ ipcMain, app, getMainWindow, ptyState, transcriptHas, sentLogSince, log, testMode }) {
  const say = typeof log === "function" ? log : () => {};
  const dir = path.join(app.getPath("userData"), "pheme");
  fs.mkdirSync(dir, { recursive: true });
  const pipeName = `\\\\.\\pipe\\agent-desktop-pheme${testMode ? "-test" : ""}-${crypto.randomBytes(8).toString("hex")}`;

  const tokenFile = path.join(dir, "local-token");
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch (e) {}
  if (!token || token.length < 32) {
    token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  }

  // main -> renderer requests, answered on "pheme-reply" (only accepted from the app window itself)
  const waiting = new Map();
  let seq = 0;
  ipcMain.on("pheme-reply", (event, msg) => {
    const w = getMainWindow();
    if (!w || w.isDestroyed() || event.sender !== w.webContents || !msg) return;
    const p = waiting.get(msg.id);
    if (p) { waiting.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.result); }
  });
  const askRenderer = (kind, payload) => new Promise((resolve, reject) => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return reject(new Error("no-window"));
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("renderer-timeout")); }, kind === "send" ? 25000 : 6000);
    waiting.set(id, { resolve, timer });
    w.webContents.send("pheme-request", Object.assign({ id, kind }, payload));
  });

  const handle = createHandler({ askRenderer, ptyState, transcriptHas, sentLogSince, log: say });
  const server = startServer({
    pipeName, token, handle, log: say,
    onListening: () => { try { fs.writeFileSync(path.join(dir, "pipe-name"), pipeName, "utf8"); } catch (e) {} },
  });
  app.on("before-quit", () => { try { server.close(); } catch (e) {} });
  return { pipeName, dir };
}

module.exports = { init };
