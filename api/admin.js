/**
 * /api/admin
 *
 * Single consolidated file replacing:
 *   api/admin/challenge/login.js        → POST   /api/admin/login
 *   api/admin/challenge/challenges.js   → GET    /api/admin/challenges
 *   api/admin/challenge/challenge.js    → POST   /api/admin/challenge
 *   api/admin/challenge/[id].js         → DELETE /api/admin/challenge/:id
 *   api/admin/challenge/upload-image.js → POST   /api/admin/upload-image
 *   api/admin/challenge/wallets.js      → GET    /api/admin/wallets
 */

const { getSupabase, cors, handleOptions } = require('./_lib');
const crypto = require('crypto');

// ── Auth helpers ─────────────────────────────────────────────────────────────
// Signed token: HMAC-SHA256(randomId, ADMIN_TOKEN)
// Stateless — no storage needed. Any request can be verified by re-deriving the HMAC.

function generateToken() {
  const id     = crypto.randomBytes(16).toString('hex');
  const secret = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const sig    = crypto.createHmac('sha256', secret).update(id).digest('hex');
  return `${id}.${sig}`;
}

function checkToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [id, sig] = parts;
  const secret   = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const expected = crypto.createHmac('sha256', secret).update(id).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig,      'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch { return false; }
}

// ── POST /api/admin?action=login ─────────────────────────────────────────────
async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  return res.status(200).json({ token: generateToken() });
}

// ── GET /api/admin?action=challenges ─────────────────────────────────────────
async function handleGetChallenges(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .order('starts_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}

// ── POST /api/admin?action=challenge ─────────────────────────────────────────
async function handleCreateChallenge(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { title, starts_at, ends_at, piece_count, image_url } = req.body || {};
  if (!title || !starts_at || !ends_at || !image_url) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const { data, error } = await supabase
    .from('challenges')
    .insert({ title, starts_at, ends_at, piece_count: piece_count || 1000, image_url })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ id: data.id });
}

// ── DELETE /api/admin?action=challenge&id=<uuid> ──────────────────────────────
async function handleDeleteChallenge(req, res, supabase) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required.' });
  await supabase.from('scores').delete().eq('challenge_id', id);
  await supabase.from('progress').delete().eq('challenge_id', id);
  const { error } = await supabase.from('challenges').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// ── POST /api/admin?action=upload-image ──────────────────────────────────────
async function handleUploadImage(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { filename, base64, mime_type } = req.body || {};
  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }
  const buffer = Buffer.from(base64, 'base64');
  const ext    = filename.split('.').pop() || 'jpg';
  const folder = (req.body && req.body.folder) ? String(req.body.folder).replace(/[^a-z0-9-_]/gi, '').slice(0, 40) : 'challenges';
  const path   = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const { error } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, { contentType: mime_type, upsert: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from('puzzle-images').getPublicUrl(path);
  return res.status(200).json({ url: urlData.publicUrl });
}

// ── GET /api/admin?action=wallets ─────────────────────────────────────────────
function normalizePlayerName(name) {
  return String(name || '').trim().toLowerCase();
}

// ── GET /api/admin?action=wallets ─────────────────────────────────────────────
async function handleGetWallets(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge_id } = req.query;
  const includeAllWinners = req.query.include_all_winners === '1' || req.query.include_all_winners === 'true';

  let query = supabase
    .from('scores')
    .select('player_name, wallet_address, time_seconds, piece_count, hints_used, created_at, challenge_id, challenges(title)')
    .order('created_at', { ascending: false });

  if (challenge_id) query = query.eq('challenge_id', challenge_id);

  const { data: scores, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const names = [...new Set((scores || [])
    .map(s => (s.player_name || '').trim())
    .filter(Boolean))];

  const profileWalletByName = new Map();
  if (names.length) {
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('name, wallet_address')
      .in('name', names);

    if (playersError) return res.status(500).json({ error: playersError.message });

    (players || []).forEach(p => {
      const key = normalizePlayerName(p.name);
      if (key && p.wallet_address) profileWalletByName.set(key, p.wallet_address);
    });
  }

  const rows = (scores || []).map(s => {
    const profileWallet = profileWalletByName.get(normalizePlayerName(s.player_name)) || null;
    return {
      player_name:            s.player_name,
      wallet_address:         s.wallet_address,
      profile_wallet_address: profileWallet,
      latest_wallet_address:  profileWallet || s.wallet_address || null,
      time_seconds:           s.time_seconds,
      piece_count:            s.piece_count,
      hints_used:             s.hints_used,
      created_at:             s.created_at,
      challenge_id:           s.challenge_id,
      challenge_title:        s.challenges?.title || '',
    };
  }).filter(row => includeAllWinners || row.wallet_address || row.profile_wallet_address);

  return res.status(200).json(rows);
}

// ── PATCH /api/admin?action=challenge (rename + extend end date) ─────────────
async function handleExtendChallenge(req, res, supabase) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  const { id, title, ends_at } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  if (!title && !ends_at) return res.status(400).json({ error: 'Provide at least a title or ends_at.' });
  if (ends_at && new Date(ends_at) <= new Date()) {
    return res.status(400).json({ error: 'New end date must be in the future.' });
  }
  const updates = {};
  if (title  && title.trim().length > 0) updates.title   = title.trim().slice(0, 200);
  if (ends_at) updates.ends_at = ends_at;
  const { error } = await supabase
    .from('challenges')
    .update(updates)
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}


// ═══════════════════════════════════════════════════════════════════════════
//  SHOP ADMIN SECTION (filters + restock-delete). Uses res-based json helper.
// ═══════════════════════════════════════════════════════════════════════════
let _shopAdminRes = null;
function json(status, obj) { _shopAdminRes.status(status).json(obj); return obj; }

async function maintainAdminOrderLifecycle(supabase) {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  try {
    const promoted = await supabase.from('shop_orders').update({ status: 'confirming', last_checked_at: now, updated_at: now })
      .eq('status', 'pending').not('payment_ref', 'is', null);
    if (promoted.error) throw promoted.error;
    const expired = await supabase.from('shop_orders').update({
      status: 'expired', failure_reason: 'Payment was not submitted within 24 hours.', updated_at: now,
    }).eq('status', 'pending').is('payment_ref', null)
      .lt('created_at', new Date(nowMs - 24 * 60 * 60 * 1000).toISOString());
    if (expired.error) throw expired.error;
    const review = await supabase.from('shop_orders').update({
      status: 'review_required', failure_reason: 'Payment verification has remained unresolved for 72 hours.', updated_at: now,
    }).eq('status', 'confirming')
      .lt('updated_at', new Date(nowMs - 72 * 60 * 60 * 1000).toISOString());
    if (review.error) throw review.error;
  } catch (error) {
    console.warn('[shop-admin] lifecycle maintenance skipped:', error.message || error);
  }
}
async function handleShopProducts(req, res, supabase) {
  if (req.method === 'GET') {
    const id = req.query.id;
    if (id) {
      const { data, error } = await supabase
        .from('shop_products')
        .select('*')
        .eq('id', id)
        .single();
      if (error) return json(error.code === 'PGRST116' ? 404 : 500, { error: error.message });
      return json(200, data);
    }
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, data || []);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { data, error } = await supabase
      .from('shop_products')
      .insert({
        name:               String(body.name || '').slice(0, 200),
        category:           String(body.category || 'prints').slice(0, 40),
        print_type:         String(body.print_type || '').slice(0, 40),
        description:        String(body.description || body.desc || '').slice(0, 1000),
        emoji:              String(body.emoji || '✦').slice(0, 10),
        variants:           body.variants || [],
        available_variants: body.available_variants || [],
        prices_ngn:         body.prices_ngn || {},
        prices_usd:         body.prices_usd || {},
        badge:              String(body.badge || '').slice(0, 60),
        image_url:          String(body.image_url || '').slice(0, 500),
        images:             body.images || [],
        slug:               body.slug ? String(body.slug).slice(0, 200) : null,
        series_slug:        body.series_slug ? String(body.series_slug).slice(0, 200) : null,
        series_name:        String(body.series_name || '').slice(0, 200),
        series_desc:        String(body.series_desc || '').slice(0, 1000),
        series_year:        String(body.series_year || '').slice(0, 20),
        story:              String(body.story || ''),
        process:            String(body.process || ''),
        quote:              String(body.quote || '').slice(0, 500),
        year:               String(body.year || '').slice(0, 20),
        medium:             String(body.medium || '').slice(0, 200),
        signed:             Boolean(body.signed),
        is_large_print:     Boolean(body.is_large_print),
        certificate_of_authenticity: Boolean(body.certificate_of_authenticity),
        clothing:           Boolean(body.clothing),
        clothing_type:      String(body.clothing_type || '').slice(0, 40),
        stock:              body.stock === undefined || body.stock === null || body.stock === '' ? null : Number(body.stock),
        stock_by_variant:   body.stock_by_variant || {},
        edition_totals:     body.edition_totals || {},
        sort_order:         Number(body.sort_order) || 0,
        active:             body.active !== false,
        print_edition:      String(body.print_edition || '').slice(0, 40) || null,
        is_sold:            Boolean(body.is_sold),
        enquire_only:       Boolean(body.enquire_only),
      })
      .select('id')
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, id: data.id });
  }

  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return json(400, { error: 'id required' });
    const body = req.body || {};
    const patch = {};
    if (body.name               !== undefined) patch.name               = String(body.name).slice(0, 200);
    if (body.category           !== undefined) patch.category           = String(body.category).slice(0, 40);
    if (body.print_type         !== undefined) patch.print_type         = String(body.print_type).slice(0, 40);
    if (body.desc               !== undefined) patch.description        = String(body.desc).slice(0, 1000);
    if (body.description        !== undefined) patch.description        = String(body.description).slice(0, 1000);
    if (body.emoji              !== undefined) patch.emoji              = String(body.emoji).slice(0, 10);
    if (body.variants           !== undefined) patch.variants           = body.variants;
    if (body.available_variants !== undefined) patch.available_variants = body.available_variants;
    if (body.prices_ngn         !== undefined) patch.prices_ngn         = body.prices_ngn;
    if (body.prices_usd         !== undefined) patch.prices_usd         = body.prices_usd;
    if (body.badge              !== undefined) patch.badge              = String(body.badge).slice(0, 60);
    if (body.image_url          !== undefined) patch.image_url          = String(body.image_url).slice(0, 500);
    if (body.clothing           !== undefined) patch.clothing           = Boolean(body.clothing);
    if (body.clothing_type      !== undefined) patch.clothing_type      = String(body.clothing_type).slice(0, 40);
    if (body.stock              !== undefined) patch.stock              = body.stock === null || body.stock === '' ? null : Number(body.stock);
    if (body.sort_order         !== undefined) patch.sort_order         = Number(body.sort_order);
    if (body.active             !== undefined) patch.active             = Boolean(body.active);
    if (body.stock_by_variant   !== undefined) patch.stock_by_variant   = body.stock_by_variant;
    if (body.edition_totals     !== undefined) patch.edition_totals      = body.edition_totals;
    if (body.slug               !== undefined) patch.slug               = String(body.slug).slice(0, 200);
    if (body.year               !== undefined) patch.year               = String(body.year).slice(0, 10);
    if (body.series_slug        !== undefined) patch.series_slug        = String(body.series_slug).slice(0, 200);
    if (body.series_name        !== undefined) patch.series_name        = String(body.series_name).slice(0, 200);
    if (body.series_desc        !== undefined) patch.series_desc        = String(body.series_desc).slice(0, 1000);
    if (body.series_year        !== undefined) patch.series_year        = String(body.series_year).slice(0, 20);
    if (body.medium             !== undefined) patch.medium             = String(body.medium).slice(0, 200);
    if (body.quote              !== undefined) patch.quote              = String(body.quote).slice(0, 500);
    if (body.story              !== undefined) patch.story              = body.story;
    if (body.process            !== undefined) patch.process            = body.process;
    if (body.signed             !== undefined) patch.signed             = Boolean(body.signed);
    if (body.is_large_print     !== undefined) patch.is_large_print     = Boolean(body.is_large_print);
    if (body.certificate_of_authenticity !== undefined) patch.certificate_of_authenticity = Boolean(body.certificate_of_authenticity);
    if (body.images             !== undefined) patch.images             = body.images;
    if (body.print_edition      !== undefined) patch.print_edition      = String(body.print_edition).slice(0, 40) || null;
    if (body.is_sold            !== undefined) patch.is_sold            = Boolean(body.is_sold);
    if (body.enquire_only       !== undefined) patch.enquire_only       = Boolean(body.enquire_only);
    const { error } = await supabase.from('shop_products').update(patch).eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return json(400, { error: 'id required' });
    const { error } = await supabase.from('shop_products').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}

// ── shop-config (GET/POST) ────────────────────────────────────────────────────
async function handleShopConfig(req, res, supabase) {
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('shop_config')
      .select('*')
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') return json(500, { error: error.message });
    return json(200, data || {});
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const patch = {
      eth_address:    String(body.eth_address   || '').slice(0, 100),
      tezos_address:  String(body.tezos_address || '').slice(0, 100),
      announcement:   String(body.announcement  || '').slice(0, 500),
      updated_at:     new Date().toISOString(),
    };
    if (body.featured_product_id !== undefined) {
      patch.featured_product_id = String(body.featured_product_id || '').slice(0, 80) || null;
    }
    if (body.discount_codes !== undefined) {
      // Sanitize each code: uppercase code string, clamp percent, validate scope.
      const codes = Array.isArray(body.discount_codes) ? body.discount_codes : [];
      patch.discount_codes = codes
        .filter(c => c && String(c.code || '').trim())
        .slice(0, 50)
        .map(c => ({
          code:    String(c.code).trim().toUpperCase().slice(0, 40),
          percent: Math.max(0, Math.min(100, Number(c.percent) || 0)),
          scope:   ['products', 'shipping', 'all'].includes(c.scope) ? c.scope : 'products',
          active:  c.active !== false,
          note:    String(c.note || '').slice(0, 120),
        }));
    }
    const { error } = await supabase
      .from('shop_config')
      .upsert({ id: 1, ...patch }, { onConflict: 'id' });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}

// ── shop-orders (GET) ─────────────────────────────────────────────────────────
async function handleShopOrders(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  await maintainAdminOrderLifecycle(supabase);
  const status = req.query.status || 'all';
  let query = supabase
    .from('shop_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status === 'paid_unshipped') {
    query = query.in('status', ['paid', 'processing']);
  } else if (status === 'pending_payment') {
    query = query.in('status', ['pending', 'confirming']);
  } else if (status === 'payment_review') {
    query = query.eq('status', 'review_required');
  } else if (status !== 'all') {
    query = query.eq('status', status);
  }
  const { data, error } = await query;
  if (error) return json(500, { error: error.message });
  return json(200, data || []);
}

// ── shop-order (PATCH / DELETE) ───────────────────────────────────────────────
async function handleShopOrderUpdate(req, res, supabase) {
  const id = req.query.id;

  // Backward-compatible cleanup endpoint: classify stale unpaid orders instead
  // of deleting them. Payment evidence and audit history are preserved.
  if (req.method === 'DELETE' && (id === 'clear-pending' || req.query.clear_pending === '1')) {
    const hours = Math.max(1, Number(req.query.older_than_hours) || 24);
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data: cleared, error } = await supabase.from('shop_orders').update({
      status: 'expired',
      failure_reason: `Payment was not submitted within ${hours} hours.`,
      updated_at: new Date().toISOString(),
    }).eq('status', 'pending').is('payment_ref', null).lt('created_at', cutoff).select('id');
    if (error) return json(500, { error: error.message });
    const count = cleared ? cleared.length : 0;
    return json(200, { ok: true, expired: count, cleared: count });
  }

  if (!id) return json(400, { error: 'id required' });

  if (req.method === 'DELETE') {
    const shouldRestock = String(req.query.restock || '') === '1';
    if (shouldRestock) {
      const { data: order, error: loadErr } = await supabase
        .from('shop_orders')
        .select('items')
        .eq('id', id)
        .maybeSingle();
      if (loadErr && loadErr.code !== 'PGRST116') return json(500, { error: loadErr.message });
      for (const item of (Array.isArray(order?.items) ? order.items : [])) {
        const vkey = item.variantKey || item.variant;
        const qty = Math.max(1, Number(item.qty) || 1);
        let { error: stockErr } = await supabase.rpc('adjust_shop_variant_stock', {
          p_id: item.id,
          p_variant_key: vkey,
          p_qty_delta: qty,
        });
        if (stockErr && (stockErr.code === 'PGRST202' || stockErr.code === '42883')) {
          ({ error: stockErr } = await supabase.rpc('decrement_variant_stock', {
            p_id: item.id, p_variant_key: vkey, p_qty: -qty,
          }));
        }
        if (stockErr) return json(500, { error: `Could not restock ${item.name || item.id}: ${stockErr.message}` });
      }
    }
    const { data: deleted, error } = await supabase
      .from('shop_orders')
      .delete()
      .eq('id', id)
      .select('id');
    if (error) return json(500, { error: error.message });
    if (!deleted || deleted.length === 0) {
      return json(404, { error: 'Order not found (already deleted or id mismatch)', deleted: 0 });
    }
    return json(200, { ok: true, restocked: shouldRestock, deleted: deleted.length });
  }

  if (req.method !== 'PATCH') return json(405, { error: 'Method not allowed' });
  const body = req.body || {};
  const patch = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    const ALLOWED = ['pending', 'pending_payment', 'confirming', 'review_required', 'expired', 'paid', 'paid_unshipped', 'processing', 'shipped', 'fulfilled', 'cancelled', 'refunded'];
    if (!ALLOWED.includes(body.status))
      return json(422, { error: 'Invalid status' });
    patch.status = body.status;
    if (body.status === 'fulfilled') patch.fulfilled_at = new Date().toISOString();
  }
  if (body.tracking_number !== undefined) patch.tracking_number = String(body.tracking_number).slice(0, 200);
  if (body.tracking_carrier !== undefined) patch.tracking_carrier = String(body.tracking_carrier).slice(0, 100);
  if (body.admin_note !== undefined) patch.admin_note = String(body.admin_note).slice(0, 1000);
  if (body.delivery_details_sent_at !== undefined) patch.delivery_details_sent_at = String(body.delivery_details_sent_at).slice(0, 40);

  const { error } = await supabase.from('shop_orders').update(patch).eq('id', id);
  if (error) {
    const msg = String(error.message || '').toLowerCase();
    if (patch.delivery_details_sent_at && msg.includes('delivery_details_sent_at')) {
      delete patch.delivery_details_sent_at;
      const retry = await supabase.from('shop_orders').update(patch).eq('id', id);
      if (retry.error) return json(500, { error: retry.error.message });
      return json(200, { ok: true, warning: 'delivery_details_sent_at column missing' });
    }
    return json(500, { error: error.message });
  }
  return json(200, { ok: true });
}

// ── Netlify entry point ───────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
//  HOLDER HUB SECTION (Àpótí Ọlọ́wẹ̀ — messages, reservations, participants)
//  Content (Opa Collection, artworks, chapters, future plans) is hardcoded
//  directly in holder-hub.html — only genuinely dynamic data (things other
//  people generate, not you) is managed here.
// ═══════════════════════════════════════════════════════════════════════════

// ── holder-reservations (GET inbox) ───────────────────────────────────────────
async function handleGetHolderReservations(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('reservations')
    .select('*, holders(display_name, wallet_address, chain)')
    .order('created_at', { ascending: false });
  if (error) return json(500, { error: error.message });
  return json(200, data || []);
}

// ── holder-reservation (PATCH status) ─────────────────────────────────────────
async function handleHolderReservation(req, res, supabase) {
  if (req.method !== 'PATCH') return json(405, { error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return json(400, { error: 'id required' });
  const { status } = req.body || {};
  if (!['new', 'contacted', 'accepted', 'declined'].includes(status)) return json(422, { error: 'Invalid status' });
  const { error } = await supabase.from('reservations').update({ status }).eq('id', id);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
}

// ── holder-messages (GET inbox) ───────────────────────────────────────────────
async function handleGetHolderMessages(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('messages')
    .select('*, holders(display_name, wallet_address, chain)')
    .order('created_at', { ascending: false });
  if (error) return json(500, { error: error.message });
  return json(200, data || []);
}

// ── holder-message (PATCH status) ─────────────────────────────────────────────
async function handleHolderMessage(req, res, supabase) {
  if (req.method !== 'PATCH') return json(405, { error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return json(400, { error: 'id required' });
  const { status } = req.body || {};
  if (!['new', 'read', 'archived'].includes(status)) return json(422, { error: 'Invalid status' });
  const { error } = await supabase.from('messages').update({ status }).eq('id', id);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
}

// ── holder-participants (GET) ─────────────────────────────────────────────────
async function handleGetHolderParticipants(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('holders')
    .select('id, wallet_address, chain, display_name, tier, is_public, token_balance, last_verified_at, created_at')
    .order('created_at', { ascending: true });
  if (error) return json(500, { error: error.message });
  return json(200, data || []);
}

// ── holder-participant (PATCH display_name / is_public) ──────────────────────
async function handleHolderParticipant(req, res, supabase) {
  if (req.method !== 'PATCH') return json(405, { error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return json(400, { error: 'id required' });
  const body = req.body || {};
  const patch = {};
  if (body.display_name !== undefined) patch.display_name = body.display_name ? String(body.display_name).slice(0, 100) : null;
  if (body.is_public     !== undefined) patch.is_public     = Boolean(body.is_public);
  if (body.tier          !== undefined) patch.tier          = ['gold', 'bronze', 'wood'].includes(body.tier) ? body.tier : null;
  const { error } = await supabase.from('holders').update(patch).eq('id', id);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
}


// ── Vercel entry point ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  const urlPath = req.url || '';
  let action = req.query.action || '';

  // Derive action from URL path if not in query string
  if (!action) {
    const match = urlPath.match(/\/admin\/([^/?]+)/);
    if (match) action = match[1];
  }

  // Extract id from path for /admin/<action>/:id (challenge, shop-products, shop-order)
  if (!req.query.id) {
    const idMatch = urlPath.match(/\/admin\/[a-z-]+\/([^/?]+)/);
    if (idMatch && idMatch[1] !== 'undefined') req.query.id = idMatch[1];
  }

  // Login doesn't need a token
  if (action === 'login') return handleLogin(req, res);

  // All other routes require a valid signed token
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  _shopAdminRes = res; // shop admin handlers use res-based json() helper

  switch (action) {
    case 'challenges':   return handleGetChallenges(req, res, supabase);
    case 'challenge':    return req.method === 'DELETE' ? handleDeleteChallenge(req, res, supabase)
                           : req.method === 'PATCH'  ? handleExtendChallenge(req, res, supabase)
                           : handleCreateChallenge(req, res, supabase);
    case 'upload-image': return handleUploadImage(req, res, supabase);
    case 'wallets':      return handleGetWallets(req, res, supabase);
    case 'shop-products': return handleShopProducts(req, res, supabase);
    case 'shop-config':   return handleShopConfig(req, res, supabase);
    case 'shop-orders':   return handleShopOrders(req, res, supabase);
    case 'shop-order':    return handleShopOrderUpdate(req, res, supabase);
    case 'holder-messages':     return handleGetHolderMessages(req, res, supabase);
    case 'holder-message':      return handleHolderMessage(req, res, supabase);
    case 'holder-reservations': return handleGetHolderReservations(req, res, supabase);
    case 'holder-reservation':  return handleHolderReservation(req, res, supabase);
    case 'holder-participants': return handleGetHolderParticipants(req, res, supabase);
    case 'holder-participant':  return handleHolderParticipant(req, res, supabase);
    default:
      return res.status(404).json({ error: `Unknown admin action: ${action}` });
  }
};
