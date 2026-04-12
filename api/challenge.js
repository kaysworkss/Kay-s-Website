// GET /api/challenge
// Returns the currently active challenge or 404.
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
    .order('starts_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'No active challenge at this time.' });
  }
  res.status(200).json(data);
};
