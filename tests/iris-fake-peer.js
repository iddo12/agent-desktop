// A stand-in "other Agent Desktop" for testing IRIS against the sandbox app.
//   node tests/iris-fake-peer.js join "IRIS1:127.0.0.1:47322:XXXX-...."   pair with the app
//   node tests/iris-fake-peer.js send "text" [info|request]                send to the paired app
//   node tests/iris-fake-peer.js listen [seconds]                          print anything received
// State lives in %TEMP%\iris-fake-peer so it persists between commands.
const path = require("path");
const os = require("os");
const { IrisService } = require("../src/iris/service");

const [cmd, a1, a2] = process.argv.slice(2);
const svc = new IrisService({
  dir: path.join(os.tmpdir(), "iris-fake-peer"),
  name: "Fake Merav PC",
  port: 47399,
  bindHost: "127.0.0.1",
  deliver: (peer, env, framed) => console.log(`\n=== received from ${peer.name} ===\n${framed}\n`),
});

(async () => {
  await svc.setEnabled(true);
  try {
    if (cmd === "join") {
      console.log(JSON.stringify(await svc.join(a1), null, 2));
    } else if (cmd === "send") {
      const peer = Object.values(svc.peers)[0];
      if (!peer) throw new Error("not paired");
      console.log(JSON.stringify(svc.send({ peerId: peer.id, text: a1, type: a2 || "info", fromAgent: "fake COO" })));
      await svc.flushOutbox();
      console.log(JSON.stringify(svc.status().outbox, null, 2));
    } else if (cmd === "listen") {
      const secs = Number(a1) || 30;
      console.log(`listening ${secs}s on 127.0.0.1:47399`);
      await new Promise((r) => setTimeout(r, secs * 1000));
    } else if (cmd === "status") {
      console.log(JSON.stringify(svc.status(), null, 2));
    } else {
      console.log("usage: join <invite> | send <text> [type] | listen [secs] | status");
    }
  } finally {
    await svc.stop();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
