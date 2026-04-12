// GET /api/admin/challenges
// Returns all challenges, newest first.
const { getSupabase, cors, handleOptions, verifyAdmin } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at, created_at')
    .order('starts_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data || []);
};
