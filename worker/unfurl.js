// Link previews: fetch a page's title, description and image for cards in the feed.
// Browsers can't read other sites' pages, so the Worker does it, carefully:
// public http(s) addresses only, a few checked redirects, a capped read, and a day of caching.

const MAX_BYTES = 300_000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; TabbyCatsBot/1.0; +https://tabbycats.party)';

// Refuse anything that isn't an ordinary public web address
function publicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost') || h === 'localhost') return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null; // no raw IP addresses
  if (h === 'tabbycats.party' || h.endsWith('.tabbycats.party')) return null;
  return u;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const clean = (s, max) => (typeof s === 'string' ? decode(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function parse(html, base) {
  const head = html.slice(0, MAX_BYTES);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
  }
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  // Farcaster mini apps describe their card in JSON
  let mini = {};
  try {
    mini = JSON.parse(decode(meta['fc:miniapp'] || meta['fc:frame'] || '{}'));
  } catch {
    /* not JSON (old-style frames) */
  }
  const image = [meta['og:image'], meta['og:image:url'], meta['twitter:image'], mini?.imageUrl, meta['fc:frame:image']].find(
    (v) => typeof v === 'string' && v,
  );
  let imageUrl = '';
  if (image) {
    try {
      const u = new URL(decode(image), base);
      if (u.protocol === 'https:' && u.href.length <= 1000) imageUrl = u.href;
    } catch {
      /* skip */
    }
  }
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || mini?.button?.action?.name || titleTag, 200),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300),
    site: clean(meta['og:site_name'] || mini?.button?.action?.name, 60),
    image: imageUrl,
  };
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c.subarray(0, Math.min(c.length, size - at)), at), (at += c.length);
  return new TextDecoder().decode(all);
}

async function lookup(start) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.href, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(5000),
      cf: { cacheTtl: 3600 },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      res.body?.cancel();
      url = next ? publicUrl(new URL(next, url).href) : null;
      if (!url) return {};
      continue;
    }
    if (!res.ok) return {};
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      res.body?.cancel();
      return {};
    }
    return parse(await readCapped(res), url);
  }
  return {};
}

// YouTube doesn't give its pages to bots, but has an official preview service
async function youtube(url) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return {};
  const d = await res.json();
  const image = typeof d.thumbnail_url === 'string' && d.thumbnail_url.startsWith('https://') ? d.thumbnail_url : '';
  return { title: clean(d.title, 200), description: clean(d.author_name, 300), site: 'YouTube', image };
}
const isYouTube = (h) => /(^|\.)youtube\.com$/.test(h) || h === 'youtu.be';

// TabbyCats' own links (shared feeds especially) are read straight from storage
async function ownLink(url, env) {
  const base = { site: 'TabbyCats', image: 'https://tabbycats.party/og-5.png' };
  const id = url.pathname.match(/^\/f\/([A-Za-z0-9]{8})$/)?.[1];
  const raw = id ? await env.FEEDS.get(id) : null;
  if (raw) {
    const f = JSON.parse(raw);
    const count = `${f.m.length} ${f.m.length === 1 ? 'account' : 'accounts'}`;
    return { ...base, title: `${f.e} ${f.n}`, description: f.d || `A TabbyCats feed, ${count}. Add it to your board in one click, meow!` };
  }
  return { ...base, title: 'TabbyCats', description: 'Curate multiple feeds on Farcaster & Hypersnap in a single client, meow!' };
}

export async function unfurl(request, env, ctx) {
  const asked = new URL(request.url).searchParams.get('url') ?? '';
  const reply = (data, maxAge) =>
    new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` } });
  try {
    const own = new URL(asked);
    if (own.protocol === 'https:' && /^(www\.)?tabbycats?\.party$/.test(own.hostname)) return reply(await ownLink(own, env), 300);
  } catch {
    /* checked below */
  }
  const target = publicUrl(asked);
  if (!target) return reply({}, 86400);
  const cacheKey = new Request(`https://tabbycats.party/api/unfurl?url=${encodeURIComponent(target.href)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  let data = {};
  try {
    data = isYouTube(target.hostname.toLowerCase()) ? await youtube(target) : await lookup(target);
  } catch {
    data = {};
  }
  const res = reply(data, data.title ? 86400 : 600); // retry empty ones sooner
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}
