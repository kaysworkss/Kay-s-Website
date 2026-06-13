/**
 * /api/game
 *
 * Single consolidated file replacing:
 *   api/challenges.js              → GET  /api/challenges
 *   api/challenge.js               → GET  /api/challenge?id=<uuid>
 *   api/score.js                   → POST /api/score
 *   api/leaderboard/[challengeId]  → GET  /api/leaderboard?id=<uuid>
 *   api/hall-of-fame.js            → GET  /api/hall-of-fame
 *   api/notify-outbid.js           → POST /api/notify-outbid
 *
 * Routing via ?action= query param.
 */

const crypto = require('crypto');
const { getSupabase, cors, handleOptions } = require('./_lib');

// ── Difficulty tiers ──────────────────────────────────────────────────────────
const DIFF_TIERS = [
  { label: 'Cowrie',   cls: 'demo',   range: [1,    48]   },
  { label: 'Coral',    cls: 'easy',   range: [49,   250]  },
  { label: 'Jade',     cls: 'medium', range: [251,  600]  },
  { label: 'Sapphire', cls: 'hard',   range: [601,  1200] },
  { label: 'Gold',     cls: 'expert', range: [1201, Infinity] },
];
function tierForCount(n) {
  return DIFF_TIERS.find(t => n >= t.range[0] && n <= t.range[1]) || DIFF_TIERS[1];
}

// ── GET /api/game?action=challenges ──────────────────────────────────────────
// Returns all currently active challenges (starts_at <= now <= ends_at)
async function handleChallenges(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .lte('starts_at', now)
    .gte('ends_at', now)
    .order('starts_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}


// ── GET /api/game?action=upcoming ────────────────────────────────────────────
// Returns all future challenges (starts_at > now), ordered soonest first
async function handleUpcoming(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .gt('starts_at', now)
    .order('starts_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}

// ── GET /api/game?action=challenge&id=<uuid> ──────────────────────────────────
async function handleChallenge(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .eq('id', id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Challenge not found.' });
  return res.status(200).json(data);
}

// ── POST /api/game?action=score ───────────────────────────────────────────────
async function handleScore(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge_id, player_name, wallet_address, time_seconds, piece_count, hints_used, ghost_used } = req.body || {};

  if (!challenge_id || !player_name || !time_seconds) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (typeof time_seconds !== 'number' || time_seconds < 1) {
    return res.status(400).json({ error: 'Invalid time_seconds.' });
  }
  const name = String(player_name).trim();
  if (name.length < 1 || name.length > 28) {
    return res.status(400).json({ error: 'player_name must be 1–28 characters.' });
  }
  const wallet = wallet_address && String(wallet_address).trim().length > 0
    ? String(wallet_address).trim().slice(0, 100) : null;

  const now = new Date().toISOString();

  // Confirm challenge is active
  const { data: challenge, error: chErr } = await supabase
    .from('challenges')
    .select('id')
    .eq('id', challenge_id)
    .lte('starts_at', now)
    .gte('ends_at', now)
    .single();
  if (chErr || !challenge) {
    return res.status(400).json({ error: 'Challenge not found or no longer active.' });
  }

  // Insert score
  const { data: score, error: scoreErr } = await supabase
    .from('scores')
    .insert({
      challenge_id,
      player_name:    name,
      wallet_address: wallet,
      time_seconds,
      piece_count:    piece_count || null,
      hints_used:     Number.isInteger(hints_used) ? hints_used : null,
      ghost_used:     Number.isInteger(ghost_used)  ? ghost_used  : null,
    })
    .select('id')
    .single();
  if (scoreErr) return res.status(500).json({ error: scoreErr.message });

  // Calculate rank
  const { data: faster } = await supabase
    .from('scores')
    .select('player_name, time_seconds, piece_count')
    .eq('challenge_id', challenge_id)
    .lt('time_seconds', time_seconds)
    .order('time_seconds', { ascending: true });

  let rank = 1;
  if (faster) {
    const myPc = piece_count || 1000;
    const sameTier = faster.filter(s => {
      const pc = s.piece_count || myPc;
      return pc >= myPc * 0.7 && pc <= myPc * 1.3;
    });
    rank = new Set(sameTier.map(s => s.player_name.trim().toLowerCase())).size + 1;
  }

  return res.status(201).json({ id: score.id, rank });
}

// ── GET /api/game?action=leaderboard&id=<challenge_id> ───────────────────────
async function handleLeaderboard(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const { data: scores, error } = await supabase
    .from('scores')
    .select('player_name, time_seconds, hints_used, piece_count, created_at')
    .eq('challenge_id', id)
    .order('time_seconds', { ascending: true })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });
  if (!scores || !scores.length) return res.status(200).json([]);

  // Deduplicate: keep best per player
  const seen = new Set();
  const deduped = scores.filter(s => {
    const key = s.player_name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 10);

  // Fetch avatars
  const names = deduped.map(s => s.player_name.trim());
  const { data: players } = await supabase
    .from('players')
    .select('name, avatar_url')
    .in('name', names);

  const avatarMap = {};
  (players || []).forEach(p => { avatarMap[p.name.trim().toLowerCase()] = p.avatar_url || null; });

  const best = deduped.map(s => ({
    ...s,
    avatar_url: avatarMap[s.player_name.trim().toLowerCase()] || null,
  }));

  return res.status(200).json(best);
}

// ── GET /api/game?action=hall-of-fame ────────────────────────────────────────
async function handleHallOfFame(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const now = new Date().toISOString();

  const { data: challenges, error: cErr } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .order('ends_at', { ascending: false });

  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!challenges || !challenges.length) return res.status(200).json([]);

  const results = await Promise.all(
    challenges.map(async (ch) => {
      const { data: scores, error: sErr } = await supabase
        .from('scores')
        .select('player_name, time_seconds, hints_used, created_at')
        .eq('challenge_id', ch.id)
        .order('time_seconds', { ascending: true })
        .limit(200);

      if (sErr || !scores) return { ...ch, entries: [] };

      const seen = new Set();
      const deduped = scores.filter(s => {
        const key = s.player_name.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 10);

      // Look up avatar_url for each unique player name
      const names = deduped.map(s => s.player_name.trim());
      const { data: players } = await supabase
        .from('players')
        .select('name, avatar_url')
        .in('name', names);

      const avatarMap = {};
      (players || []).forEach(p => { avatarMap[p.name.trim().toLowerCase()] = p.avatar_url || null; });

      const best = deduped.map(s => ({
        ...s,
        avatar_url: avatarMap[s.player_name.trim().toLowerCase()] || null,
      }));

      const tier   = tierForCount(ch.piece_count);
      const ended  = new Date(ch.ends_at) < new Date(now);

      return {
        id: ch.id, title: ch.title, image_url: ch.image_url,
        piece_count: ch.piece_count, starts_at: ch.starts_at, ends_at: ch.ends_at,
        ended, tier: tier.label, tier_cls: tier.cls, entries: best,
      };
    })
  );

  return res.status(200).json(results);
}

const _AUCTION_LOGO_URL = process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg';

// ── Parchment email shell (auction emails) ────────────────────────────────────
// Hierarchy: eyebrow → logo → hero title → gold trim → body text → rows → CTA
function _emailShell(heroTitle, _unused, _unused2, bodyHtml, rowsHtml, ctaHtml, eyebrow) {
  const eye     = eyebrow || 'Kay\u2019s Works \u00b7 Live Auction';
  const logoTag = _AUCTION_LOGO_URL
    ? `<img src="${_AUCTION_LOGO_URL}" alt="Kay\u2019s Works" width="120" style="display:block;width:120px;max-width:50%;height:auto;margin:0 auto 20px"/>`
    : '';
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

        <!-- Hero — inset, fully rounded, gold trim inside wrapper -->
        <tr><td style="padding:10px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:20px;overflow:hidden;">
            <tr><td style="background:#2a1508;background-image:radial-gradient(ellipse at 50% 110%,rgba(196,140,60,0.38) 0%,transparent 62%),linear-gradient(180deg,#2a1508 0%,#3d2010 55%,#5a2e14 100%);padding:36px 32px 40px;text-align:center;">
              <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#ffffff;font-weight:700">${eye}</p>
              ${logoTag}
              <p style="margin:0;font-size:26px;font-weight:400;color:#ffffff;line-height:1.15;font-family:Georgia,serif">${heroTitle}</p>
            </td></tr>
            <!-- Gold trim inside rounded wrapper -->
            <tr><td style="background:linear-gradient(90deg,#b8821e 0%,#e8c45a 35%,#f5d060 55%,#d4a030 80%,#b8821e 100%);height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>
          </table>
        </td></tr>

        <!-- Body text -->
        <tr><td style="padding:28px 32px 0">${bodyHtml}</td></tr>

        <!-- Detail rows -->
        <tr><td style="padding:8px 32px 4px">
          <table width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:16px 32px 32px;text-align:center">${ctaHtml}</td></tr>

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

// Helper: standard row
function _eRow(label, value, color) {
  return `
    <tr>
      <td style="padding:8px 0;vertical-align:top">
        <span style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#a08060;font-family:Georgia,serif">${label}</span>
      </td>
      <td align="right" style="padding:8px 0;vertical-align:top">
        <span style="font-size:13px;color:${color || '#2d211b'};font-weight:${color ? '400' : '600'};font-family:Georgia,serif">${value}</span>
      </td>
    </tr>`;
}

// Helper: gold pill CTA button
function _eBtn(href, text, sub) {
  return `<a href="${href}" style="display:inline-block;background:linear-gradient(90deg,#b8821e 0%,#e8c45a 35%,#f5d878 55%,#d4a030 80%,#b8821e 100%);color:#2d1508;text-decoration:none;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 34px;border-radius:999px">${text}</a>`
    + (sub ? `<p style="margin:12px 0 0;font-size:12px;color:#7a5a40;font-style:italic;font-family:Georgia,serif">${sub}</p>` : '');
}

// ── POST /api/game?action=notify-outbid ───────────────────────────────────────
async function handleNotifyOutbid(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { outbid_wallet, new_bidder, new_amount, auction_id, art_title, auction_url } = req.body || {};
  if (!outbid_wallet || !new_amount) return res.status(400).json({ error: 'Missing required fields' });
  let email;
  try { email = await _lookupBidderEmail(outbid_wallet, auction_id); }
  catch (e) { return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message }); }
  if (!email) return res.status(200).json({ sent: false, reason: 'No email registered' });

  const shortBidder = (new_bidder || '').slice(0, 6) + '\u2026' + (new_bidder || '').slice(-4);
  const title       = art_title   || 'an \u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 piece';
  const url         = auction_url || 'https://kaysworks.com/auction';
  const subject     = `You\u2019ve been outbid \u2014 ${new_amount} on ${title}`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">You\u2019ve been outbid.</p>
    <p style="margin:0;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      Someone just placed <strong style="color:#9e4f2e;font-style:normal">${new_amount}</strong> and moved ahead of you.
      I don\u2019t want you to lose this one \u2014 come back and take your spot.
    </p>`;

  const rowsHtml =
    _eRow('New leading bid', new_amount, null) +
    _eRow('Bidder ahead',    shortBidder, '#9e4f2e') +
    _eRow('Piece',           title,       '#9e4f2e');

  const html = _emailShell(
    'You\'ve been outbid!!!',
    null, null,
    bodyHtml, rowsHtml,
    _eBtn(url, 'Come back and bid', 'The auction is still live. I\u2019m rooting for you.')
  );

  try {
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], reply_to: (process.env.AUCTION_REPLY_TO_EMAIL || process.env.CONTACT_EMAIL || 'oyeniyikayode4@gmail.com'), subject, html });
    return res.status(200).json({ sent: true, id: data.id });
  } catch (e) { return res.status(500).json({ error: 'Email send failed: ' + e.message }); }
}

// ── POST /api/game?action=notify-bid-confirm ──────────────────────────────────
async function handleNotifyBidConfirm(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { bidder_wallet, amount, auction_id, art_title, auction_url, is_first } = req.body || {};
  if (!bidder_wallet || !amount) return res.status(400).json({ error: 'Missing required fields' });
  let email;
  try { email = await _lookupBidderEmail(bidder_wallet, auction_id); }
  catch (e) { return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message }); }
  if (!email) return res.status(200).json({ sent: false, reason: 'No email registered' });

  const title      = art_title   || 'an \u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 piece';
  const url        = auction_url || 'https://kaysworks.com/auction';
  const badgeLabel = is_first ? 'First bid confirmed' : 'Bid confirmed \u2014 you lead';
  const subject    = is_first
    ? `Your bid is in \u2014 ${amount} on ${title}`
    : `You\u2019re back in front \u2014 ${amount} on ${title}`;
  const heroTitle  = is_first ? 'Your bid is in. LFG!' : 'You\u2019re back in front!';

  const bodyHtml = is_first
    ? `<p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">${badgeLabel}.</p>
       <p style="margin:0;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
         <strong style="font-style:normal;color:#9e4f2e">${amount}</strong> \u2014 you\u2019re in. I see you up there.
         You just started something real. I\u2019ll let you know the moment anyone tries to move ahead.
       </p>`
    : `<p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">${badgeLabel}.</p>
       <p style="margin:0;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
         <strong style="font-style:normal;color:#9e4f2e">${amount}</strong> \u2014 and the lead is yours again.
         I saw that. I\u2019ll let you know the moment anyone challenges your position.
       </p>`;

  const rowsHtml =
    _eRow('Your bid', amount,    null) +
    _eRow('Status',   'Leading', '#3a6e30') +
    _eRow('Piece',    title,     '#9e4f2e');

  const html = _emailShell(
    heroTitle, null, null,
    bodyHtml, rowsHtml,
    _eBtn(url, 'Watch the auction', 'I\u2019ll be in touch the moment anyone tries to take your spot.')
  );

  try {
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], reply_to: (process.env.AUCTION_REPLY_TO_EMAIL || process.env.CONTACT_EMAIL || 'oyeniyikayode4@gmail.com'), subject, html });
    return res.status(200).json({ sent: true, id: data.id });
  } catch (e) { return res.status(500).json({ error: 'Email send failed: ' + e.message }); }
}

// ── POST /api/game?action=notify-winner ───────────────────────────────────────
async function handleNotifyWinner(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { winner_wallet, amount, auction_id, art_title, auction_url } = req.body || {};
  if (!winner_wallet || !amount) return res.status(400).json({ error: 'Missing required fields' });
  let email;
  try { email = await _lookupBidderEmail(winner_wallet, auction_id); }
  catch (e) { return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message }); }
  if (!email) return res.status(200).json({ sent: false, reason: 'No email registered' });

  const title   = art_title   || 'an \u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 piece';
  const url     = auction_url || 'https://kaysworks.com/auction';
  const subject = `Sold \u2014 ${title} is yours`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;color:#2d211b;font-family:Georgia,serif;line-height:1.6">You just won this!!!!</p>
    <p style="margin:0;font-size:13px;color:#5c3e2e;font-style:italic;font-family:Georgia,serif;line-height:1.65">
      <strong style="font-style:normal;color:#9e6e10">${amount}</strong> \u2014 and it\u2019s yours.
      I made this piece and I\u2019m genuinely glad it found you. Welcome to the collection \u2014
      I\u2019ll be in touch personally with next steps.
    </p>`;

  const rowsHtml =
    _eRow('Winning bid', amount,            '#9e6e10') +
    _eRow('Status',      'Auction settled', '#9e6e10') +
    _eRow('Piece',       title,             '#9e4f2e');

  const html = _emailShell(
    'You just won this!!!!', null, null,
    bodyHtml, rowsHtml,
    _eBtn(url, 'View the auction', 'Thank you for being in that room. It means everything.'),
    'Kay\u2019s Works \u00b7 Auction Won'
  );

  try {
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], reply_to: (process.env.AUCTION_REPLY_TO_EMAIL || process.env.CONTACT_EMAIL || 'oyeniyikayode4@gmail.com'), subject, html });
    return res.status(200).json({ sent: true, id: data.id });
  } catch (e) { return res.status(500).json({ error: 'Email send failed: ' + e.message }); }
}


// ── POST /api/game?action=notify-bid ─────────────────────────────────────────
// Sends a bid alert email to the site owner whenever a new bid is placed.
async function handleNotifyBid(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bidder, amount, art_title, auction_url, auction_id } = req.body || {};

  if (!bidder || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — missing RESEND_API_KEY' });
  }

  const shortBidder = bidder.slice(0, 6) + '…' + bidder.slice(-4);
  const title       = art_title  || 'an Àpótí Ọlọ́wọ̀ piece';
  const url         = auction_url || 'https://kaysworks.com/auction';
  const auctionRef  = auction_id  ? ` (${auction_id.slice(0, 8)}…)` : '';

  const emailBody = {
    from:    'Àpótí Ọlọ́wọ̀ Auction <auction@mail.kaysworks.com>',
    to:      [process.env.AUCTION_ALERT_EMAIL || process.env.CONTACT_EMAIL || 'oyeniyikayode4@gmail.com'],
    subject: `New bid — ${amount} on ${title}`,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>New Bid Alert</title>
</head>
<body style="margin:0;padding:0;background:#1e1510;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1510;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#2a1c14;border:1px solid rgba(196,132,90,0.25);border-radius:6px;overflow:hidden;max-width:560px;width:100%">
        <tr>
          <td style="padding:28px 32px 20px;border-bottom:1px solid rgba(196,132,90,0.18)">
            <p style="margin:0 0 4px;font-family:'Georgia',serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#c4845a">Kay's Works · Live Auction</p>
            <h1 style="margin:0;font-family:'Georgia',serif;font-size:26px;font-weight:400;color:#e8d5b0;line-height:1.2">${title}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(107,124,92,0.12);border:1px solid rgba(107,124,92,0.3);border-radius:4px">
              <tr><td style="padding:18px 20px">
                <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6b7c5c;font-family:'Georgia',serif">New bid placed</p>
                <p style="margin:0;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">Someone just bid <strong style="color:#c4845a">${amount}</strong></p>
                <p style="margin:8px 0 0;font-size:13px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">${shortBidder} placed a bid on ${title}${auctionRef}.</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 20px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Bidder</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${shortBidder}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Bid amount</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:16px;color:#e8d5b0;font-weight:600;font-family:'Georgia',serif">${amount}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 32px 32px;text-align:center">
            <a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">View auction</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid rgba(196,132,90,0.18);text-align:center">
            <p style="margin:0;font-size:11px;color:#4a3228;font-family:'Georgia',serif">© Kay's Works · <a href="https://kaysworks.com" style="color:#4a3228">kaysworks.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(emailBody),
    });
    const resendData = await resendRes.json();
    if (!resendRes.ok) throw new Error(resendData.message || 'Resend error');
    return res.status(200).json({ sent: true, id: resendData.id });
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
}

// Cross-chain pair claim. Requires a Supabase table:
// crosschain_auction_claims(pair_key text primary key, active_chain text,
// active_auction_key text, status text, bid_count int, opened_at timestamptz,
// reset_at timestamptz, settled_at timestamptz, updated_at timestamptz).
async function handleCrosschainClaim(req, res, supabase) {
  const now = new Date();

  if (req.method === 'GET') {
    const pairKey = String(req.query.pair_key || '').trim().toLowerCase();
    if (!pairKey) return res.status(400).json({ error: 'pair_key required' });
    const { data, error } = await supabase
      .from('crosschain_auction_claims')
      .select('*')
      .eq('pair_key', pairKey)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (data && data.bid_count === 0 && data.reset_at && new Date(data.reset_at) <= now) {
      await supabase.from('crosschain_auction_claims').delete().eq('pair_key', pairKey).eq('bid_count', 0);
      return res.status(200).json({ ok: true, claim: null, reset: true });
    }
    return res.status(200).json({ ok: true, claim: data || null });
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = String(body.action || 'claim');
  const pairKey = String(body.pair_key || '').trim().toLowerCase();
  if (!pairKey) return res.status(400).json({ error: 'pair_key required' });

  if (action === 'bid') {
    const { data, error } = await supabase
      .from('crosschain_auction_claims')
      .update({ bid_count: 1, status: 'live', updated_at: now.toISOString() })
      .eq('pair_key', pairKey)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, claim: data || null });
  }

  if (action === 'settle') {
    const { data, error } = await supabase
      .from('crosschain_auction_claims')
      .update({ status: 'settled', settled_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('pair_key', pairKey)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, claim: data || null });
  }

  if (action === 'reset') {
    const { error } = await supabase
      .from('crosschain_auction_claims')
      .delete()
      .eq('pair_key', pairKey)
      .eq('bid_count', 0);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, claim: null, reset: true });
  }

  const activeChain = String(body.active_chain || '').trim().toLowerCase();
  const activeAuctionKey = String(body.active_auction_key || '').trim().toLowerCase();
  const timeoutSec = Math.max(15, Math.min(3600, Number(body.no_bid_timeout_sec || 600)));
  if (!['eth','tezos'].includes(activeChain) || !activeAuctionKey) {
    return res.status(400).json({ error: 'active_chain and active_auction_key required' });
  }

  const resetAt = new Date(now.getTime() + timeoutSec * 1000).toISOString();
  const row = {
    pair_key: pairKey,
    active_chain: activeChain,
    active_auction_key: activeAuctionKey,
    status: 'waiting-bid',
    bid_count: 0,
    opened_at: now.toISOString(),
    reset_at: resetAt,
    updated_at: now.toISOString(),
  };

  const inserted = await supabase
    .from('crosschain_auction_claims')
    .insert(row)
    .select('*')
    .single();
  if (!inserted.error) return res.status(200).json({ ok: true, claim: inserted.data, claimed: true });

  const { data, error } = await supabase
    .from('crosschain_auction_claims')
    .select('*')
    .eq('pair_key', pairKey)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (data && data.bid_count === 0 && data.reset_at && new Date(data.reset_at) <= now) {
    await supabase.from('crosschain_auction_claims').delete().eq('pair_key', pairKey).eq('bid_count', 0);
    return handleCrosschainClaim(req, res, supabase);
  }
  return res.status(200).json({ ok: true, claim: data || null, claimed: false, conflict: true });
}


// ═══════════════════════════════════════════════════════════════════════════
//  SHOP SECTION (pending-first + price-lock + payment_metadata crypto storage)
//  Merged into game.js. Uses res-based json helpers below.
// ═══════════════════════════════════════════════════════════════════════════
let _shopRes = null;
function json(status, obj) { _shopRes.status(status).json(obj); return obj; }
function jsonError(e) {
  return json(e.statusCode || 500, {
    error: e.message || 'Server error',
    product_id: e.product_id,
    variant: e.variant,
  });
}
// ── PRODUCTS ──────────────────────────────────────────────────────────────────
async function handleShopProducts(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const slug   = req.query.slug   || '';
  const series = req.query.series || '';

  if (slug) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('slug', slug)
      .eq('active', true)
      .single();
    if (error) return json(error.code === 'PGRST116' ? 404 : 500, { error: error.message });
    const [tagged] = await applyProductTags([data], supabase);
    return json(200, tagged || data);
  }

  if (series) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('series_slug', series)
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, data || []);
  }

  const { data, error } = await supabase
    .from('shop_products')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) return json(500, { error: error.message });

  const tagged = await applyProductTags(data || [], supabase);
  return json(200, tagged);
}

// Compute "new" (added in last 14 days) and "bestseller" (top 3 by total
// quantity ordered) tags, returned alongside each product.
async function applyProductTags(products, supabase) {
  if (!products.length) return products;

  const counts = {};
  try {
    const { data: orders } = await supabase
      .from('shop_orders')
      .select('items')
      .limit(5000);
    (orders || []).forEach(o => {
      const items = Array.isArray(o.items) ? o.items : [];
      items.forEach(it => {
        const id = it && it.id;
        const qty = Number(it && it.qty) || 0;
        if (id) counts[id] = (counts[id] || 0) + qty;
      });
    });
  } catch (e) {
    // If orders can't be read, fall back to no bestseller tags.
  }

  const bestsellerIds = new Set(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id)
  );

  const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return products.map(p => {
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    const isNew = created > 0 && (now - created) <= NEW_WINDOW_MS;
    const isBestseller = bestsellerIds.has(p.id);
    return {
      ...p,
      is_new: isNew,
      is_bestseller: isBestseller,
      order_count: counts[p.id] || 0,
    };
  });
}

// CHECKOUT COMPUTATION (server-authoritative)
// Delivery rates and carrier rules mirror the checkout in shop.html.
const SERVER_DELIVERY_RATES = {
  pickup:     { label: 'Kaduna pickup',            small: { ngn: 0,    usd: 0 }, large: { ngn: 0,     usd: 0 } },
  'NG-KD':     { label: 'Kaduna State',             small: { ngn: 2500, usd: 0 }, large: { ngn: 3800,  usd: 0 } },
  'NG-ABJ':    { label: 'FCT - Abuja',              small: { ngn: 3800, usd: 0 }, large: { ngn: 5500,  usd: 0 } },
  'NG-NORTH2': { label: 'North / North-West',       small: { ngn: 4200, usd: 0 }, large: { ngn: 6000,  usd: 0 } },
  'NG-NORTH3': { label: 'North-East / Mid-Belt',    small: { ngn: 5500, usd: 0 }, large: { ngn: 7500,  usd: 0 } },
  'NG-SW':     { label: 'South-West',               small: { ngn: 7500, usd: 0 }, large: { ngn: 10000, usd: 0 } },
  'NG-SS':     { label: 'South-South / South-East', small: { ngn: 9000, usd: 0 }, large: { ngn: 12500, usd: 0 } },
  WA:  { label: 'West Africa',    ups: { small: 18, large: 28 }, dhl: { small: 20, large: 30 } },
  EU:  { label: 'Europe / UK',    ups: { small: 34, large: 50 }, dhl: { small: 48, large: 68 } },
  NA:  { label: 'North America',  ups: { small: 38, large: 55 }, dhl: { small: 52, large: 72 } },
  AO:  { label: 'Asia / Oceania', ups: { small: 46, large: 64 }, dhl: { small: 56, large: 78 } },
  ROW: { label: 'Rest of world',  ups: { small: 42, large: 60 }, dhl: { small: 50, large: 70 } },
};
const SERVER_LARGE_PRINT_VARIANTS = ['12x16"', '12x18"', '18x24"', '24x36"'];
const NGN_PER_USD = 1600;
const SERVER_HIGH_CART_USD = 60;
const SERVER_COMPLIMENTARY_SHIPPING_USD = 500;
const SERVER_SHIPPING_DIM_DIVISOR = 5000;
const SERVER_SHIPPING_BUFFER = 1.2;

function serverVariantPrice(product, variantKey, variant, currency) {
  const prices = currency === 'usd' ? (product.prices_usd || {}) : (product.prices_ngn || {});
  if (variantKey && prices[variantKey] !== undefined) return Number(prices[variantKey]) || 0;
  if (variant && prices[variant] !== undefined) return Number(prices[variant]) || 0;
  const size = String(variantKey || variant || '').split('|').pop();
  if (size && prices[size] !== undefined) return Number(prices[size]) || 0;
  return 0;
}

function serverIsInternationalZone(zone) {
  return !!zone && zone !== 'pickup' && !zone.startsWith('NG-');
}
function serverNormalizedSizeLabel(value) {
  return String(value || '').replace(/[xX?]/g, 'x');
}
function serverParsePrintInches(size) {
  const m = serverNormalizedSizeLabel(size).match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { max: Math.max(Number(m[1]), Number(m[2])) };
}
function serverOptionShippingMeta(product, type, size) {
  const opts = Array.isArray(product?.variants) ? product.variants : [];
  const opt = opts.find(v => v && typeof v === 'object' && String(v.type || v.name || v.label || '') === String(type || ''));
  const meta = opt?.shipping_meta || opt?.shipping || {};
  return meta?.[size] || meta?.[serverNormalizedSizeLabel(size)] || null;
}
function serverPrintDefaultProfile(type, size) {
  const parsed = serverParsePrintInches(size);
  const max = parsed?.max || 10;
  if (max <= 7) return { weightKg: 0.45, dimsCm: [32, 24, 3], packageType: 'flat mailer', packageClass: 'flat_art' };
  if (max <= 14) return { weightKg: 0.75, dimsCm: [46, 38, 3], packageType: 'flat mailer', packageClass: 'flat_art' };
  return { weightKg: 1.35, dimsCm: [76, 10, 10], packageType: 'protective tube', packageClass: 'tube_art' };
}
function serverDefaultProductShippingProfile(product, variantLabel) {
  const cat = String(product?.category || '').toLowerCase();
  const name = String(product?.name || '').toLowerCase();
  if (cat === 'prints') {
    const parts = String(variantLabel || '').split('|');
    return serverPrintDefaultProfile(parts[0] || '', parts[1] || variantLabel);
  }
  if (name.includes('hoodie')) return { weightKg: 0.9, dimsCm: [34, 28, 8], packageType: 'soft parcel', packageClass: 'soft_parcel' };
  if (name.includes('shirt') || name.includes('tee')) return { weightKg: 0.35, dimsCm: [30, 24, 4], packageType: 'soft parcel', packageClass: 'soft_parcel' };
  if (name.includes('journal') || cat === 'notebooks') return { weightKg: 0.55, dimsCm: [28, 22, 5], packageType: 'rigid mailer', packageClass: 'rigid_parcel' };
  if (name.includes('tote')) return { weightKg: 0.4, dimsCm: [32, 26, 4], packageType: 'soft parcel', packageClass: 'soft_parcel' };
  if (name.includes('sticker') || cat === 'stickers') return { weightKg: 0.12, dimsCm: [22, 16, 1], packageType: 'flat mailer', packageClass: 'sticker_flat' };
  return { weightKg: 0.6, dimsCm: [34, 26, 6], packageType: 'parcel', packageClass: 'rigid_parcel' };
}
function serverItemShippingProfile(product, item) {
  const variant = item.variantKey || item.variant || '';
  const parts = String(variant).split('|');
  const type = parts[0] || '';
  const size = parts[1] || item.variant || variant;
  const meta = product.category === 'prints' ? serverOptionShippingMeta(product, type, size) : null;
  const fallback = serverDefaultProductShippingProfile(product, variant);
  const dims = [Number(meta?.length_cm), Number(meta?.width_cm), Number(meta?.height_cm)];
  return {
    weightKg: Number(meta?.weight_kg) || fallback.weightKg,
    dimsCm: dims.every(n => n > 0) ? dims : fallback.dimsCm,
    packageType: meta?.package_type || fallback.packageType,
    packageClass: meta?.package_class || fallback.packageClass || (/tube/i.test(meta?.package_type || fallback.packageType) ? 'tube_art' : 'rigid_parcel'),
    carrierPrice: { ups: Number(meta?.ups_usd) || 0, dhl: Number(meta?.dhl_usd) || 0 },
  };
}
function serverMakeShippingPiece(kind, label, entries) {
  let rawKg = 0, maxL = 0, maxW = 0, maxH = 0;
  const carrierOverride = { ups: 0, dhl: 0 };
  for (const entry of entries) {
    const profile = entry.profile;
    const qty = Math.max(1, Number(entry.qty) || 1);
    rawKg += profile.weightKg * qty;
    maxL = Math.max(maxL, profile.dimsCm[0]);
    maxW = Math.max(maxW, profile.dimsCm[1]);
    maxH = Math.max(maxH, profile.dimsCm[2] + Math.max(0, qty - 1) * 0.4);
    carrierOverride.ups = Math.max(carrierOverride.ups, profile.carrierPrice.ups || 0);
    carrierOverride.dhl = Math.max(carrierOverride.dhl, profile.carrierPrice.dhl || 0);
  }
  const actualKg = +(rawKg * SERVER_SHIPPING_BUFFER).toFixed(2);
  const volumetricKg = maxL && maxW && maxH ? +((maxL * maxW * maxH) / SERVER_SHIPPING_DIM_DIVISOR).toFixed(2) : 0;
  return { kind, label, actualKg, volumetricKg, billableKg: Math.max(actualKg, volumetricKg), dimsCm: [maxL, maxW, maxH], carrierOverride };
}
function serverShippingPieces(trustedItems, productCache) {
  const entries = trustedItems.map(item => ({ item, qty: item.qty, profile: serverItemShippingProfile(productCache[item.id] || {}, item) }));
  const byClass = cls => entries.filter(e => e.profile.packageClass === cls);
  const tube = byClass('tube_art');
  const flat = byClass('flat_art');
  const stickers = byClass('sticker_flat');
  const parcels = entries.filter(e => ['soft_parcel','rigid_parcel'].includes(e.profile.packageClass));
  const pieces = [];
  if (tube.length) {
    pieces.push(serverMakeShippingPiece('tube_art', 'Tube artwork package', [...tube, ...flat]));
    if (parcels.length || stickers.length) pieces.push(serverMakeShippingPiece('parcel', 'Merch and accessories package', [...parcels, ...stickers]));
  } else if (flat.length) {
    pieces.push(serverMakeShippingPiece('flat_art', 'Flat artwork package', [...flat, ...stickers]));
    if (parcels.length) pieces.push(serverMakeShippingPiece('parcel', 'Merch and accessories package', parcels));
  } else if (parcels.length || stickers.length) {
    pieces.push(serverMakeShippingPiece('parcel', 'Parcel package', [...parcels, ...stickers]));
  }
  return pieces;
}
function serverShippingProfile(trustedItems, productCache) {
  const pieces = serverShippingPieces(trustedItems, productCache);
  const carrierOverride = { ups: 0, dhl: 0 };
  for (const piece of pieces) {
    carrierOverride.ups = Math.max(carrierOverride.ups, piece.carrierOverride.ups || 0);
    carrierOverride.dhl = Math.max(carrierOverride.dhl, piece.carrierOverride.dhl || 0);
  }
  const actualKg = +pieces.reduce((sum, piece) => sum + piece.actualKg, 0).toFixed(2);
  const volumetricKg = +pieces.reduce((sum, piece) => sum + piece.volumetricKg, 0).toFixed(2);
  const billableKg = +pieces.reduce((sum, piece) => sum + piece.billableKg, 0).toFixed(2);
  const tube = pieces.some(piece => piece.kind === 'tube_art');
  return { actualKg, volumetricKg, billableKg, tube, pieces, carrierOverride };
}
function serverIntlCarrierTier(zone, subtotalUsd, requestedCarrier = '') {
  if (!serverIsInternationalZone(zone)) return '';
  const requested = String(requestedCarrier || '').toLowerCase();
  if (requested === 'ups' || requested === 'dhl') return requested;
  if (zone === 'NA') return 'ups';
  return Number(subtotalUsd || 0) >= SERVER_HIGH_CART_USD ? 'dhl' : 'ups';
}
function serverDeliveryFee(zone, hasLarge, currency, subtotalUsd = 0, requestedCarrier = '', shippingProfile = null) {
  if (subtotalUsd >= SERVER_COMPLIMENTARY_SHIPPING_USD) return 0;
  const z = SERVER_DELIVERY_RATES[zone] || SERVER_DELIVERY_RATES.ROW;
  const carrierTier = serverIntlCarrierTier(zone, subtotalUsd, requestedCarrier);
  let tier;
  if (carrierTier) {
    const pieces = shippingProfile?.pieces?.length ? shippingProfile.pieces : [{ kind: hasLarge ? 'tube_art' : 'parcel', billableKg: hasLarge ? 1.5 : 0.7, carrierOverride: {} }];
    const usd = pieces.reduce((sum, piece) => {
      const override = piece.carrierOverride?.[carrierTier] || 0;
      if (override > 0) return sum + override;
      const kg = piece.billableKg || (piece.kind === 'tube_art' ? 1.5 : 0.7);
      const isTube = piece.kind === 'tube_art';
      const base = z[carrierTier][kg > 0.8 || isTube ? 'large' : 'small'];
      const includedKg = kg > 0.8 || isTube ? 1.5 : 0.8;
      const extraKg = Math.max(0, Math.ceil(kg - includedKg));
      return sum + base + extraKg * (carrierTier === 'dhl' ? 14 : 12);
    }, 0);
    tier = { usd, ngn: 0 };
  } else {
    tier = hasLarge ? z.large : z.small;
  }
  if (currency === 'usd') {
    if (tier.usd > 0) return tier.usd;
    return tier.ngn > 0 ? +(tier.ngn / NGN_PER_USD).toFixed(2) : 0;
  }
  if (tier.ngn > 0) return tier.ngn;
  return tier.usd > 0 ? Math.round(tier.usd * NGN_PER_USD) : 0;
}

async function computeShopCheckout(body, supabase) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    const err = new Error('No items in order');
    err.statusCode = 400;
    throw err;
  }

  const productCache = {};
  for (const item of items) {
    if (!item.id || productCache[item.id]) continue;
    const { data: product } = await supabase
      .from('shop_products')
      .select('*')
      .eq('id', item.id)
      .single();
    if (product) productCache[item.id] = product;
  }

  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const vkey = item.variantKey || item.variant;
    const sizeKey = String(vkey || '').split('|').pop();
    const product = productCache[item.id];
    if (!product) continue;

    const stockByVariant = product.stock_by_variant || {};
    // Resolve stock with the same fallback the client uses: full key → size → none
    let sv;
    if (stockByVariant[vkey] !== undefined)         sv = stockByVariant[vkey];
    else if (stockByVariant[sizeKey] !== undefined) sv = stockByVariant[sizeKey];
    else if (stockByVariant[item.variant] !== undefined) sv = stockByVariant[item.variant];

    if (sv !== undefined && Number(sv) < item.qty) {
      const err = new Error(`Only ${sv} left in stock for ${product.name} · ${item.variant}`);
      err.statusCode = 409;
      err.product_id = item.id;
      err.variant = item.variant;
      throw err;
    }
    // Only apply product-level stock when there's NO per-variant tracking at all
    if (sv === undefined && Object.keys(stockByVariant).length === 0 &&
        product.stock !== null && product.stock !== undefined && Number(product.stock) < item.qty) {
      const err = new Error(`Only ${product.stock} left in stock for ${product.name}`);
      err.statusCode = 409;
      err.product_id = item.id;
      throw err;
    }
  }

  let subtotalNgn = 0, subtotalUsd = 0, hasLarge = false;
  const trustedItems = [];
  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const product = productCache[item.id];
    if (!product) {
      const err = new Error(`Unknown product in order: ${item.id}`);
      err.statusCode = 400;
      throw err;
    }
    const vkey = item.variantKey || item.variant;
    const qty = Math.max(1, Number(item.qty) || 1);
    const priceNgn = serverVariantPrice(product, vkey, item.variant, 'ngn');
    const priceUsd = serverVariantPrice(product, vkey, item.variant, 'usd');
    subtotalNgn += priceNgn * qty;
    subtotalUsd += priceUsd * qty;
    if (product.category === 'prints' &&
        (product.is_large_print === true || SERVER_LARGE_PRINT_VARIANTS.includes(serverNormalizedSizeLabel(item.variant)))) {
      hasLarge = true;
    }
    trustedItems.push({
      id: item.id,
      name: product.name,
      variant: item.variant,
      variantKey: vkey,
      qty,
      priceNgn,
      priceUsd,
    });
  }

  const zone = String(body.delivery_zone || 'pickup');
  const method = String(body.delivery_method || 'pickup');
  const shippingProfile = serverShippingProfile(trustedItems, productCache);
  hasLarge = hasLarge || shippingProfile.tube;
  const deliveryCarrier = method === 'ship' ? serverIntlCarrierTier(zone, subtotalUsd, body.delivery_carrier) : '';
  const deliveryNgn = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'ngn', subtotalUsd, deliveryCarrier, shippingProfile) : 0;
  const deliveryUsd = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'usd', subtotalUsd, deliveryCarrier, shippingProfile) : 0;

  // ── Discount code ────────────────────────────────────────────────────────
  // Resolve and apply a discount code (if provided). The discount is computed
  // server-side from the authoritative subtotal/delivery so it can't be forged.
  const discount = await resolveShopDiscount(body.discount_code, supabase, {
    subtotalNgn, subtotalUsd, deliveryNgn, deliveryUsd,
  });

  const discountedSubtotalNgn = +(subtotalNgn - discount.amountNgn.products).toFixed(2);
  const discountedSubtotalUsd = +(subtotalUsd - discount.amountUsd.products).toFixed(2);
  const discountedDeliveryNgn = +(deliveryNgn - discount.amountNgn.shipping).toFixed(2);
  const discountedDeliveryUsd = +(deliveryUsd - discount.amountUsd.shipping).toFixed(2);

  // Optional tip (client-supplied, clamped to >= 0). Added on top of the total.
  const tipNgn = Math.max(0, +(Number(body.tip_ngn) || 0).toFixed(2));
  const tipUsd = Math.max(0, +(Number(body.tip_usd) || 0).toFixed(2));

  const totalNgn = Math.max(0, +(discountedSubtotalNgn + discountedDeliveryNgn + tipNgn).toFixed(2));
  const totalUsd = Math.max(0, +(discountedSubtotalUsd + discountedDeliveryUsd + tipUsd).toFixed(2));

  return {
    productCache,
    trustedItems,
    hasLarge,
    shippingProfile,
    zone,
    method,
    deliveryCarrier,
    subtotalNgn,
    subtotalUsd: +subtotalUsd.toFixed(2),
    deliveryNgn,
    deliveryUsd,
    discountCode: discount.code,
    discountPercent: discount.percent,
    discountScope: discount.scope,
    discountNgn: +(discount.amountNgn.products + discount.amountNgn.shipping).toFixed(2),
    discountUsd: +(discount.amountUsd.products + discount.amountUsd.shipping).toFixed(2),
    tipNgn,
    tipUsd,
    totalNgn,
    totalUsd,
    // An order is only free when there's truly nothing to pay (incl. no tip).
    isFree: totalNgn <= 0 && totalUsd <= 0,
  };
}

// ── DISCOUNT CODES ────────────────────────────────────────────────────────────
// Codes live in shop_config.discount_codes as an array of:
//   { code, percent (10|20|50|100), scope ('products'|'shipping'|'all'), active, note }
// A code with scope 'all' at 100% (the dev/test code) zeroes the entire order,
// including shipping, so it can be validated and marked paid without a gateway.
async function resolveShopDiscount(rawCode, supabase, amounts) {
  const empty = {
    code: '', percent: 0, scope: '',
    amountNgn: { products: 0, shipping: 0 },
    amountUsd: { products: 0, shipping: 0 },
  };
  const code = String(rawCode || '').trim().toUpperCase().slice(0, 40);
  if (!code) return empty;

  let codes = [];
  try {
    const { data } = await supabase
      .from('shop_config')
      .select('discount_codes')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    codes = Array.isArray(data?.discount_codes) ? data.discount_codes : [];
  } catch (_) { codes = []; }

  const match = codes.find(c =>
    c && c.active !== false &&
    String(c.code || '').trim().toUpperCase() === code
  );
  if (!match) {
    const e = new Error('That discount code is not valid');
    e.statusCode = 422;
    e.invalid_code = true;
    throw e;
  }

  const percent = Math.max(0, Math.min(100, Number(match.percent) || 0));
  const scope = ['products', 'shipping', 'all'].includes(match.scope) ? match.scope : 'products';
  const f = percent / 100;

  const applyProducts = scope === 'products' || scope === 'all';
  const applyShipping = scope === 'shipping' || scope === 'all';

  return {
    code,
    percent,
    scope,
    amountNgn: {
      products: applyProducts ? +(amounts.subtotalNgn * f).toFixed(2) : 0,
      shipping: applyShipping ? +(amounts.deliveryNgn * f).toFixed(2) : 0,
    },
    amountUsd: {
      products: applyProducts ? +(amounts.subtotalUsd * f).toFixed(2) : 0,
      shipping: applyShipping ? +(amounts.deliveryUsd * f).toFixed(2) : 0,
    },
  };
}

// ── QUOTE SIGNING (HMAC) ──────────────────────────────────────────────────────
function shopQuoteSecret() {
  return process.env.SHOP_QUOTE_SECRET
      || process.env.ADMIN_SESSION_SECRET
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || 'dev-shop-quote-secret';
}

function signShopQuote(payload) {
  return crypto.createHmac('sha256', shopQuoteSecret()).update(JSON.stringify(payload)).digest('hex');
}

function makeShopQuote(checkout, extra = {}) {
  const now = Date.now();
  const payload = {
    v: 1,
    iat: now,
    exp: now + 15 * 60 * 1000,
    items: checkout.trustedItems.map(i => ({ id: i.id, variantKey: i.variantKey, qty: i.qty })),
    delivery_method: checkout.method,
    delivery_zone: checkout.zone,
    delivery_carrier: checkout.deliveryCarrier,
    shipping_billable_kg: checkout.shippingProfile?.billableKg || 0,
    subtotal_ngn: checkout.subtotalNgn,
    subtotal_usd: checkout.subtotalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    delivery_fee_usd: checkout.deliveryUsd,
    discount_code: checkout.discountCode || '',
    discount_percent: checkout.discountPercent || 0,
    discount_scope: checkout.discountScope || '',
    discount_ngn: checkout.discountNgn || 0,
    discount_usd: checkout.discountUsd || 0,
    tip_ngn: checkout.tipNgn || 0,
    tip_usd: checkout.tipUsd || 0,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    ...extra,
  };
  return { ...payload, sig: signShopQuote(payload) };
}

function verifyShopQuote(quote, checkout, expected = {}) {
  if (!quote || typeof quote !== 'object') return false;
  const { sig, ...payload } = quote;
  if (!sig || Date.now() > Number(payload.exp || 0)) return false;
  const expectedSig = signShopQuote(payload);
  const sigBuf = Buffer.from(String(sig), 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  if (Number(payload.total_ngn) !== checkout.totalNgn) return false;
  if (Number(payload.total_usd) !== checkout.totalUsd) return false;
  if (String(payload.discount_code || '') !== String(checkout.discountCode || '')) return false;
  if (Number(payload.discount_percent || 0) !== Number(checkout.discountPercent || 0)) return false;
  if (Number(payload.tip_ngn || 0) !== Number(checkout.tipNgn || 0)) return false;
  if (String(payload.delivery_method) !== checkout.method) return false;
  if (String(payload.delivery_zone) !== checkout.zone) return false;
  if (String(payload.delivery_carrier || '') !== String(checkout.deliveryCarrier || '')) return false;
  const quoteItems = JSON.stringify(payload.items || []);
  const trustedItems = JSON.stringify(checkout.trustedItems.map(i => ({ id: i.id, variantKey: i.variantKey, qty: i.qty })));
  if (quoteItems !== trustedItems) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && String(payload[key] || '') !== String(value)) return false;
  }
  return true;
}



async function fetchServerCryptoPrice(asset) {
  const symbol = asset === 'xtz' ? 'XTZUSDT' : 'ETHUSDT';
  const coingeckoId = asset === 'xtz' ? 'tezos' : 'ethereum';
  const coinbasePair = asset === 'xtz' ? 'XTZ-USD' : 'ETH-USD';
  const TIMEOUT_MS = 7000; // raised from 3500 — Netlify cold starts + slow upstreams
  const errors = [];

  async function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }
  async function binance() {
    const r = await withTimeout(fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`binance ${r.status}`);
    const d = await r.json();
    const price = Number(d.price);
    if (!price || price <= 0) throw new Error('bad binance rate');
    return price;
  }
  async function coingecko() {
    const r = await withTimeout(fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const d = await r.json();
    const price = Number(d?.[coingeckoId]?.usd);
    if (!price || price <= 0) throw new Error('bad coingecko rate');
    return price;
  }
  async function coinbase() {
    const r = await withTimeout(fetch(`https://api.coinbase.com/v2/prices/${coinbasePair}/spot`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const d = await r.json();
    const price = Number(d?.data?.amount);
    if (!price || price <= 0) throw new Error('bad coinbase rate');
    return price;
  }

  // Try each source; collect errors so a total failure is diagnosable in logs.
  const sources = [['binance', binance], ['coingecko', coingecko], ['coinbase', coinbase]];
  const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled' && settled[i].value > 0) return settled[i].value;
    errors.push(`${sources[i][0]}: ${settled[i].reason?.message || settled[i].reason}`);
  }
  console.error(`[shop-quote] all crypto price sources failed for ${asset}:`, errors.join(' | '));
  return null;
}

async function handleShopQuote(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const checkout = await computeShopCheckout(body, supabase);
    const method = String(body.payment_method || '').slice(0, 40);
    const payerAddress = String(body.payer_address || '').slice(0, 120);
    const paymentRef = String(body.payment_ref || '').slice(0, 200);
    const extra = { payment_method: method };
    if (payerAddress) extra.payer_address = payerAddress;
    if (paymentRef) extra.payment_ref = paymentRef;
    if (method === 'eth' || method === 'tezos') {
      const asset = method === 'tezos' ? 'xtz' : 'eth';
      const price = await fetchServerCryptoPrice(asset);
      if (!price) return json(503, { error: `${asset.toUpperCase()} rate unavailable (price sources unreachable from server)` });
      extra.crypto_asset = asset;
      extra.crypto_usd_price = price;
      extra.crypto_amount = asset === 'eth'
        ? +(checkout.totalUsd / price).toFixed(6)
        : +(checkout.totalUsd / price).toFixed(4);
    } else if (method === 'usdc' || method === 'usdt') {
      extra.crypto_asset = method;
      extra.crypto_amount = +checkout.totalUsd.toFixed(2);
    }
    const quote = makeShopQuote(checkout, extra);
    return json(200, { ok: true, quote, checkout });
  } catch (e) {
    return jsonError(e);
  }
}

// Validate a discount code against the current cart and return the discounted
// totals. Used for live feedback in the checkout before the customer pays.
async function handleShopDiscount(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const checkout = await computeShopCheckout(body, supabase);
    if (!checkout.discountCode) {
      return json(422, { error: 'That discount code is not valid', invalid_code: true });
    }
    return json(200, {
      ok: true,
      discount_code: checkout.discountCode,
      discount_percent: checkout.discountPercent,
      discount_scope: checkout.discountScope,
      discount_ngn: checkout.discountNgn,
      discount_usd: checkout.discountUsd,
      subtotal_ngn: checkout.subtotalNgn,
      subtotal_usd: checkout.subtotalUsd,
      delivery_fee_ngn: checkout.deliveryNgn,
      delivery_fee_usd: checkout.deliveryUsd,
      total_ngn: checkout.totalNgn,
      total_usd: checkout.totalUsd,
      is_free: checkout.isFree,
    });
  } catch (e) {
    return jsonError(e);
  }
}

async function handleShopPaymentInit(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const provider = String(body.provider || '').toLowerCase();
    if (!['paystack','flutterwave'].includes(provider)) {
      return json(400, { error: 'Unsupported payment provider' });
    }
    const checkout = await computeShopCheckout(body, supabase);
    const reference = `${provider === 'paystack' ? 'KW' : 'KW-FW'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const quote = makeShopQuote(checkout, { payment_method: provider, payment_ref: reference });
    const email = String(body.email || '').slice(0, 320);
    const name = String(body.name || '').slice(0, 200);
    const phone = String(body.phone || '').slice(0, 60);
    const callbackUrl = String(body.callback_url || '').slice(0, 500);

    if (provider === 'paystack') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) return json(500, { error: 'Paystack secret key not configured' });
      const r = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          email,
          amount: checkout.totalNgn * 100,
          currency: 'NGN',
          reference,
          callback_url: callbackUrl || undefined,
          metadata: { name, phone, quote },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.status === false) throw new Error(data.message || 'Paystack initialization failed');
      return json(200, { ok: true, provider, reference, quote, checkout, ...data.data });
    }

    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) return json(500, { error: 'Flutterwave secret key not configured' });
    const r = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        tx_ref: reference,
        amount: checkout.totalNgn,
        currency: 'NGN',
        redirect_url: callbackUrl || undefined,
        customer: { email, name, phonenumber: phone },
        customizations: { title: "Kay's Works", description: 'Shop order' },
        meta: { quote },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.status === 'error') throw new Error(data.message || 'Flutterwave initialization failed');
    return json(200, { ok: true, provider, reference, quote, checkout, link: data.data?.link });
  } catch (e) {
    return jsonError(e);
  }
}

// ── ON-CHAIN PAYMENT VERIFICATION ─────────────────────────────────────────────
const ERC20_CONTRACTS = {
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
};
const ERC20_DECIMALS = { usdc: 6, usdt: 6 };
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function normEvmAddress(addr) {
  return String(addr || '').trim().toLowerCase();
}

function evmTopicAddress(topic) {
  const t = String(topic || '').toLowerCase();
  return t.startsWith('0x') && t.length === 66 ? '0x' + t.slice(26) : '';
}

function decimalToUnits(value, decimals) {
  const [whole, frac = ''] = String(value || '0').split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(padded || '0');
}

async function ethRpc(method, params = []) {
  const rpcUrl = process.env.ETH_RPC_URL || process.env.EVM_RPC_URL;
  if (!rpcUrl) {
    const err = new Error('ETH_RPC_URL is required for on-chain crypto verification');
    err.statusCode = 503;
    throw err;
  }
  let r, data;
  try {
    r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    data = await r.json().catch(() => ({}));
  } catch (networkErr) {
    const e = new Error('Transaction is not confirmed yet — RPC temporarily unreachable');
    e.statusCode = 409;
    throw e;
  }
  if (!r.ok || data.error) {
    const e = new Error('Transaction is not confirmed yet — RPC error: ' + (data.error?.message || r.status));
    e.statusCode = 409;
    throw e;
  }
  return data.result;
}

async function getShopPaymentAddresses(supabase) {
  const { data } = await supabase
    .from('shop_config')
    .select('eth_address, tezos_address')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  return {
    eth: process.env.SHOP_ETH_ADDRESS || data?.eth_address || '',
    tezos: process.env.SHOP_TEZOS_ADDRESS || data?.tezos_address || '',
  };
}

async function verifyEvmPayment({ method, txHash, payerAddress, quote, payeeAddress }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('Invalid Ethereum transaction hash');
  const tx = await ethRpc('eth_getTransactionByHash', [txHash]);
  const receipt = await ethRpc('eth_getTransactionReceipt', [txHash]);
  if (!tx || !receipt) {
    const err = new Error('Transaction is not confirmed yet');
    err.statusCode = 409;
    throw err;
  }
  if (String(receipt.status).toLowerCase() !== '0x1') throw new Error('Transaction failed on-chain');
  const latestBlockHex = await ethRpc('eth_blockNumber', []);
  const confirmations = Number(BigInt(latestBlockHex) - BigInt(receipt.blockNumber) + 1n);
  const minConfirmations = Number(process.env.CRYPTO_MIN_CONFIRMATIONS || 1);
  if (confirmations < minConfirmations) {
    const err = new Error(`Waiting for ${minConfirmations} confirmation(s)`);
    err.statusCode = 409;
    throw err;
  }

  const claimedFrom = normEvmAddress(payerAddress);
  const expectedTo = normEvmAddress(payeeAddress);
  if (!expectedTo) throw new Error('Shop ETH address is not configured');

  if (method === 'eth') {
    if (normEvmAddress(tx.from) !== claimedFrom) throw new Error('Transaction sender does not match claimed wallet');
    if (normEvmAddress(tx.to) !== expectedTo) throw new Error('Transaction was not sent to the shop wallet');
    const paidWei = BigInt(tx.value || '0x0');
    const requiredWei = decimalToUnits(quote.crypto_amount, 18);
    if (paidWei < requiredWei) throw new Error('Transaction amount is below the quoted ETH amount');
    return { confirmations, received_amount: Number(paidWei) / 1e18 };
  }

  const contract = normEvmAddress(ERC20_CONTRACTS[method]);
  const decimals = ERC20_DECIMALS[method];
  const required = decimalToUnits(quote.crypto_amount, decimals);
  const matchingLog = (receipt.logs || []).find(log =>
    normEvmAddress(log.address) === contract &&
    String(log.topics?.[0] || '').toLowerCase() === ERC20_TRANSFER_TOPIC &&
    evmTopicAddress(log.topics?.[1]) === claimedFrom &&
    evmTopicAddress(log.topics?.[2]) === expectedTo &&
    BigInt(log.data || '0x0') >= required
  );
  if (!matchingLog) throw new Error(`${method.toUpperCase()} transfer to the shop wallet was not found for the quoted amount`);
  return { confirmations, received_amount: Number(BigInt(matchingLog.data || '0x0')) / (10 ** decimals) };
}

async function verifyTezosPayment({ opHash, payerAddress, quote, payeeAddress }) {
  if (!/^o[1-9A-HJ-NP-Za-km-z]{50}$/.test(opHash)) throw new Error('Invalid Tezos operation hash');
  if (!payeeAddress) throw new Error('Shop Tezos address is not configured');
  const api = (process.env.TZKT_API_URL || 'https://api.tzkt.io').replace(/\/$/, '');
  const accountAddress = account => String(account?.address || account?.alias || account || '').toLowerCase();
  const operationRows = data => {
    const out = [];
    const visit = value => {
      if (!value) return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (typeof value !== 'object') return;
      if (value.hash === opHash || value.type || value.kind || value.status) {
        out.push(value);
      }
      for (const key of ['transactions', 'transaction', 'contents', 'operations']) visit(value[key]);
    };
    visit(data);
    return out.filter(row => !row.hash || String(row.hash) === opHash);
  };
  const transactionRows = rows => rows.filter(row =>
    String(row.type || row.kind || '').toLowerCase() === 'transaction' ||
    row.sender ||
    row.target ||
    row.amount !== undefined
  );
  let list = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(`${api}/v1/operations/${encodeURIComponent(opHash)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (r.status === 404) {
      const e = new Error('Transaction is not confirmed yet');
      e.statusCode = 409;
      throw e;
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      // Indexer error — treat as "not yet confirmed" so the browser keeps retrying
      const e = new Error('Transaction is not confirmed yet — indexer temporarily unavailable');
      e.statusCode = 409;
      throw e;
    }
    list = operationRows(data);
  } catch (err) {
    if (err.statusCode) throw err;
    // Network error or abort (timeout) — the op may simply not be indexed yet
    const e = new Error('Transaction is not confirmed yet — waiting for indexer');
    e.statusCode = 409;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  // If the indexer has not seen the operation yet, return 409 so the browser's
  // retry loop waits and tries again instead of failing a payment in flight.
  if (list.length === 0) {
    const e = new Error(`Transaction is not confirmed yet. TzKT returned no rows for ${opHash}`);
    e.statusCode = 409;
    throw e;
  }

  const requiredMutez = decimalToUnits(quote.crypto_amount, 6);
  const rowSummary = rows => rows.slice(0, 4).map(tx => {
    const sender = accountAddress(tx.sender) || 'unknown-sender';
    const target = accountAddress(tx.target) || 'unknown-target';
    const amount = (Number(tx.amount || 0) / 1e6).toFixed(6);
    return `${String(tx.status || 'unknown')} ${sender} -> ${target} ${amount} XTZ`;
  }).join('; ');
  const statuses = list.map(row => String(row.status || '').toLowerCase()).filter(Boolean);
  const failedStatus = statuses.find(status => ['failed', 'backtracked', 'skipped'].includes(status));
  if (failedStatus) {
    const withErrors = list.find(row => Array.isArray(row.errors) && row.errors.length);
    const reason = withErrors?.errors?.[0]?.with?.string ||
      withErrors?.errors?.[0]?.id?.split('.').pop()?.replace(/_/g, ' ') ||
      `Operation ${failedStatus}`;
    throw new Error(`Tezos operation failed on-chain: ${reason}`);
  }
  const appliedRows = transactionRows(list).filter(tx => String(tx.status || '').toLowerCase() === 'applied');
  if (!appliedRows.length) {
    const e = new Error('Transaction is not confirmed yet');
    e.statusCode = 409;
    throw e;
  }

  const expectedSender = String(payerAddress || '').toLowerCase();
  const expectedTarget = String(payeeAddress || '').toLowerCase();
  const targetRows = appliedRows.filter(tx =>
    accountAddress(tx.target) === expectedTarget
  );
  if (!targetRows.length) {
    const seenTargets = [...new Set(appliedRows.map(tx => accountAddress(tx.target)).filter(Boolean))].slice(0, 6).join(', ') || 'none';
    const seenSenders = [...new Set(appliedRows.map(tx => accountAddress(tx.sender)).filter(Boolean))].slice(0, 6).join(', ') || 'none';
    throw new Error(`Tezos operation hash does not match this shop payment. Expected target ${payeeAddress}; TzKT saw sender(s) ${seenSenders}; target(s) ${seenTargets}. First rows: ${rowSummary(appliedRows)}`);
  }

  const senderRows = targetRows.filter(tx =>
    accountAddress(tx.sender) === expectedSender
  );
  if (!senderRows.length) {
    const actualSenders = [...new Set(targetRows.map(tx => accountAddress(tx.sender)).filter(Boolean))].join(', ') || 'unknown';
    throw new Error(`Sending wallet mismatch. Operation sender(s): ${actualSenders}; confirmation used ${payerAddress}`);
  }

  const match = senderRows.find(tx => BigInt(tx.amount || 0) >= requiredMutez);
  if (!match) {
    const paidMutez = senderRows.reduce((max, tx) => {
      const amount = BigInt(tx.amount || 0);
      return amount > max ? amount : max;
    }, 0n);
    const paidXtz = (Number(paidMutez) / 1e6).toFixed(6);
    const requiredXtz = (Number(requiredMutez) / 1e6).toFixed(6);
    throw new Error(`Tezos amount is below the locked quote. Paid ${paidXtz} XTZ, required ${requiredXtz} XTZ`);
  }
  return { confirmations: match.confirmations || null, received_amount: Number(match.amount || 0) / 1e6 };
}

async function verifyCryptoPaymentOnChain({ paymentMethod, paymentRef, payerAddress, quote, supabase }) {
  const addresses = await getShopPaymentAddresses(supabase);
  if (paymentMethod === 'tezos') {
    return verifyTezosPayment({
      opHash: paymentRef,
      payerAddress,
      quote,
      payeeAddress: addresses.tezos,
    });
  }
  return verifyEvmPayment({
    method: paymentMethod,
    txHash: paymentRef,
    payerAddress,
    quote,
    payeeAddress: addresses.eth,
  });
}

async function verifyCardPayment({ provider, reference, expectedTotalNgn }) {
  if (!reference) {
    const e = new Error('Payment reference is required');
    e.statusCode = 400;
    throw e;
  }

  async function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Payment verification timed out')), ms)),
    ]);
  }

  if (provider === 'paystack') {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) { const e = new Error('Paystack secret key not configured'); e.statusCode = 500; throw e; }
    let data;
    try {
      const r = await withTimeout(fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secret}` } }
      ), 8000);
      data = await r.json().catch(() => ({}));
    } catch (err) {
      const e = new Error(`Could not reach Paystack to verify payment: ${err.message}`);
      e.statusCode = 502; throw e;
    }
    const tx = data && data.data;
    if (!data || data.status !== true || !tx || tx.status !== 'success') {
      const e = new Error('Paystack reports this payment was not completed');
      e.statusCode = 402; throw e;
    }
    const paidNgn = Number(tx.amount || 0) / 100;
    if (String(tx.currency || 'NGN') !== 'NGN' || paidNgn + 0.5 < expectedTotalNgn) {
      const e = new Error('Paystack payment amount does not match the order total');
      e.statusCode = 402; throw e;
    }
    return { provider, reference, paid_ngn: paidNgn, gateway_status: tx.status };
  }

  if (provider === 'flutterwave') {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) { const e = new Error('Flutterwave secret key not configured'); e.statusCode = 500; throw e; }
    let data;
    try {
      const r = await withTimeout(fetch(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secret}` } }
      ), 8000);
      data = await r.json().catch(() => ({}));
    } catch (err) {
      const e = new Error(`Could not reach Flutterwave to verify payment: ${err.message}`);
      e.statusCode = 502; throw e;
    }
    const tx = data && data.data;
    if (!data || data.status !== 'success' || !tx || tx.status !== 'successful') {
      const e = new Error('Flutterwave reports this payment was not completed');
      e.statusCode = 402; throw e;
    }
    const paidNgn = Number(tx.amount || 0);
    if (String(tx.currency || 'NGN') !== 'NGN' || paidNgn + 0.5 < expectedTotalNgn) {
      const e = new Error('Flutterwave payment amount does not match the order total');
      e.statusCode = 402; throw e;
    }
    return { provider, reference, paid_ngn: paidNgn, gateway_status: tx.status };
  }

  const e = new Error('Unsupported card provider for verification');
  e.statusCode = 400;
  throw e;
}

// -- STOCK CLAIM / RELEASE -----------------------------------------------------
function isUuidTextOperatorError(error) {
  return /operator does not exist:\s*uuid\s*=\s*text/i.test(error?.message || '');
}

async function adjustVariantStockDirect(supabase, item, qtyDelta) {
  const vkey = item.variantKey || item.variant;
  const sizeKey = String(vkey || '').split('|').pop(); // "mini|4×4" → "4×4"
  const { data: product, error: loadErr } = await supabase
    .from('shop_products')
    .select('id, name, stock, stock_by_variant')
    .eq('id', item.id)
    .single();
  if (loadErr) {
    const e = new Error(`Stock lookup failed for ${item.name || item.id}: ${loadErr.message}`);
    e.statusCode = 500;
    throw e;
  }
  if (!product) {
    const e = new Error(`Unknown product in order: ${item.id}`);
    e.statusCode = 400;
    throw e;
  }

  const patch = {};
  const stockByVariant = product.stock_by_variant && typeof product.stock_by_variant === 'object'
    ? { ...product.stock_by_variant }
    : null;

  // Resolve the variant's stock entry using the same key fallback as the
  // client: try the full variant key first ("mini|4×4"), then the size-only
  // key ("4×4"). This is the fix for false "sold out" errors caused by the
  // admin storing stock under the size while the cart sends the full key.
  let trackedKey = null;
  if (stockByVariant) {
    if (stockByVariant[vkey] !== undefined)         trackedKey = vkey;
    else if (stockByVariant[sizeKey] !== undefined) trackedKey = sizeKey;
  }

  if (trackedKey !== null) {
    // This variant has an explicit per-variant stock count — it governs.
    const current = Number(stockByVariant[trackedKey]);
    const next = current + qtyDelta;
    if (qtyDelta < 0 && next < 0) return { ok: false };
    stockByVariant[trackedKey] = next;
    patch.stock_by_variant = stockByVariant;
  } else if (product.stock !== null && product.stock !== undefined) {
    // No per-variant tracking — fall back to the product-level stock counter.
    const current = Number(product.stock);
    const next = current + qtyDelta;
    if (qtyDelta < 0 && next < 0) return { ok: false };
    patch.stock = next;
  }
  // If neither is tracked, the product is unlimited (open edition) → ok.

  if (!Object.keys(patch).length) return { ok: true };
  const { error: updErr } = await supabase
    .from('shop_products')
    .update(patch)
    .eq('id', item.id);
  if (updErr) {
    const e = new Error(`Stock update failed for ${item.name || item.id}: ${updErr.message}`);
    e.statusCode = 500;
    throw e;
  }
  return { ok: true };
}

async function claimVariantStock(supabase, item) {
  // Use the direct method exclusively — it resolves the variant key the same
  // way the client does (full key → size-only → unlimited), avoiding the
  // RPC's inconsistent keying that caused false "sold out" errors.
  return adjustVariantStockDirect(supabase, item, -Math.abs(Number(item.qty) || 1));
}

async function releaseVariantStock(supabase, item) {
  const vkey = item.variantKey || item.variant;
  try {
    // Mirror claimVariantStock — use the direct method so release keys match.
    await adjustVariantStockDirect(supabase, item, Math.abs(Number(item.qty) || 1));
  } catch (e) {
    console.error('[shop-order] stock release threw:', item.id, vkey, e.message);
  }
}

function shopEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function shopMoney(ngn, usd) {
  const n = Number(ngn || 0).toLocaleString('en-NG');
  const u = Number(usd || 0).toFixed(2);
  return `NGN ${n} / USD ${u}`;
}

// Shared Resend email sender used by all shop notification functions.
// Returns { id } on success, throws on failure (callers wrap in try/catch).
async function _sendEmail({ from, to, subject, html, text, reply_to }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    throw new Error('Missing RESEND_API_KEY — cannot send email');
  }
  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (text) body.text = text;
  if (reply_to) body.reply_to = reply_to;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.message || data.error || `Resend error ${r.status}`);
  }
  return { id: data.id };
}

async function sendShopSellerNotification({ order, orderRef, checkout, paymentMethod, paymentRef, payerAddress, chainVerification, cardVerification }) {
  const to = process.env.SHOP_ORDER_EMAIL ||
    process.env.FORM_ALERT_TO_EMAIL ||
    process.env.SELLER_EMAIL ||
    process.env.CONTACT_EMAIL ||
    'oyeniyikayode4@gmail.com';
  const from = process.env.SHOP_ORDER_FROM_EMAIL ||
    process.env.FORM_ALERT_FROM_EMAIL ||
    "Kay's Works Orders <orders@mail.kaysworks.com>";
  // Reply-to is the CUSTOMER's email, so replying to the order alert reaches
  // the buyer directly. Falls back to the monitored inbox if no customer email.
  const sellerReplyTo = (order.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email))
    ? order.email
    : to;
  const customerName = order.customer_name || 'Shop customer';
  const delivery = checkout.method === 'pickup'
    ? 'Kaduna pickup (free)'
    : `Ship to: ${order.address || 'No address saved'}; zone: ${checkout.zone}; delivery: NGN ${Number(checkout.deliveryNgn || 0).toLocaleString('en-NG')}`;
  const itemsHtml = checkout.trustedItems.map(item => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${shopEscapeHtml(item.name)}<br><span style="color:#777">${shopEscapeHtml(item.variant)}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${Number(item.qty || 1)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${shopMoney(item.priceNgn * item.qty, item.priceUsd * item.qty)}</td>
    </tr>`).join('');
  const verificationLines = [
    paymentRef ? `Payment ref: ${paymentRef}` : '',
    payerAddress ? `Sender wallet: ${payerAddress}` : '',
    chainVerification?.received_amount ? `Received: ${chainVerification.received_amount} ${String(paymentMethod).toUpperCase()}` : '',
    cardVerification?.gateway_status ? `Gateway status: ${cardVerification.gateway_status}` : '',
  ].filter(Boolean).map(line => `<p style="margin:4px 0;color:#444">${shopEscapeHtml(line)}</p>`).join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4eee3;font-family:Georgia,serif;color:#2d211b">
  <div style="max-width:680px;margin:0 auto;background:#fffaf2;border:1px solid #d9c8b5;padding:24px">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a85d3d">Kay's Works Shop</p>
    <h1 style="margin:0 0 16px;font-size:26px;font-weight:400">Paid shop order</h1>
    <p style="margin:0 0 16px">Order <strong>${shopEscapeHtml(orderRef)}</strong> has been paid and is ready for fulfilment.</p>
    <h2 style="font-size:15px;margin:20px 0 8px">Customer</h2>
    <p style="margin:4px 0">${shopEscapeHtml(customerName)}</p>
    <p style="margin:4px 0">${shopEscapeHtml(order.email || '')}</p>
    <p style="margin:4px 0">${shopEscapeHtml(order.phone || '')}</p>
    <p style="margin:4px 0">${shopEscapeHtml(delivery)}</p>
    <h2 style="font-size:15px;margin:20px 0 8px">Payment</h2>
    <p style="margin:4px 0">${shopEscapeHtml(String(paymentMethod || '').toUpperCase())}</p>
    ${verificationLines}
    <h2 style="font-size:15px;margin:20px 0 8px">Items</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${itemsHtml}
    </table>
            <p style="margin:22px 0 30px;text-align:right"><span style="display:inline-block;border:1px solid #cdbb9f;background:#f5ede0;padding:13px 24px;font-size:16px"><strong>Total: ${shopMoney(checkout.totalNgn, checkout.totalUsd)}</strong></span></p>
  </div>
</body></html>`;

  const text = [
    `Paid shop order: ${orderRef}`,
    `Customer: ${customerName}`,
    `Email: ${order.email || ''}`,
    `Phone: ${order.phone || ''}`,
    `Delivery: ${delivery}`,
    `Payment: ${String(paymentMethod || '').toUpperCase()}`,
    paymentRef ? `Payment ref: ${paymentRef}` : '',
    payerAddress ? `Sender wallet: ${payerAddress}` : '',
    '',
    'Items:',
    ...checkout.trustedItems.map(item => `- ${item.name} (${item.variant}) x ${item.qty}`),
    '',
    `Total: ${shopMoney(checkout.totalNgn, checkout.totalUsd)}`,
  ].filter(line => line !== '').join('\n');

  return _sendEmail({
    from,
    to: [to],
    reply_to: sellerReplyTo,
    subject: `Paid shop order ${orderRef} - ${customerName}`,
    html,
    text,
  });
}

// ── ORDER REFERENCE ───────────────────────────────────────────────────────────
async function sendShopCustomerReceipt({ order, orderRef, checkout, paymentMethod, paymentRef }) {
  const to = String(order.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    const e = new Error('Customer email is missing or invalid');
    e.statusCode = 400;
    throw e;
  }
  const from = process.env.SHOP_ORDER_FROM_EMAIL ||
    process.env.FORM_ALERT_FROM_EMAIL ||
    "Kay's Works Orders <orders@mail.kaysworks.com>";
  // Reply-to is Kay's monitored inbox, so a customer who replies reaches a
  // real person (Resend can't receive mail, so this routes replies away from it).
  const customerReplyTo = process.env.SHOP_REPLY_TO_EMAIL ||
    process.env.SHOP_ORDER_EMAIL ||
    process.env.FORM_ALERT_TO_EMAIL ||
    process.env.CONTACT_EMAIL ||
    'oyeniyikayode4@gmail.com';
  const customerName = order.customer_name || 'there';
  const shopUrl = process.env.SHOP_URL || 'https://www.kaysworks.com/shop';
  const logoUrl = process.env.SHOP_LOGO_URL || 'https://www.kaysworks.com/images/kaysworkslogo.svg';
  const delivery = checkout.method === 'pickup'
    ? 'Kaduna pickup. Kay will contact you with pickup details.'
    : `Ship to: ${order.address || 'the address on your order'}.`;
  const deliveryFeeLabel = Number(checkout.deliveryNgn || 0) > 0
    ? `Delivery fee: NGN ${Number(checkout.deliveryNgn || 0).toLocaleString('en-NG')}`
    : 'Delivery fee: Free';
  const itemsHtml = checkout.trustedItems.map(item => `
    <tr>
      <td colspan="3" style="padding:0 0 10px">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5ede0;border-radius:10px">
          <tr>
            <td style="padding:16px 18px;font-size:15px;color:#2d211b"><strong>${shopEscapeHtml(item.name)}</strong><br><span style="color:#8a7060;font-size:13px">${shopEscapeHtml(item.variant)}</span></td>
            <td width="58" align="center" style="padding:16px 10px;font-size:14px;color:#2d211b">${Number(item.qty || 1)}</td>
            <td width="165" align="right" style="padding:16px 18px;font-size:14px;color:#2d211b">${shopMoney(item.priceNgn * item.qty, item.priceUsd * item.qty)}</td>
          </tr>
        </table>
      </td>
    </tr>`).join('');
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5ede0;font-family:Georgia,serif;color:#2d211b">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5ede0;padding:28px 12px">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ede0c8;border-collapse:separate;border-spacing:0;border-radius:18px;overflow:hidden;box-shadow:0 24px 70px rgba(74,50,40,0.16)">
        <tr>
          <td align="center" style="background:#4a3228;background-image:radial-gradient(circle at 50% 0%,rgba(196,132,90,0.3),transparent 36%),linear-gradient(145deg,#4a3228 0%,#2d1d16 100%);padding:36px 36px 42px;color:#e8d5b0;border-radius:0 0 18px 18px;text-align:center">
            <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#f5ede0">Order confirmation</p>
            <img src="${shopEscapeHtml(logoUrl)}" alt="Kay's Works" width="132" style="display:block;width:132px;max-width:46%;height:auto;margin:0 auto 24px">
            <div style="width:58px;height:58px;background:rgba(245,237,224,0.12);border-radius:50%;text-align:center;line-height:58px;font-family:Arial,sans-serif;font-size:30px;color:#f5ede0;margin:0 auto 22px">&#10003;</div>
            <h1 style="margin:0 0 14px;font-size:34px;font-weight:400;line-height:1.12;color:#f5ede0">Thanks for your purchase</h1>
            <p style="margin:0 auto;line-height:1.7;color:#e8d5b0;font-size:16px;max-width:500px">Hi ${shopEscapeHtml(customerName)}, welcome to the Kay's Works collector circle. Your payment is confirmed, and your order is now being prepared with care.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px;background:#ede0c8">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5ede0;border-radius:12px;margin:0 0 18px">
              <tr>
                <td style="padding:16px 18px">
                  <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#9e4f2e"><strong>Order No:</strong> ${shopEscapeHtml(orderRef)}</p>
                  <p style="margin:0;font-size:13px;color:#5c463a"><strong>Payment:</strong> ${shopEscapeHtml(String(paymentMethod || '').toUpperCase())}${paymentRef ? ` &middot; ${shopEscapeHtml(paymentRef)}` : ''}</p>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <tr>
                <th align="left" style="padding:0 18px 9px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a7060">Item</th>
                <th align="center" style="padding:0 10px 9px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a7060">Qty</th>
                <th align="right" style="padding:0 18px 9px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a7060">Price</th>
              </tr>
              ${itemsHtml}
            </table>
            <p style="margin:12px 0 8px;text-align:right"><span style="display:inline-block;background:#f5ede0;border-radius:10px;padding:11px 18px;font-size:13px;color:#5c463a">${shopEscapeHtml(deliveryFeeLabel)}</span></p>
            <p style="margin:0 0 30px;text-align:right"><span style="display:inline-block;background:#f5ede0;border-radius:10px;padding:14px 24px;font-size:16px"><strong>Total: ${shopMoney(checkout.totalNgn, checkout.totalUsd)}</strong></span></p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" valign="top" style="padding:18px;background:#f5ede0;border-radius:12px">
                  <h2 style="margin:0 0 8px;font-size:16px">Payment method</h2>
                  <p style="margin:0;color:#5c463a;line-height:1.5">${shopEscapeHtml(String(paymentMethod || '').toUpperCase())}<br>${paymentRef ? shopEscapeHtml(paymentRef) : 'Payment confirmed'}</p>
                </td>
                <td width="16"></td>
                <td width="50%" valign="top" style="padding:18px;background:#f5ede0;border-radius:12px">
                  <h2 style="margin:0 0 8px;font-size:16px">Delivery details</h2>
                  <p style="margin:0;color:#5c463a;line-height:1.5">${shopEscapeHtml(delivery)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#4a3228;padding:30px 36px;text-align:center;color:#e8d5b0">
            <h2 style="margin:0 0 16px;font-size:24px;font-weight:400;color:#f5ede0">Come back anytime</h2>
            <a href="${shopEscapeHtml(shopUrl)}" style="display:inline-block;background:linear-gradient(90deg,#c9993a,#f3c85f);color:#2d211b;text-decoration:none;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:14px 30px;border-radius:999px">Continue shopping</a>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 36px;color:#5c463a;line-height:1.6;font-size:14px;background:#ede0c8">
            <p style="margin:0 0 14px">Thank you again for your order. If you have any questions, reply to this email and we will help.</p>
            <p style="margin:0">Warmly,<br>Kay's Works</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = [
    `Hi ${customerName}, your order has been received and your payment is confirmed.`,
    "Thank you for collecting from Kay's Works. Kay will review the details, prepare your pieces with care, and follow up with fulfilment updates.",
    '',
    `Order: ${orderRef}`,
    `Payment: ${String(paymentMethod || '').toUpperCase()}`,
    paymentRef ? `Reference: ${paymentRef}` : '',
    `Delivery: ${delivery}`,
    deliveryFeeLabel,
    '',
    'Items:',
    ...checkout.trustedItems.map(item => `- ${item.name} (${item.variant}) x ${item.qty}`),
    '',
    `Total: ${shopMoney(checkout.totalNgn, checkout.totalUsd)}`,
    `Continue shopping: ${shopUrl}`,
  ].filter(line => line !== '').join('\n');

  return _sendEmail({
    from,
    to: [to],
    reply_to: customerReplyTo,
    subject: `Your Kay's Works order ${orderRef}`,
    html,
    text,
  });
}

function makeOrderRef() {
  return 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Pack the crypto lock (asset, exact amount, usd price, and the full signed
// quote) into a single object stored in the shop_orders.payment_metadata JSONB
// column — no dedicated crypto columns required.
function cryptoOrderLockFromQuote(orderRef, paymentMethod, quote) {
  if (!['eth','tezos','usdc','usdt'].includes(paymentMethod) || !quote || !quote.crypto_amount) return null;
  return {
    kind: 'crypto_order_lock',
    order_hash: orderRef,
    payment_method: paymentMethod,
    crypto_asset: quote.crypto_asset || paymentMethod,
    crypto_amount: quote.crypto_amount,
    crypto_usd_price: quote.crypto_usd_price || null,
    quote_iat: quote.iat || null,
    quote_exp: quote.exp || null,
    total_usd: quote.total_usd || null,
    checkout_quote: quote,
  };
}

function shopOrderMetadata(body, checkout, cryptoLock = null) {
  const note = String(body.order_note || '').trim().slice(0, 800);
  const meta = {
    ...(cryptoLock || {}),
    order_note: note || undefined,
    delivery_carrier: checkout.deliveryCarrier || undefined,
    shipping_billable_kg: checkout.shippingProfile?.billableKg || undefined,
    shipping_pieces: checkout.shippingProfile?.pieces || undefined,
  };
  Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
  return Object.keys(meta).length ? meta : undefined;
}

// Read the crypto lock back from a stored order (payment_metadata, with a
// legacy fallback to admin_note in case an older order stored it there).
function readCryptoOrderLock(order) {
  for (const source of [order.payment_metadata, order.admin_note]) {
    try {
      const note = typeof source === 'string' ? JSON.parse(source) : source;
      if (note && note.kind === 'crypto_order_lock') return note;
    } catch (_) {}
  }
  return null;
}

// -- PENDING-FIRST FLOW --------------------------------------------------------
// Step 1: create a pending order BEFORE payment. Records items, totals, customer,
// and a generated order_ref. No stock touched, no payment verified yet. The
// returned order_ref is the durable handle - payment can be confirmed later even
// if the customer's cart is gone.
async function handleShopOrderCreate(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = req.body || {};
  let checkout;
  try {
    checkout = await computeShopCheckout(body, supabase);
  } catch (e) {
    return jsonError(e);
  }

  const paymentMethod = String(body.payment_method || '').slice(0, 40);
  const quoteRequired = ['paystack','flutterwave','eth','tezos','usdc','usdt'].includes(paymentMethod);
  // Verify the signed quote so a pending order can't be created with tampered totals.
  if (quoteRequired && !verifyShopQuote(body.checkout_quote, checkout, { payment_method: paymentMethod })) {
    return json(400, { error: 'Invalid or expired server checkout quote' });
  }

  const reuseRef = String(body.reuse_order_ref || '').trim().slice(0, 80);
  const cryptoLockReuse = reuseRef ? cryptoOrderLockFromQuote(reuseRef, paymentMethod, body.checkout_quote) : null;

  // If the client passed an existing pending order to reuse (from a price-lock
  // refresh), update it in place instead of inserting a duplicate. This keeps
  // one pending row per checkout session rather than one per lock refresh.
  if (reuseRef) {
    const { data: existing } = await supabase
      .from('shop_orders')
      .select('id, status')
      .eq('order_ref', reuseRef)
      .maybeSingle();
    if (existing && existing.status === 'pending') {
      const { data: updated, error: updErr } = await supabase
        .from('shop_orders')
        .update({
          customer_name:    String(body.name    || '').slice(0, 200),
          email:            String(body.email   || '').slice(0, 320),
          phone:            String(body.phone   || '').slice(0, 60),
          address:          String(body.address || '').slice(0, 500),
          items:            checkout.trustedItems,
          total_ngn:        checkout.totalNgn,
          total_usd:        checkout.totalUsd,
          delivery_fee_ngn: checkout.deliveryNgn,
          delivery_method:  checkout.method.slice(0, 40),
          delivery_zone:    checkout.zone.slice(0, 40),
          payment_method:   paymentMethod,
          payment_metadata: shopOrderMetadata(body, checkout, cryptoLockReuse),
          updated_at:       new Date().toISOString(),
        })
        .eq('order_ref', reuseRef)
        .select('id, order_ref')
        .single();
      if (!updErr && updated) {
        return json(200, {
          ok: true,
          order_ref: updated.order_ref,
          order_id: updated.id,
          total_ngn: checkout.totalNgn,
          total_usd: checkout.totalUsd,
          crypto_amount: cryptoLockReuse?.crypto_amount ?? null,
          crypto_asset: cryptoLockReuse?.crypto_asset ?? null,
        });
      }
    }
  }

  const orderRef = makeOrderRef();
  // For crypto orders, store the exact locked amount + full signed quote in
  // payment_metadata (JSONB) — matches the live schema, no extra columns needed.
  const cryptoLock = cryptoOrderLockFromQuote(orderRef, paymentMethod, body.checkout_quote);
  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
      order_ref:       orderRef,
      customer_name:   String(body.name    || '').slice(0, 200),
      email:           String(body.email   || '').slice(0, 320),
      phone:           String(body.phone   || '').slice(0, 60),
      address:         String(body.address || '').slice(0, 500),
      items:           checkout.trustedItems,
      total_ngn:       checkout.totalNgn,
      total_usd:       checkout.totalUsd,
      delivery_fee_ngn: checkout.deliveryNgn,
      delivery_method:  checkout.method.slice(0, 40),
      delivery_zone:    checkout.zone.slice(0, 40),
      payment_method:  paymentMethod,
      payment_metadata: shopOrderMetadata(body, checkout, cryptoLock),
      status: 'pending',
    })
    .select('id, order_ref')
    .single();
  if (orderError) return json(500, { error: orderError.message });

  return json(200, {
    ok: true,
    order_ref: order.order_ref,
    order_id: order.id,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    crypto_amount: cryptoLock?.crypto_amount ?? null,
    crypto_asset: cryptoLock?.crypto_asset ?? null,
  });
}

// Step 2: confirm payment for an existing pending order. Looks the order up by
// order_ref (not the cart, so this works even if the browser cart is gone),
// re-derives a checkout from the SAVED items, verifies the payment on-chain or
// via the card gateway, decrements stock, and flips the order to 'paid'.
async function handleShopOrderConfirm(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = req.body || {};
  const orderRef = String(body.order_ref || '').trim().slice(0, 80);
  if (!orderRef) return json(400, { error: 'order_ref is required' });

  // Load the pending order. This is the source of truth for what was bought.
  const { data: order, error: loadErr } = await supabase
    .from('shop_orders')
    .select('*')
    .eq('order_ref', orderRef)
    .maybeSingle();
  if (loadErr && loadErr.code !== 'PGRST116') return json(500, { error: loadErr.message });
  if (!order) return json(404, { error: 'Order not found for that reference' });
  const paymentMethod = String(body.payment_method || order.payment_method || '').slice(0, 40);
  const paymentRef = String(body.payment_ref || order.payment_ref || '').trim().slice(0, 200);
  const storedLock = readCryptoOrderLock(order);
  const payerAddress = String(body.payer_address || storedLock?.payer_address || order.payment_metadata?.payer_address || '').trim().slice(0, 120);
  if (order.status === 'paid') {
    const paidCheckout = {
      trustedItems: Array.isArray(order.items) ? order.items : [],
      totalNgn: Number(order.total_ngn) || 0,
      totalUsd: Number(order.total_usd) || 0,
      deliveryNgn: Number(order.delivery_fee_ngn) || 0,
      method: order.delivery_method || 'pickup',
      zone: order.delivery_zone || 'pickup',
    };
    let sellerNotification = { sent: false };
    try {
      const emailResult = await sendShopSellerNotification({
        order,
        orderRef,
        checkout: paidCheckout,
        paymentMethod,
        paymentRef,
        payerAddress,
        chainVerification: order.payment_metadata || null,
        cardVerification: null,
      });
      sellerNotification = { sent: true, id: emailResult?.id || null };
    } catch (notifyErr) {
      sellerNotification = { sent: false, error: notifyErr.message || String(notifyErr) };
      console.error('[shop-order] seller notification failed:', orderRef, sellerNotification.error);
    }
    let customerNotification = { sent: false };
    try {
      const emailResult = await sendShopCustomerReceipt({
        order,
        orderRef,
        checkout: paidCheckout,
        paymentMethod,
        paymentRef,
      });
      customerNotification = { sent: true, id: emailResult?.id || null };
    } catch (notifyErr) {
      customerNotification = { sent: false, error: notifyErr.message || String(notifyErr) };
      console.error('[shop-order] customer receipt failed:', orderRef, customerNotification.error);
    }
    return json(200, {
      ok: true,
      already_paid: true,
      order_id: order.id,
      order_ref: orderRef,
      seller_notification: sellerNotification,
      customer_notification: customerNotification,
    });
  }

  const isCryptoPayment = ['eth','tezos','usdc','usdt'].includes(paymentMethod);
  const isCardPayment = ['paystack','flutterwave'].includes(paymentMethod);

  if ((isCryptoPayment || isCardPayment) && !paymentRef) {
    return json(400, { error: 'Payment reference / transaction hash is required' });
  }

  // Guard against the same payment_ref being used for a different order.
  if (paymentRef) {
    const { data: dupe } = await supabase
      .from('shop_orders')
      .select('id, order_ref, status')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (dupe && dupe.order_ref !== orderRef) {
      return json(409, { error: 'This payment has already been recorded for another order' });
    }
  }

  // Reconstruct the trusted checkout from the SAVED order items so verification
  // uses authoritative server data, not anything the client re-sends now.
  const savedItems = Array.isArray(order.items) ? order.items : [];
  const checkout = {
    trustedItems: savedItems,
    totalNgn: Number(order.total_ngn) || 0,
    totalUsd: Number(order.total_usd) || 0,
    deliveryNgn: Number(order.delivery_fee_ngn) || 0,
    method: order.delivery_method || 'pickup',
    zone: order.delivery_zone || 'pickup',
  };

  // Verify payment BEFORE touching stock.
  let chainVerification = null, cardVerification = null;
  if (isCryptoPayment) {
    if (!payerAddress) return json(400, { error: 'Sending wallet address is required' });
    // Optional order-hash cross-check (the customer may supply it on manual confirm).
    const bodyOrderHash = String(body.order_hash || body.order_ref || '').trim().slice(0, 80);
    if (bodyOrderHash && bodyOrderHash !== orderRef) {
      return json(400, { error: 'Order hash does not match this order' });
    }
    // Read the locked crypto details from payment_metadata — the authoritative
    // amount + signed quote captured when the pending order was created.
    const cryptoLock = readCryptoOrderLock(order);
    if (!cryptoLock || !cryptoLock.checkout_quote || !cryptoLock.checkout_quote.crypto_amount) {
      return json(400, { error: 'Locked crypto amount is missing for this order' });
    }
    if (cryptoLock.payment_method && cryptoLock.payment_method !== paymentMethod) {
      return json(400, { error: 'Payment method does not match the locked order' });
    }
    try {
      chainVerification = await verifyCryptoPaymentOnChain({
        paymentMethod,
        paymentRef,
        payerAddress,
        quote: cryptoLock.checkout_quote,
        supabase,
      });
      chainVerification = {
        ...chainVerification,
        locked_crypto_amount: cryptoLock.crypto_amount,
        locked_crypto_asset: cryptoLock.crypto_asset,
        locked_usd_price: cryptoLock.crypto_usd_price,
        order_hash: orderRef,
      };
    } catch (e) {
      return jsonError(e);
    }
  } else if (isCardPayment) {
    try {
      cardVerification = await verifyCardPayment({
        provider: paymentMethod,
        reference: paymentRef,
        expectedTotalNgn: checkout.totalNgn,
      });
    } catch (e) {
      return jsonError(e);
    }
  }

  // Decrement stock now that payment is confirmed.
  const claimed = [];
  for (const item of checkout.trustedItems) {
    let result;
    try {
      result = await claimVariantStock(supabase, item);
    } catch (e) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return jsonError(e);
    }
    if (!result.ok) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return json(409, {
        error: `Sold out: ${item.name} · ${item.variant} is no longer available`,
        product_id: item.id,
        variant: item.variant,
        sold_out: true,
      });
    }
    claimed.push(item);
  }

  // Flip the order to paid. For crypto, fold the payment details back into the
  // payment_metadata lock (no dedicated payer_address/crypto_received columns).
  const { error: updErr } = await supabase
    .from('shop_orders')
    .update({
      status: 'paid',
      payment_method: paymentMethod,
      payment_ref: paymentRef,
      payment_metadata: isCryptoPayment ? {
        ...(readCryptoOrderLock(order) || {}),
        payer_address: payerAddress,
        payment_ref: paymentRef,
        received_amount: chainVerification?.received_amount,
        confirmations: chainVerification?.confirmations,
        paid_at: new Date().toISOString(),
      } : order.payment_metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('order_ref', orderRef);
  if (updErr) {
    for (const c of claimed) await releaseVariantStock(supabase, c);
    return json(500, { error: updErr.message });
  }

  let sellerNotification = { sent: false };
  try {
    const emailResult = await sendShopSellerNotification({
      order,
      orderRef,
      checkout,
      paymentMethod,
      paymentRef,
      payerAddress,
      chainVerification,
      cardVerification,
    });
    sellerNotification = { sent: true, id: emailResult?.id || null };
  } catch (notifyErr) {
    sellerNotification = { sent: false, error: notifyErr.message || String(notifyErr) };
    console.error('[shop-order] seller notification failed:', orderRef, sellerNotification.error);
  }
  let customerNotification = { sent: false };
  try {
    const emailResult = await sendShopCustomerReceipt({
      order,
      orderRef,
      checkout,
      paymentMethod,
      paymentRef,
    });
    customerNotification = { sent: true, id: emailResult?.id || null };
  } catch (notifyErr) {
    customerNotification = { sent: false, error: notifyErr.message || String(notifyErr) };
    console.error('[shop-order] customer receipt failed:', orderRef, customerNotification.error);
  }

  return json(200, {
    ok: true,
    order_id: order.id,
    order_ref: orderRef,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    chain_verification: chainVerification,
    card_verification: cardVerification,
    seller_notification: sellerNotification,
    customer_notification: customerNotification,
  });
}

// ── ORDER (legacy single-shot — kept for backward compatibility) ──────────────
// Record a zero-total order (100%-off discount) as paid without any gateway.
async function finalizeFreeOrder(req, res, supabase, body, checkout) {
  const claimed = [];
  for (const item of checkout.trustedItems) {
    let result;
    try {
      result = await claimVariantStock(supabase, item);
    } catch (e) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return jsonError(e);
    }
    if (!result.ok) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return json(409, {
        error: `Sold out: ${item.name} · ${item.variant} is no longer available`,
        product_id: item.id, variant: item.variant, sold_out: true,
      });
    }
    claimed.push(item);
  }

  const freeRef = makeOrderRef();
  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
      order_ref:        freeRef,
      customer_name:    String(body.name    || '').slice(0, 200),
      email:            String(body.email   || '').slice(0, 320),
      phone:            String(body.phone   || '').slice(0, 60),
      address:          String(body.address || '').slice(0, 500),
      items:            checkout.trustedItems,
      total_ngn:        checkout.totalNgn,
      total_usd:        checkout.totalUsd,
      delivery_fee_ngn: checkout.deliveryNgn,
      delivery_method:  checkout.method.slice(0, 40),
      delivery_zone:    checkout.zone.slice(0, 40),
      payment_method:   checkout.discountPercent >= 100 ? 'discount-100' : 'discount',
      payment_ref:      `DISCOUNT-${checkout.discountCode}`,
      payment_metadata: {
        discount_code: checkout.discountCode,
        discount_percent: checkout.discountPercent,
        discount_scope: checkout.discountScope,
        discount_ngn: checkout.discountNgn,
        discount_usd: checkout.discountUsd,
        free_order: true,
        paid_at: new Date().toISOString(),
      },
      status: 'paid',
    })
    .select('id, order_ref')
    .single();
  if (orderError) {
    for (const c of claimed) await releaseVariantStock(supabase, c);
    return json(500, { error: orderError.message });
  }

  const emailOrder = {
    id: order.id, order_ref: order.order_ref,
    customer_name: String(body.name || ''), email: String(body.email || ''),
    phone: String(body.phone || ''), address: String(body.address || ''),
    items: checkout.trustedItems, total_ngn: checkout.totalNgn, total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn, delivery_method: checkout.method, delivery_zone: checkout.zone,
    payment_method: 'discount', payment_ref: `DISCOUNT-${checkout.discountCode}`,
  };
  let sellerNotification = { sent: false }, customerNotification = { sent: false };
  try {
    const r = await sendShopSellerNotification({
      order: emailOrder, orderRef: order.order_ref, checkout,
      paymentMethod: `Discount ${checkout.discountPercent}% (${checkout.discountCode})`,
      paymentRef: `DISCOUNT-${checkout.discountCode}`, payerAddress: '',
      chainVerification: null, cardVerification: null,
    });
    sellerNotification = { sent: true, id: r?.id || null };
  } catch (e) { sellerNotification = { sent: false, error: e.message }; }
  try {
    const r = await sendShopCustomerReceipt({
      order: emailOrder, orderRef: order.order_ref, checkout,
      paymentMethod: 'discount', paymentRef: `DISCOUNT-${checkout.discountCode}`,
    });
    customerNotification = { sent: true, id: r?.id || null };
  } catch (e) { customerNotification = { sent: false, error: e.message }; }

  return json(200, {
    ok: true,
    free_order: true,
    order_id: order.id,
    order_ref: order.order_ref,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    discount_code: checkout.discountCode,
    discount_percent: checkout.discountPercent,
    seller_notification: sellerNotification,
    customer_notification: customerNotification,
  });
}

async function handleShopOrder(req, res, supabase) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = req.body || {};
  let checkout;
  try {
    checkout = await computeShopCheckout(body, supabase);
  } catch (e) {
    return jsonError(e);
  }

  const paymentMethod = String(body.payment_method || '').slice(0, 40);
  const paymentRef = String(body.payment_ref || '').slice(0, 200);
  const payerAddress = String(body.payer_address || '').slice(0, 120);

  // ── Free order (100%-off discount) ───────────────────────────────────────
  // When a discount zeroes the total, there is nothing to charge. Skip all
  // gateway/chain verification and record the order as paid directly. The
  // discount is baked into the signed quote, so it can't be forged.
  if (checkout.isFree) {
    if (!verifyShopQuote(body.checkout_quote, checkout, {})) {
      return json(400, { error: 'Invalid or expired server checkout quote' });
    }
    return finalizeFreeOrder(req, res, supabase, body, checkout);
  }

  const quoteRequired = ['paystack','flutterwave','eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (quoteRequired && !verifyShopQuote(body.checkout_quote, checkout, {
    payment_method: paymentMethod,
    ...(paymentMethod === 'paystack' || paymentMethod === 'flutterwave' ? { payment_ref: paymentRef } : {}),
    ...(payerAddress ? { payer_address: payerAddress } : {}),
  })) {
    return json(400, { error: 'Invalid or expired server checkout quote' });
  }
  const isCryptoPayment = ['eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (isCryptoPayment) {
    if (!paymentRef) return json(400, { error: 'Crypto transaction hash is required' });
    if (!payerAddress) return json(400, { error: 'Sending wallet address is required' });
    const { data: existingOrder, error: existingError } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (existingError && existingError.code !== 'PGRST116') return json(500, { error: existingError.message });
    if (existingOrder) return json(409, { error: 'This crypto transaction has already been submitted for an order' });
  }
  let chainVerification = null;
  if (isCryptoPayment) {
    try {
      chainVerification = await verifyCryptoPaymentOnChain({
        paymentMethod,
        paymentRef,
        payerAddress,
        quote: body.checkout_quote,
        supabase,
      });
    } catch (e) {
      return jsonError(e);
    }
  }

  const isCardPayment = ['paystack', 'flutterwave'].includes(paymentMethod);
  let cardVerification = null;
  if (isCardPayment) {
    try {
      cardVerification = await verifyCardPayment({
        provider: paymentMethod,
        reference: paymentRef,
        expectedTotalNgn: checkout.totalNgn,
      });
    } catch (e) {
      return jsonError(e);
    }
    const { data: dupe, error: dupeErr } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (dupeErr && dupeErr.code !== 'PGRST116') return json(500, { error: dupeErr.message });
    if (dupe) return json(409, { error: 'This payment has already been recorded for an order' });
  }

  const paymentConfirmed = isCryptoPayment || isCardPayment;

  const claimed = [];
  for (const item of checkout.trustedItems) {
    let result;
    try {
      result = await claimVariantStock(supabase, item);
    } catch (e) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return jsonError(e);
    }
    if (!result.ok) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return json(409, {
        error: `Sold out: ${item.name} · ${item.variant} is no longer available`,
        product_id: item.id,
        variant: item.variant,
        sold_out: true,
      });
    }
    claimed.push(item);
  }

  const newOrderRef = makeOrderRef();
  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
      order_ref:       newOrderRef,
      customer_name:   String(body.name    || '').slice(0, 200),
      email:           String(body.email   || '').slice(0, 320),
      phone:           String(body.phone   || '').slice(0, 60),
      address:         String(body.address || '').slice(0, 500),
      items:           checkout.trustedItems,
      total_ngn:       checkout.totalNgn,
      total_usd:       checkout.totalUsd,
      delivery_fee_ngn: checkout.deliveryNgn,
      delivery_method:  checkout.method.slice(0, 40),
      delivery_zone:    checkout.zone.slice(0, 40),
      payment_method:  paymentMethod,
      payment_ref:     paymentRef,
      payment_metadata: shopOrderMetadata(body, checkout),
      status: paymentConfirmed ? 'paid' : 'pending',
    })
    .select('id, order_ref')
    .single();
  if (orderError) {
    for (const c of claimed) await releaseVariantStock(supabase, c);
    return json(500, { error: orderError.message });
  }

  // Resolve the order reference for the emails (order_ref column, falling back
  // to the payment ref or row id).
  const { data: savedOrder } = await supabase
    .from('shop_orders')
    .select('*')
    .eq('id', order.id)
    .maybeSingle();
  const emailOrder = savedOrder || {
    id: order.id,
    customer_name: String(body.name || ''),
    email: String(body.email || ''),
    phone: String(body.phone || ''),
    address: String(body.address || ''),
    items: checkout.trustedItems,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    delivery_method: checkout.method,
    delivery_zone: checkout.zone,
    payment_method: paymentMethod,
    payment_ref: paymentRef,
  };
  const emailRef = emailOrder.order_ref || paymentRef || String(order.id);

  // Fire seller + customer emails (only for confirmed payments).
  let sellerNotification = { sent: false };
  let customerNotification = { sent: false };
  if (paymentConfirmed) {
    try {
      const r = await sendShopSellerNotification({
        order: emailOrder, orderRef: emailRef, checkout,
        paymentMethod, paymentRef, payerAddress,
        chainVerification, cardVerification,
      });
      sellerNotification = { sent: true, id: r?.id || null };
    } catch (e) {
      sellerNotification = { sent: false, error: e.message || String(e) };
      console.error('[shop-order] seller notification failed:', emailRef, sellerNotification.error);
    }
    try {
      const r = await sendShopCustomerReceipt({
        order: emailOrder, orderRef: emailRef, checkout,
        paymentMethod, paymentRef,
      });
      customerNotification = { sent: true, id: r?.id || null };
    } catch (e) {
      customerNotification = { sent: false, error: e.message || String(e) };
      console.error('[shop-order] customer receipt failed:', emailRef, customerNotification.error);
    }
  }

  return json(200, {
    ok: true,
    order_id: order.id,
    order_ref: emailRef,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    chain_verification: chainVerification,
    card_verification: cardVerification,
    seller_notification: sellerNotification,
    customer_notification: customerNotification,
  });
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
async function handleShopConfig(req, res, supabase) {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('shop_config')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') return json(500, { error: error.message });
  // Never expose discount codes to the public storefront — they're validated
  // server-side only. Strip them from the public config response.
  const safe = { ...(data || {}) };
  delete safe.discount_codes;
  return json(200, safe);
}

// ── Netlify entry point ───────────────────────────────────────────────────────

// ── Vercel entry point ────────────────────────────────────────────────────────

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  try {
    cors(res);
    if (handleOptions(req, res)) return;

    // Derive action from query string or URL path
    const urlPath = req.url || '';
    let action = req.query.action || '';

    if (!action) {
      // Map legacy direct paths -> actions
      if (urlPath.includes('/challenges'))     action = 'challenges';
      else if (urlPath.includes('/challenge')) action = 'challenge';
      else if (urlPath.includes('/score'))     action = 'score';
      else if (urlPath.includes('/leaderboard')) {
        action = 'leaderboard';
        // Extract challenge id from path e.g. /api/leaderboard/abc-123
        if (!req.query.id) {
          const m = urlPath.match(/\/leaderboard\/([^/?]+)/);
          if (m) req.query.id = m[1];
        }
      }
      else if (urlPath.includes('/hall-of-fame'))   action = 'hall-of-fame';
      else if (urlPath.includes('/crosschain-claim')) action = 'crosschain-claim';
      else if (urlPath.includes('/notify-outbid'))      action = 'notify-outbid';
      else if (urlPath.includes('/notify-bid-confirm')) action = 'notify-bid-confirm';
      else if (urlPath.includes('/notify-winner'))      action = 'notify-winner';
      else if (urlPath.includes('/notify-bid'))          action = 'notify-bid';
      else if (urlPath.includes('/shop-products') || urlPath.includes('/shop/products')) action = 'shop-products';
      else if (urlPath.includes('/shop-config') || urlPath.includes('/shop/config')) action = 'shop-config';
      else if (urlPath.includes('/shop-payment-init') || urlPath.includes('/shop/payment-init')) action = 'shop-payment-init';
      else if (urlPath.includes('/shop-quote') || urlPath.includes('/shop/quote')) action = 'shop-quote';
      else if (urlPath.includes('/shop-discount') || urlPath.includes('/shop/discount')) action = 'shop-discount';
      else if (urlPath.includes('/shop-order-create') || urlPath.includes('/shop/order-create')) action = 'shop-order-create';
      else if (urlPath.includes('/shop-order-confirm') || urlPath.includes('/shop/order-confirm')) action = 'shop-order-confirm';
      else if (urlPath.includes('/shop-order') || urlPath.includes('/shop/order')) action = 'shop-order';
    }

    const supabase = getSupabase();
    _shopRes = res; // shop handlers use res-based json() helper

    switch (action) {
      case 'challenges':    return handleChallenges(req, res, supabase);
      case 'upcoming':      return handleUpcoming(req, res, supabase);
      case 'challenge':     return handleChallenge(req, res, supabase);
      case 'score':         return handleScore(req, res, supabase);
      case 'leaderboard':   return handleLeaderboard(req, res, supabase);
      case 'hall-of-fame':  return handleHallOfFame(req, res, supabase);
      case 'crosschain-claim': return handleCrosschainClaim(req, res, supabase);
      case 'notify-outbid':      return handleNotifyOutbid(req, res);
      case 'notify-bid-confirm': return handleNotifyBidConfirm(req, res);
      case 'notify-winner':      return handleNotifyWinner(req, res);
      case 'notify-bid':         return handleNotifyBid(req, res);
      case 'shop-products':      return handleShopProducts(req, res, supabase);
      case 'shop-config':        return handleShopConfig(req, res, supabase);
      case 'shop-quote':         return handleShopQuote(req, res, supabase);
      case 'shop-discount':      return handleShopDiscount(req, res, supabase);
      case 'shop-payment-init':  return handleShopPaymentInit(req, res, supabase);
      case 'shop-order-create':  return handleShopOrderCreate(req, res, supabase);
      case 'shop-order-confirm': return handleShopOrderConfirm(req, res, supabase);
      case 'shop-order':         return handleShopOrder(req, res, supabase);
      default:
        return res.status(404).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error('[api/game] unhandled error:', e);
    if (!res.headersSent) {
      return res.status(e.statusCode || 500).json({
        error: e.message || 'Unhandled server error',
        stack: process.env.NODE_ENV === 'production' ? undefined : e.stack,
      });
    }
  }
};
