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

function emailList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
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

  if (formType === 'delivery-details' || formType === 'shipping') {
    const row = {
      form_type:       'delivery-details',
      status:          'pending',
      name:            clean(payload.customer_name || payload.name, 180),
      email:           clean(payload.customer_email || payload.email, 320),
      order_ref:       clean(payload.order_ref, 200),
      carrier:         clean(payload.carrier, 80),
      tracking:        clean(payload.tracking, 200),
      tracking_url:    clean(payload.tracking_url, 500),
      eta:             clean(payload.eta, 200),
      message:         clean(payload.message, 4000),
      items_summary:   clean(payload.items_summary, 2000),
      payload,
    };
    if (!row.email || !isEmail(row.email)) {
      return { error: 'Customer email is required.' };
    }
    if (!row.carrier || !row.tracking) {
      return { error: 'Carrier and tracking number are required.' };
    }
    return row;
  }

  if (formType === 'interest-1of1' || formType === 'acquisition') {
    const row = {
      form_type:       'interest-1of1',
      status:          'pending',
      name:            clean(payload.name, 180),
      email:           clean(payload.email, 320),
      commission_type: 'interest-1of1',
      artwork:         clean(payload.artwork || payload.commission_type?.replace('interest-1of1','').trim() || '', 200),
      message:         clean(payload.message, 4000),
      payload,
    };
    if (!row.name || !isEmail(row.email)) {
      return { error: 'Please complete all required fields.' };
    }
    return row;
  }

  if (formType === 'private-offer' || formType === 'offer') {
    const row = {
      form_type:      'private-offer',
      status:         'pending',
      name:           clean(payload.name, 180),
      email:          clean(payload.email, 320),
      offer_amount:   clean(payload.offer_amount, 40),
      offer_currency: clean(payload.offer_currency || 'USD', 10),
      artwork:        clean(payload.artwork, 200),
      chain:          clean(payload.chain, 40),
      wallet_address: clean(payload.wallet_address, 180),
      message:        clean(payload.message, 2000),
      payload,
    };
    if (!row.name || !isEmail(row.email) || !row.offer_amount) {
      return { error: 'Please complete all required offer fields.' };
    }
    return row;
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

  if (formType === 'newsletter' || formType === 'subscribe') {
    const email = clean(payload.email, 320);
    if (!isEmail(email)) return { error: 'Please enter a valid email address.' };
    return { form_type: 'newsletter', status: 'pending', email, name: clean(payload.name || 'Subscriber', 180), payload };
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
  if (formType === 'matching-token') return 'matching token request';
  if (formType === 'private-offer')  return 'private offer';
  if (formType === 'interest-1of1')  return 'acquisition enquiry';
  if (formType === 'delivery-details') return 'delivery notification sent';
  return 'commission request';
}

// ── Customer shipping notification ────────────────────────────────────────────
async function sendShippingNotification(row, id) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY missing');

  const name       = row.name       || 'Collector';
  const orderRef   = row.order_ref  || id || '—';
  const carrier    = row.carrier;
  const tracking   = row.tracking;
  const trackingUrl = row.tracking_url || '';
  const eta        = row.eta        || '';
  const extraMsg   = row.message    || '';
  const items      = row.items_summary || '';
  const subject    = `Your order is on its way — ${orderRef}`;

  const trackingBlock = trackingUrl
    ? `<a href="${trackingUrl}" style="display:inline-block;background:linear-gradient(90deg,#b8821e 0%,#e8c45a 35%,#f5d878 55%,#d4a030 80%,#b8821e 100%);color:#2d1508;text-decoration:none;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:12px 28px;border-radius:999px">Track your order</a>`
    : `<p style="margin:0;font-family:'Courier New',monospace;font-size:13px;color:#5c3e2e;background:rgba(196,132,90,0.08);padding:10px 14px;border-radius:6px;letter-spacing:0.06em">${tracking}</p>`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">
      Great news, ${name} — your order is packed and on its way.
    </p>
    ${items ? `<p style="margin:0 0 14px;font-size:13px;color:#7a5a40;font-family:Georgia,serif;font-style:italic;line-height:1.6">${items}</p>` : ''}
    ${extraMsg ? `<p style="margin:0 0 14px;font-size:13px;color:#5c3e2e;font-family:Georgia,serif;line-height:1.65">${extraMsg}</p>` : ''}`;

  const detailRows = [
    ['Order ref',  orderRef,  '#9e4f2e'],
    ['Carrier',    carrier,   null     ],
    ['Tracking',   tracking,  '#5c3e2e'],
    eta ? ['Estimated delivery', eta, '#6b7c5c'] : null,
  ].filter(Boolean);

  const html = _siteEmailShell({
    eyebrow:   "Kay\u2019s Works \u00b7 Your Order",
    heroTitle: "Your order is on its way \u2728",
    bodyHtml,
    rows: detailRows,
    ctaHref:   trackingUrl || 'https://kaysworks.com/shop-orders',
    ctaText:   trackingUrl ? 'Track your order' : 'View your orders',
    ctaSub:    eta ? `Expected delivery: ${eta}` : 'Tracking may take up to 24 hours to activate.',
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const text = [
    `Your order is on its way — ${orderRef}`,
    '',
    `Great news, ${name} — your order is packed and heading to you.`,
    '',
    extraMsg || '',
    '',
    `Order ref: ${orderRef}`,
    `Carrier: ${carrier}`,
    `Tracking: ${tracking}`,
    trackingUrl ? `Track here: ${trackingUrl}` : '',
    eta ? `Estimated delivery: ${eta}` : '',
    '',
    'Questions? Reply to this email or message Kay on WhatsApp.',
  ].filter(l => l !== undefined).join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL, to: [row.email],
      reply_to: ALERT_TO_EMAIL, subject, text, html,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend shipping notification failed ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

function isSchemaMismatch(error) {
  const msg = String(error && error.message || '').toLowerCase();
  return msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('column') ||
    msg.includes('pgrst204');
}

function offerSummary(row) {
  const lines = [
    row.artwork ? `Artwork: ${row.artwork}` : '',
    row.chain ? `Chain: ${row.chain}` : '',
    row.offer_amount ? `Offer: ${row.offer_amount} ${row.offer_currency || ''}`.trim() : '',
    row.wallet_address ? `Wallet: ${row.wallet_address}` : '',
    row.message ? '' : '',
    row.message || '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 4000);
}

function compactRow(row) {
  if (row.form_type === 'private-offer') {
    return {
      form_type: 'private-offer',
      status: row.status || 'pending',
      name: row.name,
      email: row.email,
      commission_type: 'private-offer',
      message: offerSummary(row),
      payload: row.payload || row,
    };
  }
  return row;
}

function minimalRow(row) {
  if (row.form_type === 'private-offer') {
    return {
      form_type: 'private-offer',
      status: row.status || 'pending',
      name: row.name,
      email: row.email,
      message: offerSummary(row),
    };
  }
  return row;
}

function compactDeliveryRow(row) {
  // Minimal shape that only uses columns guaranteed to exist on the
  // site_form_submissions table. Shipping-specific fields are folded into
  // the message + payload so the insert can't fail on a missing column.
  const summary = [
    row.order_ref ? `Order: ${row.order_ref}` : '',
    row.carrier ? `Carrier: ${row.carrier}` : '',
    row.tracking ? `Tracking: ${row.tracking}` : '',
    row.tracking_url ? `Tracking URL: ${row.tracking_url}` : '',
    row.eta ? `ETA: ${row.eta}` : '',
    row.items_summary ? `Items: ${row.items_summary}` : '',
    row.message ? `\n${row.message}` : '',
  ].filter(Boolean).join('\n').slice(0, 4000);
  return {
    form_type: 'delivery-details',
    status: row.status || 'pending',
    name: row.name,
    email: row.email,
    message: summary,
    payload: row.payload || row,
  };
}

async function insertSubmission(row) {
  const attempts = [row];
  if (row.form_type === 'private-offer') {
    attempts.push(compactRow(row), minimalRow(row));
  } else if (row.form_type === 'delivery-details') {
    attempts.push(compactDeliveryRow(row), {
      form_type: 'delivery-details',
      status: row.status || 'pending',
      name: row.name,
      email: row.email,
      message: row.message || '',
    });
  } else if (row.form_type === 'interest-1of1') {
    attempts.push({
      form_type: 'interest-1of1',
      status: row.status || 'pending',
      name: row.name,
      email: row.email,
      artwork: row.artwork || '',
      commission_type: 'interest-1of1',
      message: row.message || '',
    }, {
      form_type: 'commission',
      status: 'pending',
      name: row.name,
      email: row.email,
      commission_type: 'interest-1of1',
      message: (row.artwork ? 'Artwork: ' + row.artwork + ' | ' : '') + (row.message || ''),
    });
  } else if (row.form_type === 'newsletter') {
    attempts.push({
      form_type: 'commission',
      status: 'pending',
      name: row.name,
      email: row.email,
      commission_type: 'newsletter',
      message: 'Newsletter subscription from shop footer.',
    });
  }

  let lastError;
  for (const candidate of attempts) {
    try {
      return await supabaseFetch(TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(candidate),
      });
    } catch (error) {
      lastError = error;
      const hasFallback = ['private-offer','delivery-details','interest-1of1','newsletter'].includes(row.form_type);
      if (!hasFallback || !isSchemaMismatch(error)) throw error;
      console.warn(`${row.form_type} insert shape failed, retrying with compact schema:`, error.message);
    }
  }
  throw lastError;
}


// ── Shared parchment email shell ─────────────────────────────────────────────
function _siteEmailShell({ eyebrow, heroTitle, bodyHtml, rows, ctaHref, ctaText, ctaSub, logoUrl }) {
  const rowsHtml = (rows || []).map(([label, value, color]) => `
    <tr>
      <td style="padding:8px 0;vertical-align:top">
        <span style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#a08060;font-family:Georgia,serif">${label}</span>
      </td>
      <td align="right" style="padding:8px 0;vertical-align:top">
        <span style="font-size:13px;color:${color || '#2d211b'};font-family:Georgia,serif;${color ? '' : 'font-weight:600'}">${value}</span>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f5ede0;font-family:Georgia,serif;color:#2d211b;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5ede0;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ede0c8;border-radius:24px;overflow:hidden;">

        <!-- Hero block -->
        <tr><td style="padding:10px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:20px;overflow:hidden;">
            <tr><td style="background:#2a1508;background-image:radial-gradient(ellipse at 50% 110%,rgba(196,140,60,0.38) 0%,transparent 62%),linear-gradient(180deg,#2a1508 0%,#3d2010 55%,#5a2e14 100%);padding:36px 32px 40px;text-align:center;border-radius:20px 20px 0 0;">
              <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#ffffff;font-weight:700">${eyebrow}</p>
              ${logoUrl ? `<img src="${logoUrl}" alt="Kay’s Works" width="120" style="display:block;width:120px;max-width:50%;height:auto;margin:0 auto 20px"/>` : ''}
              <p style="margin:0;font-size:26px;font-weight:400;color:#ffffff;line-height:1.15;font-family:Georgia,serif">${heroTitle}</p>
            </td></tr>
            <!-- Gold trim inside the rounded wrapper -->
            <tr><td style="background:linear-gradient(90deg,#b8821e 0%,#e8c45a 35%,#f5d060 55%,#d4a030 80%,#b8821e 100%);height:5px;line-height:5px;font-size:0;border-radius:0 0 20px 20px;">&nbsp;</td></tr>
          </table>
        </td></tr>

        <!-- Body text -->
        <tr><td style="padding:28px 32px 0">
          ${bodyHtml}
        </td></tr>

        <!-- Detail rows -->
        ${rowsHtml ? `<tr><td style="padding:8px 32px 4px"><table width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr>` : ''}

        <!-- CTA -->
        <tr><td style="padding:20px 32px 32px;text-align:center">
          <a href="${ctaHref}" style="display:inline-block;background:linear-gradient(90deg,#b8821e 0%,#e8c45a 35%,#f5d878 55%,#d4a030 80%,#b8821e 100%);color:#2d1508;text-decoration:none;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 34px;border-radius:999px">${ctaText}</a>
          ${ctaSub ? `<p style="margin:12px 0 0;font-size:12px;color:#7a5a40;font-style:italic;font-family:Georgia,serif">${ctaSub}</p>` : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 32px 24px;border-top:1px solid rgba(90,55,30,0.15);text-align:center">
          <p style="margin:0;font-size:10px;color:#b09070;font-family:Georgia,serif">&copy; Kay\u2019s Works &middot; <a href="https://kaysworks.com" style="color:#b09070">kaysworks.com</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Client confirmation — private offer ───────────────────────────────────────
async function sendOfferConfirmation(row, id) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY missing');

  const name    = row.name    || 'Collector';
  const artwork = row.artwork || 'the piece';
  const amount  = row.offer_amount && row.offer_currency
    ? `${row.offer_amount} ${row.offer_currency}` : null;
  const subject = `Offer received \u2014 \u201c${artwork}\u201d`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">
      Thank you, ${name}.
    </p>
    <p style="margin:0 0 6px;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      Your interest in this work means a great deal to me. I\u2019ll review your offer personally and be in touch within a few days.
    </p>`;

  const rows = [
    amount              ? ['Your offer', amount,   null]       : null,
    ['Piece',             artwork,                 '#9e4f2e'  ],
    ['Reference',         id || '\u2014',           '#b09070'  ],
  ].filter(Boolean);

  const html = _siteEmailShell({
    eyebrow:   "Kay\u2019s Works \u00b7 Private Offer",
    heroTitle: "Your offer has been received",
    bodyHtml,
    rows,
    ctaHref:   'https://kaysworks.com/auction',
    ctaText:   'View the auction',
    ctaSub:    'The auction remains open \u2014 you\u2019re always welcome to place a bid.',
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const text = [
    `Offer received \u2014 ${artwork}`,
    '',
    `Thank you, ${name}.`,
    `Your interest means a great deal. I\u2019ll review your offer personally and be in touch within a few days.`,
    '',
    amount ? `Offer: ${amount}` : '',
    `Piece: ${artwork}`,
    `Reference: ${id || '\u2014'}`,
    '',
    `https://kaysworks.com/auction`,
  ].filter(l => l !== undefined).join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL, to: [row.email],
      reply_to: ALERT_TO_EMAIL, subject, text, html,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend confirmation failed ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

// ── Client confirmation — acquisition enquiry (unique / 1-of-1 works) ────────
async function sendAcquisitionConfirmation(row, id) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY missing');

  const name    = row.name    || 'Collector';
  const artwork = row.artwork || 'this work';
  const subject = `Your enquiry has been received \u2014 \u201c${artwork}\u201d`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">
      Thank you, ${name}.
    </p>
    <p style="margin:0 0 10px;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      Your interest in this work means a great deal. I\u2019ve received your enquiry and will be in touch personally within a few days to discuss the piece, availability, and next steps.
    </p>
    <p style="margin:0;font-size:13px;color:#7a5a40;font-family:Georgia,serif;line-height:1.65">
      In the meantime, feel free to explore the full collection or reach out directly if you have questions.
    </p>`;

  const rows = [
    ['Work enquired about', artwork,       '#9e4f2e'],
    ['Reference',           id || '\u2014', '#b09070'],
  ];

  const html = _siteEmailShell({
    eyebrow:   "Kay\u2019s Works \u00b7 Acquisition Enquiry",
    heroTitle: "Enquiry received",
    bodyHtml,
    rows,
    ctaHref:   'https://kaysworks.com/shop',
    ctaText:   'Explore the collection',
    ctaSub:    'More unique works and limited editions are available in the shop.',
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const text = [
    `Enquiry received \u2014 ${artwork}`,
    '',
    `Thank you, ${name}.`,
    `Your interest means a great deal. I\u2019ve received your enquiry and will be in touch personally within a few days.`,
    '',
    `Work: ${artwork}`,
    `Reference: ${id || '\u2014'}`,
    '',
    'Explore the collection: https://kaysworks.com/shop',
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL, to: [row.email],
      reply_to: ALERT_TO_EMAIL, subject, text, html,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend acquisition confirmation failed ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

// ── Newsletter welcome email ─────────────────────────────────────────────────
async function sendNewsletterWelcome(email) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  const subject = "You're on the list — Kay's Works";
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">
      Thank you for joining.
    </p>
    <p style="margin:0 0 14px;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      You'll hear from me when there's something worth sharing — new drops, series releases, and collector moments from the studio. I don't send noise.
    </p>
    <p style="margin:0 0 14px;font-size:13px;color:#5c3e2e;font-family:Georgia,serif;line-height:1.65">
      <strong>One small thing:</strong> if this landed in your spam or promotions folder, please move it to your inbox and add this address to your contacts. That way you won't miss a drop.
    </p>`;

  const html = _siteEmailShell({
    eyebrow:   "Kay's Works · Collector Circle",
    heroTitle: "You're on the list",
    bodyHtml,
    rows: [],
    ctaHref:   'https://kaysworks.com/shop',
    ctaText:   'Explore the collection',
    ctaSub:    null,
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const text = [
    "You're on the list — Kay's Works",
    '',
    "Thank you for joining.",
    "You'll hear from me when there's something worth sharing — new drops, series releases, and collector moments from the studio.",
    '',
    "One small thing: if this landed in your spam or promotions folder, please move it to your inbox and add this address to your contacts so you don't miss a drop.",
    '',
    'Explore the collection: https://kaysworks.com/shop',
  ].join('\n');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL,
      to: [email],
      reply_to: ALERT_TO_EMAIL,
      subject, text, html,
    }),
  });
}

// ── Admin alert ───────────────────────────────────────────────────────────────
async function sendMinimalAlert(row, id) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY missing');

  const label   = alertLabel(row.form_type);
  const subject = `New ${label}`;

  const bodyHtml = `
    <p style="margin:0 0 6px;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      A new ${label} has just come in. Open the admin queue to review the full submission and respond.
    </p>`;

  const rows = [];
  if (row.form_type === 'private-offer') {
    if (row.offer_amount) rows.push(['Offer',   `${row.offer_amount} ${row.offer_currency || ''}`.trim(), null]);
    if (row.artwork)      rows.push(['Artwork',  row.artwork,   '#9e4f2e']);
    if (row.chain)        rows.push(['Chain',    row.chain,     '#7a5a40']);
  }
  if (row.form_type === 'interest-1of1' && row.artwork) {
    rows.push(['Work', row.artwork, '#9e4f2e']);
  }
  rows.push(['Collector', row.name || row.collector_name || '\u2014', null]);
  rows.push(['Email',     row.email || '\u2014',    '#7a5a40']);
  if (row.wallet_address) rows.push(['Wallet',   row.wallet_address, '#7a5a40']);
  if (row.message)        rows.push(['Message',  row.message.slice(0, 140) + (row.message.length > 140 ? '\u2026' : ''), '#5c3e2e']);
  rows.push(['Ref',       id || 'saved',          '#b09070']);

  const html = _siteEmailShell({
    eyebrow:   "Kay\u2019s Works \u00b7 Admin Queue",
    heroTitle: `New ${label}`,
    bodyHtml,
    rows,
    ctaHref:   ADMIN_URL,
    ctaText:   'Open admin queue',
    ctaSub:    null,
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const text = [
    `New ${label} \u2014 Kay\u2019s Works`,
    '',
    `Collector: ${row.name || row.collector_name || '\u2014'}`,
    `Email: ${row.email || '\u2014'}`,
    row.form_type === 'private-offer' ? `Offer: ${row.offer_amount || '\u2014'} ${row.offer_currency || ''}`.trim() : '',
    row.form_type === 'private-offer' ? `Artwork: ${row.artwork || '\u2014'}` : '',
    row.message ? `Message: ${row.message}` : '',
    `Ref: ${id || 'saved'}`,
    '',
    ADMIN_URL,
  ].filter(Boolean).join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL, to: emailList(ALERT_TO_EMAIL),
      reply_to: row.email || undefined, subject, text, html,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend alert failed ${response.status}`);
  }
  return response.json().catch(() => ({}));
}


async function handleCreate(req, res) {
  const payload = await readBody(req);
  const row = buildRow(payload);
  if (row.bot) return res.status(200).json({ ok: true });
  if (row.error) return res.status(422).json({ error: row.error });

  // Record the submission, but never let a DB/schema issue block the email —
  // the customer-facing notification matters more than the audit row.
  let id = null;
  try {
    const inserted = await insertSubmission(row);
    id = inserted && inserted[0] && inserted[0].id;
  } catch (error) {
    console.error('Submission insert failed (continuing to email):', error.message);
  }
  let alert = { sent: false };
  // Skip the admin self-alert for delivery-details — the admin already knows
  // they sent shipping info (they clicked the button). Only alert for genuinely
  // new inbound submissions (enquiries, commissions, bids, etc.).
  if (row.form_type !== 'delivery-details') {
    try {
      const alertData = await sendMinimalAlert(row, id);
      alert = { sent: true, id: alertData && alertData.id };
    } catch (error) {
      console.error('Queue alert failed:', error.message);
      alert = { sent: false, error: error.message };
    }
  }
  // Newsletter subscriber — save to collectors table + send welcome email
  if (row.form_type === 'newsletter') {
    let saved = false;
    try {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: existing } = await sb.from('collectors').select('id').eq('email', row.email).maybeSingle();
      if (!existing) {
        await sb.from('collectors').insert({
          email: row.email.toLowerCase(),
          name: row.name !== 'Subscriber' ? row.name : null,
          consented_at: new Date().toISOString(),
          order_count: 0,
        });
        // Send welcome email only for new subscribers
        await sendNewsletterWelcome(row.email).catch(e => console.error('[newsletter] welcome email failed:', e.message));
        // Alert Kay
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: ALERT_FROM_EMAIL,
              to: emailList(ALERT_TO_EMAIL),
              subject: `New newsletter subscriber — ${row.email}`,
              text: `${row.email} just subscribed via the shop footer.`,
            }),
          });
        } catch(e) {}
        saved = true;
      }
      return res.status(200).json({ ok: true, saved, existing: !!existing });
    } catch(e) {
      console.error('[newsletter] error:', e.message);
      return res.status(200).json({ ok: true, saved }); // still return ok so UI shows success
    }
  }

  // Client-facing confirmation email for private offers
  let confirmation = { sent: false };
  if (row.form_type === 'private-offer') {
    try {
      const confData = await sendOfferConfirmation(row, id);
      confirmation = { sent: true, id: confData && confData.id };
    } catch (error) {
      console.error('Offer confirmation email failed:', error.message);
      confirmation = { sent: false, error: error.message };
    }
  }
  // Client-facing confirmation email for acquisition enquiries (unique / 1-of-1 works)
  if (row.form_type === 'interest-1of1') {
    try {
      const confData = await sendAcquisitionConfirmation(row, id);
      confirmation = { sent: true, id: confData && confData.id };
    } catch (error) {
      console.error('Acquisition confirmation email failed:', error.message);
      confirmation = { sent: false, error: error.message };
    }
  }
  // Client-facing shipping notification email
  if (row.form_type === 'delivery-details') {
    try {
      const confData = await sendShippingNotification(row, id);
      confirmation = { sent: true, id: confData && confData.id };
    } catch (error) {
      console.error('Shipping notification email failed:', error.message);
      confirmation = { sent: false, error: error.message };
    }
  }
  return res.status(200).json({ ok: true, id, alert, confirmation });
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

async function handleReply(req, res) {
  const id      = req.query && req.query.id;
  const body    = req.body || {};
  const message = String(body.message || '').trim();
  const subject = String(body.subject || '').trim();
  if (!id)      return res.status(400).json({ error: 'Missing submission id' });
  if (!message) return res.status(400).json({ error: 'Reply message required' });

  // Fetch the submission
  const rows = await supabaseFetch(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'GET' });
  const row = rows && rows[0];
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  if (!row.email) return res.status(400).json({ error: 'No email address on this submission' });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const fromEmail = process.env.SHOP_ORDER_FROM_EMAIL || "Kay's Works <shop@mail.kaysworks.com>";
  const replyToEmail = process.env.SHOP_REPLY_TO_EMAIL || process.env.CONTACT_EMAIL || 'hello@kaysworks.com';
  const emailSubject = subject || `Re: Your enquiry — Kay's Works`;

  // Format message as plain text + simple HTML
  const paragraphs = message.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const bodyHtml = paragraphs.map(p =>
    `<p style="margin:0 0 14px;font-size:15px;color:#2d211b;font-family:Georgia,serif;line-height:1.7">${p.replace(/\n/g,'<br/>')}</p>`
  ).join('');

  const html = _siteEmailShell({
    eyebrow:   "Kay's Works",
    heroTitle: emailSubject,
    bodyHtml,
    rows: [],
    ctaHref:   'https://www.kaysworks.com/shop',
    ctaText:   'Visit the shop',
    ctaSub:    '',
    logoUrl:   process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg',
  });

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: [row.email],
      reply_to: replyToEmail,
      subject: emailSubject,
      text: message,
      html,
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return res.status(502).json({ error: data.message || 'Email send failed' });
  }

  // Mark as settled after replying
  await supabaseFetch(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'settled', settled_at: new Date().toISOString() }),
  });

  return res.status(200).json({ ok: true, to: row.email });
}

module.exports = async (req, res) => {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') return handleCreate(req, res);
    if (req.method === 'GET') return handleList(req, res);
    if (req.method === 'PATCH') {
      // ?reply=1 triggers reply flow, plain PATCH updates status
      if (req.query && req.query.reply === '1') return handleReply(req, res);
      return handleUpdate(req, res);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
