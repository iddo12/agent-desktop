// Claude Code workspace trust (v1.54.0).
//
// Claude Code 2.1.281 started refusing to run `claude --bg` in a folder whose
// workspace-trust prompt was never accepted. Run from a plain shell it prints
// "Workspace not trusted. Run `claude` in <dir> once and accept the trust
// prompt, then retry." Under node-pty - which is how this app runs it - it
// instead draws the interactive "Quick safety check: Is this a project you
// created or one you trust?" menu and waits for a keypress forever. Every
// agent whose .claude-session folder had never been trusted (COO, Product
// Development, Software Engineering, Video Editing on 2026-09-24) therefore hung
// its dispatch until the 90 s CLI timeout and never ran at all.
//
// Trust is a security decision, so this app never grants it on its own for an
// existing agent. It only ever writes it on an explicit user action: the
// "Trust and start them" button, or creating a new agent in the app (creating
// the folder is consent for that one folder). Everything here is plain
// Node - no Electron - so it can be unit-tested against a copy of the file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { withFsRetry } = require("./fsRetry");

// Matched against pty output with terminal codes AND all whitespace removed
// (ConPTY often draws a space as a cursor-forward code, so "one you trust"
// can arrive as "oneyoutrust") - hence \s* between words rather than a space.
const TRUST_PROMPT_RE =
  /Quick\s*safety\s*check|project\s*you\s*created\s*or\s*one\s*you\s*trust|Workspace\s*not\s*trusted|Yes,\s*I\s*trust\s*this\s*folder/i;

// Claude Code keeps its global config (which holds per-project trust) at
// $CLAUDE_CONFIG_DIR/.claude.json when that is set, else ~/.claude.json.
function claudeConfigPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

// The config's "projects" map is keyed by the absolute path with forward
// slashes ("D:/Dropbox/Claude stuff/COO Agent/.claude-session").
function projectKeyFor(dir) {
  return path.resolve(dir).replace(/\\/g, "/");
}

// Windows paths are case-insensitive, so reuse whatever spelling of the key
// Claude Code itself already wrote rather than adding a second entry.
function findExistingKey(projects, key) {
  if (Object.prototype.hasOwnProperty.call(projects, key)) return key;
  if (process.platform !== "win32") return null;
  const lower = key.toLowerCase();
  return Object.keys(projects).find((k) => k.toLowerCase() === lower) || null;
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Sets hasTrustDialogAccepted: true for each folder in `dirs`, touching
// nothing else in the file. One backup per call, then a read-modify-write kept
// as short as possible: the file is re-read immediately before the change (it
// is shared with every running Claude Code process, which rewrite it often),
// the change and the write happen synchronously in the same tick, and the
// write goes to a temp file that is renamed over the original so a reader can
// never see a half-written file. Refuses to write if the current file does
// not parse - clobbering a config we cannot read would be far worse than
// failing to trust a folder.
//
// Returns { configPath, backupPath, changed: [keys], alreadyTrusted: [keys],
// verified: bool } - verified is a re-read after the rename confirming every
// requested key now carries the flag.
function markFoldersTrusted(dirs, opts = {}) {
  const configPath = opts.configPath || claudeConfigPath();
  const keys = [...new Set((dirs || []).filter(Boolean).map(projectKeyFor))];
  const result = { configPath, backupPath: null, changed: [], alreadyTrusted: [], verified: false };
  if (!keys.length) {
    result.verified = true;
    return result;
  }

  let exists = fs.existsSync(configPath);
  if (exists) {
    result.backupPath = `${configPath}.bak-agent-desktop-${backupStamp()}`;
    withFsRetry(() => fs.copyFileSync(configPath, result.backupPath));
  }

  // Re-read right before writing (not the copy above - the file may have
  // changed while the backup was being taken).
  let config = {};
  exists = fs.existsSync(configPath);
  if (exists) {
    const raw = withFsRetry(() => fs.readFileSync(configPath, "utf-8"));
    try {
      config = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Refusing to edit ${configPath}: it does not parse as JSON (${e.message})`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Refusing to edit ${configPath}: unexpected top-level shape`);
    }
  }
  if (!config.projects || typeof config.projects !== "object") config.projects = {};

  for (const key of keys) {
    const existingKey = findExistingKey(config.projects, key);
    const useKey = existingKey || key;
    const entry = config.projects[useKey];
    if (entry && typeof entry === "object" && entry.hasTrustDialogAccepted === true) {
      result.alreadyTrusted.push(useKey);
      continue;
    }
    config.projects[useKey] = { ...(entry && typeof entry === "object" ? entry : {}), hasTrustDialogAccepted: true };
    result.changed.push(useKey);
  }

  if (result.changed.length) {
    const tmpPath = `${configPath}.agent-desktop-tmp-${process.pid}`;
    const text = JSON.stringify(config, null, 2); // Claude Code's own format
    withFsRetry(() => fs.writeFileSync(tmpPath, text, "utf-8"));
    try {
      withFsRetry(() => fs.renameSync(tmpPath, configPath));
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e2) {}
      throw e;
    }
  }

  try {
    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const projects = (after && after.projects) || {};
    result.verified = [...result.changed, ...result.alreadyTrusted].every((k) => {
      const entry = projects[k];
      return !!(entry && entry.hasTrustDialogAccepted === true);
    });
  } catch (e) {
    result.verified = false;
  }
  return result;
}

module.exports = { TRUST_PROMPT_RE, claudeConfigPath, projectKeyFor, markFoldersTrusted };
