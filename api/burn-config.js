/**
 * /api/burn-config
 *
 * GET    - public, returns the burn-to-redeem dapp config
 * POST   - admin only, saves the current burn-to-redeem contract address
 * DELETE - admin only, resets config
 *
 * Uses the same Vercel Edge Config env vars as auction-config.js:
 * EDGE_CONFIG, EDGE_CONFIG_ID, VERCEL_API_TOKEN, ADMIN_PASSWORD, ADMIN_TOKEN
 */

const { createClient } = require("@vercel/edge-config");
const crypto = require("crypto");

const EC_KEY = "burn_redeem_config";

const DEFAULT_CONFIG = {
  contractAddress: "",
  network: "mainnet",
  savedAt: null,
};

async function ecGet() {
  const client = createClient(process.env.EDGE_CONFIG);
  return await client.get(EC_KEY);
}

async function ecSet(value) {
  const id = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${id}/items`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [{ operation: "upsert", key: EC_KEY, value }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Edge Config write failed ${res.status}: ${txt}`);
  }
}

async function ecDel() {
  const id = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${id}/items`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [{ operation: "delete", key: EC_KEY }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Edge Config delete failed ${res.status}: ${txt}`);
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password, X-Admin-Token");
}

function checkAdminToken(req) {
  const token = req.headers["x-admin-token"];
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [id, sig] = parts;
  const secret = process.env.ADMIN_TOKEN || "fallback-secret-change-me";
  const expected = crypto.createHmac("sha256", secret).update(id).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function isAuthorised(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && req.headers["x-admin-password"] === pw) return true;
  return checkAdminToken(req);
}

function normaliseConfig(body) {
  const contractAddress = String(body.contractAddress || body.contractAddr || "").trim();
  return {
    contractAddress: contractAddress.startsWith("KT1") ? contractAddress.slice(0, 100) : "",
    network: ["mainnet", "ghostnet"].includes(body.network) ? body.network : "mainnet",
    savedAt: Date.now(),
  };
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try {
      const stored = await ecGet();
      return res.status(200).json({ ok: true, config: stored || DEFAULT_CONFIG });
    } catch (err) {
      console.error("GET burn config error:", err);
      return res.status(500).json({ ok: false, error: "Failed to read burn config" });
    }
  }

  if (req.method === "POST") {
    if (!isAuthorised(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }

    const config = normaliseConfig(body);
    if (!config.contractAddress) {
      return res.status(400).json({ ok: false, error: "Valid KT1 contractAddress is required" });
    }

    try {
      await ecSet(config);
      return res.status(200).json({ ok: true, config });
    } catch (err) {
      console.error("POST burn config error:", err);
      return res.status(500).json({ ok: false, error: "Failed to save burn config" });
    }
  }

  if (req.method === "DELETE") {
    if (!isAuthorised(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

    try {
      await ecDel();
      return res.status(200).json({ ok: true, config: DEFAULT_CONFIG });
    } catch (err) {
      console.error("DELETE burn config error:", err);
      return res.status(500).json({ ok: false, error: "Failed to clear burn config" });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
};
