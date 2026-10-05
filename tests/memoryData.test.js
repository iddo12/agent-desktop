// Run: node tests/memoryData.test.js
// memory-data.js: name matching, richest-key-wins, token baseline, folder-key validation.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getMemoryData, openMemoryFolder, norm } = require("../src/memory-data");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "memdata-"));
const put = (rel, obj) => { const p = path.join(ws, ...rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); };
const P = "D--Dropbox-Claude-stuff-";
put(["Security", "Tools", "MemTier", "out", "memory_stats.json"], { generated: "2026-10-05T05:00:00", agents: [
  { agent: P + "Security--claude-session", l1_bytes: 500, l2_bytes: 0, l3_bytes: 10, l3_files: 1, l1_cap: 4096 },
  { agent: P + "Security", l1_bytes: 3959, l2_bytes: 51657, l3_bytes: 484396, l3_files: 244, l1_cap: 4096 },
  { agent: P + "System-Optimization---Maintenance-Agent--claude-session", l1_bytes: 3668, l2_bytes: 0, l3_bytes: 46507, l3_files: 24, l1_cap: 4096 },
  { agent: "E--Claude-work-Security-sandbox", l1_bytes: 9, l2_bytes: 9, l3_bytes: 9, l3_files: 9, l1_cap: 4096 },
] });
put(["System Optimization & Maintenance Agent", "UsageModel", "data", "baseline_context.json"], {
  at: "2026-10-05T02:54:38Z",
  agents: { "Security": { medianFirstTurnTokens: 84318 }, "System Optimization Maintenance Agent": { medianFirstTurnTokens: 60036 } },
  history: [ { date: "a", agents: { "Security": 80000 } }, { date: "b", agents: { "Security": 84318 } } ],
});

const d = getMemoryData(ws);
assert.strictEqual(d.ok, true);
assert.strictEqual(Object.keys(d.agents).length, 2, "sandbox key skipped, duplicates merged");
assert.strictEqual(d.agents[norm("Security")].l3, 484396, "richest key wins");
assert.strictEqual(d.agents[norm("Security")].tokens, 84318);
assert.strictEqual(d.agents[norm("Security")].prevTokens, 80000, "previous figure that differs from today's");
assert.strictEqual(d.agents[norm("System Optimization & Maintenance Agent")].tokens, 60036, "& dropped on both sides");
assert.strictEqual(d.agents[norm("System Optimization & Maintenance Agent")].prevTokens, null);
assert.strictEqual(getMemoryData(path.join(ws, "nope")).ok, false);
assert.strictEqual(openMemoryFolder(ws, "..\\..\\evil").ok, false, "unknown key rejected");
assert.strictEqual(openMemoryFolder(ws, "E--Claude-work-Security-sandbox").ok, false, "non-agent key rejected");
fs.rmSync(ws, { recursive: true, force: true });
console.log("memoryData.test.js ok");
