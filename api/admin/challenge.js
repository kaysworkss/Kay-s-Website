// POST /api/admin/challenge
// Create a new challenge.
// Body: { title, image_url, image_path?, reward_url?, starts_at, ends_at, piece_count }
const { getSupabase, cors, handleOptions, verifyAdmin } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { title, image_url, image_path, reward_url, starts_at, ends_at, piece_count } = req.body;

  if (!title || !image_url || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'Missing required fields: title, image_url, starts_at, ends_at.' });
  }
  if (new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at.' });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('challenges')
    .insert({
      title,
      image_url,
      image_path:  image_path  || null,
      reward_url:  reward_url  || null,
      starts_at,
      ends_at,
      piece_count: parseInt(piece_count) || 1000,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
};
