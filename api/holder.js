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
