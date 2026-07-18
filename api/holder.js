/**
 * /api/holder.js
 *
 * Consolidated Holder Hub endpoint - mirrors the action-routed pattern
 * used in api/admin.js rather than one file per route. Two actions:
 *
 *   POST /api/holder?action=verify   (public, no auth)
 *     First step of the access flow. Re-checks wallet token ownership
 *     server-side and either:
 *       - links it straight to an already-signed-in holder's account
 *         (a Supabase session token is attached - the periodic
 *         re-verify case), or
 *       - parks the result as a pending_verifications row and hands
 *         back a one-time claim token (first-time visitor, no account
 *         yet).
 *
 *   POST /api/holder?action=claim    (requires a Supabase session token)
 *     Called once, right after a first-time visitor clicks their magic
 *     link and lands back on the page with a claimToken in the URL.
 *     Finds the matching pending_verifications row (created by the
 *     verify action above), links it to their new auth user, and
 *     consumes it.
 *
 * Env vars needed (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are assumed
 * to already be wired up inside ./_lib):
 *   ETH_RPC_URL   (optional - defaults to a public node if unset)
 *
 * Everything else below is hardcoded rather than env-configured, since
 * it's fixed, public, on-chain info (contract addresses, token standard)
 * rather than a secret or something that varies by deployment - same
 * contract/token that claim-token.html checks, confirmed from its CLAIM
 * config. Holder tokens are IDs 1 and 2 on both chains - a wallet is
 * eligible if it holds either one.
 */

const { getSupabase, cors, handleOptions } = require('./_lib');

const PENDING_TTL_MINUTES = 60;

// Both chains gate on the same two token IDs - holding either one qualifies.
const HOLDER_TOKEN_IDS = [1, 2];
const HOLDER_TOKEN_TIERS = { 1: 'wood', 2: 'bronze' };

const ETH_CONTRACT_ADDRESS = '0x611cca3635b0f05b103031ee8d4f3261633292b4';
const ETH_TOKEN_STANDARD = 'erc1155'; // balanceOf(address, tokenId) - confirmed from claim-token.html
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://ethereum.publicnode.com';
const TEZOS_CONTRACT_ADDRESS = 'KT1MNxJYowrxgC1FLuN45TyPjzyFEoeHBJa8';

const AUTH_EMAIL_FROM = process.env.HOLDER_AUTH_FROM_EMAIL || "Kay's Works <auction@mail.kaysworks.com>";

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function holderAuthEmailHtml(actionLink) {
  const href = escapeHtml(actionLink);
  return `<!doctype html><html><body style="margin:0;background:#1e1410;padding:28px 12px;color:#392416">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ede0c8;border-radius:24px;overflow:hidden">
      <tr><td style="background:#2a1508;background-image:radial-gradient(ellipse at 50% 110%,rgba(196,140,60,.38),transparent 62%),linear-gradient(180deg,#2a1508,#3d2010 55%,#5a2e14);padding:38px 30px 42px;text-align:center">
        <div style="font-family:Georgia,serif;color:#e8c45a;font-size:12px;letter-spacing:4px;text-transform:uppercase">Kay's Works</div>
        <div style="font-family:Georgia,serif;color:#f5ead4;font-size:34px;line-height:1.15;margin-top:18px">The Holder Hub</div>
        <div style="font-family:Arial,sans-serif;color:#c9aa83;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:12px">Àpótí Ọlọ́wẹ̀ · Private holder access</div>
      </td></tr>
      <tr><td style="height:5px;background:linear-gradient(90deg,#b8821e,#e8c45a 35%,#f5d878 55%,#b8821e)">&nbsp;</td></tr>
      <tr><td style="padding:38px 36px 34px;text-align:center">
        <p style="font-family:Georgia,serif;font-size:20px;line-height:1.5;color:#4a2a18;margin:0 0 12px">Your private door is ready.</p>
        <p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.75;color:#74543d;margin:0 0 28px">Use this one-time link to enter the Holder Hub. It links your verified wallet to this email, so future visits only need your inbox.</p>
        <a href="${href}" style="display:inline-block;background:linear-gradient(90deg,#b8821e,#e8c45a 35%,#f5d878 55%,#d4a030 80%,#b8821e);color:#2d1508;text-decoration:none;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:15px 32px;border-radius:999px">Enter the Holder Hub</a>
        <p style="font-family:Arial,sans-serif;font-size:11px;line-height:1.6;color:#93745b;margin:26px 0 0">This link is for you alone. If you did not request it, you can safely ignore this email.</p>
      </td></tr>
      <tr><td style="padding:18px 28px 24px;border-top:1px solid rgba(90,55,30,.15);text-align:center;font-family:Arial,sans-serif;font-size:10px;letter-spacing:1px;color:#8a6a50">KAY'S WORKS · ART, MEMORY &amp; MATERIAL</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendHolderAuthEmail(email, actionLink) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: AUTH_EMAIL_FROM,
      to: [email],
      subject: "Your private link to Kay's Works Holder Hub",
      html: holderAuthEmailHtml(actionLink),
      text: `Your private Holder Hub link:\n\n${actionLink}\n\nThis one-time link connects your verified wallet to your email. If you did not request it, ignore this message.`
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Email provider returned ' + response.status + (detail ? ': ' + detail : ''));
  }
}

// Ethereum addresses are case-insensitive on-chain but come back checksummed
// (mixed-case) from wallets - always store lowercase so a pre-seeded holder
// row (e.g. imported from a spreadsheet) reliably matches on conflict instead
// of creating a duplicate row. Tezos addresses are base58check and MUST NOT
// be case-normalized - case is significant there.
function normalizeAddress(chain, address) {
  return chain === 'ethereum' ? address.toLowerCase() : address;
}

function summarizeTokenBalances(balancesByTokenId) {
  const normalized = {};
  HOLDER_TOKEN_IDS.forEach(id => {
    normalized[String(id)] = Number(balancesByTokenId && balancesByTokenId[String(id)] || 0);
  });
  const totalBalance = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  const tokenId = normalized['2'] > 0 ? 2 : normalized['1'] > 0 ? 1 : null;
  return {
    totalBalance,
    tokenId,
    tier: tokenId ? HOLDER_TOKEN_TIERS[tokenId] : null,
    balancesByTokenId: normalized,
  };
}

async function checkTezosBalances(address) {
  const url =
    'https://api.tzkt.io/v1/tokens/balances' +
    '?account=' + encodeURIComponent(address) +
    '&token.contract=' + encodeURIComponent(TEZOS_CONTRACT_ADDRESS) +
    '&token.tokenId.in=' + HOLDER_TOKEN_IDS.join(',') +
    '&limit=10';
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('TzKT returned ' + r.status + (body ? ': ' + body : ''));
  }
  const data = await r.json();
  const rows = Array.isArray(data) ? data : [];
  const balances = {};
  HOLDER_TOKEN_IDS.forEach(id => { balances[String(id)] = 0; });
  rows.forEach(row => {
    const tokenId = String(row?.token?.tokenId ?? '');
    if (!Object.prototype.hasOwnProperty.call(balances, tokenId)) return;
    balances[tokenId] += Number(row?.balance || 0);
  });
  return balances;
}

async function checkEthBalances(address) {
  const paddedAddress = address.toLowerCase().replace('0x', '').padStart(64, '0');

  // ERC-1155: balanceOf(address,uint256) - one call per token ID.
  const results = await Promise.all(
    HOLDER_TOKEN_IDS.map(id => {
      const tokenIdHex = BigInt(id).toString(16).padStart(64, '0');
      const data = '0x00fdd58e' + paddedAddress + tokenIdHex;
      return ethCallBalance(ETH_RPC_URL, ETH_CONTRACT_ADDRESS, data).then(balance => [String(id), balance]);
    })
  );
  return Object.fromEntries(results);
}

async function ethCallBalance(rpcUrl, contract, data) {
  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] };
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const jsonRes = await r.json();
  if (jsonRes.error) {
    // The RPC call itself failed (bad contract address, reverted call, etc.)
    // - surface this instead of quietly treating it as "balance: 0", since
    // that distinction matters a lot when debugging a "not verifying" report.
    throw new Error('RPC error: ' + (jsonRes.error.message || JSON.stringify(jsonRes.error)));
  }
  if (!jsonRes.result || jsonRes.result === '0x') return 0;
  return parseInt(jsonRes.result, 16);
}

// -- action=verify ----
async function handleVerify(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { chain, address } = req.body || {};
  if (!chain || !address) return res.status(400).json({ error: 'chain and address are required.' });
  if (chain !== 'tezos' && chain !== 'ethereum') return res.status(400).json({ error: 'Unsupported chain.' });
  const normalizedAddress = normalizeAddress(chain, address);

  const balancesByTokenId = chain === 'tezos'
    ? await checkTezosBalances(normalizedAddress)
    : await checkEthBalances(normalizedAddress);
  const holderTokens = summarizeTokenBalances(balancesByTokenId);
  const balance = holderTokens.totalBalance;

  if (balance < 1) return res.status(403).json({ error: 'This wallet does not currently hold the token.' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (token) {
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }
    const { error: upsertErr } = await supabase.from('holders').upsert({
      auth_user_id: userData.user.id,
      wallet_address: normalizedAddress,
      chain,
      token_balance: balance,
      last_verified_at: new Date().toISOString(),
    }, { onConflict: 'wallet_address,chain' });
    if (upsertErr) return res.status(500).json({ error: 'Could not save holder record: ' + upsertErr.message });
    return res.status(200).json({
      ok: true,
      mode: 'linked',
      balance,
      tokenId: holderTokens.tokenId,
      tier: holderTokens.tier,
      balancesByTokenId: holderTokens.balancesByTokenId,
    });
  }

  const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60000).toISOString();
  const { data: pending, error: insertErr } = await supabase
    .from('pending_verifications')
    .insert({ wallet_address: normalizedAddress, chain, token_balance: balance, expires_at: expiresAt })
    .select('id')
    .single();
  if (insertErr) return res.status(500).json({ error: 'Could not record verification: ' + insertErr.message });

  return res.status(200).json({
    ok: true,
    mode: 'pending',
    balance,
    tokenId: holderTokens.tokenId,
    tier: holderTokens.tier,
    balancesByTokenId: holderTokens.balancesByTokenId,
    claimToken: pending.id,
  });
}

// -- action=claim ----
async function handleClaim(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!accessToken) return res.status(401).json({ error: 'Missing session token.' });

  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing claim token.' });

  const { data: pending, error: findErr } = await supabase
    .from('pending_verifications')
    .select('*')
    .eq('id', token)
    .eq('consumed', false)
    .maybeSingle();

  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!pending) return res.status(400).json({ error: 'This verification link is invalid or already used.' });
  if (new Date(pending.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This verification has expired - please reconnect your wallet.' });
  }

  const { error: upsertErr } = await supabase.from('holders').upsert({
    auth_user_id: userData.user.id,
    wallet_address: pending.wallet_address,
    chain: pending.chain,
    token_balance: pending.token_balance,
    last_verified_at: new Date().toISOString(),
  }, { onConflict: 'wallet_address,chain' });

  if (upsertErr) return res.status(500).json({ error: 'Could not save holder record: ' + upsertErr.message });

  await supabase.from('pending_verifications').update({ consumed: true }).eq('id', token);

  return res.status(200).json({ ok: true });
}

// -- action=send-auth-email ----
// Sends the magic link through Resend so it matches the shop/auction brand.
// A link is only delivered after a fresh eligible-wallet check, or to an
// auth account that is already linked to a holder row.
async function handleSendAuthEmail(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const claimToken = String((req.body && req.body.claimToken) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (claimToken) {
    const { data: pending, error: pendingError } = await supabase
      .from('pending_verifications')
      .select('id,expires_at')
      .eq('id', claimToken)
      .eq('consumed', false)
      .maybeSingle();
    if (pendingError) return res.status(500).json({ error: pendingError.message });
    if (!pending || new Date(pending.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Wallet verification expired. Please reconnect your wallet.' });
    }
  }

  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(forwardedHost) ? forwardedHost : 'kaysworks.com';
  const protocol = safeHost.includes('localhost') ? 'http' : 'https';
  const hubUrl = (process.env.HOLDER_HUB_URL || `${protocol}://${safeHost}/holder-hub`).replace(/\/$/, '');
  const redirectTo = hubUrl + (claimToken ? '?vt=' + encodeURIComponent(claimToken) : '');

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo }
  });
  if (linkError || !linkData || !linkData.properties || !linkData.properties.action_link) {
    return res.status(500).json({ error: 'Could not create the sign-in link.' });
  }

  if (!claimToken) {
    const userId = linkData.user && linkData.user.id;
    const { data: linkedHolder, error: holderError } = await supabase
      .from('holders')
      .select('auth_user_id')
      .eq('auth_user_id', userId || '00000000-0000-0000-0000-000000000000')
      .maybeSingle();
    if (holderError) return res.status(500).json({ error: holderError.message });
  // Keep the response deliberately generic so this endpoint cannot be used
  // to discover which email addresses belong to collectors. If an older
  // account was accidentally linked to an anonymous user, reconnecting the
  // wallet and requesting a fresh link repairs it through the claim flow.
    if (!linkedHolder) return res.status(200).json({ ok: true });
  }

  await sendHolderAuthEmail(email, linkData.properties.action_link);
  return res.status(200).json({ ok: true });
}

// -- action=content ----
// Holder-only editable copy. The service-role query bypasses table RLS, but
// only after the supplied auth user is confirmed as a linked holder.
async function handleContent(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const walletClaim = String(req.headers['x-holder-claim'] || '');
  let authorised = false;
  if (accessToken) {
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (!userError && userData && userData.user) {
      const { data: holder } = await supabase.from('holders').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
      authorised = Boolean(holder);
    }
  } else if (walletClaim) {
    const { data: pending } = await supabase.from('pending_verifications')
      .select('id,expires_at').eq('id', walletClaim).eq('consumed', false).maybeSingle();
    authorised = Boolean(pending && new Date(pending.expires_at) > new Date());
  }
  if (!authorised) return res.status(403).json({ error: 'Holder access required.' });
  const { data, error } = await supabase.from('holder_content').select('future_plans').eq('id', 1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ future_plans: (data && data.future_plans) || '' });
}

// -- action=config ----
// Public, read-only. Lets the static HTML pull its Supabase connection info
// from the same env vars your serverless functions already use, instead of
// a value hardcoded into the page - env vars set in Vercel are only visible
// to functions like this one, never to a plain static .html file, so this
// is the bridge between the two. Safe to expose: the anon key is meant to
// be public (that's what "anon" means) - it's the service role key that
// must never leave the server.
async function handleConfig(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({
      error: 'SUPABASE_URL and/or SUPABASE_ANON_KEY are not set on this deployment. ' +
             'SUPABASE_URL likely already exists (used by ./_lib) - SUPABASE_ANON_KEY may need adding, ' +
             'it is a different value from SUPABASE_SERVICE_ROLE_KEY. Find it in Supabase -> Settings -> API -> anon/public key.'
    });
  }
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}

// -- entry point ----
module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;

  const action = req.query && req.query.action;

  try {
    if (action === 'config') return await handleConfig(req, res);

    const supabase = getSupabase();
    switch (action) {
      case 'verify': return await handleVerify(req, res, supabase);
      case 'claim':  return await handleClaim(req, res, supabase);
      case 'send-auth-email': return await handleSendAuthEmail(req, res, supabase);
      case 'content': return await handleContent(req, res, supabase);
      default:
        return res.status(404).json({ error: `Unknown holder action: ${action}` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error.' });
  }
};
