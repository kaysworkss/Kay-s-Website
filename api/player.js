/**
 * /api/player
 *
 * Single consolidated file replacing:
 *   api/player/register.js        → POST /api/player?action=register
 *   api/player/login.js           → POST /api/player?action=login
 *   api/player/progress-save.js   → POST /api/player?action=progress-save
 *   api/player/progress-load.js   → GET  /api/player?action=progress-load&challenge_id=<uuid>
 */

const { getSupabase, cors, handleOptions } = require('./_lib');
const crypto = require('crypto');

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPin(pin) {
  const salt = process.env.PIN_SALT || 'apoti-olowe-salt-changeme';
  return crypto.createHmac('sha256', salt).update(String(pin)).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getPlayerFromToken(supabase, token) {
  if (!token) return null;
  const { data, error } = await supabase
    .from('players')
    .select('id, name, wallet_address, avatar_url')
    .eq('session_token', token)
    .gt('token_expires_at', new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// ── POST /api/player?action=register ─────────────────────────────────────────
async function handleRegister(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, pin, wallet_address } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 28) {
    return res.status(400).json({ error: 'Name must be 1–28 characters.' });
  }
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  const cleanName   = name.trim();
  const cleanWallet = wallet_address && String(wallet_address).trim().length > 0
    ? String(wallet_address).trim().slice(0, 100) : null;
  const pinHash     = hashPin(pin);
  const token       = generateToken();
  const tokenExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  // Check name not already taken
  const { data: existing } = await supabase
    .from('players')
    .select('id')
    .ilike('name', cleanName)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'That name is already taken. Please choose another or log in.' });
  }

  const { data: player, error } = await supabase
    .from('players')
    .insert({ name: cleanName, wallet_address: cleanWallet, pin_hash: pinHash, session_token: token, token_expires_at: tokenExpiry })
    .select('id, name, wallet_address, avatar_url')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json({ player_id: player.id, name: player.name, wallet_address: player.wallet_address, avatar_url: player.avatar_url || null, token });
}

// ── POST /api/player?action=login ─────────────────────────────────────────────
async function handleLogin(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN are required.' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

  const pinHash = hashPin(pin);

  const { data: player, error } = await supabase
    .from('players')
    .select('id, name, wallet_address, avatar_url, pin_hash')
    .ilike('name', name.trim())
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  // Timing-safe comparison
  const expectedHash = player ? player.pin_hash : hashPin('0000');
  const match = crypto.timingSafeEqual(
    Buffer.from(pinHash, 'hex'),
    Buffer.from(expectedHash, 'hex')
  );

  if (!player || !match) return res.status(401).json({ error: 'Incorrect name or PIN.' });

  const token       = generateToken();
  const tokenExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  await supabase.from('players')
    .update({ session_token: token, token_expires_at: tokenExpiry })
    .eq('id', player.id);

  return res.status(200).json({ player_id: player.id, name: player.name, wallet_address: player.wallet_address, avatar_url: player.avatar_url || null, token });
}

// ── POST /api/player?action=progress-save ────────────────────────────────────
async function handleProgressSave(req, res, supabase, player) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge_id, piece_state, placed, total, elapsed, hints_left, edge_seed } = req.body || {};

  if (!challenge_id || !piece_state || !Array.isArray(piece_state)) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const { error } = await supabase
    .from('progress')
    .upsert({
      player_id:    player.id,
      challenge_id,
      piece_state,
      placed:       placed    || 0,
      total:        total     || 0,
      elapsed:      elapsed   || 0,
      hints_left:   typeof hints_left === 'number' ? hints_left : 3,
      edge_seed:    edge_seed || null,
      saved_at:     new Date().toISOString(),
    }, { onConflict: 'player_id,challenge_id' });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// ── GET /api/player?action=progress-load&challenge_id=<uuid> ─────────────────
async function handleProgressLoad(req, res, supabase, player) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge_id } = req.query;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required.' });

  const { data, error } = await supabase
    .from('progress')
    .select('placed, total, elapsed, hints_left, piece_state, edge_seed, saved_at')
    .eq('player_id', player.id)
    .eq('challenge_id', challenge_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'No saved progress found.' });
  if (data.placed > 0 && data.placed >= data.total) {
    return res.status(404).json({ error: 'Challenge already completed.' });
  }

  return res.status(200).json({
    placed: data.placed, total: data.total, elapsed: data.elapsed,
    hints_left: data.hints_left, piece_state: data.piece_state,
    edge_seed: data.edge_seed || null, saved_at: data.saved_at,
    player_name: player.name, wallet_address: player.wallet_address,
  });
}


// ── POST /api/player?action=update-profile ────────────────────────────────────
async function handleUpdateProfile(req, res, supabase, player) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, wallet_address, new_pin, avatar_url } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 28) {
    return res.status(400).json({ error: 'Name must be 1-28 characters.' });
  }
  if (new_pin && !/^\d{4}$/.test(String(new_pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  const cleanName   = name.trim();
  const cleanWallet = wallet_address && String(wallet_address).trim().length > 0
    ? String(wallet_address).trim().slice(0, 100) : null;
  const cleanAvatar = avatar_url && String(avatar_url).trim().length > 0
    ? String(avatar_url).trim().slice(0, 500) : null;

  // Check if new name is taken by someone else
  if (cleanName.toLowerCase() !== player.name.toLowerCase()) {
    const { data: existing } = await supabase
      .from('players')
      .select('id')
      .ilike('name', cleanName)
      .maybeSingle();
    if (existing && existing.id !== player.id) {
      return res.status(409).json({ error: 'That name is already taken.' });
    }
  }

  const updates = {
    name:           cleanName,
    wallet_address: cleanWallet,
    avatar_url:     cleanAvatar,
  };
  if (new_pin) updates.pin_hash = hashPin(new_pin);

  const { data, error } = await supabase
    .from('players')
    .update(updates)
    .eq('id', player.id)
    .select('id, name, wallet_address, avatar_url')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    player_id:      data.id,
    name:           data.name,
    wallet_address: data.wallet_address,
    avatar_url:     data.avatar_url,
  });
}

// ── POST /api/player?action=upload-avatar ─────────────────────────────────────
async function handleUploadAvatar(req, res, supabase, player) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { filename, base64, mime_type } = req.body || {};
  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }

  const crypto = require('crypto');
  const buffer = Buffer.from(base64, 'base64');
  const ext    = filename.split('.').pop() || 'jpg';
  const path   = `avatars/${player.id}-${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, { contentType: mime_type, upsert: true });

  if (error) return res.status(500).json({ error: error.message });

  const { data: urlData } = supabase.storage.from('puzzle-images').getPublicUrl(path);
  return res.status(200).json({ url: urlData.publicUrl });
}

// ── GET /api/player?action=stats ──────────────────────────────────────────────
async function handleStats(req, res, supabase, player) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { data, error } = await supabase
    .from('scores')
    .select('time_seconds, hints_used, piece_count')
    .eq('player_name', player.name)
    .order('time_seconds', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const scores     = data || [];
  const solved     = scores.length;
  const best_time  = solved > 0 ? scores[0].time_seconds : null;
  const hints_used = scores.reduce((sum, s) => sum + (s.hints_used || 0), 0);

  return res.status(200).json({ solved, best_time, hints_used });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  const urlPath = req.url || '';
  let action = req.query.action || '';

  if (!action) {
    if (urlPath.includes('/register'))      action = 'register';
    else if (urlPath.includes('/login'))    action = 'login';
    else if (urlPath.includes('/progress-save')) action = 'progress-save';
    else if (urlPath.includes('/progress-load')) action = 'progress-load';
  }

  const supabase = getSupabase();

  // Register and login don't need a token
  if (action === 'register') return handleRegister(req, res, supabase);
  if (action === 'login')    return handleLogin(req, res, supabase);

  // All other player routes need a valid session token
  const token  = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const player = await getPlayerFromToken(supabase, token);
  if (!player) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

  switch (action) {
    case 'progress-save':   return handleProgressSave(req, res, supabase, player);
    case 'progress-load':   return handleProgressLoad(req, res, supabase, player);
    case 'update-profile':  return handleUpdateProfile(req, res, supabase, player);
    case 'upload-avatar':   return handleUploadAvatar(req, res, supabase, player);
    case 'stats':           return handleStats(req, res, supabase, player);
    default:
      return res.status(404).json({ error: `Unknown player action: ${action}` });
  }
};
