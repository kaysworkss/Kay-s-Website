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
  const best = scores.filter(s => {
    const key = s.player_name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 10);

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
      const best = scores.filter(s => {
        const key = s.player_name.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 10);

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
  const title       = art_title || 'Àpótí Ọlọ́wẹ̀';
  const url         = auction_url || 'https://kaysworks.com/auction';

  // 3. Send email via Resend
  const emailBody = {
    from:    'Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>',
    to:      [email],
    subject: `You've been outbid — ${new_amount} on ${title}`,
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
                <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4845a;font-family:'Georgia',serif">Outbid alert</p>
                <p style="margin:0;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">You've been outbid at <strong style="color:#c4845a">${new_amount}</strong></p>
                <p style="margin:8px 0 0;font-size:13px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">${shortBidder} placed a higher bid on the piece you were leading.</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 20px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Your wallet</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${shortOutbid}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">New leading bid</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:16px;color:#e8d5b0;font-weight:600;font-family:'Georgia',serif">${new_amount}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 32px 32px;text-align:center">
            <a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">Return to auction</a>
            <p style="margin:18px 0 0;font-size:12px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">The auction is still live. You can still reclaim your lead.</p>
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
    else if (urlPath.includes('/notify-outbid'))  action = 'notify-outbid';
  }

  const supabase = getSupabase();

  switch (action) {
    case 'challenges':    return handleChallenges(req, res, supabase);
    case 'upcoming':      return handleUpcoming(req, res, supabase);
    case 'challenge':     return handleChallenge(req, res, supabase);
    case 'score':         return handleScore(req, res, supabase);
    case 'leaderboard':   return handleLeaderboard(req, res, supabase);
    case 'hall-of-fame':  return handleHallOfFame(req, res, supabase);
    case 'notify-outbid': return handleNotifyOutbid(req, res);
    default:
      return res.status(404).json({ error: `Unknown action: ${action}` });
  }
};
