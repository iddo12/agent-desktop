// Run: node tests/libraryState.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create } = require("../src/libraryState");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libstate-"));
const file = path.join(dir, "library-state.json");
let s = create(file);
assert.deepStrictEqual(s.get(), { read: {}, history: {} });
assert.ok(s.apply({ op: "read", id: "doc-1", value: true }).ok);
assert.ok(s.get().read["doc-1"].at);
assert.ok(s.apply({ op: "history", id: "doc-1", record: { to: "Security", toName: "Security", action: "build this", comment: "go" } }).ok);
// survives a "restart": a fresh instance reads the file back
s = create(file);
assert.ok(s.get().read["doc-1"]);
assert.strictEqual(s.get().history["doc-1"][0].action, "build this");
assert.ok(s.apply({ op: "read", id: "doc-1", value: false }).ok);
assert.strictEqual(s.get().read["doc-1"], undefined);
assert.strictEqual(s.apply({ op: "read", id: "../x", value: true }).ok, false);
assert.strictEqual(s.apply({ op: "nope", id: "a" }).ok, false);
for (let i = 0; i < 60; i++) s.apply({ op: "history", id: "d2", record: { comment: "c" + i } });
assert.strictEqual(s.get().history.d2.length, 50);
fs.rmSync(dir, { recursive: true, force: true });
console.log("libraryState ok");
