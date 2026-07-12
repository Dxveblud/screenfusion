// ScreenFusion - server di signaling + hosting statico.
// Il video NON passa da qui: e' peer-to-peer (WebRTC). Il server scambia solo
// i messaggi di handshake tra i due browser della stessa stanza.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---- hosting statico ----
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") url = "/index.html";
  const file = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) {
      // fallback SPA: qualsiasi rotta -> index.html
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, home) => {
        if (e2) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(home);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---- signaling a stanze ----
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { host, guest }

function code4() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente caratteri ambigui
  let c = "";
  for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0];
  return c;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

wss.on("connection", (ws) => {
  ws.room = null;
  ws.role = null;

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "host") {
      let code; do { code = code4(); } while (rooms.has(code));
      rooms.set(code, { host: ws, guest: null });
      ws.room = code; ws.role = "host";
      send(ws, { t: "hosted", code });

    } else if (m.t === "join") {
      const room = rooms.get((m.code || "").toUpperCase());
      if (!room) { send(ws, { t: "error", msg: "Stanza inesistente" }); return; }
      if (room.guest) { send(ws, { t: "error", msg: "Stanza gia' piena" }); return; }
      room.guest = ws; ws.room = m.code.toUpperCase(); ws.role = "guest";
      send(ws, { t: "joined" });
      send(room.host, { t: "guest-here" });

    } else if (m.t === "sig") {
      const room = rooms.get(ws.room);
      if (!room) return;
      const other = ws.role === "host" ? room.guest : room.host;
      send(other, { t: "sig", payload: m.payload });
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    const other = ws.role === "host" ? room.guest : room.host;
    send(other, { t: "peer-left" });
    if (ws.role === "host") rooms.delete(ws.room);
    else room.guest = null;
  });
});

server.listen(PORT, () => console.log("ScreenFusion server su :" + PORT));
