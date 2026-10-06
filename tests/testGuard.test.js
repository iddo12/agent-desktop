// Tests for src/testGuard.js (v1.77.2). Each scenario runs in a child node process so the
// fs patching never leaks into this runner, and so AGENT_DESKTOP_TEST_MODE can be set or unset cleanly.
// Nothing here ever touches the real workspace successfully: the "real workspace" probe is
// a path that the guard must refuse; a stray file would be removed and fail the test.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const GUARD = path.join(__dirname, "..", "src", "testGuard.js");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ad-testguard-"));
const sandbox = path.join(base, "sandbox");
const childTmp = path.join(base, "ctmp");
const outside = path.join(base, "outside"); // stands in for "somewhere real"
for (const d of [sandbox, childTmp, outside]) fs.mkdirSync(d);

function run(code, env) {
  const e = Object.assign({}, process.env, { TEMP: childTmp, TMP: childTmp, TMPDIR: childTmp, GUARD }, env || {});
  delete e.AGENT_DESKTOP_TEST_MODE; delete e.AGENT_DESKTOP_ROOT; delete e.AGENT_DESKTOP_TEST_ENABLE_FLOWS; delete e.AGENT_DESKTOP_TEST_ALLOW_WRITE;
  Object.assign(e, env || {});
  const r = spawnSync(process.execPath, ["-e", code], { env: e, encoding: "utf8" });
  return { out: (r.stdout || "").trim(), err: r.stderr || "", status: r.status };
}

const TEST = { AGENT_DESKTOP_TEST_MODE: "1", AGENT_DESKTOP_ROOT: sandbox };
let n = 0;
function t(name, fn) { fn(); n++; console.log("ok - " + name); }

const probeReal = "D:\\Dropbox\\Claude stuff\\Analytics Agent\\.claude-session\\__testguard_probe__";

t("test mode refuses writes outside the sandbox (sync, callback, promises, mkdir, rename, stream)", () => {
  const code = `
    const g = require(process.env.GUARD); g.setLogger(() => {}); g.install();
    const fs = require("fs"); const path = require("path");
    const bad = ${JSON.stringify(outside)} + path.sep + "x.txt";
    const res = {};
    const tryit = (k, f) => { try { f(); res[k] = "performed"; } catch (e) { res[k] = e.code; } };
    tryit("writeSync", () => fs.writeFileSync(bad, "x"));
    tryit("appendSync", () => fs.appendFileSync(bad, "x"));
    tryit("mkdirSync", () => fs.mkdirSync(${JSON.stringify(outside)} + path.sep + "d", { recursive: true }));
    tryit("renameSync", () => fs.renameSync(${JSON.stringify(sandbox)} + path.sep + "nope", bad));
    tryit("openSync", () => fs.openSync(bad, "w"));
    tryit("stream", () => fs.createWriteStream(bad));
    tryit("realWorkspace", () => fs.mkdirSync(${JSON.stringify(probeReal)}, { recursive: true }));
    fs.writeFile(bad, "x", (err) => {
      res.cb = err && err.code;
      fs.promises.writeFile(bad, "x").catch((e) => { res.promise = e.code; console.log(JSON.stringify(res)); });
    });
  `;
  const r = run(code, TEST);
  assert.strictEqual(r.status, 0, r.err);
  const res = JSON.parse(r.out);
  for (const k of Object.keys(res)) assert.strictEqual(res[k], "EACCES", k + " -> " + res[k]);
  assert.ok(Object.keys(res).length >= 9, JSON.stringify(res));
  assert.ok(!fs.existsSync(path.join(outside, "x.txt")) && !fs.existsSync(path.join(outside, "d")), "nothing written outside");
  assert.ok(!fs.existsSync(probeReal), "real workspace probe must not exist");
});

t("test mode allows the sandbox root, os.tmpdir() and explicit opt-ins", () => {
  const optIn = path.join(base, "optin"); fs.mkdirSync(optIn);
  const code = `
    const g = require(process.env.GUARD); g.setLogger(() => {}); g.install();
    const fs = require("fs"); const path = require("path"); const os = require("os");
    fs.mkdirSync(${JSON.stringify(sandbox)} + "/a/b", { recursive: true });
    fs.writeFileSync(${JSON.stringify(sandbox)} + "/a/b/f.txt", "ok");
    fs.writeFileSync(path.join(os.tmpdir(), "t.txt"), "ok");
    fs.writeFileSync(${JSON.stringify(optIn)} + "/o.txt", "ok");
    fs.renameSync(${JSON.stringify(sandbox)} + "/a/b/f.txt", ${JSON.stringify(sandbox)} + "/a/b/g.txt");
    fs.readFileSync(${JSON.stringify(sandbox)} + "/a/b/g.txt", "utf8");
    fs.readdirSync(${JSON.stringify(outside)}); // reads are never blocked
    console.log("done");
  `;
  const r = run(code, Object.assign({}, TEST, { AGENT_DESKTOP_TEST_ALLOW_WRITE: optIn }));
  assert.strictEqual(r.out, "done", r.err);
});

t("test mode refuses a child_process / session cwd outside the sandbox", () => {
  const code = `
    const g = require(process.env.GUARD); g.setLogger(() => {}); g.install();
    const cp = require("child_process");
    let a, b;
    try { cp.spawnSync(process.execPath, ["-v"], { cwd: ${JSON.stringify(outside)} }); a = "performed"; } catch (e) { a = e.code; }
    try { b = cp.spawnSync(process.execPath, ["-v"], { cwd: ${JSON.stringify(sandbox)} }).status; } catch (e) { b = e.code; }
    console.log(a + "|" + b);
  `;
  assert.strictEqual(run(code, TEST).out, "EACCES|0");
});

t("workspaceRoot / usageNowPath / flowsEnabled resolve under the sandbox in test mode", () => {
  const code = `
    const g = require(process.env.GUARD);
    console.log([g.workspaceRoot(), g.usageNowPath(), g.flowsEnabled()].join("|"));
  `;
  const [ws, usage, flows] = run(code, TEST).out.split("|");
  assert.strictEqual(ws, sandbox);
  assert.ok(usage.startsWith(sandbox), usage);
  assert.strictEqual(flows, "false");
  const on = run(code, Object.assign({}, TEST, { AGENT_DESKTOP_TEST_ENABLE_FLOWS: "1" })).out.split("|");
  assert.strictEqual(on[2], "true");
});

t("normal (non-test) mode: install() changes nothing, real roots unchanged, flows enabled", () => {
  const code = `
    const fs = require("fs"); const cp = require("child_process");
    const before = [fs.writeFileSync, fs.mkdirSync, fs.promises.writeFile, fs.openSync, cp.spawn, cp.execFile];
    const g = require(process.env.GUARD);
    const installed = g.install();
    const after = [fs.writeFileSync, fs.mkdirSync, fs.promises.writeFile, fs.openSync, cp.spawn, cp.execFile];
    const same = before.every((f, i) => f === after[i]);
    g.assertWritable("D:\\\\Dropbox\\\\Claude stuff\\\\anything"); // must not throw
    console.log([installed, same, g.workspaceRoot(), g.flowsEnabled(), g.isWritable("C:\\\\x")].join("|"));
  `;
  const r = run(code, {});
  assert.strictEqual(r.out, "false|true|D:\\Dropbox\\Claude stuff|true|true", r.err);
  // and a test-mode variable other than "1" is NOT test mode
  assert.strictEqual(run(code, { AGENT_DESKTOP_TEST_MODE: "0" }).out, "false|true|D:\\Dropbox\\Claude stuff|true|true");
});

try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* tmp cleanup is best effort */ }
console.log(n + " passed");
