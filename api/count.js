// Vercel serverless function: one "yes" per device, stored in Upstash Redis.
// A device is identified by TWO things: a browser ID (localStorage) and a server-set cookie.
// Clearing only one of them does not allow a second vote.
const crypto = require('crypto');
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'fin10_fin11_yes_ids';        // one entry per vote (this is the count)
const ALIAS = 'fin10_fin11_yes_aliases';   // every device ID that has voted
const RANKS = 'fin10_fin11_yes_ranks';     // device ID -> "you were Nth" (votes before this feature have no rank)
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

async function redis(...parts) {
  const path = parts.map(encodeURIComponent).join('/');
  const r = await fetch(`${URL_}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error('redis error');
  return (await r.json()).result;
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Redis not configured' });
  const id = String((req.query && req.query.id) || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let cid = getCookie(req, 'vid');
  if (!ID_RE.test(cid)) {
    cid = crypto.randomUUID();
    res.setHeader('Set-Cookie', `vid=${cid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  }

  try {
    const hasVoted = async () => {
      const r = await Promise.all([
        redis('sismember', KEY, id),
        redis('sismember', ALIAS, id),
        redis('sismember', ALIAS, cid),
      ]);
      return r.some((x) => x === 1);
    };

    let voted = await hasVoted();
    let added = false;
    let rank = null;
    if (req.method === 'POST' && !voted) {
      // sadd returns 1 only for the first request, so double-clicks can't double count
      const first = await redis('sadd', ALIAS, cid);
      if (first === 1) {
        await Promise.all([redis('sadd', KEY, id), redis('sadd', ALIAS, id)]);
        rank = Number(await redis('scard', KEY));
        await Promise.all([redis('hset', RANKS, id, rank), redis('hset', RANKS, cid, rank)]);
        added = true;
      }
      voted = true;
    }
    if (voted && rank === null) {
      const r = await Promise.all([redis('hget', RANKS, id), redis('hget', RANKS, cid)]);
      const found = r.find((x) => x !== null && x !== undefined);
      rank = found ? Number(found) : null;
      // link both IDs to this vote so clearing either one later doesn't reset it
      const writes = [redis('sadd', ALIAS, id), redis('sadd', ALIAS, cid)];
      if (rank) writes.push(redis('hset', RANKS, id, rank), redis('hset', RANKS, cid, rank));
      await Promise.all(writes);
    }

    const count = await redis('scard', KEY);
    res.status(200).json({ count: Number(count), voted, added, rank });
  } catch (e) {
    res.status(500).json({ error: 'Counter unavailable' });
  }
};
