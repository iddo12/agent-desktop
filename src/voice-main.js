// Main-process half of the mic button (v1.23.3): speech-to-text through Cloudflare Workers AI
// (Whisper), using the same account/token the shared image tool uses (Windows env vars
// CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN - never logged). The renderer records the mic,
// converts it to a 16 kHz mono WAV and sends it here as base64; the transcript goes back to
// the renderer, which puts it in the compose box for review. Loaded inside try/catch from
// main.js, so a bug here can only disable dictation, never the app.
const { execFileSync } = require("child_process");

const MODEL = "@cf/openai/whisper-large-v3-turbo";

// process.env first; fall back to the Windows *user* environment in the registry (an app started
// before the variable was set won't have it in its own environment).
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const out = execFileSync("reg", ["query", "HKCU\Environment", "/v", name], { encoding: "utf-8", windowsHide: true });
    const m = new RegExp(name + "\s+REG_\w+\s+(.+)").exec(out);
    return m ? m[1].trim() : "";
  } catch (e) {
    return "";
  }
}

function init({ ipcMain, log }) {
  const say = typeof log === "function" ? log : () => {};
  ipcMain.handle("voice-transcribe", async (event, { wavBase64 }) => {
    try {
      const acct = readEnv("CLOUDFLARE_ACCOUNT_ID");
      const tok = readEnv("CLOUDFLARE_AI_TOKEN");
      if (!acct || !tok) return { ok: false, error: "Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN) not found in Windows environment variables." };
      if (!wavBase64 || wavBase64.length < 200) return { ok: false, error: "No audio was recorded." };
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${MODEL}`, {
        method: "POST",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ audio: wavBase64 }),
      });
      const raw = await res.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch (e) {}
      if (res.status === 429) say("voice-transcribe: daily free allowance exhausted (429)");
      if (res.status === 429) return { ok: false, error: "Cloudflare's free daily speech allowance is used up (resets 00:00 UTC / 03:00 Israel time)." };
      if (!res.ok || !body || body.success === false) {
        const msg = body && body.errors && body.errors[0] && body.errors[0].message ? body.errors[0].message : "HTTP " + res.status;
        say("voice-transcribe failed: " + msg);
        return { ok: false, error: "Transcription failed: " + msg };
      }
      const text = body.result && typeof body.result.text === "string" ? body.result.text.trim() : "";
      return { ok: true, text };
    } catch (e) {
      say("voice-transcribe error: " + e.message);
      return { ok: false, error: "Transcription error: " + e.message };
    }
  });
}

module.exports = { init };
