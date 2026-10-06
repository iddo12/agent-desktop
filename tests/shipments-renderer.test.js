// node tests/shipments-renderer.test.js - guards for the Shipments tab renderer (src/renderer/daily-shipments.js) and its wiring in daily.js.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.join(__dirname, "..", "src");
const src = fs.readFileSync(path.join(root, "renderer", "daily-shipments.js"), "utf8");
const daily = fs.readFileSync(path.join(root, "renderer", "daily.js"), "utf8");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "styles-daily.css"), "utf8");
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }

t("renderer file compiles", () => { new vm.Script(src, { filename: "daily-shipments.js" }); });
t("no HTML parsing: textContent only", () => {
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) assert.ok(!src.includes(bad), "uses " + bad);
});
t("no timers in the tab (the poll lives in the main process)", () => {
  assert.ok(!/setInterval\s*\(/.test(src));
  assert.ok(!/setTimeout\s*\(/.test(src.replace(/setTimeout\(\(\) => inp2?\.focus\(\), 0\);/g, "")), "only the focus() nudge may use setTimeout");
});
t("tracking key goes through a password input and is cleared after sending", () => {
  assert.ok(/inp\.type = "password"/.test(src));
  assert.ok(/inp\.value = ""/.test(src));
  assert.ok(!/console\.(log|error)\([^)]*(key|Key)/.test(src));
});
t("event text carries dir=auto for Hebrew", () => { assert.ok(/setAttribute\("dir", "auto"\)/.test(src)); });
t("tab is wired next to Shopping, script loaded before daily.js, preload exposes the channels", () => {
  assert.ok(/\["shopping", "Shopping lists"\], \["shipments", "Shipments"\]/.test(daily));
  assert.ok(html.indexOf("daily-shipments.js") > 0 && html.indexOf("daily-shipments.js") < html.indexOf('src="daily.js"'));
  for (const c of ["daily-shipments-load", "daily-shipments-refresh", "daily-shipments-op", "daily-shipments-key"]) assert.ok(preload.includes(c), c);
});
t("css has the chip classes the legend and rows use, and a narrow layout", () => {
  for (const c of [".ship-chip.bad", ".ship-chip.warn", ".ship-chip.ok", "#daily-view.narrow .ship-row"]) assert.ok(css.includes(c), c);
});
t("every helper the renderer calls is declared", () => {
  const declared = new Set([...src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]).concat([...src.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1])));
  for (const name of ["load", "row", "group", "addBar", "keyBox", "render", "act", "chipEl", "ago", "dayText"]) assert.ok(declared.has(name), name + " not declared");
});
console.log(`shipments-renderer: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
