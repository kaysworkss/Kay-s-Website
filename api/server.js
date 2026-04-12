'use strict';

// ═══════════════════════════════════════════════════════
//  Àpótí Ọlọ́wẹ̀ — Puzzle Challenge API
//  Express + Supabase · Kaysworks 2026
// ═══════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');

const app  = express();
const port = process.env.PORT || 3001;

// ── Supabase client (service role — bypasses RLS) ──────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Middleware ─────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',   // set to your kaysworks.com domain in prod
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json({ limit: '12mb' }));      // large enough for base64 images

// multer for multipart (not currently used — images come as base64)
const upload = multer({ storage: multer.memoryStorage() });

// ── Admin auth middleware ──────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────────────
//  PUBLIC ROUTES
// ─────────────────────────────────────────────────────

// GET /challenge
// Returns the single currently-active challenge, or 404.
app.get('/challenge', async (req, res) => {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, reward_url, piece_count, starts_at, ends_at')
    .lte('starts_at', now)
    .gte('ends_at', now)
    .order('starts_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'No active challenge at this time.' });
  }
  res.json(data);
});

// GET /leaderboard/:challengeId
// Returns each player's best score for a challenge, grouped by difficulty tier.
// Frontend buckets by piece_count into tiers and shows top-10 per tier.
// We return up to 100 deduplicated scores (10 per tier × up to 6 tiers) so
// all tier leaderboards can be populated from a single request.
app.get('/leaderboard/:challengeId', async (req, res) => {
  const { challengeId } = req.params;

  // Fetch all scores for this challenge, fastest first, including piece_count
  const { data, error } = await supabase
    .from('scores')
    .select('player_name, time_seconds, piece_count, hints_used, ghost_used, created_at')
    .eq('challenge_id', challengeId)
    .order('time_seconds', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Deduplicate: keep only each player's best (fastest) time.
  // Since scores are already sorted fastest-first, the first occurrence per
  // player is always their best — no need to compare.
  const seen = new Set();
  const best = (data || []).filter(s => {
    const key = s.player_name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Return all deduplicated scores — the frontend takes top-10 per tier itself.
  // Cap at 200 to prevent absurdly large responses if a challenge runs long.
  res.json(best.slice(0, 200));
});

// POST /score
// Submit a completed puzzle score.
// Body: { challenge_id, player_name, time_seconds, piece_count?, hints_used?, ghost_used? }
app.post('/score', async (req, res) => {
  const { challenge_id, player_name, time_seconds, piece_count, hints_used, ghost_used } = req.body;

  // Basic validation
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

  // Confirm the challenge exists and is currently active
  const now = new Date().toISOString();
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

  // Insert the score
  const { data: score, error: scoreErr } = await supabase
    .from('scores')
    .insert({
      challenge_id,
      player_name: name,
      time_seconds,
      piece_count:  piece_count  || null,
      hints_used:   Number.isInteger(hints_used)  ? hints_used  : null,
      ghost_used:   Number.isInteger(ghost_used)   ? ghost_used  : null,
    })
    .select('id')
    .single();

  if (scoreErr) return res.status(500).json({ error: scoreErr.message });

  // Calculate rank within the same difficulty tier (same piece_count band).
  // Fetch all scores for this challenge with a faster time, filter to same tier,
  // then count unique players — so rank is meaningful (not comparing 24-piece
  // solves against 1000-piece solves).
  const { data: faster, error: rankErr } = await supabase
    .from('scores')
    .select('player_name, time_seconds, piece_count')
    .eq('challenge_id', challenge_id)
    .lt('time_seconds', time_seconds)
    .order('time_seconds', { ascending: true });

  let rank = 1;
  if (!rankErr && faster) {
    // Only count players in the same difficulty tier (±30% of piece_count)
    const myPc = piece_count || 1000;
    const sameTier = faster.filter(s => {
      const pc = s.piece_count || myPc;
      return pc >= myPc * 0.7 && pc <= myPc * 1.3;
    });
    const uniqueBetter = new Set(sameTier.map(s => s.player_name.trim().toLowerCase()));
    rank = uniqueBetter.size + 1;
  }

  res.status(201).json({ id: score.id, rank });
});

// ─────────────────────────────────────────────────────
//  ADMIN ROUTES  (require x-admin-token header)
// ─────────────────────────────────────────────────────

// POST /admin/login
// Body: { password }  → returns a signed JWT
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// GET /admin/challenges
// All challenges, newest first.
app.get('/admin/challenges', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('challenges')
    .select('id, title, image_url, piece_count, starts_at, ends_at, created_at')
    .order('starts_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /admin/challenge
// Create a new challenge.
// Body: { title, image_url, image_path?, reward_url?, starts_at, ends_at, piece_count }
app.post('/admin/challenge', requireAdmin, async (req, res) => {
  const { title, image_url, image_path, reward_url, starts_at, ends_at, piece_count } = req.body;

  if (!title || !image_url || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'Missing required fields: title, image_url, starts_at, ends_at.' });
  }
  if (new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at.' });
  }

  const { data, error } = await supabase
    .from('challenges')
    .insert({
      title,
      image_url,
      image_path:  image_path  || null,
      reward_url:  reward_url  || null,
      starts_at,
      ends_at,
      piece_count: parseInt(piece_count) || 1000,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /admin/challenge/:id
// Delete a challenge (cascades to scores). Also removes the image from Storage if image_path exists.
app.delete('/admin/challenge/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  // Fetch image_path before deletion so we can clean up storage
  const { data: challenge } = await supabase
    .from('challenges')
    .select('image_path')
    .eq('id', id)
    .single();

  // Delete the DB row (scores cascade)
  const { error } = await supabase.from('challenges').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  // Remove image from Storage if we have the path
  if (challenge?.image_path) {
    await supabase.storage
      .from('puzzle-images')
      .remove([challenge.image_path]);
  }

  res.json({ success: true });
});

// POST /admin/upload-image
// Upload a puzzle image to Supabase Storage.
// Body: { filename, base64, mime_type }  → returns { url, path }
app.post('/admin/upload-image', requireAdmin, async (req, res) => {
  const { filename, base64, mime_type } = req.body;

  if (!filename || !base64 || !mime_type) {
    return res.status(400).json({ error: 'Missing filename, base64, or mime_type.' });
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime_type)) {
    return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG, or WEBP.' });
  }

  const buffer   = Buffer.from(base64, 'base64');
  const ext      = mime_type.split('/')[1].replace('jpeg', 'jpg');
  const safeName = filename.replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
  const path     = `${Date.now()}-${safeName}.${ext}`;

  const { data, error } = await supabase.storage
    .from('puzzle-images')
    .upload(path, buffer, {
      contentType:  mime_type,
      cacheControl: '31536000',   // 1 year — images are immutable once published
      upsert:       false,
    });

  if (error) return res.status(500).json({ error: error.message });

  const { data: { publicUrl } } = supabase.storage
    .from('puzzle-images')
    .getPublicUrl(path);

  res.status(201).json({ url: publicUrl, path });
});

// ─────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'apoti-olowe-api', ts: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Àpótí Ọlọ́wẹ̀ API running on port ${port}`);
});
