"use strict";
// Android arka plan motoru: arayüz kapansa bile (ön plan servisi sayesinde) çalışmaya devam eder.
const { channel } = require("bridge");
const { Manager } = require("./src/engine");
const store = require("./src/store");
process.on("uncaughtException", (e) => channel.send("log", { t: Date.now(), level: "err", msg: "Beklenmeyen hata: " + e.message }));
process.on("unhandledRejection", () => {});

const m = new Manager(store);
["log", "guard", "qr", "names"].forEach((ev) => m.on(ev, (p) => channel.send(ev, p)));
m.start();
setInterval(() => channel.send("snap", m.snapshot()), 1000);

const ops = {
  hello: () => ({ names: m.names, history: m.history }),
  "add-token": (a) => m.addByToken(a.token),
  "add-cred": (a) => m.addByCredentials(a.user, a.pass),
  remove: (a) => m.removeAccount(a.id),
  toggle: (a) => m.togglePause(a.id),
  "pause-all": (a) => m.setAllPaused(a.flag),
  "games-add": (a) => m.addGames(a.id, a.ids),
  "games-remove": (a) => m.removeGames(a.id, a.ids),
  search: (a) => m.searchGames(a.term),
  guard: (a) => m.submitGuard(a.id, a.code),
  "guard-cancel": (a) => m.cancelGuard(a.id),
  "qr-start": () => { m.startQr(); },
  "qr-cancel": () => m.cancelQr()
};
channel.on("cmd", async (msg) => {
  try { channel.send("res", { rid: msg.rid, ok: true, data: await ops[msg.op](msg.a || {}) }); }
  catch (e) { channel.send("res", { rid: msg.rid, ok: false, error: e.message }); }
});
