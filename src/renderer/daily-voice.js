// My Daily voice recorder (v1.72.0 phase 4). Uses the app's existing local-whisper pipeline (window.api.transcribeAudio ->
// voice-main.js warm server); there is NO second whisper server here. The microphone exists only between begin() and
// stop()/cancel(): nothing is held, polled or kept running otherwise. The one timer is the 2-minute safety stop and it
// is cleared the moment recording ends.
//
// Injectable for tests and the sandbox: dailyVoice.setFake("milk and eggs") makes begin() skip the microphone and
// stop() return that text (or a function's result); dailyVoice.setTranscriber(fn) replaces only the transcription step.
(function () {
  "use strict";
  const MAX_MS = 120000;
  let fake = null;
  let transcriber = null;

  function encodeWav16kBase64(pcm) {
    const rate = 16000;
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const w = (o, str) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
    w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt "); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    const bytes = new Uint8Array(out.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function blobToPcm16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try { decoded = await ctx.decodeAudioData(buf); } finally { ctx.close(); }
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  }

  function micMessage(e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "The microphone is blocked. Allow desktop apps to use it in Windows Settings > Privacy > Microphone, then try again.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No microphone was found. Plug one in or pick a default recording device in Windows, then try again.";
    if (n === "NotReadableError") return "The microphone is busy in another program. Close it there, then try again.";
    return "Could not use the microphone" + (e && e.message ? ": " + e.message : ".");
  }

  async function transcribe(blob) {
    try {
      const pcm = await blobToPcm16k(blob);
      if (!pcm.length) return { ok: false, error: "Nothing was recorded." };
      const wav = encodeWav16kBase64(pcm);
      const res = transcriber ? await transcriber(wav) : await window.api.transcribeAudio(wav);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || "Transcription failed." };
      const text = String(res.text || "").trim();
      return text ? { ok: true, text } : { ok: false, error: "Nothing was heard - try again a bit closer to the mic." };
    } catch (e) {
      return { ok: false, error: "Could not read the recording: " + (e && e.message ? e.message : e) };
    }
  }

  // begin(onAutoStop) -> {ok:true, stop(): Promise<{ok,text|error}>, cancel()} or {ok:false, error}
  async function begin(onAutoStop) {
    if (fake != null) {
      const text = fake;
      return { ok: true, fake: true, stop: async () => { const t = typeof text === "function" ? await text() : text; return t ? { ok: true, text: String(t) } : { ok: false, error: "Nothing was heard - try again a bit closer to the mic." }; }, cancel: () => {} };
    }
    let stream;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder !== "function") return { ok: false, error: "Recording is not available in this window." };
      try { if (window.api.voiceWarm) window.api.voiceWarm(); } catch (e) { /* the model just loads later */ }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return { ok: false, error: micMessage(e) };
    }
    let recorder, timer = null, finished = false;
    const chunks = [];
    const release = () => { clearTimeout(timer); timer = null; try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already stopped */ } };
    try {
      recorder = new MediaRecorder(stream);
    } catch (e) {
      release();
      return { ok: false, error: "Could not start recording: " + (e && e.message ? e.message : e) };
    }
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    try { recorder.start(); } catch (e) { release(); return { ok: false, error: "Could not start recording: " + (e && e.message ? e.message : e) }; }
    const finish = async () => {
      if (finished) return { ok: false, error: "Already stopped." };
      finished = true;
      try { recorder.stop(); } catch (e) { /* not recording */ }
      release();
      await stopped;
      return transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    const cancel = () => { if (finished) return; finished = true; recorder.ondataavailable = null; try { recorder.stop(); } catch (e) { /* not recording */ } release(); };
    const h = { ok: true, stop: finish, cancel };
    timer = setTimeout(() => { if (typeof onAutoStop === "function") onAutoStop(); }, MAX_MS);
    return h;
  }

  window.dailyVoice = { begin, setFake: (v) => { fake = v == null ? null : v; }, setTranscriber: (fn) => { transcriber = typeof fn === "function" ? fn : null; }, MAX_MS };
})();
