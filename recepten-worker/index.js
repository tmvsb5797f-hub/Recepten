// recepten-api — Cloudflare Worker
// Fase 0+1: login (PIN -> sessietoken) + CRUD op recepten (D1).
// Fase 2 (later) voegt POST /api/import toe (YouTube -> Gemini).

const ALLOWED_ORIGINS = [
  "https://tmvsb5797f-hub.github.io", // GitHub Pages
  "http://localhost:8080",            // lokaal testen
  "http://127.0.0.1:8080",
];

const TOKEN_TTL = 30 * 24 * 60 * 60; // 30 dagen (seconden)
const ARR_VELDEN = ["ingredienten", "benodigdheden", "stappen", "tags"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    let res;
    try {
      res = await route(request, env, url);
    } catch (err) {
      res = json({ fout: err.message || "Serverfout" }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

// ---------- routing ----------

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    return handleLogin(request, env);
  }

  // Alles hieronder vereist een geldig token.
  if (!(await isAuthed(request, env))) {
    return json({ fout: "Niet ingelogd" }, 401);
  }

  if (path === "/api/recepten") {
    if (method === "GET") return listRecepten(env);
    if (method === "POST") return createRecept(request, env);
  }

  const m = path.match(/^\/api\/recepten\/([A-Za-z0-9-]+)$/);
  if (m) {
    const id = m[1];
    if (method === "GET") return getRecept(env, id);
    if (method === "PUT") return updateRecept(request, env, id);
    if (method === "DELETE") return deleteRecept(env, id);
  }

  return json({ fout: "Niet gevonden" }, 404);
}

// ---------- auth ----------

async function handleLogin(request, env) {
  const body = await readJson(request);
  const pin = String(body.pin || "");
  if (!env.APP_PIN) return json({ fout: "APP_PIN niet ingesteld op de server" }, 500);
  if (!veiligGelijk(pin, env.APP_PIN)) return json({ fout: "Onjuiste PIN" }, 401);
  return json({ token: await signToken(env) });
}

async function isAuthed(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return verifyToken(env, token);
}

async function hmacKey(env) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET niet ingesteld op de server");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signToken(env) {
  const payload = { exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function verifyToken(env, token) {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlNaarBytes(sig),
      new TextEncoder().encode(body)
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlNaarBytes(body)));
    return payload.exp && payload.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---------- CRUD ----------

async function listRecepten(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM recepten ORDER BY updated_at DESC"
  ).all();
  return json((results || []).map(rowNaarRecept));
}

async function getRecept(env, id) {
  const row = await env.DB.prepare("SELECT * FROM recepten WHERE id = ?").bind(id).first();
  if (!row) return json({ fout: "Niet gevonden" }, 404);
  return json(rowNaarRecept(row));
}

async function createRecept(request, env) {
  const r = schoonRecept(await readJson(request));
  if (!r.titel) return json({ fout: "Titel is verplicht" }, 400);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO recepten
       (id, titel, bron_url, bron_type, afbeelding, porties, bereidingstijd, kooktijd,
        ingredienten, benodigdheden, stappen, tags, notities, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, r.titel, r.bron_url, r.bron_type, r.afbeelding, r.porties, r.bereidingstijd,
    r.kooktijd, r.ingredienten, r.benodigdheden, r.stappen, r.tags, r.notities, now, now
  ).run();
  return getRecept(env, id);
}

async function updateRecept(request, env, id) {
  const bestaat = await env.DB.prepare("SELECT id FROM recepten WHERE id = ?").bind(id).first();
  if (!bestaat) return json({ fout: "Niet gevonden" }, 404);
  const r = schoonRecept(await readJson(request));
  if (!r.titel) return json({ fout: "Titel is verplicht" }, 400);
  await env.DB.prepare(
    `UPDATE recepten SET
       titel=?, bron_url=?, bron_type=?, afbeelding=?, porties=?, bereidingstijd=?, kooktijd=?,
       ingredienten=?, benodigdheden=?, stappen=?, tags=?, notities=?, updated_at=?
     WHERE id=?`
  ).bind(
    r.titel, r.bron_url, r.bron_type, r.afbeelding, r.porties, r.bereidingstijd, r.kooktijd,
    r.ingredienten, r.benodigdheden, r.stappen, r.tags, r.notities, Date.now(), id
  ).run();
  return getRecept(env, id);
}

async function deleteRecept(env, id) {
  await env.DB.prepare("DELETE FROM recepten WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- recept <-> rij ----------

function rowNaarRecept(row) {
  const r = { ...row };
  for (const veld of ARR_VELDEN) {
    try {
      r[veld] = row[veld] ? JSON.parse(row[veld]) : [];
    } catch {
      r[veld] = [];
    }
  }
  return r;
}

function schoonRecept(body) {
  const tekst = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  const lijst = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  return {
    titel: String(body.titel || "").trim(),
    bron_url: tekst(body.bron_url),
    bron_type: body.bron_type === "youtube" ? "youtube" : "handmatig",
    afbeelding: tekst(body.afbeelding),
    porties: tekst(body.porties),
    bereidingstijd: tekst(body.bereidingstijd),
    kooktijd: tekst(body.kooktijd),
    ingredienten: lijst(body.ingredienten),
    benodigdheden: lijst(body.benodigdheden),
    stappen: lijst(body.stappen),
    tags: lijst(body.tags),
    notities: tekst(body.notities),
  };
}

// ---------- utils ----------

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function veiligGelijk(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlNaarBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
