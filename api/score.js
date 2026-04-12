// POST /api/score
// Submit a completed puzzle score.
// Body: { challenge_id, player_name, time_seconds, piece_count?, hints_used?, ghost_used? }
const { getSupabase, cors, handleOptions } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge_id, player_name, time_seconds, piece_count, hints_used, ghost_used } = req.body;

  // Validation
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

  const supabase = getSupabase();
  const now = new Date().toISOString();

  // Confirm challenge is currently active
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
      player_name:  name,
      time_seconds,
      piece_count:  piece_count || null,
      hints_used:   Number.isInteger(hints_used) ? hints_used : null,
      ghost_used:   Number.isInteger(ghost_used)  ? ghost_used  : null,
    })
    .select('id')
    .single();

  if (scoreErr) return res.status(500).json({ error: scoreErr.message });

  // Calculate rank within same difficulty tier (±30% piece count)
  const { data: faster, error: rankErr } = await supabase
    .from('scores')
    .select('player_name, time_seconds, piece_count')
    .eq('challenge_id', challenge_id)
    .lt('time_seconds', time_seconds)
    .order('time_seconds', { ascending: true });

  let rank = 1;
  if (!rankErr && faster) {
    const myPc = piece_count || 1000;
    const sameTier = faster.filter(s => {
      const pc = s.piece_count || myPc;
      return pc >= myPc * 0.7 && pc <= myPc * 1.3;
    });
    const uniqueBetter = new Set(sameTier.map(s => s.player_name.trim().toLowerCase()));
    rank = uniqueBetter.size + 1;
  }

  res.status(201).json({ id: score.id, rank });
};
