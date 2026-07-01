/**
 * /api/holder.js
 *
 * Consolidated Holder Hub endpoint — mirrors the action-routed pattern
 * used in api/admin.js rather than one file per route. Two actions:
 *
 *   POST /api/holder?action=verify   (public, no auth)
 *     First step of the access flow. Re-checks wallet token ownership
 *     server-side and either:
 *       - links it straight to an already-signed-in holder's account
 *         (a Supabase session token is attached — the periodic
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
 *   ETH_RPC_URL
 *   ETH_CONTRACT_ADDRESS
 *   ETH_TOKEN_STANDARD    "erc721" or "erc1155"
 *   TEZOS_CONTRACT_ADDRESS
 *
 * Holder tokens are IDs 1 and 2 on both chains — a wallet is eligible if
 * it holds either one. See HOLDER_TOKEN_IDS below if that ever changes.
 */

const { getSupabase, cors, handleOptions } = require('./_lib');

const PENDING_TTL_MINUTES = 60;

// Both chains gate on the same two token IDs — holding either one qualifies.
const HOLDER_TOKEN_IDS = [1, 2];

// Ethereum addresses are case-insensitive on-chain but come back checksummed
// (mixed-case) from wallets — always store lowercase so a pre-seeded holder
// row (e.g. imported from a spreadsheet) reliably matches on conflict instead
// of creating a duplicate row. Tezos addresses are base58check and MUST NOT
// be case-normalized — case is significant there.
function normalizeAddress(chain, address) {
  return chain === 'ethereum' ? address.toLowerCase() : address;
}

async function checkTezosBalance(address) {
  const url =
    'https://api.tzkt.io/v1/tokens/balances' +
    '?account=' + encodeURIComponent(address) +
    '&token.contract=' + encodeURIComponent(process.env.TEZOS_CONTRACT_ADDRESS) +
    '&token.tokenId.in=' + HOLDER_TOKEN_IDS.join(',') +
    '&select=balance&limit=10';
  const r = await fetch(url);
  if (!r.ok) throw new Error('TzKT returned ' + r.status);
  const data = await r.json();
  const rows = Array.isArray(data) ? data : [];
  return rows.reduce((sum, raw) => {
    const val = raw && typeof raw === 'object' ? raw.balance : raw;
    return sum + (val === undefined || val === null ? 0 : Number(val));
  }, 0);
}

async function checkEthBalance(address) {
  const contract = process.env.ETH_CONTRACT_ADDRESS;
  const standard = (process.env.ETH_TOKEN_STANDARD || 'erc721').toLowerCase();
  const rpcUrl   = process.env.ETH_RPC_URL;
  const paddedAddress = address.toLowerCase().replace('0x', '').padStart(64, '0');

  if (standard !== 'erc1155') {
    // ERC-721 / ERC-20 style: single balanceOf(address), token IDs don't apply.
    const data = '0x70a08231' + paddedAddress;
    return ethCallBalance(rpcUrl, contract, data);
  }

  // ERC-1155: balanceOf(address,uint256) — one call per token ID, summed.
  const balances = await Promise.all(
    HOLDER_TOKEN_IDS.map(id => {
      const tokenIdHex = BigInt(id).toString(16).padStart(64, '0');
      const data = '0x00fdd58e' + paddedAddress + tokenIdHex;
      return ethCallBalance(rpcUrl, contract, data);
    })
  );
  return balances.reduce((sum, b) => sum + b, 0);
}

async function ethCallBalance(rpcUrl, contract, data) {
  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] };
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const jsonRes = await r.json();
  if (!jsonRes.result || jsonRes.result === '0x') return 0;
  return parseInt(jsonRes.result, 16);
}

// ── action=verify ────────────────────────────────────────────────────────────
async function handleVerify(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { chain, address } = req.body || {};
  if (!chain || !address) return res.status(400).json({ error: 'chain and address are required.' });
  if (chain !== 'tezos' && chain !== 'ethereum') return res.status(400).json({ error: 'Unsupported chain.' });
  const normalizedAddress = normalizeAddress(chain, address);

  let balance = 0;
  if (chain === 'tezos') balance = await checkTezosBalance(normalizedAddress);
  else balance = await checkEthBalance(normalizedAddress);

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
    return res.status(200).json({ ok: true, mode: 'linked', balance });
  }

  const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60000).toISOString();
  const { data: pending, error: insertErr } = await supabase
    .from('pending_verifications')
    .insert({ wallet_address: normalizedAddress, chain, token_balance: balance, expires_at: expiresAt })
    .select('id')
    .single();
  if (insertErr) return res.status(500).json({ error: 'Could not record verification: ' + insertErr.message });

  return res.status(200).json({ ok: true, mode: 'pending', balance, claimToken: pending.id });
}

// ── action=claim ─────────────────────────────────────────────────────────────
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
    return res.status(400).json({ error: 'This verification has expired — please reconnect your wallet.' });
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

// ── action=config ────────────────────────────────────────────────────────────
// Public, read-only. Lets the static HTML pull its Supabase connection info
// from the same env vars your serverless functions already use, instead of
// a value hardcoded into the page — env vars set in Vercel are only visible
// to functions like this one, never to a plain static .html file, so this
// is the bridge between the two. Safe to expose: the anon key is meant to
// be public (that's what "anon" means) — it's the service role key that
// must never leave the server.
async function handleConfig(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({
      error: 'SUPABASE_URL and/or SUPABASE_ANON_KEY are not set on this deployment. ' +
             'SUPABASE_URL likely already exists (used by ./_lib) — SUPABASE_ANON_KEY may need adding, ' +
             'it is a different value from SUPABASE_SERVICE_ROLE_KEY. Find it in Supabase → Settings → API → anon/public key.'
    });
  }
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}

// ── entry point ───────────────────────────────────────────────────────────────
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
      default:
        return res.status(404).json({ error: `Unknown holder action: ${action}` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error.' });
  }
};
