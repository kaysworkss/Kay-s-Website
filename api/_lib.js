// ─────────────────────────────────────────────────────
//  Shared helpers for all Vercel API functions
//  Àpótí Ọlọ́wẹ̀ · Kaysworks 2026
// ─────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Supabase client — created once, reused across warm invocations
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// CORS headers — applied to every response
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

// Handle preflight OPTIONS request (browsers send this before POST/DELETE)
function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.status(200).end();
    return true;
  }
  return false;
}

// Verify the admin JWT from x-admin-token header
function verifyAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getSupabase, cors, handleOptions, verifyAdmin };
