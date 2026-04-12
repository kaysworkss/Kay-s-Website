// POST /api/admin/upload-image
// Uploads a puzzle image to Supabase Storage.
// Body: { filename, base64, mime_type } → returns { url, path }
const { getSupabase, cors, handleOptions, verifyAdmin } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { filename, base64, mime_type } = req.body;

  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime_type)) {
    return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG, or WEBP.' });
  }

  const supabase = getSupabase();
  const buffer   = Buffer.from(base64, 'base64');
  const ext      = mime_type.split('/')[1].replace('jpeg', 'jpg');
  const safeName = filename.replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
  const path     = `${Date.now()}-${safeName}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, {
      contentType:  mime_type,
      cacheControl: '31536000',
      upsert:       false,
    });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data: { publicUrl } } = supabase.storage
    .from('puzzle-images')
    .getPublicUrl(path);

  res.status(201).json({ url: publicUrl, path });
};
