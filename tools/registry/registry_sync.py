"""Keeps Agent Desktop's Projects view (Ideas / Researched / Active) fed automatically.

WHY: project ideas get lost among many parallel efforts. The
registry (registry.py) already holds everything that was BUILT or WRITTEN; this
script adds the earlier life of a project, without anyone having to remember to
register it:

  idea        written down somewhere, nobody has studied it yet
  researched  a research paper/brief exists
  active      being built or in use (all pre-existing projects)

Sources, all read-only, run nightly (and safe to run any time - it is idempotent):
  1. Research\\**\\*.pdf in the workspace (skipped if there is no Research folder). A PDF already registered gets stage
     'researched' (once, if it has no stage); one that is not registered yet is
     registered as a document with stage 'researched'.
  2. A task store, if you have one (shared_reports\\tasks\\*.json, skipped if absent), tagged 'idea' or 'proposal' -> idea.
     When the task closes, the auto entry is archived.
  3. *_pending_notes.md headings that contain idea / proposal / concept and are
     not marked DONE / RESOLVED -> idea, described by the section's first paragraph.

Entries this script creates carry "auto": true and are the only ones it will
ever archive or rewrite; anything an agent or a person registered by hand is left
alone except for the one-time backfill of a missing 'stage' field.

    python registry_sync.py            # apply
    python registry_sync.py --dry-run  # show what would change
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry as R  # noqa: E402

ROOT = str(R.WORKSPACE)  # AGENT_DESKTOP_ROOT, or the folder containing agent-desktop
TASK_DIR = os.path.join(ROOT, "shared_reports", "tasks")
IDEA_TAGS = {"idea", "proposal"}
IDEA_HEADING = re.compile(r"\b(idea|proposal|concept)\b", re.I)
# Process/guideline papers, not research into a project idea.
SKIP_FOLDERS = {"creator_tools"}  # add folders of process papers that are not project research
DONE_HEADING = re.compile(r"\b(done|resolved|rolled back|superseded)\b", re.I)

# A pending note may quote a credential in plain text; never copy one into a
# card your screen shows.
SECRETISH = re.compile(r"(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{28,}")


def clean(text, limit=220):
    text = SECRETISH.sub("[hidden]", str(text or ""))
    text = re.sub(r"[`*#>]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def norm(p):
    return os.path.normcase(os.path.normpath(str(p or ""))).replace("\\", "/") if p else ""


def first_paragraph(md_text):
    paras = [p.strip() for p in re.split(r"\n\s*\n", md_text) if p.strip()]
    for p in paras:
        if not p.startswith("#") and not p.startswith("|") and not p.startswith("---"):
            return clean(p)
    return ""


class Sync:
    def __init__(self, dry):
        self.dry = dry
        self.changes = []
        self.entries = {e["id"]: e for e in R.load_all()}

    def put(self, entry, why):
        self.changes.append(f"{why}: {entry['id']}")
        if not self.dry:
            R.save(entry)
        self.entries[entry["id"]] = entry

    def new(self, entry_id, type_, title, desc, agent, topic, link, stage, why):
        now = R._now()
        e = {"id": entry_id, "sourcePath": None, "type": type_, "title": title,
             "description": desc, "agent": agent, "topic": topic, "link": link,
             "thumbnail": None, "status": "active", "stage": stage, "auto": True,
             "createdAt": now, "updatedAt": now, "confirmedAt": now}
        self.put(e, why)

    # -- backfill --------------------------------------------------------
    def backfill_projects(self):
        for e in list(self.entries.values()):
            if e["type"] == "project" and "stage" not in e and not e.get("auto"):
                e = dict(e)
                # The Ostrakon proposal was registered with a free-text status that
                # hid it from the Library; it belongs in Researched.
                if str(e.get("status", "")).startswith("proposal"):
                    e["stage"], e["status"] = "researched", "active"
                else:
                    e["stage"] = "active"
                self.put(e, "stage backfilled")

    # -- 1. research PDFs ---------------------------------------------------
    def research(self):
        known = {}
        for e in self.entries.values():
            for k in ("link", "pdf"):
                if e.get(k):
                    known[norm(e[k])] = e
        for pdf in sorted(glob.glob(os.path.join(ROOT, "Research", "**", "*.pdf"), recursive=True)):
            if os.path.basename(os.path.dirname(pdf)).lower() in SKIP_FOLDERS:
                continue
            hit = known.get(norm(pdf)) or known.get(norm(pdf[:-4] + ".md"))
            if hit:
                if "stage" not in hit:
                    hit = dict(hit)
                    hit["stage"] = "researched"
                    self.put(hit, "marked researched")
                continue
            folder = os.path.basename(os.path.dirname(pdf))
            md = pdf[:-4] + ".md"
            desc = ""
            if os.path.exists(md):
                try:
                    desc = first_paragraph(open(md, encoding="utf-8").read())
                except OSError:
                    pass
            title = os.path.basename(pdf)[:-4].replace("_", " ").strip().capitalize()
            self.new(f"research-{R._slug(os.path.basename(pdf)[:-4])}", "document", title,
                     desc or f"Research paper found in Research\\{folder}; not yet described.",
                     "Unassigned (auto-found)", folder.replace("_", " "), pdf, "researched",
                     "research PDF registered")

    # -- 2. tagged tasks ----------------------------------------------------
    def tasks(self):
        seen = set()
        for path in sorted(glob.glob(os.path.join(TASK_DIR, "*.json"))):
            try:
                d = json.load(open(path, encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for t in d.get("items", []):
                tags = {str(x).strip().lower() for x in (t.get("tags") or [])}
                if not tags & IDEA_TAGS:
                    continue
                eid = f"idea-task-{R._slug(t.get('id'))}"
                if t.get("status") == "done":
                    continue
                seen.add(eid)
                cur = self.entries.get(eid)
                if cur:
                    if cur.get("auto") and cur.get("status") != "active":
                        cur = dict(cur)
                        cur["status"], cur["updatedAt"] = "active", R._now()
                        self.put(cur, "task idea reopened")
                    continue
                self.new(eid, "project", clean(t.get("title"), 120), clean(t.get("detail")),
                         d.get("agent") or "Unassigned", "Task idea", "shared_reports/tasks/" + os.path.basename(path),
                         "idea", "idea from task")
        # A task idea whose task closed or vanished is no longer an open idea.
        for e in list(self.entries.values()):
            if e.get("auto") and e["id"].startswith("idea-task-") and e["id"] not in seen and e.get("status") == "active":
                e = dict(e)
                e["status"] = "archived"
                e["updatedAt"] = R._now()
                self.put(e, "task idea closed")

    # -- 3. pending notes ---------------------------------------------------
    def notes(self):
        seen = set()
        for path in sorted(glob.glob(os.path.join(ROOT, "*_pending_notes.md"))):
            base = os.path.basename(path)[: -len("_pending_notes.md")]
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            parts = re.split(r"(?m)^(#{2,3})\s+(.+)$", text)
            # parts: [pre, hashes, heading, body, hashes, heading, body, ...]
            for i in range(1, len(parts) - 2, 3):
                heading, body = parts[i + 1].strip(), parts[i + 2]
                if not IDEA_HEADING.search(heading) or DONE_HEADING.search(heading):
                    continue
                eid = f"idea-note-{R._slug(base)[:20]}-{R._slug(heading)[:24]}-{hashlib.md5(heading.encode('utf-8')).hexdigest()[:6]}"
                seen.add(eid)
                if eid in self.entries:
                    continue
                self.new(eid, "project", clean(re.sub(r"^\d{4}-\d{2}-\d{2}\s*[-–—]\s*", "", heading), 120),
                         first_paragraph(body), base.replace("_", " ").title(), "Pending note", path,
                         "idea", "idea from pending note")
        # A note idea whose heading was marked done, renamed or removed is no longer open.
        for e in list(self.entries.values()):
            if e.get("auto") and e["id"].startswith("idea-note-") and e["id"] not in seen and e.get("status") == "active":
                e = dict(e)
                e["status"], e["updatedAt"] = "archived", R._now()
                self.put(e, "note idea closed")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    s = Sync(args.dry_run)
    s.backfill_projects()
    s.research()
    s.tasks()
    s.notes()
    for c in s.changes:
        print(c)
    print(f"{len(s.changes)} change(s){' (dry run, nothing written)' if args.dry_run else ''}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
