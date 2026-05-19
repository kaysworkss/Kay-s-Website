const TABLE = process.env.FORM_TABLE || 'site_form_submissions';
const ALERT_TO_EMAIL = process.env.FORM_ALERT_TO_EMAIL || 'oyeniyikayode4@gmail.com';
const ALERT_FROM_EMAIL = process.env.FORM_ALERT_FROM_EMAIL || "Kay's Works Queue <auction@mail.kaysworks.com>";
const ADMIN_URL = process.env.FORM_ADMIN_URL || 'https://www.kaysworks.com/claim-admin';

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

function alertLabel(formType) {
  return formType === 'matching-token' ? 'matching token request' : 'commission request';
}

async function sendMinimalAlert(row, id) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY missing');

  const label = alertLabel(row.form_type);
  const subject = `New ${label}`;
  const text = [
    `A new ${label} has been recorded in the Kay's Works admin queue.`,
    '',
    `Submission ID: ${id || 'saved'}`,
    `Open the admin queue: ${ADMIN_URL}`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#1e1510;font-family:Georgia,serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1510;padding:36px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#2a1c14;border:1px solid rgba(196,132,90,0.25);border-radius:6px;overflow:hidden">
        <tr><td style="padding:28px 32px">
          <p style="margin:0 0 6px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#c4845a">Kay's Works Queue</p>
          <h1 style="margin:0 0 12px;color:#e8d5b0;font-size:26px;font-weight:400;line-height:1.25">${subject}</h1>
          <p style="margin:0 0 22px;color:#9a8070;font-size:15px;line-height:1.55">A new request was recorded. No wallet addresses or form details are included in this email.</p>
          <a href="${ADMIN_URL}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:13px 22px;border-radius:4px">Open admin queue</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL,
      to: [ALERT_TO_EMAIL],
      subject,
      text,
      html,
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend alert failed with ${response.status}`);
  }
  return response.json().catch(() => ({}));
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
  const id = inserted && inserted[0] && inserted[0].id;
  let alert = { sent: false };
  try {
    const alertData = await sendMinimalAlert(row, id);
    alert = { sent: true, id: alertData && alertData.id };
  } catch (error) {
    console.error('Queue alert failed:', error.message);
    alert = { sent: false, error: error.message };
  }
  return res.status(200).json({ ok: true, id, alert });
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
