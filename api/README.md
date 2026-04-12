# Àpótí Ọlọ́wẹ̀ — Puzzle Challenge · Backend

Express API powering the *Àpótí Ọlọ́wẹ̀* serialized puzzle challenge on [kaysworks.com](https://kaysworks.com).

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | Supabase (Postgres) |
| Storage | Supabase Storage |
| Auth | JWT (admin panel only) |
| Hosting | Railway (recommended) |

---

## Project structure

```
apoti-olowe-api/
├── server.js          # API — all routes
├── package.json
├── .env.example       # Copy to .env and fill in values
├── .env               # Your secrets — never commit this
└── README.md
```

---

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → service_role key |
| `ADMIN_PASSWORD` | Choose anything — this is what you type in the puzzle admin panel |
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PORT` | `3001` locally (Railway sets this automatically in production) |
| `ALLOWED_ORIGIN` | `*` locally, `https://kaysworks.com` in production |

### 3. Set up Supabase

**Run the schema** in Supabase Dashboard → SQL Editor → New Query:

Paste the contents of `supabase-schema.sql` and click **Run**.

**Create the storage bucket** manually:

1. Supabase Dashboard → Storage → New Bucket
2. Name: `puzzle-images`
3. Public: **YES**
4. Max file size: **10 MB**
5. Allowed MIME types: `image/jpeg, image/png, image/webp`

### 4. Start the server

```bash
# Development (auto-restarts on file change)
npm run dev

# Production
npm start
```

The API will be running at `http://localhost:3001`.

### 5. Update the puzzle HTML

Open `puzzle_merged.html` and update the API URL at the top of the `<script>` block:

```js
const API = 'http://localhost:3001'; // local
// or after deploying:
const API = 'https://your-project.railway.app';
```

---

## Deploying to Railway

Railway is the simplest host for this stack — it reads your `package.json` and `Procfile`-less setup automatically.

1. Push your project to a GitHub repo (make sure `.env` is in `.gitignore`)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select your repo
4. In the Railway project settings → **Variables**, add all the keys from `.env.example` with your real values
5. Railway will deploy automatically. Copy the generated URL (e.g. `https://apoti-olowe-api.railway.app`)
6. Update `const API = '...'` in your puzzle HTML to this URL
7. Set `ALLOWED_ORIGIN=https://kaysworks.com` in Railway variables

That's it — every push to `main` redeploys automatically.

---

## API reference

All routes that modify data require either the admin token or are rate-limited naturally by the puzzle flow.

### Public

| Method | Route | Description |
|---|---|---|
| `GET` | `/challenge` | Returns the currently active challenge or 404 |
| `GET` | `/leaderboard/:challengeId` | Top 10 best scores for a challenge |
| `POST` | `/score` | Submit a completed puzzle score |
| `GET` | `/health` | Health check — returns `{ status: "ok" }` |

**POST `/score` body:**
```json
{
  "challenge_id": "uuid",
  "player_name":  "Kayode",
  "time_seconds": 342,
  "piece_count":  1000,
  "hints_used":   1,
  "ghost_used":   0
}
```

**Response:**
```json
{ "id": "uuid", "rank": 3 }
```

### Admin (requires `x-admin-token` header)

| Method | Route | Description |
|---|---|---|
| `POST` | `/admin/login` | Returns a signed JWT (valid 8 hours) |
| `GET` | `/admin/challenges` | All challenges, newest first |
| `POST` | `/admin/challenge` | Publish a new challenge |
| `DELETE` | `/admin/challenge/:id` | Delete a challenge + its scores + its image |
| `POST` | `/admin/upload-image` | Upload a puzzle image to Supabase Storage |

**POST `/admin/login` body:**
```json
{ "password": "your-admin-password" }
```

**POST `/admin/challenge` body:**
```json
{
  "title":       "Week 01 — The Chiefs' Meeting",
  "image_url":   "https://xxxx.supabase.co/storage/v1/object/public/puzzle-images/week-01.jpg",
  "image_path":  "week-01.jpg",
  "reward_url":  "https://kaysworks.com/reward/week01",
  "starts_at":   "2026-05-01T09:00:00+01:00",
  "ends_at":     "2026-05-08T09:00:00+01:00",
  "piece_count": 1000
}
```

---

## Leaderboard deduplication

Player deduplication (showing each player's best time only) is handled in `server.js` rather than a database view. Supabase flags views on RLS-enabled tables as `SECURITY DEFINER` — meaning they run with the creator's privileges rather than the querying user's, which is a security warning even when RLS already blocks all direct public access.

The leaderboard route fetches all scores for a challenge ordered by time, then filters in JS to keep only each player's first (fastest) entry before returning the top 10. Since the leaderboard is capped at 10 entries this is negligibly fast and keeps all logic in the API layer.

---

## Challenge scheduling

The puzzle HTML fetches `/challenge` on load and shows whichever challenge is currently active — i.e. `starts_at <= now <= ends_at`. You can schedule challenges weeks in advance via the admin panel and they'll go live automatically.

The six *Àpótí Ọlọ́wẹ̀* chapter drops:

| Chapter | Title | Date |
|---|---|---|
| Precursor | Entry & world primer | Apr 1–30 2026 |
| 01 | The Chiefs' Meeting | May 1 2026 |
| 02 | Ìpàdé | Jun 1 2026 |
| 03 | L'abẹ Igi Oronbo | Jul 1 2026 |
| 04 | Ilé Agbẹgilérè | Aug 1 2026 |
| 05 | The Engagement | Sep 1 2026 |
| 06 | Aftermath | Sep 27 2026 |

---

## .gitignore

Create a `.gitignore` at the project root:

```
node_modules/
.env
```

Never commit `.env`. Railway reads secrets from its own environment variable store.

---

*Kaysworks · 2026*
