-- Recepten-database (Cloudflare D1 / SQLite)
-- Draai dit één keer bij het opzetten (zie README-commando's).

CREATE TABLE IF NOT EXISTS recepten (
  id             TEXT PRIMARY KEY,   -- uuid
  titel          TEXT NOT NULL,
  bron_url       TEXT,
  bron_type      TEXT DEFAULT 'handmatig',   -- 'handmatig' | 'youtube'
  afbeelding     TEXT,               -- thumbnail-URL
  porties        TEXT,
  bereidingstijd TEXT,
  kooktijd       TEXT,
  ingredienten   TEXT,               -- JSON: [{hoeveelheid, eenheid, naam, opmerking}]
  benodigdheden  TEXT,               -- JSON: ["pan", "oven", ...]
  stappen        TEXT,               -- JSON: ["stap 1", "stap 2", ...]
  tags           TEXT,               -- JSON: ["snel", "vegetarisch", ...]
  notities       TEXT,
  created_at     INTEGER,
  updated_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_recepten_updated ON recepten(updated_at DESC);
