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

  if (path === "/api/import" && method === "POST") {
    return handleImport(request, env);
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

// ---------- import (YouTube -> Gemini) ----------

// Fallback-keten: elk model-id heeft een eigen rate-limit-bucket (tokens/min).
// Bij 429/overbelasting/onbeschikbaar valt hij automatisch door naar het volgende.
const MODELLEN = ["gemini-2.5-flash", "gemini-flash-lite-latest"];

const RECEPT_REGELS =
  "Regels:\n" +
  "- Schrijf alles in het Nederlands.\n" +
  "- Gebruik metrische eenheden.\n" +
  "- Splits elk ingredient in hoeveelheid, eenheid en naam. Als een hoeveelheid niet genoemd of getoond wordt, laat 'hoeveelheid' en 'eenheid' leeg. Verzin niets.\n" +
  "- Schrijf de stappen als heldere, korte gebiedende zinnen.\n" +
  "- Verzin geen ingredienten of stappen die niet in de bron voorkomen.\n" +
  "- Bedenk 2 tot 4 passende tags.\n" +
  "- Als de bron geen recept bevat, zet is_recept op false en laat de rest leeg.";

const RECEPT_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_recept: { type: "BOOLEAN" },
    titel: { type: "STRING" },
    porties: { type: "STRING" },
    bereidingstijd: { type: "STRING" },
    kooktijd: { type: "STRING" },
    ingredienten: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          hoeveelheid: { type: "STRING" },
          eenheid: { type: "STRING" },
          naam: { type: "STRING" },
          opmerking: { type: "STRING" },
        },
        required: ["naam"],
        propertyOrdering: ["hoeveelheid", "eenheid", "naam", "opmerking"],
      },
    },
    benodigdheden: { type: "ARRAY", items: { type: "STRING" } },
    stappen: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          tekst: { type: "STRING" },
          start: { type: "INTEGER" },
        },
        required: ["tekst", "start"],
        propertyOrdering: ["tekst", "start"],
      },
    },
    tags: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["is_recept", "titel", "ingredienten", "stappen"],
  propertyOrdering: [
    "is_recept", "titel", "porties", "bereidingstijd", "kooktijd",
    "ingredienten", "benodigdheden", "stappen", "tags",
  ],
};

async function handleImport(request, env) {
  if (!env.GEMINI_KEY) return json({ fout: "GEMINI_KEY niet ingesteld op de server" }, 500);
  const body = await readJson(request);
  const videoId = parseVideoId(String(body.url || "").trim());
  if (!videoId) return json({ fout: "Geen geldige YouTube-URL" }, 400);
  const videoUrl = "https://www.youtube.com/watch?v=" + videoId;

  let recept, methode;
  try {
    recept = await extractViaVideo(env, videoUrl);   // primaire route: video
    methode = "video";
  } catch (eVideo) {
    try {
      const tekst = await haalYoutubeTekst(videoId); // fallback: beschrijving + transcript
      if (!tekst) throw new Error("geen tekst beschikbaar");
      recept = await extractViaTekst(env, tekst);
      methode = "transcript";
    } catch (eTekst) {
      return json({ fout: "Kon dit recept niet uit de video halen. " + (eVideo.message || "") }, 502);
    }
  }

  if (!recept || recept.is_recept === false || !recept.titel) {
    return json({ fout: "Geen recept gevonden in deze video." }, 422);
  }

  // Stappen normaliseren naar { tekst, start(seconde of null) }.
  const stappen = (Array.isArray(recept.stappen) ? recept.stappen : [])
    .map((s) => {
      if (typeof s === "string") return { tekst: s, start: null };
      const start = Number.isInteger(s?.start) && s.start >= 0 ? s.start : null;
      return { tekst: String(s?.tekst || ""), start };
    })
    .filter((s) => s.tekst);

  // Concept opbouwen — NIET opgeslagen, gebruiker reviewt eerst.
  return json({
    titel: recept.titel || "",
    porties: recept.porties || "",
    bereidingstijd: recept.bereidingstijd || "",
    kooktijd: recept.kooktijd || "",
    ingredienten: Array.isArray(recept.ingredienten) ? recept.ingredienten : [],
    benodigdheden: Array.isArray(recept.benodigdheden) ? recept.benodigdheden : [],
    stappen,
    tags: Array.isArray(recept.tags) ? recept.tags : [],
    bron_url: videoUrl,
    bron_type: "youtube",
    afbeelding: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    notities: "",
    _methode: methode,
  });
}

function parseVideoId(url) {
  if (!url) return null;
  const patronen = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patronen) {
    const m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url; // kale video-id
  return null;
}

async function extractViaVideo(env, videoUrl) {
  const prompt =
    "Bekijk deze kookvideo (beeld en audio) en haal het complete recept eruit. " +
    "Let ook op hoeveelheden die alleen in beeld getoond worden.\n\n" + RECEPT_REGELS +
    "\n- Geef bij elke stap 'start': het tijdstip in HELE SECONDEN vanaf het begin van de video " +
    "waarop de kok deze handeling daadwerkelijk begint uit te voeren (niet waar het alleen wordt " +
    "aangekondigd of nabesproken). Wees zo nauwkeurig mogelijk. Gebruik -1 als je het niet zeker weet.";
  return roepGemini(env, {
    contents: [{ parts: [{ file_data: { file_uri: videoUrl } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RECEPT_SCHEMA },
  });
}

async function extractViaTekst(env, tekst) {
  const prompt =
    "Hieronder staat de titel, beschrijving en/of transcriptie van een kookvideo. " +
    "Haal hier het complete recept uit.\n\n" + RECEPT_REGELS +
    "\n- Er is geen video-timing beschikbaar; zet 'start' op -1 voor elke stap." +
    "\n\nBRON:\n" + tekst.slice(0, 30000);
  return roepGemini(env, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RECEPT_SCHEMA },
  });
}

async function roepGemini(env, requestBody) {
  let laatsteFout;
  for (const model of MODELLEN) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) }
    );
    // Rate-limit / overbelasting / model onbeschikbaar -> volgend model (eigen bucket).
    if (res.status === 429 || res.status === 503 || res.status === 404) {
      laatsteFout = new Error(`${model} gaf HTTP ${res.status}`);
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || "Gemini-fout " + res.status);
    const tekst = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!tekst) throw new Error("Gemini gaf geen bruikbaar antwoord");
    try {
      return JSON.parse(tekst);
    } catch {
      throw new Error("Gemini-antwoord was geen geldige JSON");
    }
  }
  throw laatsteFout || new Error("Geen Gemini-model beschikbaar");
}

// Fallback: haal titel + beschrijving + (indien beschikbaar) transcript uit de watch-pagina.
async function haalYoutubeTekst(videoId) {
  const res = await fetch("https://www.youtube.com/watch?v=" + videoId, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) return "";
  const html = await res.text();
  const pr = haalJsonObject(html, "ytInitialPlayerResponse");
  if (!pr) return "";
  const vd = pr.videoDetails || {};
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const transcript = await haalTranscript(tracks);
  const delen = [];
  if (vd.title) delen.push("Titel: " + vd.title);
  if (vd.shortDescription) delen.push("Beschrijving:\n" + vd.shortDescription);
  if (transcript) delen.push("Transcriptie:\n" + transcript);
  return delen.join("\n\n");
}

async function haalTranscript(tracks) {
  if (!tracks.length) return "";
  const track =
    tracks.find((t) => t.languageCode === "nl") ||
    tracks.find((t) => (t.languageCode || "").startsWith("en")) ||
    tracks[0];
  try {
    const res = await fetch(track.baseUrl + "&fmt=json3");
    if (!res.ok) return "";
    const data = await res.json();
    if (!data.events) return "";
    return data.events
      .flatMap((e) => (e.segs || []).map((s) => s.utf8 || ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// Balans-matcht het eerste { } object na een marker in de HTML.
function haalJsonObject(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const i = html.indexOf("{", start);
  if (i === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0) {
        try { return JSON.parse(html.slice(i, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
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
