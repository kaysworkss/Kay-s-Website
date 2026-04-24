/**
 * /api/admin
 *
 * Single consolidated file replacing:
 *   api/admin/challenge/login.js       → POST   /api/admin/login
 *   api/admin/challenge/challenges.js  → GET    /api/admin/challenges
 *   api/admin/challenge/challenge.js   → POST   /api/admin/challenge
 *   api/admin/challenge/[id].js        → DELETE /api/admin/challenge/:id
 *   api/admin/challenge/upload-image.js→ POST   /api/admin/upload-image
 *   api/admin/challenge/wallets.js     → GET    /api/admin/wallets
 *
 * All routes require x-admin-token header except /login.
 * Routing is done via the `action` query param or URL path segment.
 *
 * URL scheme (keep identical to existing calls in puzzle.html):
 *   POST   /api/admin?action=login
 *   GET    /api/admin?action=challenges
 *   POST   /api/admin?action=challenge
 *   DELETE /api/admin?action=challenge&id=<uuid>
 *   POST   /api/admin?action=upload-image
 *   GET    /api/admin?action=wallets[&challenge_id=<uuid>]
 */

const { getSupabase, cors, handleOptions } = require('./_lib');
const crypto = require('crypto');

// ── Auth helpers ─────────────────────────────────────────────────────────────

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function checkToken(req) {
  const token = req.headers['x-admin-token'];
  return token && token === process.env.ADMIN_TOKEN;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /api/admin?action=login
async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  // Return a token derived from ADMIN_TOKEN env var (or generate one)
  const token = process.env.ADMIN_TOKEN || generateToken();
  return res.status(200).json({ token });
}

// GET /api/admin?action=challenges
async function handleGetChallenges(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .order('starts_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}

// POST /api/admin?action=challenge
async function handleCreateChallenge(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { title, starts_at, ends_at, piece_count, image_url } = req.body || {};
  if (!title || !starts_at || !ends_at || !image_url) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const { data, error } = await supabase
    .from('challenges')
    .insert({ title, starts_at, ends_at, piece_count: piece_count || 1000, image_url })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ id: data.id });
}

// DELETE /api/admin?action=challenge&id=<uuid>
async function handleDeleteChallenge(req, res, supabase) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required.' });
  // Delete scores first (cascade may handle this, but explicit is safer)
  await supabase.from('scores').delete().eq('challenge_id', id);
  await supabase.from('progress').delete().eq('challenge_id', id);
  const { error } = await supabase.from('challenges').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// POST /api/admin?action=upload-image
async function handleUploadImage(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { filename, base64, mime_type } = req.body || {};
  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }
  // Decode base64 and upload to Supabase Storage bucket "puzzle-images"
  const buffer = Buffer.from(base64, 'base64');
  const ext    = filename.split('.').pop() || 'jpg';
  const path   = `challenges/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, { contentType: mime_type, upsert: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from('puzzle-images').getPublicUrl(path);
  return res.status(200).json({ url: urlData.publicUrl });
}

// GET /api/admin?action=wallets[&challenge_id=uuid]
async function handleGetWallets(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { challenge_id } = req.query;
  let query = supabase
    .from('scores')
    .select('player_name, wallet_address, time_seconds, piece_count, hints_used, created_at, challenge_id, challenges(title)')
    .not('wallet_address', 'is', null)
    .order('created_at', { ascending: false });
  if (challenge_id) query = query.eq('challenge_id', challenge_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const result = (data || []).map(s => ({
    player_name:     s.player_name,
    wallet_address:  s.wallet_address,
    time_seconds:    s.time_seconds,
    piece_count:     s.piece_count,
    hints_used:      s.hints_used,
    created_at:      s.created_at,
    challenge_id:    s.challenge_id,
    challenge_title: s.challenges?.title || '',
  }));
  return res.status(200).json(result);
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  // Extract action — supports both ?action=xxx and path-based calls
  // e.g. /api/admin?action=login  OR  /api/admin/login (Vercel rewrites)
  const urlPath = req.url || '';
  let action = req.query.action || '';

  // Derive action from URL path if not in query string
  if (!action) {
    const match = urlPath.match(/\/admin\/([^/?]+)/);
    if (match) action = match[1];
  }

  // Extract id from URL path for /admin/challenge/:id
  if (!req.query.id) {
    const idMatch = urlPath.match(/\/admin\/challenge\/([^/?]+)/);
    if (idMatch && idMatch[1] !== 'undefined') req.query.id = idMatch[1];
  }

  // Login doesn't need a token
  if (action === 'login') return handleLogin(req, res);

  // All other routes require admin token
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  switch (action) {
    case 'challenges':    return handleGetChallenges(req, res, supabase);
    case 'challenge':     return req.method === 'DELETE'
                            ? handleDeleteChallenge(req, res, supabase)
                            : handleCreateChallenge(req, res, supabase);
    case 'upload-image':  return handleUploadImage(req, res, supabase);
    case 'wallets':       return handleGetWallets(req, res, supabase);
    default:
      return res.status(404).json({ error: `Unknown admin action: ${action}` });
  }
};
