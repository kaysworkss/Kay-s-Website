// GET /api/challenges
// Returns all currently active challenges (up to 3), sorted by piece_count asc.
// The frontend renders a difficulty picker card for each challenge.
const { getSupabase, cors, handleOptions } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, reward_url, piece_count, starts_at, ends_at')
    .lte('starts_at', now)
    .gte('ends_at', now)
    .order('piece_count', { ascending: true })
    .limit(3);

  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) {
    return res.status(404).json({ error: 'No active challenge at this time.' });
  }
  res.status(200).json(data);
};
