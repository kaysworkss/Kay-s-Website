/**
 * /api/auction-config
 *
 * GET  — public, returns the current auction config as JSON
 * POST — admin only (requires X-Admin-Password header), saves new config
 * DELETE — admin only, clears config back to default
 *
 * Storage: Vercel KV (Redis). Set KV_REST_API_URL + KV_REST_API_TOKEN
 * in your Vercel project's Environment Variables.
 */

const KV_KEY = "auction_config";

// ── KV helpers (thin wrapper around Vercel KV REST API) ──────────────────────

async function kvGet(key) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${key}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  return json.result ?? null; // returns the raw string stored, or null
}

async function kvSet(key, value) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/set/${key}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
    }
  );
  if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
}

async function kvDel(key) {
  await fetch(
    `${process.env.KV_REST_API_URL}/del/${key}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    }
  );
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function isAuthorised(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn("ADMIN_PASSWORD env var not set — admin routes are unprotected!");
    return true;
  }
  return req.headers["x-admin-password"] === pw;
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
}

// ── Default / empty config ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  status: "off",
  contractAddr: "",
  artTitle: "",
  artArtist: "",
  artAbout: "",
  artYear: "",
  artMedium: "",
  artImage: "",
  gateName: "",
  gateLink: "",
  rpcUrl: "",
  launchDate: "",
  savedAt: null,
};

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  cors(res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const raw = await kvGet(KV_KEY);
      const config = raw ? JSON.parse(raw) : DEFAULT_CONFIG;
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      console.error("GET error:", err);
      return res.status(500).json({ ok: false, error: "Failed to read config" });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    if (!isAuthorised(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }

    // Whitelist fields — never store arbitrary keys
    const config = {
      status:       ["live", "upcoming", "off"].includes(body.status) ? body.status : "off",
      contractAddr: String(body.contractAddr  || "").slice(0, 100),
      artTitle:     String(body.artTitle      || "").slice(0, 200),
      artArtist:    String(body.artArtist     || "").slice(0, 200),
      artAbout:     String(body.artAbout      || "").slice(0, 2000),
      artYear:      String(body.artYear       || "").slice(0, 10),
      artMedium:    String(body.artMedium     || "").slice(0, 200),
      artImage:     String(body.artImage      || "").slice(0, 500),
      gateName:     String(body.gateName      || "").slice(0, 200),
      gateLink:     String(body.gateLink      || "").slice(0, 500),
      rpcUrl:       String(body.rpcUrl        || "").slice(0, 500),
      launchDate:   String(body.launchDate    || "").slice(0, 50),
      savedAt:      Date.now(),
    };

    try {
      await kvSet(KV_KEY, JSON.stringify(config));
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      console.error("POST error:", err);
      return res.status(500).json({ ok: false, error: "Failed to save config" });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    if (!isAuthorised(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    try {
      await kvDel(KV_KEY);
      return res.status(200).json({ ok: true, config: DEFAULT_CONFIG });
    } catch (err) {
      console.error("DELETE error:", err);
      return res.status(500).json({ ok: false, error: "Failed to clear config" });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
