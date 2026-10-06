"""PHEME -> Agent Desktop delivery client (Agent Desktop v1.77.4+).

Hands dictated text to the agent that is open in Agent Desktop over its local named pipe instead of clicking at a guessed
screen position. Pure standard library. Agent Desktop publishes, per start, in %APPDATA%\\agent-desktop\\pheme\\:
    local-token   random token (readable only by this Windows user)
    pipe-name     the pipe of this start
Environment override for tests: PHEME_AD_DIR (the folder that holds those two files).

Result of deliver(): (status, info)
    ("ok", {"agent", "verified", "written", "queued"?})  delivered (verified=False, written=True: handed over, the transcript
                                                          did not confirm yet - do NOT resend)
    ("refused", {"reason", "agent"?})                    Agent Desktop answered no (nothing selected, My Daily showing,
                                                          pty not attached, text too long, ...) - nothing was typed
    ("unavailable", {"reason"})                          no Agent Desktop pipe (older version / not running) - caller may
                                                          use the click method
"""
import json
import os
import threading

MAX_TEXT = 20000


def ad_dir():
    d = os.environ.get("PHEME_AD_DIR")
    if d:
        return d
    return os.path.join(os.environ.get("APPDATA", ""), "agent-desktop", "pheme")


class Unavailable(Exception):
    pass


def _read(name):
    with open(os.path.join(ad_dir(), name), "r", encoding="utf-8") as f:
        return f.read().strip()


def _other_pipes(skip):
    pre = "\\\\.\\pipe\\"
    try:
        names = os.listdir(pre)
    except OSError:
        return []
    import re
    return [pre + n for n in names if re.match(r"^agent-desktop-pheme-[0-9a-f]+$", n) and pre + n != skip]


def _talk(pipe, req, timeout):
    """One JSON line out, one JSON line back. Raises Unavailable if the pipe cannot be opened or answers nothing."""
    out = {}

    def work():
        try:
            with open(pipe, "r+b", buffering=0) as f:
                f.write((json.dumps(req) + "\n").encode("utf-8"))
                buf = b""
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    buf += chunk
                    if b"\n" in buf:
                        break
            out["reply"] = buf.decode("utf-8", "replace").strip()
        except OSError as e:
            out["err"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        # The request may already have been taken: this is NOT 'unavailable' (a click fallback could duplicate it).
        raise TimeoutError("no answer from Agent Desktop within %ss" % timeout)
    if "err" in out:
        raise Unavailable("cannot open the Agent Desktop pipe: %s" % out["err"])
    try:
        return json.loads(out.get("reply") or "")
    except ValueError:
        raise TimeoutError("unreadable answer from Agent Desktop")


def call(cmd, timeout=60, **fields):
    try:
        token = _read("local-token")
        pipe = _read("pipe-name")
    except OSError as e:
        raise Unavailable("no Agent Desktop pheme pipe info (%s)" % e.__class__.__name__)
    req = dict(fields, cmd=cmd, token=token)
    tried = [pipe]
    try:
        return _talk(pipe, req, timeout)
    except Unavailable as first:
        # a stale pipe-name (old instance): try any live pheme pipe, each one checks the token itself
        for p in _other_pipes(pipe):
            tried.append(p)
            try:
                return _talk(p, req, timeout)
            except Unavailable:
                continue
        raise first


def selected_agent(timeout=10):
    """('ok', {'agent': name}) | ('refused', {'reason'}) | ('unavailable', {'reason'})"""
    try:
        r = call("selected-agent", timeout=timeout)
    except Unavailable as e:
        return "unavailable", {"reason": str(e)}
    except TimeoutError as e:
        return "refused", {"reason": "timeout: " + str(e)}
    if r.get("ok"):
        return "ok", {"agent": r.get("agent")}
    return "refused", {"reason": r.get("reason", "refused"), "agent": r.get("agent")}


def deliver(text, source="pheme", timeout=60):
    if not isinstance(text, str) or not text.strip():
        return "refused", {"reason": "empty-text"}
    if len(text) > MAX_TEXT:
        return "refused", {"reason": "text-too-long"}
    try:
        r = call("send-to-selected", timeout=timeout, text=text, source=source)
    except Unavailable as e:
        return "unavailable", {"reason": str(e)}
    except TimeoutError as e:
        return "refused", {"reason": "timeout (state unknown, not resent): " + str(e)}
    if r.get("ok"):
        return "ok", {k: r[k] for k in ("agent", "verified", "written", "queued", "how") if k in r}
    return "refused", {"reason": r.get("reason", "refused"), "agent": r.get("agent")}
