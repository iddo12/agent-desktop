// Fails (exit 1) when package.json's version has no "## v<version> - <title>" heading in CLAUDE.md.
// That heading is what the "Update & restart" dialog shows under "What's new" (app-update.js
// changelogFromClaudeMd). Run by .git/hooks/pre-commit; run it by hand after any version bump:
//   node tools/check-changelog.js
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const md = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
const re = new RegExp("^## +v" + version.split(".").join("[.]") + " +- +[^ ]", "m");
if (!re.test(md)) {
  console.error("No changelog entry for v" + version + ": add a heading '## v" + version + " - <short title>' to CLAUDE.md (it is the \"What's new\" text in the update dialog).");
  process.exit(1);
}
console.log("changelog entry for v" + version + " present");
