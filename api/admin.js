/**
 * /api/admin
 *
 * Single consolidated file replacing:
 *   api/admin/challenge/login.js        → POST   /api/admin/login
 *   api/admin/challenge/challenges.js   → GET    /api/admin/challenges
 *   api/admin/challenge/challenge.js    → POST   /api/admin/challenge
 *   api/admin/challenge/[id].js         → DELETE /api/admin/challenge/:id
 *   api/admin/challenge/upload-image.js → POST   /api/admin/upload-image
 *   api/admin/challenge/wallets.js      → GET    /api/admin/wallets
 */

const { getSupabase, cors, handleOptions } = require('./_lib');
const crypto = require('crypto');

// ── Auth helpers ─────────────────────────────────────────────────────────────
// Signed token: HMAC-SHA256(randomId, ADMIN_TOKEN)
// Stateless — no storage needed. Any request can be verified by re-deriving the HMAC.

function generateToken() {
  const id     = crypto.randomBytes(16).toString('hex');
  const secret = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const sig    = crypto.createHmac('sha256', secret).update(id).digest('hex');
  return `${id}.${sig}`;
}

function checkToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [id, sig] = parts;
  const secret   = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const expected = crypto.createHmac('sha256', secret).update(id).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig,      'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch { return false; }
}

// ── POST /api/admin?action=login ─────────────────────────────────────────────
async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  return res.status(200).json({ token: generateToken() });
}

// ── GET /api/admin?action=challenges ─────────────────────────────────────────
async function handleGetChallenges(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .order('starts_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}

// ── POST /api/admin?action=challenge ─────────────────────────────────────────
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

// ── DELETE /api/admin?action=challenge&id=<uuid> ──────────────────────────────
async function handleDeleteChallenge(req, res, supabase) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required.' });
  await supabase.from('scores').delete().eq('challenge_id', id);
  await supabase.from('progress').delete().eq('challenge_id', id);
  const { error } = await supabase.from('challenges').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// ── POST /api/admin?action=upload-image ──────────────────────────────────────
async function handleUploadImage(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { filename, base64, mime_type } = req.body || {};
  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }
  const buffer = Buffer.from(base64, 'base64');
  const ext    = filename.split('.').pop() || 'jpg';
  const path   = `challenges/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const { error } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, { contentType: mime_type, upsert: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from('puzzle-images').getPublicUrl(path);
  return res.status(200).json({ url: urlData.publicUrl });
}

// ── GET /api/admin?action=wallets ─────────────────────────────────────────────
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
  return res.status(200).json((data || []).map(s => ({
    player_name:     s.player_name,
    wallet_address:  s.wallet_address,
    time_seconds:    s.time_seconds,
    piece_count:     s.piece_count,
    hints_used:      s.hints_used,
    created_at:      s.created_at,
    challenge_id:    s.challenge_id,
    challenge_title: s.challenges?.title || '',
  })));
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  const urlPath = req.url || '';
  let action = req.query.action || '';

  // Derive action from URL path if not in query string
  if (!action) {
    const match = urlPath.match(/\/admin\/([^/?]+)/);
    if (match) action = match[1];
  }

  // Extract id from path for /admin/challenge/:id
  if (!req.query.id) {
    const idMatch = urlPath.match(/\/admin\/challenge\/([^/?]+)/);
    if (idMatch && idMatch[1] !== 'undefined') req.query.id = idMatch[1];
  }

  // Login doesn't need a token
  if (action === 'login') return handleLogin(req, res);

  // All other routes require a valid signed token
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();

  switch (action) {
    case 'challenges':   return handleGetChallenges(req, res, supabase);
    case 'challenge':    return req.method === 'DELETE'
                           ? handleDeleteChallenge(req, res, supabase)
                           : handleCreateChallenge(req, res, supabase);
    case 'upload-image': return handleUploadImage(req, res, supabase);
    case 'wallets':      return handleGetWallets(req, res, supabase);
    default:
      return res.status(404).json({ error: `Unknown admin action: ${action}` });
  }
};
