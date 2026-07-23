# recepten-api (Cloudflare Worker)

Backend voor de receptenboek-app: login (PIN → sessietoken) + CRUD op een D1-database.

## Eenmalig opzetten

```bash
cd recepten-worker

# 1. D1-database aanmaken
wrangler d1 create recepten
#    → kopieer de getoonde "database_id" naar wrangler.toml

# 2. Tabel aanmaken (in de echte, remote database)
wrangler d1 execute recepten --remote --file=./schema.sql

# 3. Secrets instellen
wrangler secret put APP_PIN          # jouw inlog-PIN, bv. 1974
wrangler secret put TOKEN_SECRET     # lange willekeurige string, zie hieronder
#    genereer een sterke waarde met:  openssl rand -hex 32

# 4. Deployen
wrangler deploy
#    → noteer de URL, bv. https://recepten-api.<jouw-subdomein>.workers.dev
```

## Frontend koppelen

Zet de Worker-URL bovenaan in `../index.html`:

```js
const API_BASE = "https://recepten-api.<jouw-subdomein>.workers.dev";
```

## Lokaal testen (optioneel)

`file://` wordt door CORS geblokkeerd. Serveer de app dus via http:

```bash
cd ..                       # naar de repo-root
python3 -m http.server 8080
# open http://localhost:8080/   (origin staat al in de allowlist)
```

Of push `index.html` naar GitHub Pages (die origin staat ook in de allowlist).

## Endpoints

| Methode | Pad | Auth | Doel |
|---|---|---|---|
| POST | `/api/login` | – | `{pin}` → `{token}` |
| GET | `/api/recepten` | ✓ | lijst |
| POST | `/api/recepten` | ✓ | aanmaken |
| GET | `/api/recepten/:id` | ✓ | ophalen |
| PUT | `/api/recepten/:id` | ✓ | bijwerken |
| DELETE | `/api/recepten/:id` | ✓ | verwijderen |

> Fase 2 voegt `POST /api/import` toe (YouTube → Gemini → concept-recept).
