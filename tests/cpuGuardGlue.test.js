// Run: node tests/cpuGuardGlue.test.js  - banner state + consent/install flow with fakes (no scheduler touched).
const assert = require("assert");
const os = require("os");
const path = require("path");
const { computeBannerState } = require("../src/cpuGuardGlue");
const guard = require("../src/cpuGuardInstall");

const lim = (o = {}) => ({ queued: 0, inflight: 0, started: 0, total: 0, hold: { active: false, boxed: [] }, ...o });

// ---- banner ----
assert.strictEqual(computeBannerState(lim(), null).show, false, "nothing to say");
assert.strictEqual(computeBannerState(lim(), { fresh: true, boxed: [] }).show, false);
let b = computeBannerState(lim({ queued: 2, started: 3, total: 5 }), null);
assert.ok(b.show && b.kind === "queue" && /3 of 5/.test(b.text));
b = computeBannerState(lim(), { fresh: true, boxed: ["Security"] });
assert.ok(b.show && b.kind === "overload" && /Security/.test(b.text));
b = computeBannerState(lim(), { fresh: false, boxed: ["Security"] });
assert.strictEqual(b.show, false, "stale status.json (guard not running) shows nothing");
b = computeBannerState(lim({ queued: 4, hold: { active: true, boxed: ["A", "B"] } }), { fresh: true, boxed: [] });
assert.ok(b.show && b.kind === "hold" && /4 waiting/.test(b.text) && /A, B/.test(b.text));

// ---- consent / install flow with fakes ----
function run(flagsInit, existing, answer) {
  const flags = { ...flagsInit };
  const calls = { ask: 0, install: 0, start: 0 };
  const srcDir = path.join(__dirname, "..", "tools", "cpuguard");
  return guard
    .ensureCpuGuard({
      srcDir,
      stateDir: path.join(os.tmpdir(), "cg-test-state"),
      platform: "win32",
      testMode: false,
      getFlags: () => flags,
      setFlag: (k, v) => { flags[k] = v; },
      askConsent: async () => { calls.ask++; return answer; },
      deps: {
        queryTasks: async () => existing,
        installGuard: async () => { calls.install++; return { ok: true, version: "2.1" }; },
        startGuard: async () => { calls.start++; return true; },
      },
    })
    .then((r) => ({ r, flags, calls }));
}

(async () => {
  let x = await run({}, [], true);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [1, 1], "first time: asks, then installs");
  assert.strictEqual(x.flags.cpuGuardConsent, "yes");
  assert.strictEqual(x.flags.cpuGuardEnabled, true);
  assert.strictEqual(x.flags.cpuGuardVersion, "2.1");

  x = await run({}, [], false);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [1, 0], "declined: nothing installed");
  assert.strictEqual(x.flags.cpuGuardConsent, "no");

  x = await run({ cpuGuardConsent: "no" }, [], true);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [0, 0], "declined once: never asked again");

  x = await run({ cpuGuardConsent: "yes", cpuGuardVersion: "2.1" }, [], true);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [0, 1], "consented, task gone: reinstall without asking");

  x = await run({}, [{ name: "SEC_CpuGuard", state: "Running" }], true);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [0, 0], "existing running guard: no dialog, no second one");

  x = await run({ cpuGuardEnabled: false, cpuGuardConsent: "yes" }, [], true);
  assert.deepStrictEqual([x.calls.ask, x.calls.install], [0, 0], "turned off by the user");

  const t = await guard.ensureCpuGuard({ srcDir: ".", stateDir: ".", platform: "win32", testMode: true, getFlags: () => ({}), setFlag() {}, askConsent: async () => { throw new Error("must not ask"); } });
  assert.strictEqual(t.action, "none", "sandbox/test mode never installs or asks");

  // install failure: consent remembered, no enabled flag
  const flags = {};
  const f = await guard.ensureCpuGuard({
    srcDir: path.join(__dirname, "..", "tools", "cpuguard"), stateDir: "x", platform: "win32", testMode: false,
    getFlags: () => flags, setFlag: (k, v) => { flags[k] = v; }, askConsent: async () => true,
    deps: { queryTasks: async () => [], installGuard: async () => ({ ok: false, error: "denied" }) },
  });
  assert.strictEqual(f.ok, false);
  assert.strictEqual(flags.cpuGuardEnabled, undefined, "failed install is not recorded as enabled");

  console.log("cpuGuardGlue ok");
})().catch((e) => { console.error(e); process.exit(1); });
