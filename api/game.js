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

// ── POST /api/game?action=notify-outbid ──────────────────────────────────────
// Sends outbid email via Resend. Looks up email from collector_notifications
// table in Supabase using the outbid wallet address + auction_id.
async function handleNotifyOutbid(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { outbid_wallet, new_bidder, new_amount, auction_id, art_title, auction_url } = req.body || {};

  if (!outbid_wallet || !new_amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://haijshusgcbdexfueunr.supabase.co';
  const SUPABASE_ANON = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY    = process.env.RESEND_API_KEY;

  if (!RESEND_KEY || !SUPABASE_ANON) {
    return res.status(500).json({ error: 'Server misconfigured — missing env vars' });
  }

  // 1. Look up the outbid wallet's email from Supabase
  let email = null;
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/collector_notifications?wallet_address=eq.${encodeURIComponent(outbid_wallet)}&auction_id=eq.${encodeURIComponent(auction_id)}&limit=1&select=email`,
      { headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON } }
    );
    const rows = await sbRes.json();
    if (Array.isArray(rows) && rows.length > 0) email = rows[0].email;
  } catch (e) {
    return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message });
  }

  if (!email) {
    return res.status(200).json({ sent: false, reason: 'No email registered' });
  }

  // 2. Format display values
  const shortOutbid = outbid_wallet.slice(0, 6) + '…' + outbid_wallet.slice(-4);
  const shortBidder = (new_bidder || '').slice(0, 6) + '…' + (new_bidder || '').slice(-4);
  const title       = art_title || 'an Àpótí Ọlọ́wọ̀ piece';
  const url         = auction_url || 'https://kaysworks.com/auction';

  // 3. Send email via Resend
  const emailBody = {
    from:    'Àpótí Ọlọ́wọ̀ Auction <auction@mail.kaysworks.com>',
    to:      [email],
    subject: `Ohhh — ${shortBidder} just swept in and took your crown`,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Outbid Notice</title>
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
            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(158,79,46,0.12);border:1px solid rgba(196,132,90,0.3);border-radius:4px">
              <tr><td style="padding:18px 20px">
                <p style="margin:0 0 10px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4845a;font-family:'Georgia',serif">You've been outbid</p>
                <p style="margin:0 0 8px;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">${shortBidder} just dropped <strong style="color:#c4845a">${new_amount}</strong> and took your spot.</p>
                <p style="margin:0;font-size:14px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">Are you going to let that stand? The Àpótí doesn't wait for anyone — and neither does this room.</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 20px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">New leading bid</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:16px;color:#e8d5b0;font-weight:600;font-family:'Georgia',serif">${new_amount}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Bidder ahead of you</span>
                </td>
                <td align="right" style="padding:10px 0">
                  <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${shortBidder}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 32px 32px;text-align:center">
            <a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">Bid back — reclaim your lead</a>
            <p style="margin:18px 0 0;font-size:12px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">This is your moment to respond. The auction is still live.</p>
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

// ── Shared helper: look up a bidder's email from collector_notifications ──────
async function _lookupBidderEmail(wallet, auction_id) {
  const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://haijshusgcbdexfueunr.supabase.co';
  const SUPABASE_ANON = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collector_notifications?wallet_address=eq.${encodeURIComponent(wallet.toLowerCase())}&auction_id=eq.${encodeURIComponent(auction_id)}&limit=1&select=email`,
    { headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON } }
  );
  const rows = await sbRes.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].email : null;
}

// ── Shared helper: send via Resend ────────────────────────────────────────────
async function _sendEmail(emailBody) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) throw new Error('Missing RESEND_API_KEY');
  const res  = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(emailBody),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Resend error');
  return data;
}

// ── Shared email shell ────────────────────────────────────────────────────────
function _emailShell(title, badgeColor, badgeLabel, headingHtml, bodyRowsHtml, ctaHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
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
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${badgeColor};border:1px solid rgba(196,132,90,0.3);border-radius:4px">
              <tr><td style="padding:18px 20px">
                <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4845a;font-family:'Georgia',serif">${badgeLabel}</p>
                ${headingHtml}
              </td></tr>
            </table>
          </td>
        </tr>
        ${bodyRowsHtml}
        <tr>
          <td style="padding:4px 32px 32px;text-align:center">
            ${ctaHtml}
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
</html>`;
}

// ── POST /api/game?action=notify-bid-confirm ──────────────────────────────────
// Email sent to the bidder themselves when their bid lands (first bid or retake).
async function handleNotifyBidConfirm(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bidder_wallet, amount, auction_id, art_title, auction_url, is_first } = req.body || {};
  if (!bidder_wallet || !amount) return res.status(400).json({ error: 'Missing required fields' });

  let email;
  try { email = await _lookupBidderEmail(bidder_wallet, auction_id); } catch (e) {
    return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message });
  }
  if (!email) return res.status(200).json({ sent: false, reason: 'No email registered' });

  const title    = art_title   || 'an Àpótí Ọlọ́wọ̀ piece';
  const url      = auction_url || 'https://kaysworks.com/auction';
  const subject  = is_first
    ? `The first bid is in — and it's YOU. ${amount} on ${title}`
    : `Crown changed. You're back on top at ${amount}`;
  const badgeLabel = is_first ? 'First bid confirmed' : 'Lead reclaimed';
  const heading    = is_first
    ? `<p style="margin:0 0 8px;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">YASSS. You just made history — first bid ever, <strong style="color:#c4845a">${amount}</strong>.</p>
       <p style="margin:0;font-size:14px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">The energy just shifted in this room. That's YOU at the top. Kay is doing a backflip right now. Stay sharp — this won't last without you watching.</p>`
    : `<p style="margin:0 0 8px;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">You're back. <strong style="color:#c4845a">${amount}</strong> and the crown is yours again.</p>
       <p style="margin:0;font-size:14px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">Kay sees your ${amount} and approves. You're the one to beat now. Protect that position — the room is watching.</p>`;
  const bodyRows = `
    <tr>
      <td style="padding:0 32px 20px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
              <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Your bid</span>
            </td>
            <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
              <span style="font-size:16px;color:#e8d5b0;font-weight:600;font-family:'Georgia',serif">${amount}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 0">
              <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Piece</span>
            </td>
            <td align="right" style="padding:10px 0">
              <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${title}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  const cta = `<a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">Watch the room</a>
    <p style="margin:18px 0 0;font-size:12px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">We'll email you the moment anyone tries to take your spot.</p>`;

  const html = _emailShell(title, 'rgba(107,124,92,0.12)', badgeLabel, heading, bodyRows, cta);

  try {
    const data = await _sendEmail({ from: 'Àpótí Ọlọ́wọ̀ Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
    return res.status(200).json({ sent: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
}

// ── POST /api/game?action=notify-winner ───────────────────────────────────────
// Email sent to the winning bidder when the auction settles.
async function handleNotifyWinner(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { winner_wallet, amount, auction_id, art_title, auction_url } = req.body || {};
  if (!winner_wallet || !amount) return res.status(400).json({ error: 'Missing required fields' });

  let email;
  try { email = await _lookupBidderEmail(winner_wallet, auction_id); } catch (e) {
    return res.status(500).json({ error: 'Supabase lookup failed: ' + e.message });
  }
  if (!email) return res.status(200).json({ sent: false, reason: 'No email registered' });

  const title   = art_title   || 'an Àpótí Ọlọ́wọ̀ piece';
  const url     = auction_url || 'https://kaysworks.com/auction';
  const subject = `SOLD — ${amount}. ${title} is yours. Kay salutes you.`;

  const heading = `<p style="margin:0 0 8px;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">🏆 The gavel falls. <strong style="color:#c9993a">${amount}</strong> — SOLD.</p>
    <p style="margin:0;font-size:14px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">You own a piece of the Àpótí Ọlọ́wọ̀ story now. Kay made this for someone like you. Welcome to the collection.</p>`;

  const bodyRows = `
    <tr>
      <td style="padding:0 32px 20px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
              <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Winning bid</span>
            </td>
            <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
              <span style="font-size:16px;color:#c9993a;font-weight:600;font-family:'Georgia',serif">${amount}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 0">
              <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Piece</span>
            </td>
            <td align="right" style="padding:10px 0">
              <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${title}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const cta = `<a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">View the settled auction</a>
    <p style="margin:18px 0 0;font-size:12px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">Congratulations from Kay and everyone who was in that room.</p>`;

  const html = _emailShell(title, 'rgba(201,153,58,0.12)', 'Auction won', heading, bodyRows, cta);

  try {
    const data = await _sendEmail({ from: 'Àpótí Ọlọ́wọ̀ Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
    return res.status(200).json({ sent: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
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
  return res.status(409).json({ ok: false, claim: data || null, error: 'PAIR_ALREADY_CLAIMED' });
}

// ── GET /api/game?action=shop-products ────────────────────────────────────────
// Optional ?slug=apoti-olowe-study-i for single product
// Optional ?series=apoti-olowe for all prints in a series
async function handleShopProducts(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug   = req.query.slug   || '';
  const series = req.query.series || '';

  if (slug) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('slug', slug)
      .eq('active', true)
      .single();
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    const [tagged] = await applyProductTags([data], supabase);
    return res.status(200).json(tagged || data);
  }

  if (series) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('series_slug', series)
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  const { data, error } = await supabase
    .from('shop_products')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const tagged = await applyProductTags(data || [], supabase);
  return res.status(200).json(tagged);
}

// Compute "new" (added in last 14 days) and "bestseller" (top 3 by total
// quantity ordered) tags, returned alongside each product.
async function applyProductTags(products, supabase) {
  if (!products.length) return products;

  // Tally ordered quantity per product id across all recorded orders.
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

  // Top 3 product ids by quantity (only those with at least one sale).
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

// ── POST /api/game?action=shop-order ──────────────────────────────────────────
// Records an order and decrements stock per variant.
// Called from shop.html after payment confirmation.

// Server-authoritative delivery rates — MUST mirror DELIVERY_RATES in shop.html.
// Client-sent fees/totals are never trusted; everything is recomputed here.
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

// Look up the authoritative price for a variant from a product row.
function serverVariantPrice(product, variantKey, variant, currency) {
  const prices = currency === 'usd' ? (product.prices_usd || {}) : (product.prices_ngn || {});
  if (variantKey && prices[variantKey] !== undefined) return Number(prices[variantKey]) || 0;
  if (variant && prices[variant] !== undefined) return Number(prices[variant]) || 0;
  // Fall back to the size segment of a "type|size" key.
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

function jsonError(res, e) {
  return res.status(e.statusCode || 500).json({
    error: e.message || 'Server error',
    product_id: e.product_id,
    variant: e.variant,
  });
}

async function fetchServerCryptoPrice(asset) {
  const symbol = asset === 'xtz' ? 'XTZUSDT' : 'ETHUSDT';
  const coingeckoId = asset === 'xtz' ? 'tezos' : 'ethereum';
  async function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }
  async function binance() {
    const r = await withTimeout(fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`), 3500);
    if (!r.ok) throw new Error('binance rate failed');
    const d = await r.json();
    const price = Number(d.price);
    if (!price || price <= 0) throw new Error('bad binance rate');
    return price;
  }
  async function coingecko() {
    const r = await withTimeout(fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`), 3500);
    if (!r.ok) throw new Error('coingecko rate failed');
    const d = await r.json();
    const price = Number(d?.[coingeckoId]?.usd);
    if (!price || price <= 0) throw new Error('bad coingecko rate');
    return price;
  }
  try {
    return await Promise.any([binance(), coingecko()]);
  } catch (_) {
    return null;
  }
}

async function handleShopQuote(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
      if (!price) return res.status(503).json({ error: `${asset.toUpperCase()} rate unavailable` });
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
    return res.status(200).json({ ok: true, quote, checkout });
  } catch (e) {
    return jsonError(res, e);
  }
}

async function handleShopPaymentInit(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const provider = String(body.provider || '').toLowerCase();
    if (!['paystack','flutterwave'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported payment provider' });
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
      if (!secret) return res.status(500).json({ error: 'Paystack secret key not configured' });
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
      return res.status(200).json({ ok: true, provider, reference, quote, checkout, ...data.data });
    }

    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'Flutterwave secret key not configured' });
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
    return res.status(200).json({ ok: true, provider, reference, quote, checkout, link: data.data?.link });
  } catch (e) {
    return jsonError(res, e);
  }
}

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
  const r = await fetch(`${api}/v1/operations/transactions?hash=${encodeURIComponent(opHash)}`, {
    headers: { Accept: 'application/json' },
  });
  const rows = await r.json().catch(() => []);
  if (!r.ok) throw new Error('Tezos verification API failed');
  const requiredMutez = decimalToUnits(quote.crypto_amount, 6);
  const match = (Array.isArray(rows) ? rows : []).find(tx =>
    String(tx.status || '').toLowerCase() === 'applied' &&
    String(tx.sender?.address || tx.sender?.alias || '').toLowerCase() === String(payerAddress).toLowerCase() &&
    String(tx.target?.address || tx.target?.alias || '').toLowerCase() === String(payeeAddress).toLowerCase() &&
    BigInt(tx.amount || 0) >= requiredMutez
  );
  if (!match) throw new Error('Tezos transaction to the shop wallet was not found for the quoted amount');
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

// Server-side confirmation that a card payment actually succeeded. The client
// is never trusted to assert payment: we ask the gateway directly, using the
// reference we minted at payment-init, and require both a success status and an
// amount that covers the quoted NGN total. Throws (statusCode 402/502) on any
// failure so the caller can reject before claiming stock or recording an order.
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
    // Paystack amounts are in kobo (1 NGN = 100 kobo).
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
      // We hold the tx_ref (minted at init), so verify by reference.
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
    const paidNgn = Number(tx.amount || 0); // Flutterwave reports in major units
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

// Atomically claim stock for one item via the decrement_variant_stock RPC.
// Returns { ok: true } on success, or { ok: false, available } when there
// isn't enough. Untracked/unlimited stock returns ok:true. A missing RPC or
// transport error is surfaced as a thrown error so the caller can 500 rather
// than silently overselling.
async function claimVariantStock(supabase, item) {
  const vkey = item.variantKey || item.variant;
  const { data, error } = await supabase.rpc('decrement_variant_stock', {
    p_id: item.id,
    p_variant_key: vkey,
    p_qty: item.qty,
  });
  if (error) {
    const e = new Error(`Stock claim failed for ${item.name || item.id}: ${error.message}`);
    e.statusCode = 500;
    throw e;
  }
  // The function returns a boolean: true = claimed, false = insufficient.
  return { ok: data === true };
}

// Best-effort compensating release of stock previously claimed in this request,
// used to roll back when a later item in the same order fails. Returns nothing;
// failures here are logged but not thrown (we're already in an error path).
async function releaseVariantStock(supabase, item) {
  const vkey = item.variantKey || item.variant;
  try {
    const { error } = await supabase.rpc('decrement_variant_stock', {
      p_id: item.id,
      p_variant_key: vkey,
      p_qty: -item.qty, // negative qty adds the units back
    });
    if (error) console.error('[shop-order] stock release failed:', item.id, vkey, error.message);
  } catch (e) {
    console.error('[shop-order] stock release threw:', item.id, vkey, e.message);
  }
}

async function handleShopOrder(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  let checkout;
  try {
    checkout = await computeShopCheckout(body, supabase);
  } catch (e) {
    return jsonError(res, e);
  }

  const paymentMethod = String(body.payment_method || '').slice(0, 40);
  const paymentRef = String(body.payment_ref || '').slice(0, 200);
  const payerAddress = String(body.payer_address || '').slice(0, 120);
  const quoteRequired = ['paystack','flutterwave','eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (quoteRequired && !verifyShopQuote(body.checkout_quote, checkout, {
    payment_method: paymentMethod,
    ...(paymentMethod === 'paystack' || paymentMethod === 'flutterwave' ? { payment_ref: paymentRef } : {}),
    ...(payerAddress ? { payer_address: payerAddress } : {}),
  })) {
    return res.status(400).json({ error: 'Invalid or expired server checkout quote' });
  }
  const isCryptoPayment = ['eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (isCryptoPayment) {
    if (!paymentRef) return res.status(400).json({ error: 'Crypto transaction hash is required' });
    if (!payerAddress) return res.status(400).json({ error: 'Sending wallet address is required' });
    const { data: existingOrder, error: existingError } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (existingError && existingError.code !== 'PGRST116') return res.status(500).json({ error: existingError.message });
    if (existingOrder) return res.status(409).json({ error: 'This crypto transaction has already been submitted for an order' });
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
      return jsonError(res, e);
    }
  }

  // ── Verify card payments with the gateway BEFORE touching stock ──────────
  // There are no provider webhooks: this server-side verify is the only proof
  // that a card payment actually happened. The client is never trusted to
  // assert it. A failed/abandoned/spoofed payment is rejected here, so no stock
  // is claimed and no order is recorded for unpaid carts.
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
      return jsonError(res, e);
    }
    // Guard against the same successful charge being submitted twice.
    const { data: dupe, error: dupeErr } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (dupeErr && dupeErr.code !== 'PGRST116') return res.status(500).json({ error: dupeErr.message });
    if (dupe) return res.status(409).json({ error: 'This payment has already been recorded for an order' });
  }

  // Payment is confirmed (or not required) at this point.
  const paymentConfirmed = isCryptoPayment || isCardPayment;

  // ── Claim stock atomically BEFORE recording the order ────────────────────
  // Each claim is a single check-and-decrement in Postgres (decrement_variant_stock,
  // which locks the row FOR UPDATE), so two concurrent orders for the last unit
  // can no longer both succeed. If any line can't be satisfied, we release every
  // line we already claimed in this request and reject the whole order.
  //
  // Note on payment ordering: by the time we reach here the customer has already
  // paid (card via the gateway redirect, crypto verified on-chain above). So a
  // 409 here means "paid but sold out" — the caller must refund. This is rare
  // (only a true race for the final unit triggers it) and is strictly better
  // than silently overselling a numbered edition.
  const claimed = [];
  for (const item of checkout.trustedItems) {
    let result;
    try {
      result = await claimVariantStock(supabase, item);
    } catch (e) {
      // RPC/transport failure: roll back and surface as a server error.
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return jsonError(res, e);
    }
    if (!result.ok) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return res.status(409).json({
        error: `Sold out: ${item.name} · ${item.variant} is no longer available`,
        product_id: item.id,
        variant: item.variant,
        sold_out: true,
      });
    }
    claimed.push(item);
  }

  // ── Record the order ─────────────────────────────────────────────────────
  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
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
      status: paymentConfirmed ? 'paid' : 'pending',
    })
    .select('id')
    .single();
  if (orderError) {
    // Order didn't record — give the stock back so we don't strand units.
    for (const c of claimed) await releaseVariantStock(supabase, c);
    return res.status(500).json({ error: orderError.message });
  }

  return res.status(200).json({
    ok: true,
    order_id: order.id,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    chain_verification: chainVerification,
    card_verification: cardVerification,
  });
}
// ── GET /api/game?action=shop-config ──────────────────────────────────────────
async function handleShopConfig(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('shop_config')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  return res.status(200).json(data || {});
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  // Derive action from query string or URL path
  const urlPath = req.url || '';
  let action = req.query.action || '';

  if (!action) {
    // Map legacy direct paths → actions
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
    else if (urlPath.includes('/shop-order') || urlPath.includes('/shop/order')) action = 'shop-order';
  }

  const supabase = getSupabase();

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
    case 'shop-payment-init':  return handleShopPaymentInit(req, res, supabase);
    case 'shop-order':         return handleShopOrder(req, res, supabase);
    default:
      return res.status(404).json({ error: `Unknown action: ${action}` });
  }
};
