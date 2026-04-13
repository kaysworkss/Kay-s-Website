// GET /api/hall-of-fame
// Returns all past (ended) challenges with top-3 scores per difficulty tier.
// Used by the Hall of Fame page at /puzzle-hall-of-fame.html
const { getSupabase, cors, handleOptions } = require('./_lib');

const DIFF_TIERS = [
  { label: 'Demo',   cls: 'demo',   range: [1,    48]   },
  { label: 'Easy',   cls: 'easy',   range: [49,   250]  },
  { label: 'Medium', cls: 'medium', range: [251,  600]  },
  { label: 'Hard',   cls: 'hard',   range: [601,  1200] },
  { label: 'Expert', cls: 'expert', range: [1201, Infinity] },
];

function tierForCount(n) {
  return DIFF_TIERS.find(t => n >= t.range[0] && n <= t.range[1]) || DIFF_TIERS[1];
}

module.exports = async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const now = new Date().toISOString();

  // Fetch all challenges (past and present), newest first
  const { data: challenges, error: cErr } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at')
    .order('ends_at', { ascending: false });

  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!challenges || !challenges.length) return res.status(200).json([]);

  // For each challenge, fetch deduplicated top scores
  const results = await Promise.all(
    challenges.map(async (ch) => {
      const { data: scores, error: sErr } = await supabase
        .from('scores')
        .select('player_name, time_seconds, hints_used, created_at')
        .eq('challenge_id', ch.id)
        .order('time_seconds', { ascending: true })
        .limit(200);

      if (sErr || !scores) return { ...ch, entries: [] };

      // Deduplicate: keep best per player
      const seen = new Set();
      const best = scores.filter(s => {
        const key = s.player_name.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 10); // top 10 per challenge

      const tier = tierForCount(ch.piece_count);
      const ended = new Date(ch.ends_at) < new Date(now);

      return {
        id: ch.id,
        title: ch.title,
        image_url: ch.image_url,
        piece_count: ch.piece_count,
        starts_at: ch.starts_at,
        ends_at: ch.ends_at,
        ended,
        tier: tier.label,
        tier_cls: tier.cls,
        entries: best,
      };
    })
  );

  res.status(200).json(results);
};
