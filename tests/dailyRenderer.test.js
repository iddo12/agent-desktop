// node tests/dailyRenderer.test.js - guard: every render*/compute*/paint*/tabCounts helper the My Daily renderer calls is declared in the file
// (v1.75.6 shipped with renderTabs deleted by a bad edit, which blanked the whole view; eslint's no-undef test could not run on that machine).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "daily.js"), "utf8");
const declared = new Set([...src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
const called = new Set([...src.matchAll(/(?<![.\w])((?:render|compute|paint)[A-Z][A-Za-z0-9]*|tabCounts|demoBanner|noticeBanner)\s*\(/g)].map((m) => m[1]));
const missing = [...called].filter((n) => !declared.has(n));
if (missing.length) { console.error("FAIL: called but not declared in renderer/daily.js: " + missing.join(", ")); process.exit(1); }
console.log(`dailyRenderer: ${called.size} helpers all declared`);
