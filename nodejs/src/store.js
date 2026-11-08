"use strict";
// Android: uygulamanın özel klasörüne düz JSON olarak yazar (diğer uygulamalar okuyamaz).
const fs = require("fs"), path = require("path"), os = require("os");
const dir = [process.env.DATADIR, os.homedir(), os.tmpdir()].filter(Boolean)[0];
const file = (n) => path.join(dir, "zenith_" + n);
const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch (_) { return d; } };
const wr = (n, v) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(n) + ".tmp", JSON.stringify(v)); fs.renameSync(file(n) + ".tmp", file(n)); return true; } catch (_) { return false; } };
module.exports = {
  loadNames: () => rd("names.json", {}),
  saveNames: (v) => wr("names.json", v),
  loadAccounts() {
    const raw = rd("accounts.json", {});
    const arr = Array.isArray(raw) ? raw : raw.accounts || [];
    return { entries: arr.filter((e) => e && typeof e.token === "string" && e.token), archivedGameMs: raw.archivedGameMs || 0 };
  },
  saveAccounts: (v) => wr("accounts.json", v)
};
