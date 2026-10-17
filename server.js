// خادم بدون أي مكتبات خارجية: يقدّم التطبيق ويحفظ البيانات في ملف data.json
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ADMIN_USER = process.env.ADMIN_USER || "2001";
const ADMIN_PASS = process.env.ADMIN_PASS || "2001";

let db = { chats: {}, bookings: {}, broadcasts: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, "utf8"))); } catch (e) {}
function save() { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) {} }

const tokens = new Set();
const fails = {};
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function activeKeys(exceptUid) {
  const s = new Set();
  Object.values(db.bookings).forEach(pd => {
    if (pd.uid === exceptUid) return;
    (pd.list || []).forEach(x => { if (x.st !== "x" && x.k) s.add(x.k); });
  });
  return s;
}
function chatOf(uid, name) {
  if (!db.chats[uid]) db.chats[uid] = { uid, name: str(name, 60) || "مريض", msgs: [], ts: Date.now(), unreadAdmin: false };
  return db.chats[uid];
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (p.startsWith("/api/")) {
      const b = req.method === "POST" ? await readBody(req) : {};
      const isAdmin = () => tokens.has(req.headers["x-token"]);

      if (p === "/api/admin/login" && req.method === "POST") {
        const ip = req.socket.remoteAddress || "x", f = fails[ip] || { n: 0, ts: Date.now() };
        if (Date.now() - f.ts > 600000) { f.n = 0; f.ts = Date.now(); }
        if (f.n >= 10) return send(res, 429, { error: "many" });
        if (str(b.user, 50) === ADMIN_USER && str(b.pass, 50) === ADMIN_PASS) {
          const t = crypto.randomBytes(24).toString("hex"); tokens.add(t);
          return send(res, 200, { token: t });
        }
        f.n++; fails[ip] = f;
        return send(res, 401, { error: "bad" });
      }

      // ---- المراجع ----
      if (p === "/api/state" && req.method === "GET") {
        const uid = str(u.searchParams.get("uid"), 40);
        if (!uid) return send(res, 400, {});
        const c = db.chats[uid], pd = db.bookings[uid];
        return send(res, 200, {
          msgs: c ? c.msgs : [],
          list: pd ? pd.list : null,
          slots: Array.from(activeKeys(uid)),
          broadcasts: db.broadcasts.slice(-20)
        });
      }
      if (p === "/api/chat" && req.method === "POST") {
        const uid = str(b.uid, 40), text = str(b.text, 1000).trim();
        if (!uid || !text) return send(res, 400, {});
        const c = chatOf(uid, b.name);
        c.name = str(b.name, 60) || c.name;
        c.msgs.push({ f: "me", x: text, t: str(b.t, 12) });
        c.msgs = c.msgs.slice(-300); c.ts = Date.now(); c.unreadAdmin = true;
        save(); return send(res, 200, { ok: 1 });
      }
      if (p === "/api/bookings" && req.method === "POST") {
        const uid = str(b.uid, 40);
        if (!uid || !Array.isArray(b.list)) return send(res, 400, {});
        const old = db.bookings[uid], cancelled = new Set();
        if (old) (old.list || []).forEach(x => { if (x.st === "x") cancelled.add(x.id); });
        const list = b.list.slice(0, 100).map(x => ({
          id: +x.id || 0, doc: str(x.doc, 60), spec: str(x.spec, 40), ts: +x.ts || 0, time: str(x.time, 12),
          name: str(x.name, 60), phone: str(x.phone, 30), k: str(x.k, 80),
          st: (x.st === "x" || cancelled.has(+x.id)) ? "x" : "ok"
        }));
        const taken = activeKeys(uid);
        if (list.some(x => x.st !== "x" && x.k && taken.has(x.k))) return send(res, 409, { error: "taken" });
        db.bookings[uid] = { uid, name: str(b.name, 60) || "مريض", list };
        save(); return send(res, 200, { ok: 1 });
      }

      // ---- الإدارة ----
      if (p.startsWith("/api/admin/")) {
        if (!isAdmin()) return send(res, 401, { error: "auth" });
        if (p === "/api/admin/state" && req.method === "GET")
          return send(res, 200, { chats: Object.values(db.chats), bookings: Object.values(db.bookings), broadcasts: db.broadcasts.slice(-50) });
        if (p === "/api/admin/reply" && req.method === "POST") {
          const uid = str(b.uid, 40), text = str(b.text, 1000).trim();
          if (!uid || !text || !db.chats[uid]) return send(res, 400, {});
          const c = db.chats[uid];
          c.msgs.push({ f: "s", x: text, t: str(b.t, 12) }); c.ts = Date.now(); c.unreadAdmin = false;
          save(); return send(res, 200, { ok: 1 });
        }
        if (p === "/api/admin/read" && req.method === "POST") {
          const c = db.chats[str(b.uid, 40)]; if (c) { c.unreadAdmin = false; save(); }
          return send(res, 200, { ok: 1 });
        }
        if (p === "/api/admin/cancel" && req.method === "POST") {
          const uid = str(b.uid, 40), pd = db.bookings[uid];
          if (!pd) return send(res, 404, {});
          pd.list.forEach(x => { if (x.id === +b.id) x.st = "x"; });
          const c = chatOf(uid, pd.name);
          c.msgs.push({ f: "s", x: str(b.note, 300), t: str(b.t, 12) }); c.ts = Date.now();
          save(); return send(res, 200, { ok: 1 });
        }
        if (p === "/api/admin/broadcast" && req.method === "POST") {
          const text = str(b.text, 500).trim(); if (!text) return send(res, 400, {});
          db.broadcasts.push({ id: "b" + Date.now(), text, ts: Date.now() });
          save(); return send(res, 200, { ok: 1 });
        }
      }
      return send(res, 404, { error: "not found" });
    }
    if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
    const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json; charset=utf-8", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
    const root = path.join(__dirname, "public");
    let file = path.normalize(path.join(root, p === "/" ? "index.html" : decodeURIComponent(p)));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
    res.end(fs.readFileSync(file));
  } catch (e) { send(res, 500, { error: "server" }); }
});
server.listen(PORT, () => console.log("running on " + PORT));
