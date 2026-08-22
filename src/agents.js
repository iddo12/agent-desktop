const fs = require("fs");
const path = require("path");
const { withFsRetry } = require("./fsRetry");

// Agents live as sibling folders next to agent-desktop itself, under one
// shared parent directory. Defaults to that parent directory so it works
// out of the box wherever you clone this repo; override with
// AGENT_DESKTOP_ROOT if you want your agents to live somewhere else.
const ROOT = process.env.AGENT_DESKTOP_ROOT || path.resolve(__dirname, "..", "..");
const STATE_FILENAME = "master_state.md";
const CONFIG_FILENAME = "agent_config.json";
const AVATAR_FILENAME = "avatar.png";
const SESSIONS_DIRNAME = "sessions";

// "sessions" (root-level) holds shared handoff transcripts, not an agent -
// each agent's OWN sessions/ subfolder (its archive, inside its own folder)
// is a different thing and isn't affected by this exclusion. If ROOT
// contains other non-agent folders (a shared reference doc, a legacy tool,
// etc.), list them via AGENT_DESKTOP_EXTRA_EXCLUDE (comma-separated) rather
// than hardcoding them here, so this stays generic across setups.
const EXTRA_EXCLUDED = (process.env.AGENT_DESKTOP_EXTRA_EXCLUDE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const EXCLUDED_FOLDERS = new Set(["agent-desktop", ".claude", "node_modules", "sessions", ...EXTRA_EXCLUDED]);

const HEALTH_LABELS = {
  healthy: "Healthy",
  good: "Healthy",
  ok: "Healthy",
  green: "Healthy",
  warning: "Warning",
  degraded: "Warning",
  "at risk": "Warning",
  amber: "Warning",
  yellow: "Warning",
  critical: "Critical",
  error: "Critical",
  down: "Critical",
  red: "Critical",
};

function healthLabel(raw) {
  const key = (raw || "").trim().toLowerCase();
  return HEALTH_LABELS[key] || "Unknown";
}

function extractSection(text, names) {
  for (const name of names) {
    const pattern = new RegExp(`^#{1,6}\\s*${escapeRegExp(name)}\\s*$`, "im");
    const m = pattern.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index + m[0].length);
    const nextHeading = /^#{1,6}\s/m.exec(rest);
    const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
    const lines = body
      .split("\n")
      .map((l) => l.trim().replace(/^[-*]\s*/, ""))
      .filter((l) => l.length > 0 && l !== "---");
    if (lines.length > 0) return lines;
  }
  return [];
}

function extractField(text, names) {
  for (const name of names) {
    const pattern = new RegExp(`^\\s*[-*]?\\s*\\*{0,2}${escapeRegExp(name)}\\*{0,2}\\s*:\\s*(.+)$`, "im");
    const m = pattern.exec(text);
    if (m) return m[1].trim().replace(/\*+$/, "").trim();
  }
  return null;
}

function extractFieldOrSection(text, names) {
  const section = extractSection(text, names);
  if (section.length > 0) return section.join(" ");
  return extractField(text, names);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMasterState(text) {
  return {
    status: extractFieldOrSection(text, ["Status", "Current Status"]) || "No status field found",
    health: extractFieldOrSection(text, ["Health"]) || "Unknown",
    updated: extractFieldOrSection(text, ["Last Updated", "Updated"]),
    tasks: extractSection(text, ["Recent Tasks", "Tasks", "Recent Activity"]),
  };
}

function loadAgentConfig(agentDir) {
  const cfgPath = path.join(agentDir, CONFIG_FILENAME);
  if (fs.existsSync(cfgPath)) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch (e) {
      /* fall through to default */
    }
  }
  return { display_name: path.basename(agentDir), role: "", avatar: null };
}

function avatarDataUrl(agentDir, config) {
  if (!config.avatar) return null;
  const avatarPath = path.join(agentDir, config.avatar);
  if (!fs.existsSync(avatarPath)) return null;
  const buf = fs.readFileSync(avatarPath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// A denylist alone isn't enough - any folder ROOT happens to contain (a
// saved document, a random project, anything not explicitly excluded)
// showed up in the sidebar as if it were a real agent, confirmed live: a
// folder holding nothing but a stray .docx rendered as "No work plan yet"
// with a truncated folder name for a title. Requiring agent_config.json
// alone was the first fix tried, but broke live: this app's own oldest
// agents (Security among them) predate that file existing at all and have
// never had one, relying only on master_state.md/sessions/.claude-session.
// Any ONE of these four markers is what actually distinguishes a set-up
// agent from an arbitrary folder - none of them being present is what a
// stray folder (like the .docx one) actually looks like.
function looksLikeAgentFolder(agentDir) {
  return (
    fs.existsSync(path.join(agentDir, CONFIG_FILENAME)) ||
    fs.existsSync(path.join(agentDir, STATE_FILENAME)) ||
    fs.existsSync(path.join(agentDir, SESSIONS_DIRNAME)) ||
    fs.existsSync(path.join(agentDir, ".claude-session"))
  );
}

function listAgents() {
  if (!fs.existsSync(ROOT)) return [];
  const entries = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !EXCLUDED_FOLDERS.has(e.name) && looksLikeAgentFolder(path.join(ROOT, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map((entry) => {
    const agentDir = path.join(ROOT, entry.name);
    const statePath = path.join(agentDir, STATE_FILENAME);
    const hasState = fs.existsSync(statePath);
    const raw = hasState ? fs.readFileSync(statePath, "utf-8") : "";
    const parsed = hasState
      ? parseMasterState(raw)
      : { status: "No work plan yet", health: "Unknown", updated: null, tasks: [] };
    const config = loadAgentConfig(agentDir);

    return {
      folderName: entry.name,
      path: agentDir,
      displayName: config.display_name || entry.name,
      role: config.role || "",
      avatar: avatarDataUrl(agentDir, config),
      healthLabel: healthLabel(parsed.health),
      status: parsed.status,
      tasks: parsed.tasks,
      updated: parsed.updated,
      hasState,
    };
  });
}

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "").trim();
}

// Recurses looking for any actual file - a directory tree of only empty
// subdirectories (e.g. a leftover empty .claude-session left behind after
// deleting an agent - confirmed to actually happen, likely Dropbox's own
// background sync recreating a directory shortly after a delete finishes,
// since it was a just-killed process's own working directory) counts as
// nothing, not a real collision.
function hasAnyFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (hasAnyFile(path.join(dir, entry.name))) return true;
  }
  return false;
}

function createAgent({ name, role, avatarBuffer, avatarExt }) {
  const folderName = sanitizeFolderName(name);
  if (!folderName) throw new Error("Agent name is required");

  const agentDir = path.join(ROOT, folderName);
  if (fs.existsSync(agentDir) && hasAnyFile(agentDir)) {
    throw new Error(`A folder named "${folderName}" already exists`);
  }

  withFsRetry(() => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, SESSIONS_DIRNAME), { recursive: true });
  });

  const config = { display_name: name, role: role || "", avatar: null };

  if (avatarBuffer) {
    const avatarPath = path.join(agentDir, AVATAR_FILENAME);
    withFsRetry(() => fs.writeFileSync(avatarPath, avatarBuffer));
    config.avatar = AVATAR_FILENAME;
  }

  withFsRetry(() => fs.writeFileSync(path.join(agentDir, CONFIG_FILENAME), JSON.stringify(config, null, 2), "utf-8"));
  withFsRetry(() =>
    fs.writeFileSync(
      path.join(agentDir, STATE_FILENAME),
      "## Status\nJust created - no work plan set yet.\n\n## Health\nUnknown\n\n## Recent Tasks\n- (none logged yet)\n",
      "utf-8"
    )
  );

  return agentDir;
}

// Deliberately does NOT rename the agent's own folder even if the display
// name changes - the folder name is tied to that agent's session identity
// (.claude-session lives inside it, and its own Claude Code project bucket
// in ~/.claude/projects/ is keyed off this exact path). Renaming it would
// either orphan an active pty session or require coordinating a rename
// across a running node-pty process, and Dropbox-sync (or any cloud-sync
// tool) file operations can be flaky around exactly this kind of surgery -
// renaming a folder with an active process's cwd inside it, mid-sync.
// Editing only ever changes what's displayed, never the underlying path.
function updateAgent(agentPath, { name, role, avatarBuffer }) {
  if (!fs.existsSync(agentPath)) throw new Error("Agent folder not found");
  const config = loadAgentConfig(agentPath);
  if (name && name.trim()) config.display_name = name.trim();
  config.role = role || "";

  if (avatarBuffer) {
    withFsRetry(() => fs.writeFileSync(path.join(agentPath, AVATAR_FILENAME), avatarBuffer));
    config.avatar = AVATAR_FILENAME;
  }

  withFsRetry(() => fs.writeFileSync(path.join(agentPath, CONFIG_FILENAME), JSON.stringify(config, null, 2), "utf-8"));
  return agentPath;
}

// Only ever deletes a direct child of ROOT - refuses anything else outright
// (a symlink, a path-traversal attempt, ROOT itself) rather than trusting
// the caller's path. This is a real, permanent, unrecoverable delete of the
// agent's entire folder (config, avatar, and its full sessions\ archive) -
// the renderer gates this behind a type-the-name-to-confirm step before it
// ever reaches here, precisely because there's no undo on this side.
function deleteAgent(agentPath) {
  const resolved = path.resolve(agentPath);
  if (path.dirname(resolved) !== path.resolve(ROOT)) {
    throw new Error("Refusing to delete a path outside the agents root");
  }
  if (!fs.existsSync(resolved)) throw new Error("Agent folder not found");
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = { ROOT, listAgents, createAgent, updateAgent, deleteAgent, SESSIONS_DIRNAME };
