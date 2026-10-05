// Main-process half of the mic button. The renderer records the mic, converts it to a 16 kHz
// mono WAV and sends it here as base64; the transcript goes back to the renderer, which puts it
// in the compose box for review. Loaded inside try/catch from main.js, so a bug here can only
// disable dictation, never the app.
//
// v1.59.5: LOCAL FIRST. On 2026-09-25 a long dictation was lost when Cloudflare's free daily
// Workers AI allowance ran out mid-afternoon (it is shared with the image tool). Transcription
// now runs on this PC with whisper.cpp (whisper-cli.exe, same large-v3-turbo model Cloudflare
// used) whenever it is installed - free, unlimited, private, ~3 s for 2 minutes on an RTX 4070.
// Cloudflare (v1.23.3) is the fallback for a machine without the local engine, or if the local
// run fails. Where the engine lives is per machine (never hardcoded - other people run this app):
//   AGENT_DESKTOP_WHISPER_EXE      path to whisper-cli.exe (a CUDA build uses an NVIDIA GPU,
//                                  otherwise it runs on the CPU, much slower)
//   AGENT_DESKTOP_WHISPER_MODEL    path to a ggml-*.bin model (e.g. ggml-large-v3-turbo.bin)
//   AGENT_DESKTOP_WHISPER_MODEL_HE optional Hebrew fine-tune (ivrit.ai GGML); used when the
//                                  language check says the recording is Hebrew
// Windows user environment variables (read from the registry too, so no app restart needed).
//
// Every recording is also written to <userData>\voice-recordings\ before transcription, so a
// failure never loses what was said; the renderer offers a Retry that re-sends the saved file.
const voiceSplit = require("./voiceSplit");
const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CF_MODEL = "@cf/openai/whisper-large-v3-turbo";
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_RECORDINGS = 20;

// process.env first; fall back to the Windows *user* environment in the registry (an app started
// before the variable was set won't have it in its own environment).
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf-8", windowsHide: true });
    const m = new RegExp(name + "\\s+REG_\\w+\\s+(.+)").exec(out);
    return m ? m[1].trim() : "";
  } catch (e) {
    return "";
  }
}

function localEngine() {
  const exe = readEnv("AGENT_DESKTOP_WHISPER_EXE");
  const model = readEnv("AGENT_DESKTOP_WHISPER_MODEL");
  const modelHe = readEnv("AGENT_DESKTOP_WHISPER_MODEL_HE");
  const ok = !!(exe && model && fs.existsSync(exe) && fs.existsSync(model));
  return { ok, exe, model, modelHe: modelHe && fs.existsSync(modelHe) ? modelHe : "" };
}

function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: LOCAL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf-8" }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// v1.63.9: WARM SERVER. Every recording used to spawn whisper-cli, which reloads the 1.6 GB model
// into the GPU each time (and a second time for the Hebrew language check). When the GPU is busy
// (Premiere) that cold start is what made dictation slow. Now a long-lived whisper-server.exe
// (same folder as whisper-cli.exe) keeps the model loaded: it is started the moment the mic
// button is pressed (so loading overlaps the speaking), answers over 127.0.0.1, and is stopped
// after IDLE_UNLOAD_MS of no use so it does not hold VRAM for good. Any failure falls back to
// the per-run whisper-cli path below, then to Cloudflare, so this can only make things faster.
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const SERVER_START_MS = 60 * 1000;
let failedAt = 0; // a failed start is not retried for a minute (each try can cost up to SERVER_START_MS)
const servers = new Map(); // model path -> { proc, port, ready: Promise<boolean>, idle: Timer, model }

function serverExe(eng) {
  const exe = path.join(path.dirname(eng.exe), "whisper-server.exe");
  return fs.existsSync(exe) ? exe : "";
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function httpReq(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers, timeout: LOCAL_TIMEOUT_MS }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf-8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("server timed out")));
    if (body) req.write(body);
    req.end();
  });
}
function stopServer(model) {
  const s = servers.get(model);
  if (!s) return;
  servers.delete(model);
  clearTimeout(s.idle);
  try { if (s.proc) s.proc.kill(); } catch (e) {}
}
function stopAllServers() { for (const m of [...servers.keys()]) stopServer(m); }
function touchIdle(model) {
  const s = servers.get(model);
  if (!s) return;
  clearTimeout(s.idle);
  s.idle = setTimeout(() => stopServer(model), IDLE_UNLOAD_MS);
  if (s.idle.unref) s.idle.unref();
}
// Starts (or reuses) the server for one model; resolves to its entry, or null if it can't run.
function ensureServer(eng, model, say) {
  if (Date.now() - failedAt < 60 * 1000) return Promise.resolve(null);
  const existing = servers.get(model);
  if (existing) return existing.ready.then((ok) => (ok ? existing : null));
  const exe = serverExe(eng);
  if (!exe) return Promise.resolve(null);
  const entry = { proc: null, port: 0, ready: null, idle: null, model };
  servers.set(model, entry);
  entry.ready = (async () => {
    try {
      entry.port = await freePort();
      const t0 = Date.now();
      entry.proc = spawn(exe, ["-m", model, "--host", "127.0.0.1", "--port", String(entry.port), "-l", "auto", "-mc", "0", "-nt", "-sns"], { windowsHide: true, stdio: "ignore" });
      let dead = false;
      entry.proc.on("exit", () => { dead = true; if (servers.get(model) === entry) { servers.delete(model); clearTimeout(entry.idle); } });
      entry.proc.on("error", () => { dead = true; });
      while (!dead && Date.now() - t0 < SERVER_START_MS) {
        try {
          const r = await httpReq(entry.port, "GET", "/", null, {});
          if (r.status) { say(`voice-server: ${path.basename(model)} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`); touchIdle(model); return true; }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 150));
      }
      failedAt = Date.now();
      stopServer(model);
      return false;
    } catch (e) {
      failedAt = Date.now();
      stopServer(model);
      return false;
    }
  })();
  return entry.ready.then((ok) => (ok ? entry : null));
}
// One inference on a warm server. Returns { text, lang } or throws.
async function serverInfer(entry, wavPathOrBuffer, lang) {
  const boundary = "----adv" + Date.now().toString(16);
  const field = (n, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const head = field("response_format", "verbose_json") + field("language", lang || "auto") + field("temperature", "0.0") +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), Buffer.isBuffer(wavPathOrBuffer) ? wavPathOrBuffer : fs.readFileSync(wavPathOrBuffer), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await httpReq(entry.port, "POST", "/inference", body, { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length });
  if (r.status !== 200) throw new Error("server HTTP " + r.status);
  const j = JSON.parse(r.body);
  if (j.error) throw new Error(String(j.error));
  touchIdle(entry.model);
  return { text: String(j.text || ""), lang: String(j.detected_language || j.language || "") };
}
// v1.71.2: on a very short clip ("done") language auto-detect guesses wildly (Russian "Даль."). Dictation is
// Hebrew or English, so a short clip detected as anything else is re-run forced to English.
const SHORT_CLIP_SEC = 4;
function clipSeconds(wavPathOrBuffer) {
  try {
    const b = Buffer.isBuffer(wavPathOrBuffer) ? wavPathOrBuffer : fs.readFileSync(wavPathOrBuffer);
    const bps = b.readUInt32LE(28);
    return bps > 0 ? Math.max(0, b.length - 44) / bps : 99;
  } catch (e) { return 99; }
}
async function inferChecked(entry, wavPathOrBuffer) {
  let r = await serverInfer(entry, wavPathOrBuffer);
  const l = (r.lang || "").toLowerCase();
  if (l && !/^(en|english|he|iw|hebrew)$/.test(l) && clipSeconds(wavPathOrBuffer) < SHORT_CLIP_SEC) {
    const again = await serverInfer(entry, wavPathOrBuffer, "en");
    return { text: again.text, lang: "en" };
  }
  return r;
}
async function transcribeViaServer(eng, wavPath, say) {
  const t0 = Date.now();
  const main = await ensureServer(eng, eng.model, say);
  if (!main) return null;
  // v1.69.14: a recording with pauses is cut into pieces and each piece gets its own language, so a sentence
  // that mixes Hebrew and English keeps both (one language per recording dropped the other). No pauses, or a
  // format we cannot read: unchanged single pass below.
  const pieces = voiceSplit.splitWav(fs.readFileSync(wavPath));
  if (pieces) {
    const heSrv = eng.modelHe ? await ensureServer(eng, eng.modelHe, say) : null;
    const parts = [], langs = [];
    for (const piece of pieces) {
      let pr = await inferChecked(main, piece);
      let pl = pr.lang || "auto";
      if (heSrv && (/^(he|iw|hebrew)$/i.test(pl) || voiceSplit.hasHebrew(pr.text))) {
        try { const hr = await serverInfer(heSrv, piece); if (String(hr.text).trim()) { pr = hr; pl = "he"; } } catch (e) {}
      }
      langs.push(pl);
      const t = pr.text.replace(/\s*[\r\n]+\s*/g, " ").trim();
      if (t) parts.push(t);
    }
    say(`voice-transcribe: warm server, ${pieces.length} pieces (${langs.join(",")}), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return parts.join(" ");
  }
  let r = await inferChecked(main, wavPath);
  let lang = r.lang || "auto";
  if (eng.modelHe && /^(he|iw|hebrew)$/i.test(lang)) {
    const he = await ensureServer(eng, eng.modelHe, say);
    if (he) { r = await serverInfer(he, wavPath); lang = "he"; }
  }
  say(`voice-transcribe: warm server, language ${lang}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return r.text.replace(/\s*\n\s*/g, " ").trim();
}

// -mc 0: don't carry the previous window's text as context. Tested 2026-09-25 on a 134 s clip:
// with context the model repeated sentences (19 where 12 were spoken); without, 12.
async function transcribeLocal(eng, wavPath, say) {
  try {
    const warm = await transcribeViaServer(eng, wavPath, say);
    if (warm !== null) return warm;
  } catch (e) {
    say("voice-transcribe: warm server failed (" + e.message + "), using whisper-cli");
  }
  let model = eng.model;
  let lang = "auto";
  if (eng.modelHe) {
    const det = await run(eng.exe, ["-m", eng.model, "-f", wavPath, "-l", "auto", "-dl"]);
    const m = /auto-detected language:\s*(\w+)/.exec(det.stderr + det.stdout);
    if (m) lang = m[1];
    if (lang === "he") model = eng.modelHe;
  }
  const t0 = Date.now();
  const r = await run(eng.exe, ["-m", model, "-f", wavPath, "-l", "auto", "-mc", "0", "-nt", "-np"]);
  if (r.err) throw new Error((r.err.killed ? "timed out" : r.err.message.split("\n")[0]) + "");
  say(`voice-transcribe: local, language ${lang}, ${path.basename(model)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return r.stdout.replace(/\s*\n\s*/g, " ").trim();
}

async function transcribeCloudflare(wavBase64, say) {
  const acct = readEnv("CLOUDFLARE_ACCOUNT_ID");
  const tok = readEnv("CLOUDFLARE_AI_TOKEN");
  if (!acct || !tok) return { ok: false, error: "No local speech engine is set up, and no Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN) were found." };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${CF_MODEL}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ audio: wavBase64 }),
  });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (e) {}
  if (res.status === 429) {
    say("voice-transcribe: Cloudflare daily free allowance exhausted (429)");
    return { ok: false, error: "Cloudflare's free daily speech allowance is used up (resets 00:00 UTC / 03:00 Israel time)." };
  }
  if (!res.ok || !body || body.success === false) {
    const msg = body && body.errors && body.errors[0] && body.errors[0].message ? body.errors[0].message : "HTTP " + res.status;
    say("voice-transcribe failed: " + msg);
    return { ok: false, error: "Transcription failed: " + msg };
  }
  const text = body.result && typeof body.result.text === "string" ? body.result.text.trim() : "";
  return { ok: true, text, engine: "cloudflare" };
}

function init({ ipcMain, log, app }) {
  const say = typeof log === "function" ? log : () => {};
  const recDir = path.join(app && app.getPath ? app.getPath("userData") : os.tmpdir(), "voice-recordings");

  // Lets the renderer skip the 50 s chunking (a Cloudflare request-size workaround) when the
  // engine is local: one pass over the whole recording has no join points to mangle words.
  ipcMain.handle("voice-engine", async () => ({ local: localEngine().ok }));

  // Called when the mic button starts recording: load the model while the user speaks.
  ipcMain.handle("voice-warm", async () => {
    try {
      const eng = localEngine();
      if (eng.ok) { const e = await ensureServer(eng, eng.model, say); return { ok: !!e }; }
    } catch (err) {}
    return { ok: false };
  });
  if (app && app.on) { app.on("will-quit", stopAllServers); app.on("before-quit", stopAllServers); }
  process.on("exit", stopAllServers);

  // Save a recording to disk; returns its path. Keeps the newest KEEP_RECORDINGS.
  ipcMain.handle("voice-save", async (event, { wavBase64 }) => {
    try {
      fs.mkdirSync(recDir, { recursive: true });
      const file = path.join(recDir, new Date().toISOString().replace(/[:.]/g, "-") + ".wav");
      fs.writeFileSync(file, Buffer.from(wavBase64, "base64"));
      const old = fs.readdirSync(recDir).filter((f) => f.endsWith(".wav")).sort();
      old.slice(0, Math.max(0, old.length - KEEP_RECORDINGS)).forEach((f) => { try { fs.unlinkSync(path.join(recDir, f)); } catch (e) {} });
      return { ok: true, file };
    } catch (e) {
      say("voice-save error: " + e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("voice-transcribe", async (event, { wavBase64, file }) => {
    try {
      if (!wavBase64 && file && fs.existsSync(file)) wavBase64 = fs.readFileSync(file).toString("base64");
      if (!wavBase64 || wavBase64.length < 200) return { ok: false, error: "No audio was recorded." };
      const eng = localEngine();
      if (eng.ok) {
        let tmp = null;
        try {
          let wavPath = file && fs.existsSync(file) ? file : null;
          if (!wavPath) {
            tmp = path.join(os.tmpdir(), `ad-voice-${process.pid}-${Date.now()}.wav`);
            fs.writeFileSync(tmp, Buffer.from(wavBase64, "base64"));
            wavPath = tmp;
          }
          const text = await transcribeLocal(eng, wavPath, say);
          return { ok: true, text, engine: "local" };
        } catch (e) {
          say("voice-transcribe: local engine failed (" + e.message + "), trying Cloudflare");
        } finally {
          if (tmp) try { fs.unlinkSync(tmp); } catch (e) {}
        }
      }
      return await transcribeCloudflare(wavBase64, say);
    } catch (e) {
      say("voice-transcribe error: " + e.message);
      return { ok: false, error: "Transcription error: " + e.message };
    }
  });
}

module.exports = { init };
