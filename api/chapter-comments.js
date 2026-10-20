// Chapter comments for the existing Vercel + Supabase setup.
const { getSupabase } = require('./_lib');
const crypto = require('crypto');
const FIELDS = 'id,chapter_id,parent_id,display_name,body,created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASES = ['2026-05-03', '2026-06-01', '2026-08-03', '2026-09-14', '2026-10-14', '2026-11-09'];
function readerIdentity(req,res) {
  const secret=process.env.COMMENTS_RATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!secret) throw Error('Missing comments secret');
  const hmac=x=>crypto.createHmac('sha256',secret).update(x).digest('hex');
  const cookie=String(req.headers.cookie || '').match(/(?:^|;\s*)ao_reader=([0-9a-f]{32})\.([0-9a-f]{64})(?:;|$)/);
  let id=cookie?.[1];
  if(!id || !crypto.timingSafeEqual(Buffer.from(cookie[2],'hex'),Buffer.from(hmac('cookie:'+id),'hex'))) {
    id=crypto.randomBytes(16).toString('hex');
    const secure=String(req.headers.host || '').startsWith('127.0.0.1:') || String(req.headers.host || '').startsWith('localhost:') ? '' : '; Secure';
    res.setHeader('Set-Cookie',`ao_reader=${id}.${hmac('cookie:'+id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  const ip=String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if(!ip) throw Error('Missing network address');
  return {reader:hmac('reader:'+id),ip:hmac(ip)};
}
function allowedOrigin(req) {
  return !req.headers.origin || new Set(['https://www.kaysworks.com','https://kaysworks.com',process.env.ALLOWED_ORIGIN,process.env.VERCEL_URL && 'https://'+process.env.VERCEL_URL].filter(Boolean)).has(req.headers.origin);
}
function admin(req) {
  const actual = req.headers['x-admin-password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof actual !== 'string') return false;
  const digest = x => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}
function isReleased(chapter) {
  const index = Number(chapter.slice(2)) - 1;
  return Date.now() >= Date.parse(RELEASES[index] + (chapter === 'ch5' ? 'T09:00:00+01:00' : 'T00:00:00+01:00'));
}
async function sendCommentAlert(comment) {
  if (!process.env.RESEND_API_KEY) {
    console.error('[chapter-comments] Email alerts unavailable: RESEND_API_KEY is not configured.');
    return;
  }
  // Match the site's existing form-alert sender and recipient settings.
  const to = (process.env.COMMENTS_ALERT_TO_EMAIL || process.env.FORM_ALERT_TO_EMAIL || 'oyeniyikayode4@gmail.com').split(',').map(x=>x.trim()).filter(Boolean);
  const from = process.env.COMMENTS_ALERT_FROM_EMAIL || process.env.FORM_ALERT_FROM_EMAIL || "Kay's Works Queue <auction@mail.kaysworks.com>";
  const moderation = 'https://www.kaysworks.com/comments-admin';
  const chapterLink = 'https://www.kaysworks.com/apoti-olowe#script-'+comment.chapter_id;
  const chapterLabel = 'Chapter '+comment.chapter_id.slice(2);
  const kind = comment.parent_id ? 'reply' : 'comment';
  const escape = value => String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Resend deduplicates retries with the same comment ID for 24 hours.
  // Ignore stale replays once that window has expired.
  if (Date.now()-Date.parse(comment.created_at)>23*60*60*1000) return;
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'chapter-comment-'+comment.id},
    signal:AbortSignal.timeout(4000),
    body:JSON.stringify({from,to,subject:`New ${kind} on Àpótí Ọlọ́wẹ̀ · ${chapterLabel}`,
      text:`${chapterLabel} — New ${kind}\n\n${comment.display_name} wrote:\n\n${comment.body}\n\nRead the chapter: ${chapterLink}\nModerate comments: ${moderation}\n\nDisplay names are provided by readers and are not verified.`,
      html:`<h2>${chapterLabel} — New ${kind}</h2><p><strong>${escape(comment.display_name)}</strong> wrote:</p><p style="white-space:pre-wrap">${escape(comment.body)}</p><p><a href="${chapterLink}">Read the chapter</a> · <a href="${moderation}">Manage comments</a></p><p style="font-size:12px;color:#666">Display names are provided by readers and are not verified.</p>`})
  });
  if(!response.ok)throw new Error('Resend returned '+response.status);
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Same-origin browser requests; do not grant cross-origin access to admin headers.
  if (req.method === 'OPTIONS') return res.status(204).end();
  const moderate = req.query.action === 'moderate';
  if ((moderate || req.method === 'PATCH') && !admin(req)) return res.status(401).json({error:'Please sign in.'});
  try {
    if (!['GET','POST','PATCH'].includes(req.method)) {
      res.setHeader('Allow','GET, POST, PATCH');
      return res.status(405).json({error:'Method not allowed.'});
    }
    let payload = {};
    if (req.method !== 'GET') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).json({error:'Send JSON.'});
      try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
      catch { return res.status(400).json({error:'Invalid request.'}); }
      if (Array.isArray(payload) || typeof payload !== 'object') return res.status(400).json({error:'Invalid request.'});
      if (Buffer.byteLength(JSON.stringify(payload)) > 20000) return res.status(413).json({error:'Comment is too long.'});
    }
    const chapter = req.method === 'GET' ? req.query.chapter : payload.chapter;
    if (req.method !== 'PATCH' && !/^ch[1-6]$/.test(chapter || '')) return res.status(400).json({error:'Choose a chapter.'});
    if (!moderate && req.method !== 'PATCH' && !isReleased(chapter)) return res.status(403).json({error:'Comments open when this chapter is released.'});
    const db = getSupabase();
    if (req.method === 'PATCH') {
      if (!UUID.test(payload.id || '') || !['visible','hidden'].includes(payload.status)) return res.status(400).json({error:'Invalid moderation request.'});
      const {data,error} = await db.from('chapter_comments').update({status:payload.status}).eq('id',payload.id).select('id,status').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({error:'Comment not found.'});
      return res.status(200).json(data);
    }
    if (req.method === 'GET') {
      if (moderate) {
        const {data,error} = await db.from('chapter_comments').select(FIELDS+',status').eq('chapter_id',chapter).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(200);
        if(error) throw error;
        return res.status(200).json({comments:data || []});
      }
      if(req.query.view==='discussion') {
        const sort=req.query.sort || 'best', offset=Number(req.query.offset || 0);
        if(!['best','new','old'].includes(sort) || !Number.isInteger(offset) || offset<0 || offset>100000) return res.status(400).json({error:'Invalid comment order or page.'});
        const identity=readerIdentity(req,res);
        const {data,error}=await db.rpc('read_chapter_discussion',{p_chapter:chapter,p_reader:identity.reader,p_sort:sort,p_offset:offset});
        if(error) throw error;
        return res.status(200).json(data);
      }
      let query = db.from('chapter_comments').select(FIELDS).eq('chapter_id',chapter).eq('status','visible').is('parent_id',null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(21);
      if (req.query.before) {
        let cursor;
        try { cursor = JSON.parse(Buffer.from(req.query.before,'base64url').toString()); } catch { return res.status(400).json({error:'Invalid page.'}); }
        if (!UUID.test(cursor.id || '') || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|\+00:00)$/.test(cursor.at || '') || !Number.isFinite(Date.parse(cursor.at))) return res.status(400).json({error:'Invalid page.'});
        query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
      }
      const {data,error} = await query;
      if(error) throw error;
      const roots=(data || []).slice(0,20);
      let replies=[];
      if(roots.length) {
        const result=await db.from('chapter_comments').select(FIELDS).eq('chapter_id',chapter).eq('status','visible').in('parent_id',roots.map(c=>c.id)).order('created_at',{ascending:true}).limit(1000);
        if(result.error) throw result.error;
        replies=result.data || [];
      }
      const last=roots[roots.length-1];
      return res.status(200).json({comments:roots.map(c=>({...c,replies:replies.filter(r=>r.parent_id===c.id)})),next_cursor:data.length>20?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null});
    }
    if(payload.action==='reaction' || payload.action==='like') {
      if(!allowedOrigin(req)) return res.status(403).json({error:'Please react from the website.'});
      if(payload.action==='reaction' && payload.value!==null && !['upvote','funny','love','surprised','angry','sad'].includes(payload.value)) return res.status(400).json({error:'Choose a reaction.'});
      if(payload.action==='like' && (!UUID.test(payload.comment_id || '') || typeof payload.enabled!=='boolean')) return res.status(400).json({error:'Choose a comment.'});
      const identity=readerIdentity(req,res);
      const {data,error}=await db.rpc('set_chapter_engagement',{p_chapter:chapter,p_reader:identity.reader,p_ip:identity.ip,p_kind:payload.action,p_value:payload.value || null,p_comment:payload.comment_id || null,p_enabled:payload.enabled || false});
      if(error?.message?.includes('engagement_rate_limit')) {res.setHeader('Retry-After','60');return res.status(429).json({error:'Please wait a moment before reacting again.'});}
      if(error?.message?.includes('engagement_invalid')) return res.status(400).json({error:'This reaction is no longer available.'});
      if(error)throw error;
      return res.status(200).json(data);
    }
    if(payload.action) return res.status(400).json({error:'Unknown action.'});
    const name=typeof payload.name==='string'?payload.name.trim():'';
    const body=typeof payload.body==='string'?payload.body.trim():'';
    if(name.length<1 || name.length>60 || body.length<1 || body.length>3000 || !UUID.test(payload.request_id || '') || (payload.parent_id && !UUID.test(payload.parent_id))) return res.status(400).json({error:'Enter a name (up to 60 characters) and a comment (up to 3,000 characters).'});
    if(payload.website) return res.status(400).json({error:'Unable to post this comment.'});
    if((body.match(/https?:\/\//gi)||[]).length>2) return res.status(400).json({error:'Please include no more than two links.'});
    const origin=req.headers.origin;
    const allowed=new Set(['https://www.kaysworks.com','https://kaysworks.com',process.env.ALLOWED_ORIGIN,process.env.VERCEL_URL && 'https://'+process.env.VERCEL_URL].filter(Boolean));
    if(origin && !allowed.has(origin)) return res.status(403).json({error:'Please post from the website.'});
    const ip=String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    if(!ip) return res.status(400).json({error:'Unable to verify this request.'});
    const secret=process.env.COMMENTS_RATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!secret) throw new Error('Missing database configuration');
    const ipHash=crypto.createHmac('sha256',secret).update(ip).digest('hex');
    const {data,error}=await db.rpc('submit_chapter_comment',{p_chapter:chapter,p_name:name,p_body:body,p_parent:payload.parent_id || null,p_ip_hash:ipHash,p_request_id:payload.request_id});
    if(error) {
      if(error.message?.includes('comment_rate_limit')) { res.setHeader('Retry-After','30'); return res.status(429).json({error:'Please wait before posting again. You can post up to 10 comments per hour.'}); }
      if(error.message?.includes('comment_parent_invalid')) return res.status(400).json({error:'This conversation is no longer available. Refresh the comments.'});
      throw error;
    }
    // Await delivery attempt so Vercel does not stop it after the response.
    // A mail-provider outage must not undo a successfully saved comment.
    try { await sendCommentAlert(data); }
    catch(error) { console.error('[chapter-comments] Email alert failed:',error.message); }
    return res.status(201).json({comment:data});
  } catch(error) {
    console.error('[chapter-comments]',error.code || error.message);
    return res.status(503).json({error:'Comments are temporarily unavailable. Please try again later.'});
  }
};
