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
//
// Returns aggregate stats for the authenticated player.
//
// Bug history: the previous version used `.eq('player_name', player.name)`,
// which is case-sensitive. Two failure modes:
//   1. Historical scores with different capitalization/whitespace.
//   2. Players who renamed via update-profile — old scores still bear the old name.
// The fix matches by case-insensitive trimmed name (consistent with the rest of
// the codebase) AND by wallet_address as a fallback, so a renamed player still
// owns their old scores via wallet.
//
// Response shape (frontend reads `solved`, `best_time`, `hints_used`; the
// `best_by_tier` block is consumed by the per-difficulty profile breakdown):
//   {
//     solved: number,
//     best_time: number | null,        // overall best in seconds
//     hints_used: number,              // total across all solves
//     best_by_tier: {                  // best per difficulty tier
//       Cowrie:   { time, pieces } | null,
//       Coral:    { time, pieces } | null,
//       Jade:     { time, pieces } | null,
//       Sapphire: { time, pieces } | null,
//       Gold:     { time, pieces } | null,
//     }
//   }

// Difficulty tiers — must mirror DIFF_TIERS in the frontend (puzzle.html).
const DIFF_TIERS = [
  { label: 'Cowrie',   range: [1,    48]   },
  { label: 'Coral',    range: [49,   250]  },
  { label: 'Jade',     range: [251,  600]  },
  { label: 'Sapphire', range: [601,  1200] },
  { label: 'Gold',     range: [1201, 9999] },
];
function tierForPieces(n) {
  const pc = Number(n) || 0;
  return DIFF_TIERS.find(t => pc >= t.range[0] && pc <= t.range[1]) || DIFF_TIERS[DIFF_TIERS.length - 1];
}

async function handleStats(req, res, supabase, player) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const nameKey   = (player.name || '').trim();
  const walletKey = (player.wallet_address || '').trim();

  // Two separate queries, combined in JS. This avoids PostgREST .or() filter-string
  // parsing pitfalls with names that contain spaces or special characters.
  // Match strategy:
  //   (a) case-insensitive name match — handles old scores where capitalization differs
  //   (b) wallet-address match — handles renamed players whose old score rows still
  //       carry the previous display name
  const cols = 'time_seconds, hints_used, piece_count, challenge_id, player_name, wallet_address';

  const queries = [];
  if (nameKey) {
    queries.push(supabase.from('scores').select(cols).ilike('player_name', nameKey));
  }
  if (walletKey) {
    queries.push(supabase.from('scores').select(cols).eq('wallet_address', walletKey));
  }

  if (!queries.length) {
    return res.status(200).json({
      solved: 0, best_time: null, hints_used: 0,
      best_by_tier: {}, _debug: { reason: 'no name or wallet on player record' }
    });
  }

  const results = await Promise.all(queries);
  for (const r of results) {
    if (r.error) return res.status(500).json({ error: r.error.message });
  }

  // Merge and dedupe by score row (a row may match both name and wallet queries).
  // Composite key challenge_id + time_seconds + player_name catches duplicate rows
  // returned from both queries without losing genuinely distinct attempts.
  const seen = new Set();
  const merged = [];
  for (const r of results) {
    for (const s of (r.data || [])) {
      const key = `${s.challenge_id}|${s.time_seconds}|${s.player_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
  }

  // Per-challenge best (lowest time). "Solved" counts unique challenges to match
  // how the leaderboard displays one row per player per puzzle.
  const bestPerChallenge = new Map();
  for (const s of merged) {
    const t = Number(s.time_seconds) || 0;
    if (t <= 0) continue;
    const prev = bestPerChallenge.get(s.challenge_id);
    if (!prev || t < (Number(prev.time_seconds) || Infinity)) {
      bestPerChallenge.set(s.challenge_id, s);
    }
  }
  const uniqueScores = Array.from(bestPerChallenge.values());

  const solved = uniqueScores.length;
  let best_time  = null;
  let hints_used = 0;
  const best_by_tier = {};
  for (const t of DIFF_TIERS) best_by_tier[t.label] = null;

  // Some legacy score rows may have null piece_count. We still want them to count
  // toward solved/hints/best_time totals; for per-tier bests, we look up
  // piece_count from the challenges table as a fallback.
  const missingPieceChallengeIds = uniqueScores
    .filter(s => !s.piece_count)
    .map(s => s.challenge_id);

  let challengePieceMap = {};
  if (missingPieceChallengeIds.length) {
    const { data: chs } = await supabase
      .from('challenges')
      .select('id, piece_count')
      .in('id', missingPieceChallengeIds);
    if (chs) {
      for (const ch of chs) challengePieceMap[ch.id] = ch.piece_count;
    }
  }

  for (const s of uniqueScores) {
    const t = Number(s.time_seconds) || 0;
    const h = Number(s.hints_used)   || 0;
    let   p = Number(s.piece_count)  || 0;
    if (!p) p = Number(challengePieceMap[s.challenge_id]) || 0;

    if (best_time == null || t < best_time) best_time = t;
    hints_used += h;

    if (p > 0) {
      const tier = tierForPieces(p);
      const cur  = best_by_tier[tier.label];
      if (!cur || t < cur.time) {
        best_by_tier[tier.label] = { time: t, pieces: p };
      }
    }
  }

  return res.status(200).json({
    solved,
    best_time,
    hints_used,
    best_by_tier,
    // Diagnostic — visible in browser devtools Network tab for troubleshooting.
    // Safe to leave in; it doesn't expose anything the player doesn't already know.
    _debug: {
      raw_rows_returned: merged.length,
      unique_challenges: uniqueScores.length,
      matched_by_name: (results[0] && results[0].data) ? results[0].data.length : 0,
      matched_by_wallet: (results[1] && results[1].data) ? results[1].data.length : 0,
      player_name_used: nameKey,
      player_wallet_used: walletKey || null,
    }
  });
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
