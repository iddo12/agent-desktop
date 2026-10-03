"""The workspace registry: every document written and every thing built.

One place that answers "what have my agents made, and where is it?". Agent
Desktop's Library (Projects / Documents / Images tabs) reads it.

REGISTERING IS PART OF FINISHING THE WORK. Put a standing line in your agents'
CLAUDE.md so each one registers what it makes and keeps the entry current when
the thing changes. A stale registry is worse than none.

    # register something you just made
    python registry.py --add --type project \\
        --title "Business card scanner" \\
        --agent "Trade Show Agent" --topic "Trade shows" \\
        --link "C:/Projects/cards/README.md" \\
        --desc "Reads business-card photos into a contact list."

    python registry.py                      # everything, grouped
    python registry.py --type document      # just documents
    python registry.py --agent Research     # one agent's output
    python registry.py --json               # for Agent Desktop to read
    python registry.py --update <id> --desc "..." --link "..."
    python registry.py --touch <id>         # confirm it is still accurate
    python registry.py --stale              # entries nobody has confirmed lately
    python registry.py --remove <id>
    python registry.py --add --type project --stage idea --title "..." ...

STAGE (optional): idea | researched | active - where a project sits in the
Projects pipeline. A project with no stage counts as active.

STORAGE. One JSON file per entry under `<root>/shared_registry/`, where <root>
is the AGENT_DESKTOP_ROOT environment variable, or the folder that contains
`agent-desktop`. One file per entry rather than a single shared list so two
agents registering at the same moment cannot overwrite each other.
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import time

WORKSPACE = pathlib.Path(os.environ.get("AGENT_DESKTOP_ROOT") or pathlib.Path(__file__).resolve().parents[3])
REGISTRY_DIR = WORKSPACE / "shared_registry"
# Registered images are COPIED here rather than linked in place, so an entry never
# points at a scratch path that gets cleaned up later.
IMAGES_DIR = REGISTRY_DIR / "images"

# Warn past this. Not a hard stop - refusing to register a deliverable because
# a folder got big would be the wrong trade - but it should never grow quietly.
IMAGES_WARN_MB = 500

# An image is the one type where the thumbnail IS the thing, so --link and
# --thumbnail usually point at the same file; the tab renders these as a gallery.
TYPES = ("project", "document", "image")

# Where a project sits in its life (ideas must not get lost
# among many parallel efforts). idea = written down only; researched = someone
# studied it and there is a paper/brief; active = being built or in use.
# Missing on an entry means "active" for a project (all older entries), and
# "not a pipeline item" for a document. Documents may carry a stage too: a
# research paper is the proof a project is "researched".
STAGES = ("idea", "researched", "active")

# How long before an entry is worth re-checking. Long enough not to nag,
# short enough that a link rotted months ago gets noticed.
STALE_AFTER_DAYS = 90


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _slug(text, fallback=None):
    """An id from the title, with a fallback for titles that have no ASCII.

    Added 2026-09-23: the first Hebrew-titled document registered here came out
    with the id "entry", because stripping non-ASCII left nothing behind. The
    next Hebrew document would have collided with it. When the title yields
    nothing usable, fall back to the file name behind the entry's link, which
    is ASCII in practice and still says what the thing is.
    """
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(text or "")).strip("-").lower()
    if not s and fallback:
        stem = re.sub(r"\.[a-z0-9]+$", "", str(fallback).replace("\\", "/").rstrip("/").rsplit("/", 1)[-1])
        s = re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-").lower()
    return s[:48] or "entry"


def load_all():
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(REGISTRY_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _path_for(entry_id):
    return REGISTRY_DIR / f"{entry_id}.json"


def save(entry):
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_DIR / f".{entry['id']}.tmp"
    tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    # Dropbox briefly locks a file it has just synced, so a replace straight
    # after an --add can fail with WinError 5; retry for up to ~15s.
    import time
    for attempt in range(16):
        try:
            tmp.replace(_path_for(entry["id"]))
            break
        except PermissionError:
            if attempt == 15:
                raise
            time.sleep(1)
    return entry


def find(entry_id):
    """By full id or unique prefix - nobody should have to type the whole thing."""
    q = str(entry_id).strip().lower()
    entries = load_all()
    exact = [e for e in entries if e["id"].lower() == q]
    if exact:
        return exact[0]
    partial = [e for e in entries if q in e["id"].lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        raise LookupError(f"{entry_id!r} matches {len(partial)}: " + ", ".join(e["id"] for e in partial))
    return None


def _adopt_image(link):
    """Copy an image into the registry's own folder; return the new path.

    Falls back to leaving the link alone if the source cannot be read, since a
    link to something is better than refusing to register it at all.
    """
    src = pathlib.Path(link)
    if not src.is_file():
        return link, None
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    dest = IMAGES_DIR / src.name
    n = 1
    while dest.exists() and dest.stat().st_size != src.stat().st_size:
        dest = IMAGES_DIR / f"{src.stem}-{n}{src.suffix}"
        n += 1
    try:
        if not dest.exists():
            shutil.copy2(src, dest)
    except OSError:
        return link, None
    return str(dest), str(src)


def images_total_mb():
    try:
        return sum(f.stat().st_size for f in IMAGES_DIR.glob("*") if f.is_file()) / (1024 * 1024)
    except OSError:
        return 0.0


def _warn_if_hidden_document(entry):
    """Agent Desktop's Library hides every entry whose status is not 'active'.
    A document registered as e.g. 'draft' is therefore invisible to the user - this
    happened to the COO on 2026-09-24. Say so loudly, on stderr, but change
    nothing: archiving a document on purpose is legitimate."""
    status = entry.get("status") or "active"
    if entry.get("type") == "document" and status != "active":
        print(f"WARNING: status is {status!r}. This document will NOT appear in the "
              f"Documents tab until its status is 'active' "
              f"(registry.py --update {entry['id']} --status active).", file=sys.stderr)


def add(args):
    if args.type not in TYPES:
        raise ValueError(f"--type must be one of {', '.join(TYPES)}")
    if args.stage and args.stage not in STAGES:
        raise ValueError(f"--stage must be one of {', '.join(STAGES)}")
    if not args.title or not args.agent or not args.link:
        raise ValueError("--title, --agent and --link are all required")
    entry_id = f"{_slug(args.title, fallback=args.link)}"
    if _path_for(entry_id).exists():
        entry_id = f"{entry_id}-{int(time.time()) % 100000}"
    source_path = None
    if args.type == "image" and not args.no_copy:
        args.link, source_path = _adopt_image(args.link)
        if args.thumbnail is None:
            args.thumbnail = args.link
    entry = {
        "id": entry_id,
        "sourcePath": source_path,
        "type": args.type,
        "title": args.title,
        "description": args.desc or "",
        "agent": args.agent,
        "topic": args.topic or "Uncategorised",
        "link": args.link,
        "thumbnail": args.thumbnail or (args.link if args.type == "image" else None),
        "status": args.status or "active",
        **({"stage": args.stage} if args.stage else {}),
        "createdAt": _now(),
        "updatedAt": _now(),
        "confirmedAt": _now(),
    }
    save(entry)
    print(f"registered {entry_id}  ({entry['type']}, {entry['agent']})")
    _warn_if_hidden_document(entry)
    if entry["type"] == "image":
        total = images_total_mb()
        print(f"  copied into {IMAGES_DIR}")
        if total > IMAGES_WARN_MB:
            print(f"  NOTE: registry images now total {total:.0f} MB - over the {IMAGES_WARN_MB} MB "
                  f"watch level. Dropbox is capacity-limited; tell the Optimization agent.")
    return 0


def update(args):
    entry = find(args.update)
    if not entry:
        raise LookupError(f"no entry {args.update!r}")
    # Library shows only the latest version of a document; the link being replaced is
    # kept (newest first, max 20, no repeats) so older versions open from a fine-print list.
    if args.link and entry.get("link") and entry["link"] != args.link:
        older = [v for v in entry.get("olderVersions", []) if v.get("link") not in (entry["link"], args.link)]
        older.insert(0, {"link": entry["link"], "replacedAt": _now()})
        entry["olderVersions"] = older[:20]
    for field, value in (("title", args.title), ("description", args.desc), ("link", args.link),
                         ("topic", args.topic), ("agent", args.agent), ("thumbnail", args.thumbnail),
                         ("status", args.status), ("type", args.type), ("pdf", args.pdf),
                         ("stage", args.stage)):
        if value:
            entry[field] = value
    entry["updatedAt"] = _now()
    entry["confirmedAt"] = _now()
    save(entry)
    print(f"updated {entry['id']}")
    _warn_if_hidden_document(entry)
    return 0


def touch(args):
    """Say 'still accurate' without changing anything - resets the stale clock."""
    entry = find(args.touch)
    if not entry:
        raise LookupError(f"no entry {args.touch!r}")
    entry["confirmedAt"] = _now()
    save(entry)
    print(f"{entry['id']} confirmed current")
    return 0


def remove(args):
    entry = find(args.remove)
    if not entry:
        raise LookupError(f"no entry {args.remove!r}")
    _path_for(entry["id"]).unlink()
    print(f"removed {entry['id']}")
    return 0


def _days_since(stamp):
    try:
        then = time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S"))
        return (time.time() - then) / 86400
    except (ValueError, TypeError):
        return 0


def stale(args):
    rows = [e for e in load_all() if _days_since(e.get("confirmedAt")) > STALE_AFTER_DAYS]
    if not rows:
        print(f"Nothing unconfirmed for more than {STALE_AFTER_DAYS} days.")
        return 0
    print(f"{len(rows)} entr(ies) not confirmed in {STALE_AFTER_DAYS}+ days:\n")
    for e in rows:
        print(f"  {e['id']:<40} {int(_days_since(e['confirmedAt']))}d  ({e['agent']})")
    print("\nCheck each is still accurate, then: registry.py --touch <id>")
    return 0


def show(args):
    rows = load_all()
    if args.type:
        rows = [e for e in rows if e["type"] == args.type]
    if args.agent:
        rows = [e for e in rows if args.agent.lower() in e["agent"].lower()]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("Registry is empty.")
        return 0
    for kind in TYPES:
        group = [e for e in rows if e["type"] == kind]
        if not group:
            continue
        print(f"\n{kind.upper()}S ({len(group)})")
        by_topic = {}
        for e in group:
            by_topic.setdefault(e.get("topic") or "Uncategorised", []).append(e)
        for topic in sorted(by_topic):
            print(f"\n  {topic}")
            for e in by_topic[topic]:
                flag = "" if e.get("status") == "active" else f"  [{e.get('status')}]"
                print(f"    {e['title']}{flag}")
                print(f"      {e['agent']}  ·  {e['id']}")
                if e.get("description"):
                    print(f"      {e['description']}")
                print(f"      {e['link']}")
    print(f"\n{len(rows)} entr(ies).")
    return 0


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # Windows consoles default to a codec that chokes on non-ASCII titles
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--add", action="store_true")
    p.add_argument("--update", metavar="ID")
    p.add_argument("--touch", metavar="ID")
    p.add_argument("--remove", metavar="ID")
    p.add_argument("--stale", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--type", choices=TYPES)
    p.add_argument("--title")
    p.add_argument("--desc")
    p.add_argument("--agent")
    p.add_argument("--topic")
    p.add_argument("--link")
    p.add_argument("--thumbnail")
    # A PDF copy of a document whose main link is a web page (every document should be
    # openable as a PDF). For plain documents, just make --link the PDF.
    p.add_argument("--pdf", help="path to a PDF copy (when --link is a web page)")
    p.add_argument("--status", help="active | archived | superseded")
    p.add_argument("--stage", choices=STAGES,
                   help="pipeline stage in Agent Desktop's Projects view: idea | researched | active")
    p.add_argument("--no-copy", action="store_true",
                   help="for images: link in place instead of copying into the registry "
                        "(use for very large files that should not go into Dropbox)")
    p.add_argument("--size", action="store_true", help="how much space registered images use")
    # For an image the file itself is the preview, so default --thumbnail to
    # --link rather than making every caller pass the same path twice.
    args = p.parse_args(argv)

    if args.add:
        return add(args)
    if args.update:
        return update(args)
    if args.touch:
        return touch(args)
    if args.remove:
        return remove(args)
    if args.stale:
        return stale(args)
    if args.size:
        total = images_total_mb()
        count = len(list(IMAGES_DIR.glob("*"))) if IMAGES_DIR.exists() else 0
        print(f"{count} image file(s), {total:.1f} MB in {IMAGES_DIR}")
        print(f"watch level {IMAGES_WARN_MB} MB - {'OVER' if total > IMAGES_WARN_MB else 'under'}")
        return 0
    return show(args)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (LookupError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
