// Splits a recording at its pauses so each piece can get its own language decision (v1.69.14).
// Whisper locks onto ONE language per recording, so a sentence that mixes Hebrew and English lost one of them.
// Pure functions, no Electron: tests/voiceSplit.test.js. Only 16-bit PCM WAV is handled; anything else returns
// null and the caller transcribes the whole file exactly as before.

function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === "fmt " && start + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === "data") {
      if (start + size > buf.length) size = buf.length - start;   // streamed header or truncated file
      data = buf.subarray(start, start + size);
      break;
    }
    off = start + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) return null;
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const samples = new Int16Array(frames);                    // first channel only
  for (let i = 0; i < frames; i++) samples[i] = data.readInt16LE(i * 2 * fmt.channels);
  return { rate: fmt.rate, samples };
}

function makeWav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// [start, end) sample ranges that hold speech, cut at pauses of at least minGap seconds.
function splitRanges(samples, rate, opts = {}) {
  const minGap = opts.minGap || 0.5, minLen = opts.minLen || 0.7, maxLen = opts.maxLen || 28;
  const hop = Math.max(1, Math.round(0.02 * rate));
  const n = Math.floor(samples.length / hop);
  if (n < 5) return [[0, samples.length]];
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += samples[j] * samples[j];
    e[i] = Math.sqrt(s / hop);
  }
  const sorted = Float64Array.from(e).sort();
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  const thr = Math.max(150, p95 * 0.06);                      // adaptive: 6 % of the loud level
  const gapFrames = Math.round(minGap / 0.02);
  const segs = [];
  let start = -1, lastVoiced = -1;
  for (let i = 0; i < n; i++) {
    if (e[i] > thr) { if (start < 0) start = i; lastVoiced = i; }
    else if (start >= 0 && i - lastVoiced >= gapFrames) { segs.push([start, lastVoiced + 1]); start = -1; }
  }
  if (start >= 0) segs.push([start, lastVoiced + 1]);
  if (!segs.length) return [];
  const pad = Math.round(0.15 * rate);
  const out = [];
  for (const [s, t] of segs) {
    const a = Math.max(0, s * hop - pad), b = Math.min(samples.length, t * hop + pad);
    if (out.length && (a - out[out.length - 1][1] < pad || b - a < minLen * rate)) out[out.length - 1][1] = b;   // too short / too close: join the previous piece
    else out.push([a, b]);
  }
  const final = [];
  for (let [a, b] of out) {
    while (b - a > maxLen * rate) { final.push([a, a + Math.round(maxLen * rate)]); a += Math.round(maxLen * rate); }
    final.push([a, b]);
  }
  return final;
}

// Buffers of WAV pieces, or null when the file cannot be split (unknown format, or fewer than two pieces).
function splitWav(buf, opts) {
  const w = parseWav(buf);
  if (!w) return null;
  const ranges = splitRanges(w.samples, w.rate, opts);
  if (ranges.length < 2) return null;
  return ranges.map(([a, b]) => makeWav(w.samples.subarray(a, b), w.rate));
}

const hasHebrew = (s) => /[\u0590-\u05ff]/.test(String(s || ""));

module.exports = { parseWav, makeWav, splitRanges, splitWav, hasHebrew };
