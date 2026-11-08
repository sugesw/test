"use strict";
/**
 * Zenith Hours motoru. Orijinal index.js'teki mantık (yeniden bağlanma, rate-limit,
 * "başka yerde oyun var", yinelenen hesap, token yenileme) korunmuştur;
 * konsol paneli yerine olaylar (EventEmitter) ve snapshot() ile arayüze veri verir.
 */
const { EventEmitter } = require("events");
const SteamUser = require("steam-user");
const { LoginSession, EAuthTokenPlatformType } = require("steam-session");
const QRCode = require("qrcode");

const MAX_GAMES = 32; // Steam aynı anda en fazla 32 oyuna izin verir
const T = {
    retryBase: 10 * 1000,
    retryMax: 5 * 60 * 1000,
    elsewhere: 5 * 60 * 1000,   // başka yerde giriş yapıldıysa 5 dk bekle
    throttle: 30 * 60 * 1000,   // rate limit ise 30 dk bekle
    stagger: 3000               // açılışta hesapları 3 sn arayla bağla
};
const ER = { InvalidPassword: 5, LoggedInElsewhere: 6, AccessDenied: 15, Expired: 27, RateLimitExceeded: 84, AccountLoginDeniedThrottle: 87 };

const FALLBACK_NAMES = {
    730: "Counter-Strike 2", 570: "Dota 2", 440: "Team Fortress 2", 220: "Half-Life 2", 620: "Portal 2",
    271590: "Grand Theft Auto V", 3240220: "Grand Theft Auto V Enhanced", 3527290: "PEAK", 2281730: "Combat Master",
    291550: "Brawlhalla", 203140: "Hitman: Absolution", 1659040: "HITMAN World of Assassination", 863550: "HITMAN 2",
    945360: "Among Us", 477160: "Human: Fall Flat", 233450: "Prison Architect", 578080: "PUBG: BATTLEGROUNDS",
    359550: "Tom Clancy's Rainbow Six Siege", 1568590: "Goose Goose Duck", 227300: "Euro Truck Simulator 2",
    1172470: "Apex Legends", 346110: "ARK: Survival Evolved", 304930: "Unturned", 1625450: "Muck"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inspectToken(token) {
    const parts = String(token).split(".");
    if (parts.length !== 3) return { ok: false, reason: "JWT formatında değil" };
    try {
        const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const exp = p.exp ? p.exp * 1000 : null;
        if (exp && exp < Date.now()) return { ok: false, reason: "süresi dolmuş" };
        return { ok: true, exp, aud: Array.isArray(p.aud) ? p.aud : [], sub: p.sub ? String(p.sub) : "" };
    } catch (_) {
        return { ok: false, reason: "çözümlenemedi" };
    }
}

function sanitizeIds(g) {
    if (!Array.isArray(g)) return [];
    return [...new Set(g.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
}

let uid = 0;

class Account {
    constructor(mgr, entry, opts) {
        this.mgr = mgr;
        this.id = "a" + ++uid;
        this.entry = entry;          // { token, name, sid, games, paused, stats }
        this.opts = opts;            // logOn seçenekleri
        this.tmpName = opts.accountName || "";
        this.status = "connecting";  // connecting | idling | paused | reconnecting | waiting | empty | stopped
        this.reconnectAt = 0;
        this.idleMs = (entry.stats && entry.stats.idleMs) || 0;
        this.gameMs = (entry.stats && entry.stats.gameMs) || 0;
        this.segStart = null;
        this.online = false;
        this.isBlocked = false;      // başka yerde oyun oynanıyor
        this.userPaused = !!entry.paused;
        this.retryCount = 0;
        this.timer = null;
        this.removed = false;
        this.guardCb = null;
        this.client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true, enablePicsCache: false });
        this.bind();
    }

    get games() { return this.entry.games; }
    log(level, msg) { this.mgr.log(level, msg, this); }

    label() {
        return this.entry.name || this.tmpName || `Hesap ${this.mgr.accounts.indexOf(this) + 1}`;
    }

    segBegin() { if (!this.segStart) this.segStart = Date.now(); }
    segEnd() {
        if (!this.segStart) return;
        const d = Date.now() - this.segStart;
        this.idleMs += d;
        this.gameMs += d * this.games.length; // liste değişse de geçmiş bozulmasın
        this.segStart = null;
    }
    totalIdle() { return this.idleMs + (this.segStart ? Date.now() - this.segStart : 0); }
    gameMsTotal() { return this.gameMs + (this.segStart ? (Date.now() - this.segStart) * this.games.length : 0); }
    gameHours() { return this.gameMsTotal() / 3600000; }

    startIdling() {
        const g = this.games;
        if (this.userPaused) {
            this.client.gamesPlayed([]);
            this.segEnd();
            this.status = "stopped";
            return;
        }
        this.client.gamesPlayed(g);
        if (!g.length) {
            this.segEnd();
            this.status = "empty";
            return;
        }
        this.segBegin();
        this.status = "idling";
        this.log("ok", `${g.length} oyun için saat/kart kasılıyor.`);
    }

    setGames(list) {
        this.segEnd(); // eski oyun sayısıyla o ana kadarki saati hesapla
        this.entry.games = list;
        this.mgr.save();
        if (this.online && !this.isBlocked) this.startIdling();
        else if (!list.length) this.status = this.userPaused ? "stopped" : "empty";
    }

    setUserPaused(flag) {
        if (this.userPaused === flag) return;
        this.userPaused = flag;
        this.segEnd();
        if (this.online && !this.isBlocked) this.startIdling();
        else if (flag) this.status = "stopped";
        this.mgr.save();
    }

    connect() {
        if (this.mgr.shuttingDown || this.removed) return;
        if (Date.now() < this.mgr.throttleUntil) {
            // Steam limiti IP başınadır; başka bir hesap takıldıysa bu hesap da denemesin
            return this.scheduleReconnect(this.mgr.throttleUntil - Date.now() + Math.floor(Math.random() * 5000), "Steam rate limit bekleniyor");
        }
        this.reconnectAt = 0;
        this.status = "connecting";
        try {
            this.client.logOn(this.opts);
        } catch (e) {
            this.log("err", `Giriş başlatılamadı: ${e.message}`);
            this.scheduleReconnect(this.nextBackoff(), "Giriş hatası");
        }
    }

    connectIn(ms) {
        if (ms <= 0) return this.connect();
        this.status = "connecting";
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.connect(), ms);
    }

    nextBackoff() {
        this.retryCount = Math.min(this.retryCount + 1, 10);
        return Math.min(T.retryBase * 2 ** (this.retryCount - 1), T.retryMax);
    }

    scheduleReconnect(ms, reason) {
        if (this.mgr.shuttingDown || this.removed) return;
        clearTimeout(this.timer);
        this.status = "waiting";
        this.reconnectAt = Date.now() + ms;
        this.log("warn", `${reason}. ${ms >= 60000 ? Math.round(ms / 60000) + " dk" : Math.round(ms / 1000) + " sn"} sonra yeniden denenecek.`);
        this.timer = setTimeout(() => this.connect(), ms);
    }

    remove(reason) {
        if (this.removed) return;
        this.log("warn", `${reason}. Hesap listeden çıkarıldı.`);
        this.removed = true;
        this.online = false;
        this.segEnd();
        clearTimeout(this.timer);
        this.mgr.archivedGameMs += this.gameMsTotal();
        const i = this.mgr.accounts.indexOf(this);
        if (i >= 0) this.mgr.accounts.splice(i, 1);
        try { this.client.gamesPlayed([]); this.client.logOff(); } catch (_) {}
        this.mgr.save();
    }

    bind() {
        const a = this, cl = this.client;
        // her olay işleyicisi korumalı: bir hesapta hata çıkarsa diğer hesaplar etkilenmez
        const on = (ev, fn) => cl.on(ev, (...args) => {
            try {
                const r = fn(...args);
                if (r && typeof r.catch === "function") r.catch((e) => a.log("err", `${ev} olayında hata: ${e.message || e}`));
            } catch (e) { a.log("err", `${ev} olayında hata: ${e.message || e}`); }
        });

        on("loggedOn", () => {
            if (a.removed) return;
            a.retryCount = 0;
            a.isBlocked = false;
            a.reconnectAt = 0;
            a.online = true;

            // aynı hesap iki kez eklenmiş mi? (kullanıcı adı/şifre ile eklenince ancak burada anlaşılır)
            const sid = cl.steamID && cl.steamID.getSteamID64();
            if (sid) {
                const dup = a.mgr.accounts.find((o) => o !== a && o.entry.sid === sid);
                if (dup) return a.remove("Bu hesap zaten ekli (yinelenen kayıt)");
                if (a.entry.sid !== sid) { a.entry.sid = sid; a.mgr.save(); }
            }

            a.log("ok", "Steam oturumu açıldı.");
            cl.setPersona(SteamUser.EPersonaState.Online);
            a.startIdling();
            a.mgr.ensureNames(a.games);
        });

        on("accountInfo", (name) => {
            if (a.removed) return;
            if (a.entry.name !== name) { a.entry.name = name; a.mgr.save(); }
        });

        on("playingState", (blocked, playingApp) => {
            if (a.removed) return;
            if (blocked) {
                a.isBlocked = true;
                a.status = "paused";
                a.segEnd();
                a.log("warn", `Hesap başka yerde oyun oynuyor (AppID ${playingApp}). Kasma duraklatıldı, boşalınca otomatik devam eder.`);
            } else if (a.isBlocked) {
                a.isBlocked = false;
                a.log("ok", "Diğer oturum kapandı, kasma devam ediyor.");
                a.startIdling();
            }
        });

        on("refreshToken", (token) => {
            if (a.removed) return;
            a.entry.token = token;
            a.opts = { refreshToken: token };
            if (!a.entry.sid) a.entry.sid = inspectToken(token).sub || "";
            a.mgr.save();
        });

        on("steamGuard", (domain, callback, lastCodeWrong) => {
            if (a.removed) return;
            a.guardCb = callback;
            a.mgr.emit("guard", { id: a.id, label: a.label(), domain: domain || null, wrong: !!lastCodeWrong });
        });

        on("disconnected", (eresult, msg) => {
            a.online = false;
            a.segEnd();
            if (!a.mgr.shuttingDown && !a.removed) {
                a.status = "reconnecting";
                a.log("warn", `Bağlantı koptu (${msg || eresult}). Otomatik yeniden bağlanılıyor.`);
            }
        });

        on("error", (err) => {
            a.online = false;
            a.segEnd();
            if (a.mgr.shuttingDown || a.removed) return;

            const code = err && err.eresult;
            const msg = (err && err.message) || String(err);
            a.log("err", `Oturum hatası: ${msg}`);

            if ([ER.InvalidPassword, ER.AccessDenied, ER.Expired].includes(code) || /refresh token|expired/i.test(msg)) {
                return a.remove("Kayıtlı oturum/şifre geçersiz. Tekrar eklemen gerekiyor");
            }
            if (code === ER.LoggedInElsewhere) return a.scheduleReconnect(T.elsewhere, "Hesap başka bir yerde açıldı");
            if (code === ER.RateLimitExceeded || code === ER.AccountLoginDeniedThrottle) {
                a.mgr.throttleUntil = Math.max(a.mgr.throttleUntil, Date.now() + T.throttle);
                return a.scheduleReconnect(T.throttle, "Steam çok fazla deneme gördü (rate limit)");
            }
            a.scheduleReconnect(a.nextBackoff(), "Hata");
        });
    }
}

class Manager extends EventEmitter {
    constructor(io) {
        super();
        this.io = io;
        this.accounts = [];
        this.archivedGameMs = 0;
        this.throttleUntil = 0;
        this.shuttingDown = false;
        this.names = { ...FALLBACK_NAMES, ...io.loadNames() };
        this.tried = new Set();
        this.nameChain = Promise.resolve();
        this.qrRun = 0;
        this.qrSession = null;
        this.saveTimer = null;
        this.history = [];
    }

    // ───────── genel ─────────
    log(level, msg, acc) {
        const e = { t: Date.now(), level, msg, account: acc ? acc.label() : null };
        this.history.push(e);
        if (this.history.length > 200) this.history.shift();
        this.emit("log", e);
    }

    start() {
        const { entries, archivedGameMs } = this.io.loadAccounts();
        this.archivedGameMs = archivedGameMs;
        for (const e of entries) {
            const info = inspectToken(e.token);
            if (!info.ok) { this.log("warn", `${e.name || "Bir hesabın"} oturumu geçersiz (${info.reason}), atlandı. Tekrar eklemen gerekiyor.`); continue; }
            this.createAccount({ refreshToken: e.token }, e);
        }
        this.accounts.forEach((a, i) => a.connectIn(i * T.stagger));
        this.ensureNames([...new Set(this.accounts.flatMap((a) => a.games))]);
        this.saveTimer = setInterval(() => this.save(), 60 * 1000); // süre istatistikleri için
    }

    save() {
        const accounts = this.accounts.filter((a) => a.entry.token).map((a) => ({
            token: a.entry.token,
            name: a.entry.name || "",
            sid: a.entry.sid || "",
            games: a.games,
            paused: a.userPaused,
            stats: { idleMs: Math.round(a.totalIdle()), gameMs: Math.round(a.gameMsTotal()) }
        }));
        const ok = this.io.saveAccounts({ accounts, archivedGameMs: Math.round(this.archivedGameMs) });
        if (!ok) this.log("err", "Hesaplar kaydedilemedi! Disk veya izinleri kontrol et.");
        return ok;
    }

    totalGameHours() {
        return (this.archivedGameMs + this.accounts.reduce((s, a) => s + a.gameMsTotal(), 0)) / 3600000;
    }

    snapshot() {
        const now = Date.now();
        const accounts = this.accounts.map((a) => ({
            id: a.id,
            label: a.label(),
            status: a.status,
            retryIn: a.reconnectAt > now ? a.reconnectAt - now : 0,
            idleMs: a.totalIdle(),
            gameHours: a.gameHours(),
            games: a.games.slice(),
            paused: a.userPaused
        }));
        return {
            t: now,
            accounts,
            totalGameHours: this.totalGameHours(),
            idling: accounts.filter((a) => a.status === "idling").length,
            allPaused: accounts.length > 0 && accounts.every((a) => a.paused)
        };
    }

    get(id) {
        const a = this.accounts.find((x) => x.id === id);
        if (!a) throw new Error("Hesap bulunamadı.");
        return a;
    }

    // ───────── hesap ekleme ─────────
    createAccount(opts, entry) {
        const token = opts.refreshToken || null;
        const sid = (entry && entry.sid) || (token ? inspectToken(token).sub : "") || "";
        if (sid && this.accounts.some((a) => a.entry.sid === sid)) return null;
        const acc = new Account(this, {
            token,
            name: (entry && entry.name) || "",
            sid,
            games: sanitizeIds(entry && entry.games).slice(0, MAX_GAMES),
            paused: !!(entry && entry.paused),
            stats: entry && entry.stats
        }, opts);
        this.accounts.push(acc);
        return acc;
    }

    addByToken(token) {
        token = String(token || "").trim();
        const info = inspectToken(token);
        if (!info.ok) throw new Error(`Token geçersiz: ${info.reason}.`);
        const acc = this.createAccount({ refreshToken: token });
        if (!acc) throw new Error("Bu hesap zaten ekli.");
        this.save();
        acc.connect();
        return acc.id;
    }

    addByCredentials(accountName, password) {
        accountName = String(accountName || "").trim();
        if (!accountName || !password) throw new Error("Kullanıcı adı ve şifre boş olamaz.");
        const acc = this.createAccount({ accountName, password });
        acc.connect();
        return acc.id;
    }

    importEntries(raw) {
        const arr = Array.isArray(raw) ? raw : (raw && raw.accounts) || [];
        let added = 0, skipped = 0;
        for (const e of arr) {
            if (!e || typeof e.token !== "string" || !e.token) continue;
            if (!inspectToken(e.token).ok) { skipped++; continue; }
            const acc = this.createAccount({ refreshToken: e.token }, e);
            if (acc) { acc.connectIn(added * T.stagger); added++; } else skipped++;
        }
        if (added) { this.save(); this.ensureNames([...new Set(this.accounts.flatMap((a) => a.games))]); }
        return { added, skipped };
    }

    async startQr() {
        this.cancelQr();
        const run = ++this.qrRun;
        const send = (p) => { if (run === this.qrRun) this.emit("qr", p); };
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (run !== this.qrRun) return;
            const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
            this.qrSession = session;
            const done = new Promise((resolve, reject) => {
                session.on("remoteInteraction", () => send({ state: "scanned" }));
                session.on("authenticated", () => resolve(session.refreshToken));
                session.on("timeout", () => reject(new Error("QR süresi doldu")));
                session.on("error", reject);
            });
            done.catch(() => {});
            try {
                const { qrChallengeUrl } = await session.startWithQR();
                const dataUrl = await QRCode.toDataURL(qrChallengeUrl, { margin: 1, width: 280 });
                send({ state: "ready", dataUrl });
                const token = await done;
                if (run !== this.qrRun) return;
                this.qrSession = null;
                try { this.addByToken(token); send({ state: "done" }); }
                catch (e) { send({ state: "error", message: e.message }); }
                return;
            } catch (e) {
                try { session.cancelLoginAttempt(); } catch (_) {}
                if (run !== this.qrRun) return; // kullanıcı vazgeçti
                if (attempt === 3) send({ state: "error", message: e.message || "QR girişi başarısız oldu." });
                else send({ state: "refreshing" });
            }
        }
    }

    cancelQr() {
        this.qrRun++;
        if (this.qrSession) { try { this.qrSession.cancelLoginAttempt(); } catch (_) {} this.qrSession = null; }
    }

    submitGuard(id, code) {
        const a = this.get(id);
        const cb = a.guardCb;
        a.guardCb = null;
        if (cb) cb(String(code || "").trim());
    }

    cancelGuard(id) {
        const a = this.accounts.find((x) => x.id === id);
        if (a) a.remove("Giriş iptal edildi");
    }

    // ───────── hesap işlemleri ─────────
    removeAccount(id) { this.get(id).remove("Hesap silindi"); }

    togglePause(id) {
        const a = this.get(id);
        a.setUserPaused(!a.userPaused);
        return a.userPaused;
    }

    setAllPaused(flag) { this.accounts.forEach((a) => a.setUserPaused(!!flag)); }

    // ───────── oyunlar ─────────
    addGames(id, ids) {
        const a = this.get(id);
        const list = [...a.games];
        const res = { added: [], dup: [], full: [] };
        for (const n of sanitizeIds(ids)) {
            if (list.includes(n)) res.dup.push(n);
            else if (list.length >= MAX_GAMES) res.full.push(n);
            else { list.push(n); res.added.push(n); }
        }
        if (res.added.length) { a.setGames(list); this.ensureNames(res.added); }
        return res;
    }

    removeGames(id, ids) {
        const a = this.get(id);
        const drop = new Set(sanitizeIds(ids));
        a.setGames(a.games.filter((g) => !drop.has(g)));
    }

    clearGames(id) { this.get(id).setGames([]); }

    // ───────── oyun isimleri ─────────
    async fetchName(id) {
        try {
            const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic&l=turkish`, { signal: AbortSignal.timeout(8000) });
            const j = await r.json();
            return (j && j[id] && j[id].data && j[id].data.name) || null;
        } catch (_) { return null; }
    }

    ensureNames(ids) {
        const missing = ids.filter((id) => !this.names[id] && !this.tried.has(id));
        if (!missing.length) return;
        missing.forEach((id) => this.tried.add(id));
        this.nameChain = this.nameChain.then(async () => {
            let changed = false;
            for (const id of missing) {
                const n = await this.fetchName(id);
                if (n) { this.names[id] = n; changed = true; this.emit("names", this.names); }
                await sleep(400);
            }
            if (changed) this.io.saveNames(this.names);
        }).catch(() => {});
    }

    async searchGames(term) {
        term = String(term || "").trim();
        if (term.length < 2) return [];
        const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=turkish&cc=TR`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const items = ((j && j.items) || []).slice(0, 8).map((i) => ({ id: i.id, name: i.name }));
        let changed = false;
        items.forEach((i) => { if (!this.names[i.id]) { this.names[i.id] = i.name; changed = true; } });
        if (changed) { this.emit("names", this.names); this.io.saveNames(this.names); }
        return items;
    }

    // ───────── kapanış ─────────
    shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        clearInterval(this.saveTimer);
        this.cancelQr();
        this.accounts.forEach((a) => a.segEnd());
        this.save();
        this.accounts.forEach((a) => {
            clearTimeout(a.timer);
            try { a.client.gamesPlayed([]); a.client.logOff(); } catch (_) {}
        });
    }
}

module.exports = { Manager, MAX_GAMES, inspectToken };
