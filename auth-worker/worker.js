// ScreenFusion — Auth Worker (registrazione, login, abbonamenti) su Cloudflare + KV.
//
// SETUP (dashboard Cloudflare):
//   1) Workers & Pages -> KV -> Create namespace  ->  nome: USERS
//   2) Crea un Worker, incolla questo file
//   3) Settings -> Variables:
//        - KV Namespace Binding:  Variable name = USERS_KV   ->  namespace USERS
//        - Secret:  SESSION_SECRET  = (una stringa lunga a caso, es. 40+ caratteri)
//        - Secret:  ADMIN_KEY       = (un'altra stringa segreta: serve per dare/togliere abbonamenti)
//   4) Deploy. Poi imposta l'URL del Worker nel sito (AUTH_WORKER_URL) e nel server.
//
// API (tutte JSON, con CORS):
//   POST /register  {email,password}                 -> crea account. { token, email, expires }
//   POST /login     {email,password}                 -> login.        { token, email, expires }
//   POST /validate  {token}                          -> { valid, active, email, expires }
//   POST /admin     {key,action,email,days}          -> gestione abbonamenti (action: grant|revoke|get|list)
//
// "expires" = timestamp ms in cui scade l'abbonamento (0 = nessun abbonamento attivo).
// "active"  = true se expires > adesso. Chi condivide lo schermo deve avere active=true.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---- password hashing (PBKDF2-SHA256) --------------------------------------
async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return { salt: toHex(salt), hash: toHex(bits) };
}
async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  // confronto a tempo costante
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

// ---- session token firmato (HMAC-SHA256) -----------------------------------
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function makeToken(email, secret) {
  const payload = b64u(enc.encode(JSON.stringify({ e: email, iat: Date.now() })));
  return payload + "." + await hmac(payload, secret);
}
async function readToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  if (await hmac(payload, secret) !== sig) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64uDec(payload)));
    return data.e ? data : null;
  } catch { return null; }
}

const emailOk = (e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 120;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.USERS_KV) return json({ error: "KV USERS_KV non collegato" }, 500);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { return json({ error: "JSON non valido" }, 400); }
    }

    // ---- REGISTER ----
    if (path === "/register" && request.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!emailOk(email)) return json({ error: "Email non valida" }, 400);
      if (password.length < 6) return json({ error: "Password troppo corta (min 6)" }, 400);
      if (await env.USERS_KV.get("u:" + email)) return json({ error: "Email già registrata" }, 409);
      const { salt, hash } = await hashPassword(password);
      const trialDays = Number(env.TRIAL_DAYS || 0);
      const expires = trialDays > 0 ? Date.now() + trialDays * 86400000 : 0;
      const user = { email, salt, hash, expires, created: Date.now() };
      await env.USERS_KV.put("u:" + email, JSON.stringify(user));
      const token = await makeToken(email, env.SESSION_SECRET);
      return json({ token, email, expires, active: expires > Date.now() });
    }

    // ---- LOGIN ----
    if (path === "/login" && request.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const raw = await env.USERS_KV.get("u:" + email);
      if (!raw) return json({ error: "Email o password errati" }, 401);
      const user = JSON.parse(raw);
      if (!await verifyPassword(password, user.salt, user.hash))
        return json({ error: "Email o password errati" }, 401);
      const token = await makeToken(email, env.SESSION_SECRET);
      return json({ token, email, expires: user.expires || 0, active: (user.expires || 0) > Date.now() });
    }

    // ---- VALIDATE (usato dal sito e dal server signaling) ----
    if (path === "/validate" && request.method === "POST") {
      const data = await readToken(body.token, env.SESSION_SECRET);
      if (!data) return json({ valid: false });
      const raw = await env.USERS_KV.get("u:" + data.e);
      if (!raw) return json({ valid: false });
      const user = JSON.parse(raw);
      const expires = user.expires || 0;
      return json({ valid: true, active: expires > Date.now(), email: user.email, expires });
    }

    // ---- ADMIN (dai/togli abbonamento) ----
    if (path === "/admin" && request.method === "POST") {
      if (!env.ADMIN_KEY || body.key !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, 403);
      const action = String(body.action || "");
      if (action === "list") {
        const out = [];
        let cursor;
        do {
          const res = await env.USERS_KV.list({ prefix: "u:", cursor });
          for (const k of res.keys) {
            const u = JSON.parse(await env.USERS_KV.get(k.name));
            out.push({ email: u.email, expires: u.expires || 0, active: (u.expires || 0) > Date.now() });
          }
          cursor = res.cursor; if (res.list_complete) break;
        } while (cursor);
        return json({ users: out });
      }
      const email = String(body.email || "").trim().toLowerCase();
      const raw = await env.USERS_KV.get("u:" + email);
      if (!raw) return json({ error: "Utente non trovato" }, 404);
      const user = JSON.parse(raw);
      if (action === "grant") {
        const days = Number(body.days || 30);
        const base = Math.max(user.expires || 0, Date.now());   // estende se già attivo
        user.expires = base + days * 86400000;
      } else if (action === "revoke") {
        user.expires = 0;
      } else if (action === "get") {
        // solo lettura
      } else {
        return json({ error: "Azione non valida (grant|revoke|get|list)" }, 400);
      }
      await env.USERS_KV.put("u:" + email, JSON.stringify(user));
      return json({ email: user.email, expires: user.expires || 0, active: (user.expires || 0) > Date.now() });
    }

    if (path === "/") return json({ ok: true, service: "screenfusion-auth" });
    return json({ error: "Not found" }, 404);
  },
};
