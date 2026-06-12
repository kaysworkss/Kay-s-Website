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
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
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
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
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
    const data = await _sendEmail({ from: '\u00c0p\u00f3t\u00ed \u1ecdl\u1d52w\u1eb9\u0300 Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
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
    to:      ['oyeniyikayode4@gmail.com'],
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
      .or('active.is.null,active.eq.true')
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
      .or('active.is.null,active.eq.true')
      .order('sort_order', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, data || []);
  }

  const { data, error } = await supabase
    .from('shop_products')
    .select('*')
    .or('active.is.null,active.eq.true')
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

// ── CHECKOUT COMPUTATION (server-authoritative) ───────────────────────────────
// Server-authoritative delivery rates — MUST mirror DELIVERY_RATES in shop.html.
const SERVER_DELIVERY_RATES = {
  'pickup':   { small: { ngn: 0,    usd: 0  }, large: { ngn: 0,    usd: 0  } },
  'NG-other': { small: { ngn: 4500, usd: 0  }, large: { ngn: 6500, usd: 0  } },
  'WA':       { small: { ngn: 0,    usd: 22 }, large: { ngn: 0,    usd: 30 } },
  'EU':       { small: { ngn: 0,    usd: 35 }, large: { ngn: 0,    usd: 48 } },
  'NA':       { small: { ngn: 0,    usd: 42 }, large: { ngn: 0,    usd: 58 } },
  'AO':       { small: { ngn: 0,    usd: 50 }, large: { ngn: 0,    usd: 68 } },
  'ROW':      { small: { ngn: 0,    usd: 48 }, large: { ngn: 0,    usd: 62 } },
};
const SERVER_LARGE_PRINT_VARIANTS = ['12×16"', '12×18"', '18×24"', '24×36"'];
const NGN_PER_USD = 1600;

function serverVariantPrice(product, variantKey, variant, currency) {
  const prices = currency === 'usd' ? (product.prices_usd || {}) : (product.prices_ngn || {});
  if (variantKey && prices[variantKey] !== undefined) return Number(prices[variantKey]) || 0;
  if (variant && prices[variant] !== undefined) return Number(prices[variant]) || 0;
  const size = String(variantKey || variant || '').split('|').pop();
  if (size && prices[size] !== undefined) return Number(prices[size]) || 0;
  return 0;
}

function serverDeliveryFee(zone, hasLarge, currency) {
  const z = SERVER_DELIVERY_RATES[zone] || SERVER_DELIVERY_RATES['ROW'];
  const tier = hasLarge ? z.large : z.small;
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
    const product = productCache[item.id];
    if (!product) continue;

    const stockByVariant = product.stock_by_variant || {};
    const sv = stockByVariant[vkey] !== undefined ? stockByVariant[vkey] : stockByVariant[item.variant];
    if (sv !== undefined && sv < item.qty) {
      const err = new Error(`Only ${sv} left in stock for ${product.name} · ${item.variant}`);
      err.statusCode = 409;
      err.product_id = item.id;
      err.variant = item.variant;
      throw err;
    }
    if (sv === undefined && product.stock !== null && product.stock !== undefined && product.stock < item.qty) {
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
        (product.is_large_print === true || SERVER_LARGE_PRINT_VARIANTS.includes(item.variant))) {
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
  const deliveryNgn = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'ngn') : 0;
  const deliveryUsd = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'usd') : 0;
  const totalNgn = subtotalNgn + deliveryNgn;
  const totalUsd = +(subtotalUsd + deliveryUsd).toFixed(2);

  return {
    productCache,
    trustedItems,
    hasLarge,
    zone,
    method,
    subtotalNgn,
    subtotalUsd: +subtotalUsd.toFixed(2),
    deliveryNgn,
    deliveryUsd,
    totalNgn,
    totalUsd,
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
    subtotal_ngn: checkout.subtotalNgn,
    subtotal_usd: checkout.subtotalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    delivery_fee_usd: checkout.deliveryUsd,
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
  if (String(payload.delivery_method) !== checkout.method) return false;
  if (String(payload.delivery_zone) !== checkout.zone) return false;
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
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error?.message || `Ethereum RPC ${method} failed`);
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
  const timer = setTimeout(() => controller.abort(), 4500);
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
      const e = new Error(`Could not reach TzKT operation lookup: HTTP ${r.status}`);
      e.statusCode = 502;
      throw e;
    }
    list = operationRows(data);
  } catch (err) {
    if (err.statusCode) throw err;
    const e = new Error(`Could not reach TzKT operation lookup: ${err.message || err}`);
    e.statusCode = 502;
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
  const variantCandidates = stockVariantKeyCandidates(item, stockByVariant);
  const stockKey = stockByVariant
    ? variantCandidates.find(key => stockByVariant[key] !== undefined)
    : null;
  if (stockByVariant && stockKey !== null && stockKey !== undefined) {
    const current = Number(stockByVariant[stockKey]);
    const next = current + qtyDelta;
    if (qtyDelta < 0 && next < 0) return { ok: false };
    stockByVariant[stockKey] = next;
    patch.stock_by_variant = stockByVariant;
  }

  if (product.stock !== null && product.stock !== undefined) {
    const current = Number(product.stock);
    const next = current + qtyDelta;
    if (qtyDelta < 0 && next < 0) return { ok: false };
    patch.stock = next;
  }

  if (!Object.keys(patch).length) return { ok: true, stockKey: stockKey || null };
  const { error: updErr } = await supabase
    .from('shop_products')
    .update(patch)
    .eq('id', item.id);
  if (updErr) {
    const e = new Error(`Stock update failed for ${item.name || item.id}: ${updErr.message}`);
    e.statusCode = 500;
    throw e;
  }
  return { ok: true, stockKey: stockKey || null };
}

function stockKeyFingerprint(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[??"]/g, '')
    .replace(/\s+/g, '')
    .replace(/[?*]/g, 'x');
}

function stockVariantKeyCandidates(item, stockByVariant = null) {
  const raw = [item._claimedStockKey, item.variantKey, item.variant].filter(Boolean).map(String);
  for (const value of [...raw]) {
    if (value.includes('|')) raw.push(value.split('|').pop());
  }
  const seen = new Set();
  const candidates = raw.filter(value => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (stockByVariant && typeof stockByVariant === 'object') {
    const fingerprints = new Set(candidates.map(stockKeyFingerprint));
    for (const key of Object.keys(stockByVariant)) {
      if (fingerprints.has(stockKeyFingerprint(key))) candidates.push(key);
    }
  }
  return candidates;
}

async function claimVariantStock(supabase, item) {
  const qty = Math.abs(Number(item.qty) || 1);
  const candidates = stockVariantKeyCandidates(item);
  let lastError = null;
  for (const vkey of candidates) {
    const { data, error } = await supabase.rpc('decrement_variant_stock', {
      p_id: item.id,
      p_variant_key: vkey,
      p_qty: qty,
    });
    if (error) {
      if (isUuidTextOperatorError(error)) {
        return adjustVariantStockDirect(supabase, item, -qty);
      }
      lastError = error;
      break;
    }
    if (data === true) return { ok: true, stockKey: vkey };
  }
  if (lastError) {
    const e = new Error(`Stock claim failed for ${item.name || item.id}: ${lastError.message}`);
    e.statusCode = 500;
    throw e;
  }
  return adjustVariantStockDirect(supabase, item, -qty);
}

async function releaseVariantStock(supabase, item) {
  const qty = Math.abs(Number(item.qty) || 1);
  const candidates = stockVariantKeyCandidates(item);
  try {
    for (const vkey of candidates) {
      const { data, error } = await supabase.rpc('decrement_variant_stock', {
        p_id: item.id,
        p_variant_key: vkey,
        p_qty: -qty,
      });
      if (error) {
        if (isUuidTextOperatorError(error)) {
          await adjustVariantStockDirect(supabase, item, qty);
          return;
        }
        console.error('[shop-order] stock release failed:', item.id, vkey, error.message);
        return;
      }
      if (data === true) return;
    }
    await adjustVariantStockDirect(supabase, item, qty);
  } catch (e) {
    console.error('[shop-order] stock release threw:', item.id, item._claimedStockKey || item.variantKey || item.variant, e.message);
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

async function sendShopSellerNotification({ order, orderRef, checkout, paymentMethod, paymentRef, payerAddress, chainVerification, cardVerification }) {
  const to = process.env.SHOP_ORDER_EMAIL ||
    process.env.FORM_ALERT_TO_EMAIL ||
    process.env.SELLER_EMAIL ||
    process.env.CONTACT_EMAIL ||
    'oyeniyikayode4@gmail.com';
  const from = process.env.SHOP_ORDER_FROM_EMAIL ||
    process.env.FORM_ALERT_FROM_EMAIL ||
    "Kay's Works Queue <auction@mail.kaysworks.com>";
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
    "Kay's Works Queue <auction@mail.kaysworks.com>";
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
