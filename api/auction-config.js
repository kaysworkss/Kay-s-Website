/**
 * /api/auction-config
 *
 * GET    — public, returns current auction config as JSON
 * POST   — admin only (X-Admin-Password header), saves new config
 * DELETE — admin only, resets config to default
 *
 * Storage: Vercel Edge Config
 * Env vars: EDGE_CONFIG, EDGE_CONFIG_ID, VERCEL_API_TOKEN, ADMIN_PASSWORD
 */

const { createClient } = require("@vercel/edge-config");

const EC_KEY = "auction_config";

// ── Edge Config helpers ───────────────────────────────────────────────────────

async function ecGet() {
  const client = createClient(process.env.EDGE_CONFIG);
  return await client.get(EC_KEY);
}

async function ecSet(value) {
  const id    = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${id}/items`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "upsert", key: EC_KEY, value }],
      }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Edge Config write failed ${res.status}: ${txt}`);
  }
}

async function ecDel() {
  const id    = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${id}/items`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "delete", key: EC_KEY }],
      }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Edge Config delete failed ${res.status}: ${txt}`);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorised(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn("ADMIN_PASSWORD not set — admin routes unprotected!");
    return true;
  }
  return req.headers["x-admin-password"] === pw;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
}

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  status:       "off",
  contractAddr: "",
  artTitle:     "",
  artArtist:    "",
  artAbout:     "",
  artYear:      "",
  artMedium:    "",
  artImage:     "",
  gateName:     "",
  gateLink:     "",
  rpcUrl:       "",
  launchDate:   "",
  savedAt:      null,
};

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    try {
      const stored = await ecGet();
      const config = stored || DEFAULT_CONFIG;
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      console.error("GET error:", err);
      return res.status(500).json({ ok: false, error: "Failed to read config" });
    }
  }

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
      await ecSet(config);
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      console.error("POST error:", err);
      return res.status(500).json({ ok: false, error: "Failed to save config" });
    }
  }

  if (req.method === "DELETE") {
    if (!isAuthorised(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    try {
      await ecDel();
      return res.status(200).json({ ok: true, config: DEFAULT_CONFIG });
    } catch (err) {
      console.error("DELETE error:", err);
      return res.status(500).json({ ok: false, error: "Failed to clear config" });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
};
