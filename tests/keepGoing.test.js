// node tests/keepGoing.test.js - end-of-turn detector (src/keepGoing.js)
const assert = require("assert");
const K = require("../src/keepGoing");

let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }

// ---- classify: text -> verdict (table-driven, real-world-style endings)
const TABLE = [
  // --- should NUDGE: announces a concrete next action, nobody blocks
  ["nudge", "Fixed the parser bug and the tests pass.\n\nNext: wiring the new check into the daily report."],
  ["nudge", "The scan finished clean.\n\nNext step: run the same scan on the NAS share."],
  ["nudge", "Backup verified. I'll now rotate the old snapshots."],
  ["nudge", "Done with the header change. Now I will update the tests."],
  ["nudge", "Config updated.\n\nStarting with the lensvid.com site, then the other three."],
  ["nudge", "Both files are in place. Then I'll restart the service and check the log."],
  ["nudge", "Found the cause: a stale lock file. Let me remove it and re-run the job."],
  ["nudge", "Registry entry added.\n\nI'm going to regenerate the PDF next."],
  ["nudge", "Phase 1 is complete.\n\n**Next up:** Phase 2, the importer."],
  ["nudge", "Understood. I will now read the handoff and start on the open items."],
  ["nudge", "Tests green (42/42).\n\n- Next: bump the version\n- Next: write the changelog entry"],
  ["none", "Both reports parsed.\n\nNext steps\n- merge the two tables\n- publish the summary"],
  // --- review probes (H1/L1): legitimately waiting or reporting -> never nudged
  ["blocked", "Started the 40-minute render in the background. I'll check on it when it finishes."],
  ["blocked", "The scan is running; I'll check back in 10 minutes."],
  ["blocked", "Deployed. I'll monitor the next run tomorrow at 08:00."],
  ["blocked", "Sent the spec to the Graphics agent. I will pick up the render when they answer."],
  ["blocked", "Sent the spec to the Graphics agent. I'll continue once they reply."],
  ["blocked", "Ready to push. Say go and I'll push."],
  ["blocked", "Everything is staged. Once you approve the diff I'll merge it."],
  ["none", "Review complete. Two HIGH findings.\n\nSuggested next steps for the builder: fix the 2 HIGH items."],
  ["none", "The next step is the GitHub push, which Iddo approved yesterday."],
  ["none", "Let me summarize what happened: all three sites were updated."],
  ["none", "I'll push the branch to GitHub now."],
  ["none", "Next: sending the report to the client."],
  // --- L1 false negatives fixed
  ["nudge", "The build is green. You can see the diff in the folder. Next: I'll now write the report."],
  ["nudge", "Registry updated. Now running module B."],
  ["nudge", "Starting the migration of the second site."],
  ["nudge", "Cleanup finished. Next, update the registry entry."],
  // --- second review: innocent words no longer read as waiting
  ["nudge", "Tests pass. Next: I'll wire up the monitor module."],
  ["nudge", "Tests pass. Next: I'll fix the approval dialog layout."],
  ["nudge", "Parser done. Next: I'll rename the later variable."],
  ["blocked", "Deployed to staging. I'll monitor the job and report."],
  ["nudge", "Cleanup done on D:. Proceeding with the E: drive now."],
  ["nudge", "I've reviewed the three candidates. I'm about to compare their output formats."],
  ["nudge", "The build succeeded. Moving on to the installer packaging."],
  ["nudge", "Picking up the SEO crawl where it stopped. Next: crawl the remaining 120 URLs."],
  // --- should NOT nudge: waiting on Iddo / another agent / question
  ["blocked", "Everything is ready.\n\nNext: Iddo should approve the DNS change."],
  ["blocked", "I drafted the email. Do you want me to send it?"],
  ["blocked", "Fixed. Want me to also update the docs?"],
  ["blocked", "I need your OK before I touch the production database."],
  ["blocked", "Waiting for the COO to answer which site goes first."],
  ["blocked", "Let me know if you want the full report or just the summary."],
  ["blocked", "Report is in the folder. Next, Iddo needs to open it and pick a variant."],
  ["blocked", "I've sent the question to the Graphics agent and am waiting for their reply."],
  ["blocked", "Two options: A is faster, B is cheaper. Which one should I use?"],
  ["blocked", "All steps done. For Iddo: please log in to the registrar and confirm the transfer."],
  ["blocked", "Can't continue until the NAS is back online. I'll stand by."],
  ["blocked", "The fleet throttle is HOLD so I'm pausing the backlog."],
  ["blocked", "I hit the weekly limit, so I will stop here."],
  ["blocked", "Next: ask Iddo whether to keep the old plugin."],
  ["blocked", "Once you confirm the license key, I'll continue with the install."],
  ["blocked", "Please approve the plan above and I'll start."],
  ["blocked", "Blocked on a password only Iddo can enter.\n\nNext: nothing until he does."],
  // --- finished
  ["done", "All tasks are complete. Nothing left to do."],
  ["done", "The backlog is empty, so I'm stopping here."],
  ["done", "No open tasks remain. Everything is done."],
  ["done", "That completes the migration. All three sites are on the new theme."],
  ["done", "Task complete: the PDF is generated and registered."],
  // --- protocol lines are honoured exactly
  ["blocked", "I'll now do the rest.\n\nBLOCKED: need Iddo's login for the registrar"],
  ["blocked", "Next: run the migration.\n\n**BLOCKED:** throttle HOLD"],
  ["done", "Next I'll rebuild the index.\n\nDONE: index rebuilt, 4 sites verified"],
  ["done", "Summary above.\nDONE - everything shipped"],
  // --- plain statements / reports without an announced next step
  ["none", "Yes, the file is at D:\\Dropbox\\Claude stuff\\report.pdf."],
  ["none", "The tests passed."],
  ["none", ""],
  ["none", "Handled."],
];
for (const [want, text] of TABLE) {
  t("classify " + want + ": " + text.slice(0, 50).replace(/\n/g, " "), () => {
    const r = K.classify(text);
    assert.strictEqual(r.verdict, want, "got " + r.verdict + " (" + r.reason + ")");
  });
}

// ---- protocol
t("protocolOf BLOCKED", () => assert.deepStrictEqual(K.protocolOf("x\nBLOCKED: no key").kind, "blocked"));
t("protocolOf DONE bold", () => assert.deepStrictEqual(K.protocolOf("x\n**DONE:** shipped").kind, "done"));
t("protocolOf ignores mid-text", () => assert.strictEqual(K.protocolOf("BLOCKED: x\na\nb\nc\nd"), null));

// ---- parseTail
const iso = (ms) => new Date(ms).toISOString();
function asst(ts, text, tool) {
  const content = [];
  if (text) content.push({ type: "text", text });
  if (tool) content.push({ type: "tool_use", name: "Bash", id: "t" + ts, input: {} });
  return JSON.stringify({ type: "assistant", timestamp: iso(ts), message: { role: "assistant", content } });
}
function usr(ts, text) { return JSON.stringify({ type: "user", timestamp: iso(ts), message: { role: "user", content: text } }); }
function res(ts) { return JSON.stringify({ type: "user", timestamp: iso(ts), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }); }

const NOW = Date.parse("2026-10-03T12:00:00Z");
function mk(lines, extra) {
  return Object.assign({ now: NOW, enabled: true, paused: false, working: false, halt: null, throttle: "GO", mission: null, parsed: K.parseTail(lines.join("\n")) }, extra || {});
}
const END = "Fixed it.\n\nNext: running the full test suite.";

t("parseTail basics", () => {
  const p = K.parseTail([usr(NOW - 300000, "do X"), asst(NOW - 290000, "", true), res(NOW - 280000), asst(NOW - 270000, END)].join("\n"));
  assert.strictEqual(p.last.role, "assistant");
  assert.strictEqual(p.turnToolUses, 1);
  assert.strictEqual(p.lastHuman.text, "do X");
  assert.strictEqual(p.lastHuman.systemish, false);
});
t("parseTail partial first line dropped", () => {
  const p = K.parseTail('garbage-not-json"}\n' + asst(NOW, "hi"), true);
  assert.strictEqual(p.entryCount, 1);
});
t("tool_result is not a human message", () => {
  const p = K.parseTail([usr(NOW - 9000, "go"), asst(NOW - 8000, "", true), res(NOW - 7000)].join("\n"));
  assert.strictEqual(p.lastHuman.text, "go");
});

// ---- decide
t("decide nudge", () => {
  const r = K.decide(mk([usr(NOW - 400000, "go"), asst(NOW - 300000, END)]));
  assert.strictEqual(r.verdict, "nudge");
});
t("decide: tool call ended the turn = not an announcement", () => {
  const r = K.decide(mk([usr(NOW - 400000, "go"), asst(NOW - 300000, "Next: tests.", true)]));
  assert.strictEqual(r.verdict, "none");
});
t("decide: working / paused / disabled", () => {
  const lines = [usr(NOW - 400000, "go"), asst(NOW - 300000, END)];
  assert.strictEqual(K.decide(mk(lines, { working: true })).verdict, "none");
  assert.strictEqual(K.decide(mk(lines, { paused: true })).verdict, "none");
  assert.strictEqual(K.decide(mk(lines, { enabled: false })).verdict, "none");
});
t("decide: rate-limit / auth / server error halt", () => {
  const lines = [usr(NOW - 400000, "go"), asst(NOW - 300000, END)];
  for (const kind of ["rate_limit", "auth", "server_error"]) assert.strictEqual(K.decide(mk(lines, { halt: { kind } })).verdict, "none");
});
t("decide: API error entry", () => {
  const e = JSON.stringify({ type: "assistant", isApiErrorMessage: true, timestamp: iso(NOW - 300000), message: { content: [{ type: "text", text: "API Error: next: x" }] } });
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, "go"), e])).verdict, "none");
});
t("decide: settling (<20s) defers", () => {
  const r = K.decide(mk([usr(NOW - 400000, "go"), asst(NOW - 5000, END)]));
  assert.strictEqual(r.verdict, "none"); assert.ok(r.defer);
});
t("decide: stale end of turn (> 3h)", () => {
  assert.strictEqual(K.decide(mk([usr(NOW - 4e7, "go"), asst(NOW - 4e7 + 1000, END)])).verdict, "none");
});
t("decide: human typed recently defers, old human message does not", () => {
  const r = K.decide(mk([usr(NOW - 40000, "what is the status"), asst(NOW - 30000, END)]));
  assert.strictEqual(r.verdict, "none"); assert.ok(r.defer);
  assert.strictEqual(K.decide(mk([usr(NOW - 200000, "what is the status"), asst(NOW - 100000, END)])).verdict, "nudge");
});
t("decide: throttle HOLD blocks, SLOW does not, missing = GO", () => {
  const lines = [usr(NOW - 400000, "go"), asst(NOW - 300000, END)];
  assert.strictEqual(K.decide(mk(lines, { throttle: "HOLD" })).verdict, "blocked");
  assert.strictEqual(K.decide(mk(lines, { throttle: "SLOW" })).verdict, "nudge");
  assert.strictEqual(K.decide(mk(lines, { throttle: null })).verdict, "nudge");
});
t("decide: handoff turn", () => {
  const hp = "[hid:abc] First save durable lessons to memory, then write D:\\a\\handoff_latest.md LAST, then reply only: Handoff saved";
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, hp), asst(NOW - 300000, "Handoff saved\n\nNext: the new session continues with X.")])).verdict, "none");
});
t("decide: protocol lines win over announcements", () => {
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, "go"), asst(NOW - 300000, "Next: x.\nBLOCKED: needs Iddo")])).verdict, "blocked");
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, "go"), asst(NOW - 300000, "Next: x.\nDONE: all shipped")])).verdict, "done");
});
t("decide: nudge message in the transcript counts as system, not human", () => {
  const r = K.decide(mk([usr(NOW - 100000, "[hid:z] " + K.NUDGE_TEXT), asst(NOW - 60000, END)]));
  assert.strictEqual(r.verdict, "nudge");
  assert.strictEqual(K.parseTail(usr(NOW - 100000, "[hid:z] " + K.NUDGE_TEXT)).lastHuman.isNudge, true);
});

// ---- mission after handoff
const RES = "[hid:q] " + K.resumePromptText("D:\\a\\handoff_history\\h.md", { mission: true });
const MISSION = { active: true, since: NOW - 500000, firstTurnDone: false };
t("mission: first turn after handoff, no tool calls, no announce phrase -> nudge", () => {
  const r = K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 300000, "Read the handoff. I have the picture.")], { mission: MISSION }));
  assert.strictEqual(r.verdict, "nudge"); assert.ok(r.mission);
});
t("mission: first turn that did work and ended plainly -> no nudge", () => {
  const r = K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 390000, "", true), res(NOW - 380000), asst(NOW - 300000, "Updated the config.")], { mission: MISSION }));
  assert.strictEqual(r.verdict, "none");
});
t("mission: BLOCKED / DONE line honoured", () => {
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 300000, "BLOCKED: waiting for Iddo's key")], { mission: MISSION })).verdict, "blocked");
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 300000, "DONE: nothing was open")], { mission: MISSION })).verdict, "done");
});
t("mission: a question to Iddo is not nudged", () => {
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 300000, "Which of the two sites first?")], { mission: MISSION })).verdict, "blocked");
});
t("mission: without a marker the same plain text is not nudged", () => {
  assert.strictEqual(K.decide(mk([usr(NOW - 400000, RES), asst(NOW - 300000, "Read the handoff. I have the picture.")])).verdict, "none");
});

// ---- handoff file parsing / resume text
const HF_OK = "# Handoff\n## LESSONS\n- a\n## OPEN NOW\n- finish the importer\n- review PR\n## STATE\nmid-way.\nExact next step: run `node import.js --resume`\n## KEY FACTS\nx\n";
t("parseHandoff: mission with exact next step", () => {
  const h = K.parseHandoff(HF_OK);
  assert.strictEqual(h.mission, true); assert.ok(/import\.js/.test(h.nextStep)); assert.strictEqual(h.blocked, false);
});
t("parseHandoff: empty OPEN NOW -> no mission", () => {
  assert.strictEqual(K.parseHandoff("## LESSONS\n- a\n## OPEN NOW\nNone\n## STATE\nidle\n## KEY FACTS\nx").mission, false);
});
t("parseHandoff: BLOCKED declared -> no mission", () => {
  const h = K.parseHandoff("## LESSONS\n- a\n## OPEN NOW\nBLOCKED: waiting for Iddo's decision on X\n- other\n## STATE\ns\n## KEY FACTS\nx");
  assert.strictEqual(h.blocked, true); assert.strictEqual(h.mission, false);
});
t("resumePromptText: mission text vs old text, marker kept", () => {
  const a = K.resumePromptText("P", { mission: true }), b = K.resumePromptText("P", { mission: false });
  assert.ok(a.startsWith("[[HANDOFF-RESUME]] P") && b.startsWith("[[HANDOFF-RESUME]] P"));
  assert.ok(/IMMEDIATELY/.test(a) && /do not recap/i.test(a) && /BLOCKED:/.test(a));
  assert.ok(/two short lines/.test(b));
});

t("parseHandoff: 'wait for Iddo to say go' is not a mission", () => {
  assert.strictEqual(K.parseHandoff("## LESSONS\n- a\n## OPEN NOW\n- x\n## STATE\nExact next step: wait for Iddo to say go, then push\n## KEY FACTS\nz").mission, false);
});
t("hashText stable + differs", () => {
  assert.strictEqual(K.hashText("abc"), K.hashText("abc"));
  assert.notStrictEqual(K.hashText("abc"), K.hashText("abd"));
});
t("nudgeLabelFor", () => {
  assert.ok(K.nudgeLabelFor("[hid:1] " + K.NUDGE_TEXT));
  assert.strictEqual(K.nudgeLabelFor("hello"), null);
});

console.log((n - fails) + "/" + n + " keepGoing tests passed");
process.exit(fails ? 1 : 0);
