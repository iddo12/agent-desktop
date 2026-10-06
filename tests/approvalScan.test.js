// Run: node tests/approvalScan.test.js
// v1.77.3 approval scan: a stale non-blocked job file of the same agent must not reset the 90 s waiting timer
// (the Approve/Deny banner depended on it), jobs older than 36 h are never stat'ed twice, unchanged files are not re-read.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const scan = require("../src/approvalScan");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adappr-"));
const now = Date.now();
function job(id, st, ageMs) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const f = path.join(dir, id, "state.json");
  fs.writeFileSync(f, JSON.stringify(st));
  const t = new Date(now - ageMs);
  fs.utimesSync(f, t, t);
}
const accept = (st) => (st.cwd ? path.dirname(st.cwd) : null);
const blocked = (cwd) => ({ cwd, tempo: "blocked", needs: "approve Bash: ls" });
const idle = (cwd) => ({ cwd, tempo: "idle", needs: "" });

// stale idle job sorts BEFORE and AFTER the blocked one: the agent must still report blocked
job("a-stale", idle("/x/Agent1/.claude-session"), 3600e3);
job("m-block", blocked("/x/Agent1/.claude-session"), 1000);
job("z-stale", idle("/x/Agent1/.claude-session"), 7200e3);
job("q-only-idle", idle("/x/Agent2/.claude-session"), 1000);
const cache = scan.createScanCache();
let r = scan.collectAgentJobStates(dir, now, cache, accept);
assert.ok(r.get("/x/Agent1").blocked, "blocked job wins over stale idle files");
assert.strictEqual(r.get("/x/Agent2").blocked, null);

// simulate main's loop: since entry survives 3 passes
const since = new Map();
for (let pass = 0; pass < 3; pass++) {
  r = scan.collectAgentJobStates(dir, now + pass * 60e3, cache, accept);
  for (const [ap, e] of r) { if (!e.blocked) since.delete(ap); else if (!since.has(ap)) since.set(ap, now + pass * 60e3); }
}
assert.strictEqual(since.get("/x/Agent1"), now, "waiting timer kept from the first pass");

// several blocked files: newest mtime wins
job("b1", { cwd: "/x/Agent3/.claude-session", tempo: "blocked", needs: "approve Read: OLD" }, 5000);
job("b2", { cwd: "/x/Agent3/.claude-session", tempo: "blocked", needs: "approve Read: NEW" }, 1000);
r = scan.collectAgentJobStates(dir, now, scan.createScanCache(), accept);
assert.strictEqual(r.get("/x/Agent3").blocked.needs, "approve Read: NEW");

// cwd filter / non-approve blocked
job("c1", { cwd: "/x/Agent4/.claude-session", tempo: "blocked", needs: "answer a question" }, 1000);
r = scan.collectAgentJobStates(dir, now, scan.createScanCache(), (st) => (/Agent4/.test(st.cwd) ? null : path.dirname(st.cwd)));
assert.ok(!r.has("/x/Agent4"), "rejected by accept()");
r = scan.collectAgentJobStates(dir, now, scan.createScanCache(), accept);
assert.strictEqual(r.get("/x/Agent4").blocked, null, "blocked on a question is not an approval");

// old jobs: stat'ed once, then never; unchanged files not re-read
job("old1", blocked("/x/Agent5/.claude-session"), 40 * 3600e3);
const c2 = scan.createScanCache();
let stats = 0, reads = 0;
const spy = { readdirSync: fs.readdirSync, statSync: (p) => { stats++; return fs.statSync(p); }, readFileSync: (p, e) => { reads++; return fs.readFileSync(p, e); } };
r = scan.collectAgentJobStates(dir, now, c2, accept, spy);
assert.ok(!r.has("/x/Agent5"), "older than 36 h ignored");
const s1 = stats, r1 = reads;
scan.collectAgentJobStates(dir, now, c2, accept, spy);
assert.strictEqual(stats - s1, s1 - 1, "second pass skips the one old job (one stat less)");
assert.strictEqual(reads - r1, 0, "second pass re-reads nothing (mtime unchanged)");
// a changed file is re-read
job("m-block", idle("/x/Agent1/.claude-session"), 500);
r = scan.collectAgentJobStates(dir, now, c2, accept, spy);
assert.strictEqual(r.get("/x/Agent1").blocked, null, "agent unblocked after its job file changed");
assert.strictEqual(scan.collectAgentJobStates(path.join(dir, "nope"), now, c2, accept), null, "missing jobs dir = null");

fs.rmSync(dir, { recursive: true, force: true });
console.log("approvalScan.test.js: all assertions passed");
