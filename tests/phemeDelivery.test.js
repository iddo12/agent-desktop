// node tests/phemeDelivery.test.js - PHEME delivery: command handler (src/phemeDelivery.js), the real pipe server with its
// token check, and the Python client (tools/pheme_ad_delivery.py) against a fake pipe server. No Electron is started.
const assert = require("assert");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const P = require("../src/phemeDelivery");

let fails = 0, n = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// ---- handler ----
function mk(over, opts) {
  const calls = [];
  const deps = Object.assign({
    askRenderer: async (kind, payload) => {
      calls.push([kind, payload]);
      if (kind === "selected") return { ok: true, agentPath: "C:\\a\\Legal", name: "Legal" };
      return { ok: true, how: "sent", sentText: payload.text };
    },
    ptyState: () => "attached",
    transcriptHas: async () => true,
    sentLogSince: () => true,
    sleep: async () => {},
    now: (() => { let x = 1000; return () => (x += 500); })(),
    log: () => {},
  }, over || {});
  return { handle: P.createHandler(deps, Object.assign({ verifyMs: 3000, pollMs: 500 }, opts || {})), calls };
}

t("selected-agent: returns the agent name", async () => {
  const { handle } = mk();
  assert.deepStrictEqual(await handle({ cmd: "selected-agent" }), { ok: true, agent: "Legal" });
});
t("selected-agent: nothing selected -> clear refusal", async () => {
  const { handle } = mk({ askRenderer: async () => ({ ok: false, reason: "no-agent-selected" }) });
  const r = await handle({ cmd: "selected-agent" });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "no-agent-selected");
});
t("send: My Daily / ARGUS showing -> refused, nothing sent", async () => {
  const { handle, calls } = mk({ askRenderer: async (k, p) => { calls2.push(k); return { ok: false, reason: "not-an-agent-chat (My Daily, ARGUS or another view is showing)" }; } });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.strictEqual(r.ok, false); assert(/not-an-agent-chat/.test(r.reason));
  assert(!calls2.includes("send"));
});
const calls2 = [];
t("send: pty not attached -> refused before the renderer is asked to send", async () => {
  const { handle, calls } = mk({ ptyState: () => "none" });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.deepStrictEqual([r.ok, r.reason, r.agent], [false, "pty-not-attached", "Legal"]);
  assert(!calls.some((c) => c[0] === "send"));
});
t("send: pty still starting -> refused with its own reason", async () => {
  const { handle } = mk({ ptyState: () => "starting" });
  assert.strictEqual((await handle({ cmd: "send-to-selected", text: "hello there" })).reason, "pty-starting");
});
t("send: oversized text refused, never truncated", async () => {
  const { handle, calls } = mk();
  const r = await handle({ cmd: "send-to-selected", text: "x".repeat(P.MAX_TEXT + 1) });
  assert.strictEqual(r.ok, false); assert(/text-too-long/.test(r.reason)); assert.strictEqual(calls.length, 0);
  const ok = await handle({ cmd: "send-to-selected", text: "x".repeat(P.MAX_TEXT) });
  assert.strictEqual(ok.ok, true);
});
t("send: empty / non-string text refused", async () => {
  const { handle } = mk();
  assert.strictEqual((await handle({ cmd: "send-to-selected", text: "   " })).reason, "empty-text");
  assert.strictEqual((await handle({ cmd: "send-to-selected", text: 42 })).reason, "empty-text");
  assert.strictEqual((await handle({ cmd: "send-to-selected" })).reason, "empty-text");
});
t("send: verified in the transcript -> ok, verified, pinned to the selected agent", async () => {
  const { handle, calls } = mk();
  const r = await handle({ cmd: "send-to-selected", text: "please check the invoice", source: "pheme" });
  assert.deepStrictEqual([r.ok, r.agent, r.verified, r.written], [true, "Legal", true, true]);
  const s = calls.find((c) => c[0] === "send")[1];
  assert.strictEqual(s.expectPath, "C:\\a\\Legal"); assert.strictEqual(s.source, "pheme");
});
t("send: the long-message file reference is what gets verified, not the original text", async () => {
  let seen = null;
  const { handle } = mk({
    askRenderer: async (k, p) => k === "selected" ? { ok: true, agentPath: "C:\\a\\L", name: "L" } : { ok: true, how: "sent", sentText: 'saved to a file - please read it: "C:\\tmp\\m1.txt"' },
    transcriptHas: async (ap, text) => { seen = text; return true; },
  });
  await handle({ cmd: "send-to-selected", text: "long ".repeat(200) });
  assert(/m1\.txt/.test(seen));
});
t("send: verification timeout, pty write seen -> ok but verified:false (caller must not resend)", async () => {
  const { handle } = mk({ transcriptHas: async () => false });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.deepStrictEqual([r.ok, r.verified, r.written], [true, false, true]);
});
t("send: verification timeout and no pty write -> not-written failure", async () => {
  const { handle } = mk({ transcriptHas: async () => null, sentLogSince: () => false });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.deepStrictEqual([r.ok, r.reason], [false, "not-written"]);
});
t("send: agent busy / not ready -> queued in the app, ok but not verified", async () => {
  const { handle } = mk({ askRenderer: async (k) => k === "selected" ? { ok: true, agentPath: "C:\\a\\L", name: "L" } : { ok: true, how: "held" } });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.deepStrictEqual([r.ok, r.queued, r.verified], [true, true, false]);
});
t("send: renderer refuses the send (selection changed) -> failure with agent", async () => {
  const { handle } = mk({ askRenderer: async (k) => k === "selected" ? { ok: true, agentPath: "C:\\a\\L", name: "L" } : { ok: false, reason: "selection-changed" } });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.deepStrictEqual([r.ok, r.reason, r.agent], [false, "selection-changed", "L"]);
});
t("send: renderer unreachable -> refused, no exception", async () => {
  const { handle } = mk({ askRenderer: async () => { throw new Error("renderer-timeout"); } });
  const r = await handle({ cmd: "send-to-selected", text: "hello there" });
  assert.strictEqual(r.ok, false); assert(/renderer-timeout/.test(r.reason));
});
t("send: two quick dictations are serialised, never overlapping", async () => {
  let active = 0, maxActive = 0;
  const { handle } = mk({
    askRenderer: async (k, p) => {
      if (k === "selected") return { ok: true, agentPath: "C:\\a\\L", name: "L" };
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20)); active--;
      return { ok: true, how: "sent", sentText: p.text };
    },
  });
  await Promise.all([handle({ cmd: "send-to-selected", text: "first one" }), handle({ cmd: "send-to-selected", text: "second one" })]);
  assert.strictEqual(maxActive, 1);
});
t("unknown command / bad request", async () => {
  const { handle } = mk();
  assert.strictEqual((await handle({ cmd: "rm -rf" })).reason, "unknown-cmd");
  assert.strictEqual((await handle(null)).reason, "bad-request");
  assert.strictEqual((await handle({ cmd: "ping" })).ok, true);
});
t("tokenOk: exact match only", async () => {
  assert(P.tokenOk("abc", "abc")); assert(!P.tokenOk("abd", "abc")); assert(!P.tokenOk("", "")); assert(!P.tokenOk(undefined, "abc")); assert(!P.tokenOk("abcd", "abc"));
});

// ---- real pipe server ----
const rid = () => crypto.randomBytes(6).toString("hex");
function pipeRequest(pipe, obj, raw) {
  return new Promise((resolve) => {
    const s = net.createConnection(pipe);
    let b = "";
    s.on("data", (d) => (b += d));
    s.on("end", () => resolve(b));
    s.on("close", () => resolve(b));
    s.on("error", () => resolve(b));
    s.on("connect", () => s.write(raw !== undefined ? raw : JSON.stringify(obj) + "\n"));
  });
}
t("pipe server: token required, bad token never reaches the handler", async () => {
  const pipe = "\\\\.\\pipe\\agent-desktop-pheme-test-" + rid();
  let reached = 0;
  const srv = P.startServer({ pipeName: pipe, token: "t".repeat(48), handle: async () => { reached++; return { ok: true }; } });
  await new Promise((r) => srv.on("listening", r));
  try {
    assert.strictEqual(JSON.parse(await pipeRequest(pipe, { cmd: "ping", token: "nope" })).reason, "bad-token");
    assert.strictEqual(JSON.parse(await pipeRequest(pipe, { cmd: "ping" })).reason, "bad-token");
    assert.strictEqual(reached, 0);
    assert.strictEqual(JSON.parse(await pipeRequest(pipe, { cmd: "ping", token: "t".repeat(48) })).ok, true);
    assert.strictEqual(reached, 1);
    assert.strictEqual(await pipeRequest(pipe, null, "not json\n"), ""); // garbage: closed without an answer
    assert.strictEqual(await pipeRequest(pipe, null, "x".repeat(200 * 1024)), ""); // oversize: dropped
  } finally { srv.close(); }
});

// ---- python client against a fake pipe server ----
function runPy(code, env) {
  return new Promise((resolve) => {
    const py = spawn("python", ["-c", code], { env: Object.assign({}, process.env, env), cwd: path.join(__dirname, "..", "tools") });
    let out = "", err = "";
    py.stdout.on("data", (d) => (out += d)); py.stderr.on("data", (d) => (err += d));
    py.on("error", (e) => resolve({ out: "", err: String(e), code: -1 }));
    py.on("close", (c) => resolve({ out: out.trim(), err, code: c }));
  });
}
async function withFake(replyFor, fn, livePipe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pheme-fake-"));
  const pipe = "\\\\.\\pipe\\agent-desktop-pheme-" + (livePipe ? "" : "test-") + rid();
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(dir, "local-token"), token); fs.writeFileSync(path.join(dir, "pipe-name"), pipe);
  const seen = [];
  const srv = P.startServer({ pipeName: pipe, token, handle: async (req) => { seen.push(req); return replyFor(req); } });
  await new Promise((r) => srv.on("listening", r));
  try { await fn({ dir, seen, token }); } finally { srv.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}
const PYCALL = (expr) => `import json,sys; sys.path.insert(0,'.'); import pheme_ad_delivery as d; r=${expr}; print(json.dumps(r))`;

t("python client: delivered + verified", async () => {
  await withFake((req) => ({ ok: true, agent: "Legal", verified: true, written: true, how: "sent" }), async ({ dir, seen, token }) => {
    const r = await runPy(PYCALL(`d.deliver('shalom olam', 'pheme', timeout=10)`), { PHEME_AD_DIR: dir });
    const [status, info] = JSON.parse(r.out);
    assert.strictEqual(status, "ok"); assert.strictEqual(info.agent, "Legal"); assert.strictEqual(info.verified, true);
    assert.strictEqual(seen[0].cmd, "send-to-selected"); assert.strictEqual(seen[0].text, "shalom olam"); assert.strictEqual(seen[0].token, token);
  });
});
t("python client: unicode (Hebrew) survives the pipe", async () => {
  await withFake((req) => ({ ok: true, agent: "A", verified: true, written: true }), async ({ dir, seen }) => {
    await runPy(PYCALL(`d.deliver('\\u05e9\\u05dc\\u05d5\\u05dd', 'pheme', timeout=10)`), { PHEME_AD_DIR: dir });
    assert.strictEqual(seen[0].text, "\u05e9\u05dc\u05d5\u05dd");
  });
});
t("python client: AD refuses -> 'refused' with the reason (caller must not click)", async () => {
  await withFake(() => ({ ok: false, reason: "no-agent-selected" }), async ({ dir }) => {
    const r = await runPy(PYCALL(`d.deliver('hello', timeout=10)`), { PHEME_AD_DIR: dir });
    const [status, info] = JSON.parse(r.out);
    assert.strictEqual(status, "refused"); assert.strictEqual(info.reason, "no-agent-selected");
  });
});
t("python client: unverified but written -> ok with verified false", async () => {
  await withFake(() => ({ ok: true, agent: "Legal", verified: false, written: true }), async ({ dir }) => {
    const [status, info] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=10)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "ok"); assert.strictEqual(info.verified, false); assert.strictEqual(info.written, true);
  });
});
t("python client: selected-agent query", async () => {
  await withFake(() => ({ ok: true, agent: "Legal" }), async ({ dir, seen }) => {
    const [status, info] = JSON.parse((await runPy(PYCALL(`d.selected_agent(timeout=10)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "ok"); assert.strictEqual(info.agent, "Legal"); assert.strictEqual(seen[0].cmd, "selected-agent");
  });
});
t("python client: no token/pipe files -> 'unavailable' (older Agent Desktop: click fallback allowed)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pheme-none-"));
  try {
    const [status, info] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=5)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "unavailable"); assert(info.reason);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t("python client: stale pipe name (dead instance) -> 'unavailable'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pheme-stale-"));
  fs.writeFileSync(path.join(dir, "local-token"), "t".repeat(48)); fs.writeFileSync(path.join(dir, "pipe-name"), "\\\\.\\pipe\\agent-desktop-pheme-deadbeef00000000");
  try {
    const [status] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=5)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "unavailable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t("python client: stale pipe-name but a live pipe exists -> found by scan, token still checked", async () => {
  await withFake(() => ({ ok: true, agent: "Legal", verified: true, written: true }), async ({ dir, token }) => {
    fs.writeFileSync(path.join(dir, "pipe-name"), "\\\\.\\pipe\\agent-desktop-pheme-deadbeef00000000");
    const [status] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=10)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "ok");
    fs.writeFileSync(path.join(dir, "local-token"), "w".repeat(48)); // wrong token: the server refuses
    const [s2, i2] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=10)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(s2, "refused"); assert.strictEqual(i2.reason, "bad-token");
  }, true);
});
t("python client: no answer in time -> 'refused' (state unknown, never 'unavailable', so no duplicate click)", async () => {
  await withFake(() => new Promise(() => {}), async ({ dir }) => {
    const [status, info] = JSON.parse((await runPy(PYCALL(`d.deliver('hello', timeout=1.5)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(status, "refused"); assert(/timeout/.test(info.reason));
  });
});
t("python client: oversize / empty refused locally, nothing sent", async () => {
  await withFake(() => ({ ok: true }), async ({ dir, seen }) => {
    const a = JSON.parse((await runPy(PYCALL(`d.deliver('x'*20001, timeout=5)`), { PHEME_AD_DIR: dir })).out);
    const b = JSON.parse((await runPy(PYCALL(`d.deliver('  ', timeout=5)`), { PHEME_AD_DIR: dir })).out);
    assert.strictEqual(a[0], "refused"); assert.strictEqual(b[0], "refused"); assert.strictEqual(seen.length, 0);
  });
});

(async () => {
  for (const [name, fn] of tests) {
    n++;
    try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack || e)); }
  }
  console.log(`${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();
