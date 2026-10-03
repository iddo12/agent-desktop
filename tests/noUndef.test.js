// Run: node tests/noUndef.test.js
// v1.69.4 guard: an undefined variable in main.js / the renderer only fails at run time (v1.69.4 round 1 shipped a
// ReferenceError that broke every attach). ESLint no-undef over all app source, with the known globals of each side.
const { ESLint } = require("eslint");
const globals = require("globals");
const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..");

async function lint(patterns, extraGlobals, sourceType, extraIgnoreNames) {
  const eslint = new ESLint({
    cwd: root, overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.js", "**/*.cjs"],
      languageOptions: { ecmaVersion: 2023, sourceType, globals: Object.assign({}, extraGlobals) },
      rules: { "no-undef": "error" },
    }],
  });
  const res = await eslint.lintFiles(patterns);
  const bad = [];
  for (const r of res) for (const m of r.messages) bad.push(`${path.relative(root, r.filePath)}:${m.line}:${m.column} ${m.message}`);
  return bad;
}
// the renderer files are plain <script> tags sharing one global scope: names declared at the top level of any of them are globals
function rendererTopLevelNames() {
  const dir = path.join(root, "src", "renderer");
  const names = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      const m = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) names[m[1]] = "writable";
    }
  }
  return names;
}
(async () => {
  const bad = []
    .concat(await lint(["src/*.js", "src/*.cjs"], Object.assign({ window: "readonly" }, globals.node), "commonjs"))
    .concat(await lint(["src/renderer/*.js"], Object.assign({}, globals.browser, rendererTopLevelNames(), { Terminal: "readonly", FitAddon: "readonly", WebLinksAddon: "readonly" }), "script"));
  if (bad.length) { console.error("undefined variables:\n" + bad.join("\n")); process.exit(1); }
  console.log("noUndef ok");
})().catch((e) => { console.error(e); process.exit(1); });
