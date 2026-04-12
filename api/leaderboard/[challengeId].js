// GET /api/leaderboard/[challengeId]
// Returns all deduplicated scores for a challenge (best per player).
// Frontend buckets into difficulty tiers and shows top-10 per tier.
const { getSupabase, cors, handleOptions } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { challengeId } = req.query;
  if (!challengeId) return res.status(400).json({ error: 'Missing challengeId' });

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('scores')
    .select('player_name, time_seconds, piece_count, hints_used, ghost_used, created_at')
    .eq('challenge_id', challengeId)
    .order('time_seconds', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Deduplicate: keep only each player's best (fastest) time.
  // Scores are already sorted fastest-first so first occurrence = best.
  const seen = new Set();
  const best = (data || []).filter(s => {
    const key = s.player_name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Return all deduplicated scores — frontend slices to top-10 per tier.
  // Cap at 200 to prevent oversized responses.
  res.status(200).json(best.slice(0, 200));
};
