// POST /api/admin/login
// Body: { password } → returns a signed JWT valid for 8 hours
const jwt = require('jsonwebtoken');
const { cors, handleOptions } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.status(200).json({ token });
};
