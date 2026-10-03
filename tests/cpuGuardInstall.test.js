// Run: node tests/cpuGuardInstall.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const g = require("../src/cpuGuardInstall");

const bin = "C:\\Users\\Me\\AppData\\Roaming\\agent-desktop\\cpuguard\\bin";
const stateDir = "C:\\Users\\Me\\AppData\\Roaming\\agent-desktop\\cpuguard";
const wantArgs = g.buildTaskArguments({ vbs: bin + "\\RunHidden.vbs", ps1: bin + "\\CpuGuard.ps1", stateDir });

// arguments and XML
assert.strictEqual(wantArgs, `//B "${bin}\\RunHidden.vbs" "${bin}\\CpuGuard.ps1" -StateDir "${stateDir}"`);
const xml = g.buildTaskXml({ userId: "PC\\Me & Co", vbs: bin + "\\RunHidden.vbs", ps1: bin + "\\CpuGuard.ps1", stateDir, binDir: bin });
assert.ok(xml.includes("<LogonTrigger>"));
assert.ok(xml.includes("<RunLevel>LeastPrivilege</RunLevel>"), "no elevation");
assert.ok(xml.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "no time limit");
assert.ok(xml.includes("<RestartOnFailure>"), "restart on failure");
assert.ok(xml.includes("<Command>wscript.exe</Command>"));
assert.ok(xml.includes("PC\\Me &amp; Co"), "xml escaped");
assert.ok(xml.includes("&quot;"), "quotes in arguments escaped");
assert.ok(!/HighestAvailable/.test(xml));

assert.strictEqual(g.parseGuardVersion("<#" + String.fromCharCode(10) + "CPUGUARD_VERSION=2.2" + String.fromCharCode(10) + "foo"), "2.2");
assert.strictEqual(g.parseGuardVersion("nothing"), null);
assert.strictEqual(g.parseGuardVersion(fs.readFileSync(path.join(__dirname, "..", "tools", "cpuguard", "CpuGuard.ps1"), "utf8")), "2.2");
assert.ok(g.defaultStateDir({ APPDATA: "C:\\A" }).endsWith(path.join("agent-desktop", "cpuguard")));

// decisions
const d = (o) => g.decideEnsure({ platform: "win32", testMode: false, flags: {}, existing: [], wantArgs, shippedVersion: "2.2", ...o }).action;
assert.strictEqual(d({ platform: "linux" }), "none");
assert.strictEqual(d({ testMode: true }), "none");
assert.strictEqual(d({}), "ask", "first time: ask");
assert.strictEqual(d({ flags: { cpuGuardConsent: "no" } }), "none", "declined: never ask again");
assert.strictEqual(d({ flags: { cpuGuardConsent: "yes" } }), "install", "consented but task gone");
assert.strictEqual(d({ flags: { cpuGuardEnabled: false, cpuGuardConsent: "yes" } }), "none", "turned off");
assert.strictEqual(d({ existing: [{ name: "SEC_CpuGuard", state: "Running" }] }), "none", "foreign guard running");
assert.strictEqual(d({ existing: [{ name: "SEC_CpuGuard", state: "Ready" }] }), "none", "legacy guard exists: no second one");
assert.strictEqual(d({ existing: [{ name: g.TASK_NAME, state: "Running", args: wantArgs }], flags: { cpuGuardVersion: "2.2" } }), "none", "ours running, current");
assert.strictEqual(d({ existing: [{ name: g.TASK_NAME, state: "Ready", args: wantArgs }], flags: { cpuGuardVersion: "2.2", cpuGuardConsent: "yes" } }), "start");
assert.strictEqual(d({ existing: [{ name: g.TASK_NAME, state: "Running", args: wantArgs }], flags: { cpuGuardVersion: "2.0" } }), "reinstall", "app updated, newer script");
assert.strictEqual(d({ existing: [{ name: g.TASK_NAME, state: "Running", args: '//B "D:/old/app/x.vbs" "D:/old/app/CpuGuard.ps1"' }], flags: { cpuGuardVersion: "2.2" } }), "reinstall", "path changed");
assert.strictEqual(d({ existing: [{ name: g.TASK_NAME, state: "Disabled", args: wantArgs }], flags: { cpuGuardVersion: "2.2" } }), "none", "disabled by user");
console.log("cpuGuardInstall ok");
