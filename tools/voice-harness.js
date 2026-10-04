// Runs Agent Desktop's real voice-transcribe handler outside Electron, on one or more WAV files, using the local
// Whisper engine from the Windows user environment. Used to check changes to src/voice-main.js.
//   node tools/voice-harness.js <a.wav> [b.wav ...]            each file on its own
//   node tools/voice-harness.js --join <a.wav> <b.wav> ...     the files joined with 1 s pauses, as ONE recording
const fs = require("fs");
const os = require("os");
const path = require("path");
const vs = require("../src/voiceSplit");
const voice = require("../src/voice-main");

const handlers = {};
voice.init({
  ipcMain: { handle: (n, f) => { handlers[n] = f; } },
  log: (m) => console.log("  [log]", m),
  app: { getPath: () => os.tmpdir() },
});

(async () => {
  const args = process.argv.slice(2);
  const join = args[0] === "--join";
  const files = (join ? args.slice(1) : args).filter(Boolean);
  const jobs = [];
  if (join) {
    const parts = [];
    let rate = 16000;
    for (const f of files) {
      const w = vs.parseWav(fs.readFileSync(f));
      if (!w) throw new Error("cannot read " + f);
      rate = w.rate;
      parts.push(w.samples, new Int16Array(rate));   // 1 s of silence after each
    }
    const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const tmp = path.join(os.tmpdir(), "voice-harness-joined.wav");
    fs.writeFileSync(tmp, vs.makeWav(all, rate));
    jobs.push(tmp);
  } else jobs.push(...files);
  for (const f of jobs) {
    const t0 = Date.now();
    const r = await handlers["voice-transcribe"]({}, { file: f });
    console.log(path.basename(f), ((Date.now() - t0) / 1000).toFixed(1) + "s", JSON.stringify(r).slice(0, 400));
  }
  process.exit(0);
})();
