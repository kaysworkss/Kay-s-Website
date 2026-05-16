export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ ok: false, error: 'No password provided' });
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.error('[admin-auth] ADMIN_PASSWORD env variable is not set');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  if (password === process.env.ADMIN_PASSWORD) {
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false });
}
