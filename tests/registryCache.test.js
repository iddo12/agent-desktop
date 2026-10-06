// Run: node tests/registryCache.test.js
// v1.77.3: registry list cache. Equals the uncached list, rebuilds when an entry file changes/appears/vanishes,
// reuses the answer (no per-entry fs calls) while the folder is unchanged.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const realLoad = Module._load;
Module._load = function (req) { if (req === "electron") return { shell: {}, clipboard: {}, nativeImage: {} }; return realLoad.apply(this, arguments); };
const registry = require("../src/registry");
Module._load = realLoad;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "adreg-"));
const dir = path.join(ws, "shared_registry");
fs.mkdirSync(dir);
const doc = path.join(ws, "d1.pdf");
fs.writeFileSync(doc, "x");
function put(id, extra) {
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(Object.assign({ id, type: "document", title: id, agent: "A", link: doc, updatedAt: "2026-10-0" + (id.length % 9 + 1) }, extra || {})));
}
put("one"); put("three");
const strip = (l) => JSON.parse(JSON.stringify(l));
const a = registry.listRegistry(ws);
assert.deepStrictEqual(strip(a), strip(registry.mergeWebCopies(registry.listRegistryRaw(ws))), "cached list equals the uncached build");
assert.strictEqual(a.length, 2);

// unchanged folder: same object, and no per-entry existence checks
let exists = 0;
const realExists = fs.existsSync;
fs.existsSync = function () { exists++; return realExists.apply(fs, arguments); };
assert.strictEqual(registry.listRegistry(ws), a, "second call returns the memoized list");
assert.strictEqual(exists, 0, "no existsSync per entry while unchanged");
fs.existsSync = realExists;

// a new entry, a changed entry and a removed entry each rebuild at once
put("seven");
assert.strictEqual(registry.listRegistry(ws).length, 3, "added entry visible immediately");
put("one", { title: "ONE CHANGED title longer" });
assert.ok(registry.listRegistry(ws).some((e) => e.title === "ONE CHANGED title longer"), "changed entry visible immediately");
fs.unlinkSync(path.join(dir, "seven.json"));
assert.strictEqual(registry.listRegistry(ws).length, 2, "removed entry gone immediately");

// linked file vanishing is bounded by the 60 s memo: explicit invalidate shows it
fs.unlinkSync(doc);
assert.ok(!registry.listRegistry(ws).some((e) => e.missing), "within the memo window the old existence answer is served");
registry.invalidateListCache();
assert.ok(registry.listRegistry(ws).every((e) => e.missing), "after invalidate the missing link shows");
assert.deepStrictEqual(registry.listRegistry(path.join(ws, "nowhere")), [], "no registry folder = empty list");

fs.rmSync(ws, { recursive: true, force: true });
console.log("registryCache.test.js: all assertions passed");
