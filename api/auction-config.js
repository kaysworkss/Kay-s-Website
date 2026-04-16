/**
 * /api/auction-config
 *
 * GET    — public, returns current auction config as JSON
 * POST   — admin only (X-Admin-Password header), saves new config
 * DELETE — admin only, resets config to defaults
 *
 * Storage: Vercel Edge Config
 *
 * Required environment variables (set in Vercel Dashboard → Project → Settings → Env Vars):
 *   EDGE_CONFIG              — auto-added by Vercel when you link an Edge Config store
 *   EDGE_CONFIG_ID           — the ID of your Edge Config store (e.g. ecfg_xxxx), found in the store URL
 *   VERCEL_API_TOKEN         — a Vercel API token with read/write scope (create at vercel.com/account/tokens)
 *   ADMIN_PASSWORD           — your chosen admin password
 */

import { createClient } from "@vercel/edge-config";

const EDGE_CONFIG_KEY = "auction_config";

// ── Edge Config read client ───────────────────────────────────────────────────
// Uses the EDGE_CONFIG connection string env var (auto-set by Vercel after linking).

const edgeConfig = createClient(process.env.EDGE_CONFIG);

// ── Edge Config write helpers (via Vercel REST API) ───────────────────────────
// Edge Config is read-optimised; writes go through the Vercel REST API.

async function ecWrite(key, value) {
  const storeId = process.env.EDGE_CONFIG_ID;
  const token   = process.env.VERCEL_API_TOKEN;

  if (!storeId || !token) {
    throw new Error("EDGE_CONFIG_ID or VERCEL_API_TOKEN env var is missing");
  }

  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${storeId}/items`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "upsert", key, value }],
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Config write failed (${res.status}): ${text}`);
  }
}

async function ecDelete(key) {
  const storeId = process.env.EDGE_CONFIG_ID;
  const token   = process.env.VERCEL_API_TOKEN;

  if (!storeId || !token) {
    throw new Error("EDGE_CONFIG_ID or VERCEL_API_TOKEN env var is missing");
  }

  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${storeId}/items`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "delete", key }],
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Config delete failed (${res.status}): ${text}`);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorised(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn("ADMIN_PASSWORD env var not set — admin routes are unprotected!");
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

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const config = await edgeConfig.get(EDGE_CONFIG_KEY);
      return res.status(200).json({ ok: true, config: config ?? DEFAULT_CONFIG });
    } catch (err) {
      console.error("GET error:", err);
      return res.status(500).json({ ok: false, error: "Failed to read config" });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
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
      await ecWrite(EDGE_CONFIG_KEY, config);
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
      await ecDelete(EDGE_CONFIG_KEY);
      return res.status(200).json({ ok: true, config: DEFAULT_CONFIG });
    } catch (err) {
      console.error("DELETE error:", err);
      return res.status(500).json({ ok: false, error: "Failed to clear config" });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
