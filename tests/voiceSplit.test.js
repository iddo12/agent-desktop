const test = require("node:test");
const assert = require("node:assert/strict");
const vs = require("../src/voiceSplit");

const RATE = 16000;
// a burst of "speech" (a loud tone) of `sec` seconds, and silence
const burst = (sec) => Int16Array.from({ length: Math.round(sec * RATE) }, (_, i) => Math.round(8000 * Math.sin(i * 0.3)));
const quiet = (sec) => new Int16Array(Math.round(sec * RATE));
const join = (...parts) => { const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

test("two bursts with a 1 s pause become two pieces; a continuous burst stays one", () => {
  const two = vs.makeWav(join(quiet(0.3), burst(2), quiet(1), burst(2), quiet(0.3)), RATE);
  const pieces = vs.splitWav(two);
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.ok(vs.parseWav(p), "each piece is a readable WAV");
  assert.equal(vs.splitWav(vs.makeWav(join(quiet(0.3), burst(4), quiet(0.3)), RATE)), null);
});

test("a short pause (0.3 s) does not split", () => {
  assert.equal(vs.splitWav(vs.makeWav(join(burst(2), quiet(0.3), burst(2)), RATE)), null);
});

test("silence only and unreadable input return null, never throw", () => {
  assert.equal(vs.splitWav(vs.makeWav(quiet(3), RATE)), null);
  assert.equal(vs.splitWav(Buffer.from("not a wav")), null);
  assert.equal(vs.splitWav(null), null);
});

test("pieces together keep the speech: total length is close to the speech length", () => {
  const w = vs.makeWav(join(burst(1.5), quiet(0.8), burst(1.5), quiet(0.8), burst(1.5)), RATE);
  const pieces = vs.splitWav(w);
  assert.equal(pieces.length, 3);
  const total = pieces.reduce((n, p) => n + vs.parseWav(p).samples.length, 0) / RATE;
  assert.ok(total > 4.4 && total < 5.6, "total " + total);
});

test("hasHebrew", () => {
  assert.equal(vs.hasHebrew("שלום"), true);
  assert.equal(vs.hasHebrew("hello"), false);
});
