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
 * config. Wood and Bronze entry tokens are IDs 1 and 2 on both chains;
 * token ID 3 is the Gold distinction displayed inside the Holder Hub.
 */

const { getSupabase, cors, handleOptions } = require('./_lib');

const PENDING_TTL_MINUTES = 60;

// IDs 1 and 2 grant entry. ID 3 is checked as an additional Gold distinction,
// but does not replace the Wood/Bronze token used for access and identity.
const ENTRY_TOKEN_IDS = [1, 2];
const HOLDER_TOKEN_IDS = [1, 2, 3];
const HOLDER_TOKEN_TIERS = { 1: 'wood', 2: 'bronze' };

const ETH_CONTRACT_ADDRESS = '0x611cca3635b0f05b103031ee8d4f3261633292b4';
const ETH_TOKEN_STANDARD = 'erc1155'; // balanceOf(address, tokenId) - confirmed from claim-token.html
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://ethereum.publicnode.com';
const TEZOS_CONTRACT_ADDRESS = 'KT1MNxJYowrxgC1FLuN45TyPjzyFEoeHBJa8';
const TEZOS_COLLECTION_CONTRACT = 'KT1RF7ck9WMY6oXQnaZbTyJhwuLx7cPyvbEz';
const TEZOS_COLLECTION_NAMES = { '0':'Ìjòkòó IV','1':'Ìjòkòó I','2':'Ìjòkòó II','3':'Ìjòkòó III','4':'Ìjòkòó V','5':'Ìjòkòó VI','6':'Ìpàdé I' };
const ETH_COLLECTION_CONTRACTS = ['0x824b9144174d0b5c00dbcf39d43d290701e0ffcb','0xd7066137225cb0e1eb3220a2b814ff228e2c0249'];
const ETH_EDITION_TOKEN_ID = 4;
const ETH_COLLECTION_TOKEN_NAMES = {
  '0x824b9144174d0b5c00dbcf39d43d290701e0ffcb:1': 'Ìgbáradì',
  '0xd7066137225cb0e1eb3220a2b814ff228e2c0249:1': "The Chiefs' Meeting",
};
// Additional collection wallets explicitly linked by their holders. These are
// returned only by the authenticated participant feed and are never embedded
// in the public Holder Hub HTML.
const PARTICIPANT_COLLECTION_WALLETS = [
  {
    display_name: 'Spitfingers',
    chain: 'ethereum',
    wallet_address: '0x958b84f8a709fe789b1dfaeb7f76640d5d4970a9',
  },
  {
    display_name: 'Batsoupyum',
    chain: 'ethereum',
    wallet_address: '0xcc6c1d21e8474b3578e69eb036c712ab08ffdfbb',
  },
];

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
  const totalBalance = ENTRY_TOKEN_IDS.reduce((sum, id) => sum + normalized[String(id)], 0);
  const tokenId = normalized['2'] > 0 ? 2 : normalized['1'] > 0 ? 1 : null;
  return {
    totalBalance,
    tokenId,
    tier: tokenId ? HOLDER_TOKEN_TIERS[tokenId] : null,
    hasGoldToken: normalized['3'] > 0,
    balancesByTokenId: normalized,
  };
}

function holderDisplayName(row) {
  return String(row?.display_name || row?.displayName || '').trim();
}

function holderRowKey(row) {
  return String(row?.chain || '') + ':' + String(row?.wallet_address || row?.walletAddress || '').toLowerCase();
}

async function hasHolderForAuthUser(supabase, authUserId) {
  if (!authUserId) return false;
  const { data, error } = await supabase
    .from('holders')
    .select('id')
    .eq('auth_user_id', authUserId)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function checkHolderRowBalances(row) {
  const chain = String(row?.chain || '').toLowerCase();
  const address = row?.wallet_address || row?.walletAddress || '';
  if (!address) return null;
  if (chain === 'tezos') return checkTezosBalances(address);
  if (chain === 'ethereum' || chain === 'eth') return checkEthBalances(normalizeAddress('ethereum', address));
  return null;
}

async function findLinkedHolderRows(supabase, chain, walletAddress, connectedBalancesByTokenId) {
  const selectFields = 'id,auth_user_id,wallet_address,chain,token_balance,display_name,tier,last_verified_at,email_updates_opt_in';
  const linked = [];
  const seen = new Set();
  const addRows = rows => {
    (Array.isArray(rows) ? rows : [rows]).filter(Boolean).forEach(row => {
      const key = holderRowKey(row);
      if (!key || key === ':') return;
      if (seen.has(key)) return;
      seen.add(key);
      linked.push(row);
    });
  };

  const { data: current, error: currentError } = await supabase
    .from('holders')
    .select(selectFields)
    .eq('wallet_address', walletAddress)
    .eq('chain', chain)
    .maybeSingle();
  if (currentError) {
    console.warn('Could not look up holder pair:', currentError.message);
  }
  addRows(current);

  if (current && current.auth_user_id) {
    const { data: authRows, error: authError } = await supabase
      .from('holders')
      .select(selectFields)
      .eq('auth_user_id', current.auth_user_id);
    if (authError) console.warn('Could not look up auth-linked holder wallets:', authError.message);
    else addRows(authRows);
  }

  const displayName = holderDisplayName(current);
  if (displayName) {
    const { data: nameRows, error: nameError } = await supabase
      .from('holders')
      .select(selectFields)
      .eq('display_name', displayName);
    if (nameError) console.warn('Could not look up name-linked holder wallets:', nameError.message);
    else addRows(nameRows);

    // Include explicitly linked collection-only wallets in the signed-in
    // holder response as well as the participant circle. This lets the normal
    // ownership scanner populate "Works You Own" without granting hub access
    // from a wallet that does not contain an entry token.
    addRows(PARTICIPANT_COLLECTION_WALLETS
      .filter(row => holderDisplayName(row).toLowerCase() === displayName.toLowerCase())
      .map(row => ({ ...row, token_balance: 0, tier: null })));
  }

  addRows({
    wallet_address: walletAddress,
    chain,
    token_balance: Object.values(connectedBalancesByTokenId || {}).reduce((sum, value) => sum + Number(value || 0), 0),
    balancesByTokenId: connectedBalancesByTokenId,
    display_name: holderDisplayName(current) || null,
    tier: current?.tier || null,
  });

  return Promise.all(linked.map(async row => {
    const isConnected = row.wallet_address === walletAddress && row.chain === chain;
    let balancesByTokenId = isConnected ? connectedBalancesByTokenId : null;
    let balanceCheckError = null;
    if (!balancesByTokenId) {
      try {
        balancesByTokenId = await checkHolderRowBalances(row);
      } catch (err) {
        balanceCheckError = err.message || String(err);
        console.warn('Could not live-check linked holder wallet:', row.chain, row.wallet_address, err);
      }
    }
    return {
      id: row.id || null,
      auth_user_id: row.auth_user_id || null,
      wallet_address: row.wallet_address,
      chain: row.chain,
      token_balance: Number(row.token_balance || 0),
      display_name: holderDisplayName(row) || null,
      tier: row.tier || null,
      last_verified_at: row.last_verified_at || null,
      email_updates_opt_in: row.email_updates_opt_in === true,
      balancesByTokenId,
      balance_check_error: balanceCheckError,
    };
  }));
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

async function ethCallHex(rpcUrl, contract, data) {
  const payload = { jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to:contract, data }, 'latest'] };
  const response = await fetch(rpcUrl, {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload),
  });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message || 'Ethereum call failed');
  if (!result.result || result.result === '0x') throw new Error('Ethereum call returned no data');
  return result.result;
}

function decodeAbiString(result) {
  const hex = String(result || '').replace(/^0x/, '');
  if (hex.length < 128) return '';
  const offset = Number.parseInt(hex.slice(0,64),16) * 2;
  const length = Number.parseInt(hex.slice(offset,offset + 64),16) * 2;
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return '';
  return Buffer.from(hex.slice(offset + 64,offset + 64 + length),'hex').toString('utf8');
}

async function metadataNameFromUri(uri) {
  try {
    if (uri.startsWith('data:application/json;base64,')) {
      return JSON.parse(Buffer.from(uri.split(',')[1],'base64').toString('utf8'))?.name || '';
    }
    const url = uri.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + uri.slice(7) : uri;
    const response = await fetch(url);
    if (!response.ok) return '';
    return (await response.json())?.name || '';
  } catch (_) { return ''; }
}

async function discoverErc721Names(address, contract, balance) {
  const paddedAddress = address.toLowerCase().replace('0x','').padStart(64,'0');
  let tokenIds = [];
  // Prefer ERC-721 Enumerable: it returns only this owner's current tokens and
  // avoids guessing from historical transfers.
  try {
    tokenIds = await Promise.all(Array.from({ length:balance }, async (_,index) => {
      const raw = await ethCallHex(ETH_RPC_URL,contract,'0x2f745c59' + paddedAddress + BigInt(index).toString(16).padStart(64,'0'));
      return Number.parseInt(raw,16);
    }));
  } catch (_) {
    // Some older contracts omit ERC-721 Enumerable. Mirror the Holder Hub's
    // ownerOf scan and verify every match against the current owner.
    let scanMax = 1500;
    try {
      const supply = await ethCallBalance(ETH_RPC_URL,contract,'0x18160ddd');
      if (Number.isFinite(supply)) scanMax = Math.min(5000,Math.max(250,supply + 50));
    } catch (_) {}
    const wanted = address.toLowerCase();
    for (let start=0; start<=scanMax && tokenIds.length<balance; start+=100) {
      const ids = Array.from({ length:Math.min(100,scanMax-start+1) },(_,i)=>start+i);
      const owners = await Promise.all(ids.map(async id => {
        try {
          const raw = await ethCallHex(ETH_RPC_URL,contract,'0x6352211e' + BigInt(id).toString(16).padStart(64,'0'));
          return '0x' + raw.slice(-40).toLowerCase();
        } catch (_) { return ''; }
      }));
      owners.forEach((owner,index) => { if (owner === wanted) tokenIds.push(ids[index]); });
    }
  }
  const names = [];
  for (const id of tokenIds) {
    const mapped = ETH_COLLECTION_TOKEN_NAMES[contract.toLowerCase() + ':' + id] || '';
    let name = '';
    try {
      const raw = await ethCallHex(ETH_RPC_URL,contract,'0xc87b56dd' + BigInt(id).toString(16).padStart(64,'0'));
      name = await metadataNameFromUri(decodeAbiString(raw));
    } catch (_) {}
    names.push(name || mapped || `Collected work #${id}`);
  }
  return names;
}

async function checkCollectionWorks(row) {
  const chain = String(row?.chain || '').toLowerCase();
  const address = String(row?.wallet_address || row?.walletAddress || '');
  if (!address) return { ownsWork:false, workNames:[] };
  if (chain === 'tezos') {
    const url = 'https://api.tzkt.io/v1/tokens/balances?account=' + encodeURIComponent(address) +
      '&token.contract=' + encodeURIComponent(TEZOS_COLLECTION_CONTRACT) + '&balance.gt=0&limit=200';
    const response = await fetch(url);
    if (!response.ok) throw new Error('TzKT collection lookup returned ' + response.status);
    const rows = await response.json();
    const workNames = (Array.isArray(rows) ? rows : []).map(item => {
      const id = String(item?.token?.tokenId ?? '');
      return TEZOS_COLLECTION_NAMES[id] || item?.token?.metadata?.name || `Collected work #${id}`;
    });
    return { ownsWork:workNames.length > 0, workNames };
  }
  if (chain === 'ethereum' || chain === 'eth') {
    const padded = address.toLowerCase().replace('0x','').padStart(64,'0');
    const erc721Balances = await Promise.all(ETH_COLLECTION_CONTRACTS.map(contract =>
      ethCallBalance(ETH_RPC_URL, contract, '0x70a08231' + padded).catch(() => 0)
    ));
    const editionData = '0x00fdd58e' + padded + BigInt(ETH_EDITION_TOKEN_ID).toString(16).padStart(64,'0');
    const editionBalance = await ethCallBalance(ETH_RPC_URL, ETH_CONTRACT_ADDRESS, editionData).catch(() => 0);
    const discovered = await Promise.all(ETH_COLLECTION_CONTRACTS.map((contract,index) =>
      erc721Balances[index] > 0 ? discoverErc721Names(address,contract,erc721Balances[index]) : []
    ));
    const workNames = discovered.flat();
    if (editionBalance > 0) workNames.push('Lábẹ́ Igi Òroǹbó I');
    return { ownsWork:erc721Balances.some(Number) || editionBalance > 0, workNames:[...new Set(workNames)] };
  }
  return { ownsWork:false, workNames:[] };
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
  const linkedWallets = await findLinkedHolderRows(supabase, chain, normalizedAddress, holderTokens.balancesByTokenId);
  const namedWallet = linkedWallets.find(row => holderDisplayName(row)) || null;
  const displayName = holderDisplayName(namedWallet);
  const authLinkedWallet = linkedWallets.find(row => row.auth_user_id) || null;
  const emailLinked = Boolean(authLinkedWallet);
  const emailUpdatesOptIn = linkedWallets.some(row => row.email_updates_opt_in === true);

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

    const postLinkWallets = await findLinkedHolderRows(supabase, chain, normalizedAddress, holderTokens.balancesByTokenId);
    const namedPostLinkWallet = postLinkWallets.find(row => holderDisplayName(row)) || null;
    const postLinkDisplayName = holderDisplayName(namedPostLinkWallet) || displayName;
    const postLinkEmailUpdatesOptIn = postLinkWallets.some(row => row.email_updates_opt_in === true) || emailUpdatesOptIn;

    return res.status(200).json({
      ok: true,
      mode: 'linked',
      balance,
      tokenId: holderTokens.tokenId,
      tier: holderTokens.tier,
      balancesByTokenId: holderTokens.balancesByTokenId,
      displayName: postLinkDisplayName,
      emailLinked,
      auth_user_id: userData.user.id,
      email_updates_opt_in: postLinkEmailUpdatesOptIn,
      linked_wallets: postLinkWallets.length ? postLinkWallets : linkedWallets,
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
    displayName,
    emailLinked,
    auth_user_id: authLinkedWallet?.auth_user_id || null,
    email_updates_opt_in: emailUpdatesOptIn,
    linked_wallets: linkedWallets,
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

  // If an admin pre-registered paired wallets under the same display name,
  // attach any still-unclaimed companion rows to this account on first claim.
  // Never overwrite a row that is already linked to another auth account.
  const { data: claimedHolder } = await supabase
    .from('holders')
    .select('display_name')
    .eq('wallet_address', pending.wallet_address)
    .eq('chain', pending.chain)
    .maybeSingle();
  const pairedDisplayName = String(claimedHolder?.display_name || '').trim();
  if (pairedDisplayName) {
    const { error: pairError } = await supabase
      .from('holders')
      .update({ auth_user_id: userData.user.id })
      .eq('display_name', pairedDisplayName)
      .is('auth_user_id', null);
    if (pairError) console.warn('Could not attach pre-registered paired wallets:', pairError.message);
  }

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
    let linkedHolder = false;
    try {
      linkedHolder = await hasHolderForAuthUser(supabase, userId);
    } catch (holderError) {
      return res.status(500).json({ error: holderError.message });
    }
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
      authorised = await hasHolderForAuthUser(supabase, userData.user.id);
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

async function isHolderAuthorised(req, supabase) {
  const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const walletClaim = String(req.headers['x-holder-claim'] || '');
  if (accessToken) {
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (!userError && userData && userData.user) {
      return hasHolderForAuthUser(supabase, userData.user.id);
    }
  }
  if (walletClaim) {
    const { data: pending } = await supabase.from('pending_verifications')
      .select('id,expires_at').eq('id', walletClaim).eq('consumed', false).maybeSingle();
    return Boolean(pending && new Date(pending.expires_at) > new Date());
  }
  return false;
}

function normalizeClaimChain(chain) {
  const value = String(chain || '').trim().toLowerCase();
  if (value === 'eth') return 'ethereum';
  if (value === 'ethereum' || value === 'tezos') return value;
  return '';
}

function normalizeClaimWallet(chain, wallet) {
  const value = String(wallet || '').trim();
  return normalizeClaimChain(chain) === 'ethereum' ? value.toLowerCase() : value;
}

function walletKey(row) {
  const chain = normalizeClaimChain(row?.chain);
  const wallet = normalizeClaimWallet(chain, row?.wallet_address || row?.walletAddress || row?.address);
  return chain && wallet ? `${chain}:${wallet.toLowerCase()}` : '';
}

async function getHolderAccessRows(req, supabase) {
  const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const walletClaim = String(req.headers['x-holder-claim'] || '');

  if (accessToken) {
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !userData || !userData.user) return [];

    const selectFields = 'id,auth_user_id,wallet_address,chain,display_name,tier,token_balance,last_verified_at,email_updates_opt_in';
    const { data: authRows, error: authError } = await supabase
      .from('holders')
      .select(selectFields)
      .eq('auth_user_id', userData.user.id);
    if (authError) throw authError;

    const rows = Array.isArray(authRows) ? [...authRows] : [];
    const names = [...new Set(rows.map(holderDisplayName).filter(Boolean))];
    for (const name of names) {
      const { data: nameRows, error: nameError } = await supabase
        .from('holders')
        .select(selectFields)
        .eq('display_name', name);
      if (!nameError && Array.isArray(nameRows)) rows.push(...nameRows);
    }

    const seen = new Set();
    return rows.filter(row => {
      const key = walletKey(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => {
      const named = Number(Boolean(holderDisplayName(b))) - Number(Boolean(holderDisplayName(a)));
      if (named) return named;
      return Date.parse(b.last_verified_at || 0) - Date.parse(a.last_verified_at || 0);
    });
  }

  if (walletClaim) {
    const { data: pending, error } = await supabase
      .from('pending_verifications')
      .select('wallet_address,chain,token_balance,expires_at')
      .eq('id', walletClaim)
      .eq('consumed', false)
      .maybeSingle();
    if (error) throw error;
    if (pending && new Date(pending.expires_at) > new Date()) {
      const linkedRows = await findLinkedHolderRows(
        supabase,
        pending.chain,
        pending.wallet_address,
        null
      );
      return linkedRows.length ? linkedRows : [pending];
    }
  }

  return [];
}

async function handleMerchClaims(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const holderRows = await getHolderAccessRows(req, supabase);
  if (!holderRows.length) return res.status(403).json({ error: 'Holder access required.' });

  const walletKeys = new Set(holderRows.map(walletKey).filter(Boolean));
  let rows = [];
  const { data, error } = await supabase
    .from('holder_merch_claims')
    .select('order_ref,status,requested_qty,fulfilled_qty,wallet_address,chain,contract_address,created_at,fulfilled_at')
    .eq('project', 'apoti-olowe')
    .eq('entitlement_key', 'apoti-olowe-token-2-merch')
    .in('status', ['reserved', 'partial_fulfilled', 'fulfilled'])
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    const missing = error.code === '42P01' || /does not exist|schema cache/i.test(String(error.message || ''));
    if (!missing) return res.status(500).json({ error: error.message });
  } else {
    rows = (Array.isArray(data) ? data : []).filter(row => walletKeys.has(walletKey(row)));
  }

  const reservedQty = rows.reduce((sum, row) => sum + Math.max(0, Number(row.requested_qty || 0)), 0);
  const fulfilledQty = rows.reduce((sum, row) => sum + Math.max(0, Number(row.fulfilled_qty || 0)), 0);
  return res.status(200).json({
    ok: true,
    reserved_qty: reservedQty,
    fulfilled_qty: fulfilledQty,
    claims: rows.map(row => ({
      order_ref: row.order_ref,
      status: row.status,
      requested_qty: Number(row.requested_qty || 0),
      fulfilled_qty: Number(row.fulfilled_qty || 0),
      wallet_address: row.wallet_address,
      chain: row.chain,
      created_at: row.created_at || null,
      fulfilled_at: row.fulfilled_at || null,
    })),
  });
}

async function handleProfile(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const holderRows = await getHolderAccessRows(req, supabase);
  if (!holderRows.length) return res.status(403).json({ error: 'Holder access required.' });

  const primary =
    holderRows.find(row => row.auth_user_id) ||
    holderRows.find(row => holderDisplayName(row)) ||
    holderRows[0];

  return res.status(200).json({
    ok: true,
    holder: primary,
    linked_wallets: holderRows,
  });
}

// -- action=participants ----
// Holder-only participant list, served through the service-role API so the
// dashboard does not depend on a public-view RLS policy being perfectly open.
async function handleParticipants(req, res, supabase, publicAccess = false) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (publicAccess) res.setHeader('Access-Control-Allow-Origin', '*');
  if (!publicAccess) {
    const authorised = await isHolderAuthorised(req, supabase);
    if (!authorised) return res.status(403).json({ error: 'Holder access required.' });
  }

  // This route is holder-authorised, so read the minimal wallet-linking fields
  // directly. auth_user_id lets the client merge a collector's entry-token and
  // artwork wallets even when one row has no display name.
  let { data, error } = await supabase
    .from('holders')
    .select('id,auth_user_id,wallet_address,chain,display_name,tier,created_at')
    .order('created_at', { ascending: true });

  if (error) {
    const fallback = await supabase
      .from('holder_public')
      .select('*')
      .order('created_at', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }

  if (error) return res.status(500).json({ error: error.message });

  const participantRows = Array.isArray(data) ? [...data] : [];
  PARTICIPANT_COLLECTION_WALLETS.forEach(linkedWallet => {
    const alreadyPresent = participantRows.some(row =>
      String(row.chain || '').toLowerCase() === linkedWallet.chain &&
      String(row.wallet_address || '').toLowerCase() === linkedWallet.wallet_address
    );
    if (!alreadyPresent) {
      const namedHolder = participantRows.find(row =>
        holderDisplayName(row).toLowerCase() === holderDisplayName(linkedWallet).toLowerCase()
      );
      participantRows.push({
        ...linkedWallet,
        auth_user_id: namedHolder?.auth_user_id || null,
        tier: null,
        created_at: null,
      });
    }
  });

  // Enrich the private participant feed with Gold-token status while returning
  // no additional public wallet information beyond what this holder-only route
  // already provides. Failure to reach a chain never invents Gold ownership.
  const participants = await Promise.all(participantRows.map(async row => {
    try {
      const [balancesByTokenId, collection] = await Promise.all([
        checkHolderRowBalances(row),
        checkCollectionWorks(row).catch(() => ({ ownsWork:false, workNames:[] })),
      ]);
      const detectedTier = Number(balancesByTokenId?.['2'] || 0) > 0
        ? 'bronze'
        : Number(balancesByTokenId?.['1'] || 0) > 0
          ? 'wood'
          : row.tier;
      return {
        ...row,
        tier: detectedTier || null,
        has_gold_token: Number(balancesByTokenId?.['3'] || 0) > 0,
        owns_work: collection.ownsWork,
        work_names: collection.workNames,
      };
    } catch (err) {
      console.warn('Could not check participant Gold token:', row.chain, row.wallet_address, err.message || err);
      return { ...row, has_gold_token: false };
    }
  }));

  if (publicAccess) {
    return res.status(200).json({ participants: participants.map(row => ({
      participant_key: row.auth_user_id ? `account:${row.auth_user_id}` : `name:${holderDisplayName(row).toLowerCase()}`,
      display_name: holderDisplayName(row) || null,
      wallet_address: row.wallet_address,
      chain: row.chain,
      tier: row.tier || null,
      has_gold_token: row.has_gold_token === true,
      owns_work: row.owns_work === true,
      work_names: Array.isArray(row.work_names) ? row.work_names : [],
    })) });
  }
  return res.status(200).json({ participants });
}

// -- action=email-updates ----
// Holder-controlled opt-in for project update emails from the Holder Hub admin.
async function handleEmailUpdates(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const accessToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!accessToken) return res.status(401).json({ error: 'Missing session token.' });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const enabled = Boolean(req.body && req.body.enabled);
  const { error } = await supabase
    .from('holders')
    .update({ email_updates_opt_in: enabled })
    .eq('auth_user_id', userData.user.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, email_updates_opt_in: enabled });
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
      case 'profile': return await handleProfile(req, res, supabase);
      case 'merch-claims': return await handleMerchClaims(req, res, supabase);
      case 'participants': return await handleParticipants(req, res, supabase);
      case 'public-participants': return await handleParticipants(req, res, supabase, true);
      case 'email-updates': return await handleEmailUpdates(req, res, supabase);
      default:
        return res.status(404).json({ error: `Unknown holder action: ${action}` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error.' });
  }
};
