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

// -mc 0: don't carry the previous window's text as context. Tested 2026-09-25 on a 134 s clip:
// with context the model repeated sentences (19 where 12 were spoken); without, 12.
async function transcribeLocal(eng, wavPath, say) {
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
