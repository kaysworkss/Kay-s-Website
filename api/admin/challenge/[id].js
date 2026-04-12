// DELETE /api/admin/challenge/[id]
// Deletes a challenge (cascades to scores) and removes its image from Storage.
const { getSupabase, cors, handleOptions, verifyAdmin } = require('../../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const supabase = getSupabase();

  // Fetch image_path before deletion so we can clean up storage
  const { data: challenge } = await supabase
    .from('challenges')
    .select('image_path')
    .eq('id', id)
    .single();

  // Delete the DB row (scores cascade)
  const { error } = await supabase.from('challenges').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  // Remove image from Storage if we have the path
  if (challenge?.image_path) {
    await supabase.storage.from('puzzle-images').remove([challenge.image_path]);
  }

  res.status(200).json({ success: true });
};
