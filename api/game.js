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
  const title       = art_title || 'an Àpótí Ọlọ́wẹ̀ piece';
  const url         = auction_url || 'https://kaysworks.com/auction';

  // 3. Send email via Resend
  const emailBody = {
    from:    'Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>',
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

  const title    = art_title   || 'an Àpótí Ọlọ́wẹ̀ piece';
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
    const data = await _sendEmail({ from: 'Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
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

  const title   = art_title   || 'an Àpótí Ọlọ́wẹ̀ piece';
  const url     = auction_url || 'https://kaysworks.com/auction';
  const subject = `SOLD — ${amount}. ${title} is yours. Kay salutes you.`;

  const heading = `<p style="margin:0 0 8px;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">🏆 The gavel falls. <strong style="color:#c9993a">${amount}</strong> — SOLD.</p>
    <p style="margin:0;font-size:14px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">You own a piece of the Àpótí Ọlọ́wẹ̀ story now. Kay made this for someone like you. Welcome to the collection.</p>`;

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
    const data = await _sendEmail({ from: 'Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>', to: [email], subject, html });
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
  const title       = art_title  || 'an Àpótí Ọlọ́wẹ̀ piece';
  const url         = auction_url || 'https://kaysworks.com/auction';
  const auctionRef  = auction_id  ? ` (${auction_id.slice(0, 8)}…)` : '';

  const emailBody = {
    from:    'Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>',
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
    return res.status(200).json(data);
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
  return res.status(200).json(data || []);
}

// ── POST /api/game?action=shop-order ──────────────────────────────────────────
// Records an order and decrements stock per variant.
// Called from shop.html after payment confirmation.
async function handleShopOrder(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items in order' });

  // 1. Check stock for all items before doing anything
  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const { data: product, error } = await supabase
      .from('shop_products')
      .select('stock, stock_by_variant, name')
      .eq('id', item.id)
      .single();
    if (error) continue; // no stock tracking on this product — allow

    // Per-variant stock check
    const stockByVariant = product.stock_by_variant || {};
    if (stockByVariant[item.variant] !== undefined) {
      if (stockByVariant[item.variant] < item.qty) {
        return res.status(409).json({
          error: `Only ${stockByVariant[item.variant]} left in stock for ${product.name} · ${item.variant}`,
          product_id: item.id, variant: item.variant,
        });
      }
    } else if (product.stock !== null && product.stock !== undefined) {
      // Flat stock check
      if (product.stock < item.qty) {
        return res.status(409).json({
          error: `Only ${product.stock} left in stock for ${product.name}`,
          product_id: item.id,
        });
      }
    }
  }

  // 2. Insert order
  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
      customer_name:   String(body.name    || '').slice(0, 200),
      email:           String(body.email   || '').slice(0, 320),
      phone:           String(body.phone   || '').slice(0, 60),
      address:         String(body.address || '').slice(0, 500),
      items:           items,
      total_ngn:       Number(body.total_ngn) || 0,
      total_usd:       Number(body.total_usd) || 0,
      delivery_fee_ngn: Number(body.delivery_fee_ngn) || 0,
      delivery_method:  String(body.delivery_method || '').slice(0, 40),
      delivery_zone:    String(body.delivery_zone   || '').slice(0, 40),
      payment_method:  String(body.payment_method || '').slice(0, 40),
      payment_ref:     String(body.payment_ref    || '').slice(0, 200),
      status: 'pending',
    })
    .select('id')
    .single();
  if (orderError) return res.status(500).json({ error: orderError.message });

  // 3. Decrement stock
  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const { data: product } = await supabase
      .from('shop_products')
      .select('stock, stock_by_variant')
      .eq('id', item.id)
      .single();
    if (!product) continue;

    const sbv = product.stock_by_variant || {};
    if (sbv[item.variant] !== undefined) {
      sbv[item.variant] = Math.max(0, sbv[item.variant] - item.qty);
      await supabase.from('shop_products').update({ stock_by_variant: sbv }).eq('id', item.id);
    } else if (product.stock !== null && product.stock !== undefined) {
      await supabase.from('shop_products')
        .update({ stock: Math.max(0, product.stock - item.qty) })
        .eq('id', item.id);
    }
  }

  return res.status(200).json({ ok: true, order_id: order.id });
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
    else if (urlPath.includes('/shop-products'))      action = 'shop-products';
    else if (urlPath.includes('/shop-config'))        action = 'shop-config';
    else if (urlPath.includes('/shop-order'))         action = 'shop-order';
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
    case 'shop-order':         return handleShopOrder(req, res, supabase);
    default:
      return res.status(404).json({ error: `Unknown action: ${action}` });
  }
};
