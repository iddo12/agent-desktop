#!/usr/bin/env node
// IRIS command-line tool - how an agent (normally the COO) sends a message to a
// linked Agent Desktop. Talks to the running app over a local named pipe; the
// app does the checks, sealing and delivery.
//
//   node tools/iris.js peers
//   node tools/iris.js send --to "<peer name or id>" --text "..." [--type info|request|reply] [--reply-to <id>] [--from "<agent>"]
//   node tools/iris.js send --to "<peer>" --file message.txt
//   add --test to talk to the sandbox instance
const fs = require("fs");
const path = require("path");
const net = require("net");

const args = process.argv.slice(2);
const isTest = args.includes("--test");
const cmd = args.find((a) => !a.startsWith("--") && !isValueOf(a));
function isValueOf(a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith("--") && !["--test"].includes(args[i - 1]);
}
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
const dir = path.join(appData, isTest ? "agent-desktop-test" : "agent-desktop", "iris");
let pipeName;

function fail(msg) {
  console.error(`iris: ${msg}`);
  process.exit(1);
}

let token;
try { token = fs.readFileSync(path.join(dir, "local-token"), "utf8").trim(); } catch (e) {
  fail(`can't read the local token in ${dir} - is Agent Desktop running with IRIS installed?`);
}

// The app picks a random pipe name at each start and writes it here.
try { pipeName = fs.readFileSync(path.join(dir, "pipe-name"), "utf8").trim(); } catch (e) {
  fail("can't find the IRIS pipe name - is Agent Desktop running?");
}

let req;
if (cmd === "peers" || cmd === "status") {
  req = { cmd };
} else if (cmd === "send") {
  let text = opt("text");
  if (opt("file")) text = fs.readFileSync(opt("file"), "utf8");
  if (!opt("to")) fail("--to is required");
  if (!text) fail("--text or --file is required");
  req = { cmd: "send", to: opt("to"), text, type: opt("type") || "info", replyTo: opt("reply-to"), fromAgent: opt("from") || path.basename(process.cwd().replace(/[\\/]\.claude-session$/, "")) };
} else {
  console.log("usage: iris.js peers | send --to <peer> --text <text> [--type info|request|reply] [--reply-to <id>] [--test]");
  process.exit(cmd ? 1 : 0);
}
req.token = token;

const sock = net.createConnection(pipeName);
let buf = "";
sock.setTimeout(30000, () => fail("timed out talking to Agent Desktop"));
sock.on("error", (e) => fail(`Agent Desktop isn't reachable (${e.code || e.message})`));
sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
sock.on("data", (d) => { buf += d.toString("utf8"); });
sock.on("end", () => {
  let res;
  try { res = JSON.parse(buf.trim()); } catch (e) { fail("bad reply from Agent Desktop"); }
  if (!res.ok) fail(res.reason || "failed");
  if (cmd === "send") {
    if (res.pending) {
      console.log(`queued to ${res.peer} - id ${res.id} - a reply only leaves this machine after a human approves it in the Links tab`);
    } else {
      console.log(`sent to ${res.peer} - id ${res.id} - ${res.status === "delivered" ? "delivered" : "queued (will retry until it expires)"}`);
    }
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
});
