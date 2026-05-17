const TABLE = process.env.FORM_TABLE || 'site_form_submissions';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Admin-Password');
  res.setHeader('Cache-Control', 'no-store');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function clean(value, maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isAuthorised(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn('ADMIN_PASSWORD not set - admin routes unprotected.');
    return true;
  }
  return req.headers['x-admin-password'] === pw;
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return { url: url.replace(/\/$/, ''), key };
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error((data && (data.message || data.error)) || `Supabase error ${response.status}`);
  }
  return data;
}

function buildRow(payload) {
  const formType = clean(payload.form_type || payload.type || 'commission', 80).toLowerCase();

  if (clean(payload._gotcha || payload.website)) {
    return { bot: true };
  }

  if (formType === 'matching-token' || formType === 'claim') {
    const row = {
      form_type: 'matching-token',
      status: 'pending',
      collector_name: clean(payload.collector_name || payload.name, 180),
      email: clean(payload.email, 320),
      source_chain: clean(payload.source_chain, 80),
      source_wallet: clean(payload.source_wallet, 180),
      source_balance: clean(payload.source_balance, 40),
      requested_token: clean(payload.requested_token, 120),
      destination_wallet: clean(payload.destination_wallet, 180),
      note: clean(payload.note, 2000),
      payload,
    };
    if (!row.collector_name || !isEmail(row.email) || !row.source_chain || !row.source_wallet || !row.destination_wallet || !row.requested_token) {
      return { error: 'Please complete all required matching token fields.' };
    }
    return row;
  }

  const row = {
    form_type: 'commission',
    status: 'pending',
    name: clean(payload.name, 180),
    email: clean(payload.email, 320),
    commission_type: clean(payload.commission_type, 160),
    message: clean(payload.message, 4000),
    payload,
  };
  if (!row.name || !isEmail(row.email) || !row.message) {
    return { error: 'Please complete all required commission fields.' };
  }
  return row;
}

async function handleCreate(req, res) {
  const payload = await readBody(req);
  const row = buildRow(payload);
  if (row.bot) return res.status(200).json({ ok: true });
  if (row.error) return res.status(422).json({ error: row.error });

  const inserted = await supabaseFetch(TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  return res.status(200).json({ ok: true, id: inserted && inserted[0] && inserted[0].id });
}

async function handleList(req, res) {
  if (!isAuthorised(req)) return res.status(401).json({ error: 'Unauthorized' });
  const status = clean(req.query.status || 'pending', 40);
  const type = clean(req.query.type || '', 80);
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'created_at.desc');
  params.set('limit', '200');
  if (status !== 'all') params.set('status', `eq.${status}`);
  if (type) params.set('form_type', `eq.${type}`);
  const rows = await supabaseFetch(`${TABLE}?${params.toString()}`);
  return res.status(200).json(rows || []);
}

async function handleUpdate(req, res) {
  if (!isAuthorised(req)) return res.status(401).json({ error: 'Unauthorized' });
  const id = clean(req.query.id, 80);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const body = await readBody(req);
  const status = clean(body.status || 'settled', 40);
  if (!['pending', 'settled', 'archived'].includes(status)) {
    return res.status(422).json({ error: 'Invalid status' });
  }
  const patch = {
    status,
    settled_at: status === 'settled' ? new Date().toISOString() : null,
  };
  const rows = await supabaseFetch(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  return res.status(200).json({ ok: true, submission: rows && rows[0] });
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') return handleCreate(req, res);
    if (req.method === 'GET') return handleList(req, res);
    if (req.method === 'PATCH') return handleUpdate(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
