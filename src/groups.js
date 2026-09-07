const fs = require("fs");
const path = require("path");
const { withFsRetry } = require("./fsRetry");

// Groups ("folders" / "categories" in the UI) live in ONE JSON file next to
// the agent folders, under the same shared parent directory agents.js scans.
// Override the parent with AGENT_DESKTOP_ROOT, same as agents.js.
const ROOT = process.env.AGENT_DESKTOP_ROOT || path.resolve(__dirname, "..", "..");
const GROUPS_FILENAME = "agent_groups.json";
const GROUPS_PATH = path.join(ROOT, GROUPS_FILENAME);

// ---------------------------------------------------------------------------
// What this file is, and just as importantly what it is NOT
// ---------------------------------------------------------------------------
// agent_groups.json is a PURELY VISUAL grouping for the Agent Desktop
// sidebar - a way to see at a glance which agents belong together. It does
// NOT define reporting lines, which agent answers to which "manager", or any
// operational hierarchy. That lives in each agent's own CLAUDE.md, not here.
// The app shows a one-time, dismissible note making this explicit the first
// time a group is created; the same caveat is in README.md. Keep both in
// sync if this behaviour ever changes.
//
// On-disk shape:
//   {
//     "version": 1,
//     "groups": [
//       {
//         "id": "g_ab12cd",          // stable, generated once
//         "name": "Core & Executive",
//         "color": "#3b82f6",        // any CSS color the picker produces
//         "parentId": null,           // another group's id, or null for top level
//         "order": 0,                 // sort order among siblings
//         "members": ["Security"]     // agent FOLDER names, ordered
//       }
//     ]
//   }
//
// `parentId` exists from day one so groups can eventually nest (a group
// inside a group). The current UI only exposes one level, but the data model
// already supports arbitrary depth, so adding nested-group UI later needs no
// migration.
//
// Agents are referenced by FOLDER NAME - the stable, load-bearing identifier
// an agent's session identity is keyed on (see agents.js) - never by display
// name, which the user can edit freely. An agent may appear in at most one
// group; any accidental duplicate is resolved first-group-wins on load.

function defaultGroupsDoc() {
  return { version: 1, groups: [] };
}

function readGroups() {
  if (!fs.existsSync(GROUPS_PATH)) return defaultGroupsDoc();
  try {
    const parsed = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
    if (!parsed || !Array.isArray(parsed.groups)) return defaultGroupsDoc();
    return normalizeGroupsDoc(parsed);
  } catch (e) {
    // A corrupt or half-written file must never take the sidebar down - fall
    // back to "no groups" (every agent renders as Ungrouped, i.e. exactly the
    // pre-feature flat list) rather than throwing.
    return defaultGroupsDoc();
  }
}

// Idempotent cleanup applied on every read and every write, so the renderer
// never has to defend against a malformed group array and the file on disk
// stays tidy no matter what was posted to it.
function normalizeGroupsDoc(doc) {
  const claimed = new Set(); // agent folder names already placed in a group
  const rawGroups = Array.isArray(doc.groups) ? doc.groups : [];

  let groups = rawGroups
    .filter((g) => g && typeof g.id === "string" && typeof g.name === "string" && g.name.trim())
    .map((g, i) => {
      const rawMembers = Array.isArray(g.members) ? g.members : [];
      const members = [];
      for (const m of rawMembers) {
        if (typeof m !== "string" || !m) continue;
        if (claimed.has(m)) continue; // first group to list an agent keeps it
        claimed.add(m);
        members.push(m);
      }
      return {
        id: g.id,
        name: g.name.trim(),
        color: typeof g.color === "string" && g.color.trim() ? g.color.trim() : "#6b7280",
        parentId: typeof g.parentId === "string" && g.parentId ? g.parentId : null,
        order: Number.isFinite(g.order) ? g.order : i,
        members,
      };
    });

  // Drop parentId values that don't point at a real group (a deleted parent,
  // a bad hand-edit) so the renderer's tree walk can't loop or orphan.
  const ids = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    if (g.parentId && !ids.has(g.parentId)) g.parentId = null;
  }
  // Guard against a parentId cycle (only possible via a hand-edit): if
  // following parents from a group ever revisits it, flatten it to top level.
  for (const g of groups) {
    const seen = new Set([g.id]);
    let cur = g.parentId;
    while (cur) {
      if (seen.has(cur)) {
        g.parentId = null;
        break;
      }
      seen.add(cur);
      const parent = groups.find((x) => x.id === cur);
      cur = parent ? parent.parentId : null;
    }
  }

  // Re-pack sibling order to a clean 0..n-1 per parent.
  const byParent = new Map();
  for (const g of groups) {
    const key = g.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(g);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.order - b.order);
    siblings.forEach((g, i) => {
      g.order = i;
    });
  }
  groups.sort((a, b) => a.order - b.order);

  return { version: 1, groups };
}

function writeGroups(doc) {
  const normalized = normalizeGroupsDoc(doc && typeof doc === "object" ? doc : defaultGroupsDoc());
  withFsRetry(() => fs.writeFileSync(GROUPS_PATH, JSON.stringify(normalized, null, 2), "utf-8"));
  return normalized;
}

module.exports = { readGroups, writeGroups, GROUPS_PATH, GROUPS_FILENAME };
