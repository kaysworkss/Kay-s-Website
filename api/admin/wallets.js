// GET /api/admin/wallets
// Returns all scores that have a wallet address, with player name, challenge title, time, and date.
// Protected by x-admin-token header.
// Optional query param: challenge_id — filter to a specific challenge.
const { getSupabase, cors, handleOptions } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const { challenge_id } = req.query;

  // Build query — join challenges to get title
  let query = supabase
    .from('scores')
    .select('player_name, wallet_address, time_seconds, piece_count, hints_used, created_at, challenge_id, challenges(title)')
    .not('wallet_address', 'is', null)
    .order('created_at', { ascending: false });

  if (challenge_id) {
    query = query.eq('challenge_id', challenge_id);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });

  // Flatten challenge title
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

  res.status(200).json(result);
};
