// ScreenFusion - server di signaling multi-dispositivo + hosting statico.
// Il video NON passa da qui: e' tutto peer-to-peer (WebRTC). Il server smista
// solo i messaggi di handshake tra i dispositivi della stessa stanza.
//
// Ruoli in una stanza:
//   overlay = pubblica il suo schermo (crea la stanza e il link)
//   main    = pubblica lo schermo di gioco e mostra la fusione
//   phone   = solo guarda la fusione (telefono/altro PC)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".ico":"image/x-icon", ".png":"image/png",
  ".svg":"image/svg+xml", ".json":"application/json; charset=utf-8" };

// ---- Configurazione ICE (STUN + TURN) ---------------------------------------
// STUN da solo basta quando i due router permettono la connessione diretta
// (stessa WiFi, o NAT "gentile"). Su 4G/5G, NAT simmetrico, reti aziendali/
// universitarie serve per forza un TURN che fa da relay, altrimenti il video
// P2P non passa e il telefono resta nero.
//
// Come attivare un TURN funzionante (necessario per "funziona sempre"):
//   1) crea un account gratuito su https://www.metered.ca (50GB/mese gratis)
//   2) dashboard -> TURN Server: copia l'URL "credentials" gia' pronto,
//      del tipo  https://TUOAPP.metered.live/api/v1/turn/credentials?apiKey=XXXX
//   3) su Render, nel servizio ScreenFusion -> Environment, aggiungi:
//        TURN_CREDENTIAL_URL = <quell'URL>
//   In alternativa puoi mettere un TURN tuo con TURN_URLS / TURN_USERNAME /
//   TURN_CREDENTIAL (hanno la precedenza su tutto).
const STUN = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

// Le credenziali TURN prese via API (Metered) durano ore: le teniamo in cache
// cosi' non chiamiamo l'API a ogni /ice.
let _iceCache = null;                      // { servers:[...], exp:timestamp }
const ICE_TTL_MS = 55 * 60 * 1000;

function staticTurn() {
  if (!process.env.TURN_URLS) return null;
  const urls = process.env.TURN_URLS.split(",").map(s => s.trim()).filter(Boolean);
  return [{
    urls,
    username: process.env.TURN_USERNAME || "",
    credential: process.env.TURN_CREDENTIAL || "",
  }];
}

function turnCredentialUrl() {
  if (process.env.TURN_CREDENTIAL_URL) return process.env.TURN_CREDENTIAL_URL;
  if (process.env.METERED_API_KEY && process.env.METERED_APP)
    return `https://${process.env.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
  return null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? require("https") : require("http");
    const req = lib.get(url, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(6000, () => req.destroy(new Error("timeout")));
  });
}

async function turnServers() {
  const st = staticTurn();
  if (st) return st;                                   // TURN manuale: precedenza
  const url = turnCredentialUrl();
  if (!url) return [];                                 // nessun TURN configurato
  if (_iceCache && _iceCache.exp > Date.now()) return _iceCache.servers;
  try {
    const j = await fetchJson(url);
    const servers = Array.isArray(j) ? j : (Array.isArray(j.iceServers) ? j.iceServers : []);
    if (servers.length) { _iceCache = { servers, exp: Date.now() + ICE_TTL_MS }; return servers; }
  } catch (e) { console.log("TURN fetch fallito:", e.message); }
  return _iceCache ? _iceCache.servers : [];           // usa l'ultima cache buona
}

async function getIceServers() {
  return [...STUN, ...(await turnServers())];
}

const server = http.createServer(async (req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);

  if (url === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return; }
  if (url === "/ice") {
    const iceServers = await getIceServers();
    res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  if (url === "/") url = "/index.html";
  const file = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, home) => {
        if (e2) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(home);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();   // code -> Map(id -> {ws, role})
let nextId = 1;

function code4() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = ""; for (let i = 0; i < 4; i++) c += A[(Math.random()*A.length)|0];
  return c;
}
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function peerList(room, exceptId) {
  const out = [];
  for (const [id, p] of room) if (id !== exceptId) out.push({ id, role: p.role });
  return out;
}

wss.on("connection", (ws) => {
  ws.id = nextId++; ws.room = null; ws.role = null; ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "ping") { send(ws, { t: "pong" }); return; }

    if (m.t === "create") {
      // se il client chiede un codice (riconnessione dell'host dopo un riavvio)
      // e quel codice e' libero, glielo ridiamo: il link condiviso resta valido.
      let code = (m.code || "").toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code) || rooms.has(code)) { do { code = code4(); } while (rooms.has(code)); }
      const room = new Map(); rooms.set(code, room);
      room.set(ws.id, { ws, role: m.role || "overlay" });
      ws.room = code; ws.role = m.role || "overlay";
      send(ws, { t: "created", code, id: ws.id, peers: [] });

    } else if (m.t === "join") {
      const code = (m.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: "error", msg: "Stanza inesistente o overlay non attivo" }); return; }
      room.set(ws.id, { ws, role: m.role });
      ws.room = code; ws.role = m.role;
      send(ws, { t: "joined", code, id: ws.id, peers: peerList(room, ws.id) });
      for (const [id, p] of room)
        if (id !== ws.id) send(p.ws, { t: "peer-joined", id: ws.id, role: ws.role });

    } else if (m.t === "sig") {
      const room = rooms.get(ws.room); if (!room) return;
      const dst = room.get(m.to);
      if (dst) send(dst.ws, { t: "sig", from: ws.id, payload: m.payload });
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.room); if (!room) return;
    room.delete(ws.id);
    for (const [, p] of room) send(p.ws, { t: "peer-left", id: ws.id });
    if (room.size === 0) rooms.delete(ws.room);
  });
});

// Keepalive: elimina le connessioni morte (Render/proxy chiudono i socket idle)
// e tiene vive quelle buone. Ogni 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

// Keep-awake: Render Free si addormenta dopo ~15 min senza traffico HTTP, e con
// lui spariscono le stanze in memoria. Un self-ping ogni 10 min lo tiene sveglio
// (RENDER_EXTERNAL_URL e' impostata da Render in automatico).
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  const u = SELF_URL.replace(/\/+$/, "") + "/healthz";
  const lib = u.startsWith("https") ? require("https") : require("http");
  setInterval(() => { try { lib.get(u, r => r.resume()).on("error", () => {}); } catch {} }, 10 * 60 * 1000);
}

server.listen(PORT, () => console.log("ScreenFusion server su :" + PORT));
