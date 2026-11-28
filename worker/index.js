// Serves the built app, redirects the other domains to tabbycats.party, and runs two
// small endpoints that need the app account's key or can't be called from a browser.
import { privateKeyToAccount } from 'viem/accounts';

const CANONICAL = 'tabbycats.party';
const APP_FID = 3359500; // @tabbycats
const FARCASTER_NODE = 'https://snap.farcaster.xyz:3381';
const SIGNED_KEY_REQUEST = {
  domain: {
    name: 'Farcaster SignedKeyRequestValidator',
    version: '1',
    chainId: 10,
    verifyingContract: '0x00000000FC700472606ED4fA22623Acf62c60553',
  },
  types: {
    SignedKeyRequest: [
      { name: 'requestFid', type: 'uint256' },
      { name: 'key', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
};

const HSTS = 'max-age=63072000; includeSubDomains; preload';
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'strict-transport-security': HSTS, 'x-content-type-options': 'nosniff' },
  });

// Ask the Farcaster app to let a user approve a new posting key for TabbyCats.
async function signerRequest(request, env) {
  const { key } = (await request.json().catch(() => null)) ?? {};
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) return json({ error: 'Invalid key' }, 400);
  const account = privateKeyToAccount(env.APP_CUSTODY_KEY);
  const deadline = Math.floor(Date.now() / 1000) + 15 * 60; // short-lived: limits misuse of a leaked request
  const signature = await account.signTypedData({
    ...SIGNED_KEY_REQUEST,
    primaryType: 'SignedKeyRequest',
    message: { requestFid: BigInt(APP_FID), key, deadline: BigInt(deadline) },
  });
  const res = await fetch('https://api.farcaster.xyz/v2/signed-key-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, requestFid: APP_FID, signature, deadline }),
  });
  const body = await res.json().catch(() => ({}));
  const req = body?.result?.signedKeyRequest;
  if (!res.ok || !req) return json({ error: 'Farcaster did not accept the request' }, 502);
  return json({ token: req.token, deeplinkUrl: req.deeplinkUrl });
}

// Forward a signed message to the Farcaster node (its CORS preflight fails in browsers).
async function submit(request) {
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 4096) return json({ error: 'Bad message' }, 400);
  const res = await fetch(`${FARCASTER_NODE}/v1/submitMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'strict-transport-security': HSTS },
  });
}

// Locks down what the page may load: only TabbyCats' own scripts can run (the main defence
// against injected content), it can only fetch from TabbyCats and the two network nodes, and
// other sites can't frame it to trick clicks. Images may come from any https host.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' https://snap.farcaster.xyz:3381 https://haatz.quilibrium.com https://hypersnap.rainonmeproductions.com https://blossom.primal.net https://nostr.download https://blossom.band https://api.farcaster.xyz",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set('content-security-policy', CSP);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  out.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  out.headers.set('strict-transport-security', HSTS);
  return out;
}

// ---- Shared feeds: short links with their own link previews ----
const FEED_ID = /^[A-Za-z0-9]{8}$/;
const SOURCE_TAG = { combined: 'Farcaster & Hypersnap', farcaster: 'Farcaster', hypersnap: 'Hypersnap' };

function newFeedId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => abc[b % abc.length]).join('');
}

// Accept only the fields a feed needs, with sane sizes (it all ends up in other people's previews).
function cleanFeed(d) {
  const fids = Array.isArray(d?.m) ? [...new Set(d.m.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 1000) : [];
  if (!fids.length) return null;
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');
  const names = Array.isArray(d?.names) ? d.names.filter((n) => typeof n === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(n)).slice(0, 3) : [];
  return {
    n: text(d.n, 60) || 'Shared feed',
    d: text(d.d, 200),
    e: text(d.e, 8) || '📋',
    src: ['combined', 'farcaster', 'hypersnap'].includes(d.src) ? d.src : 'combined',
    m: fids,
    names,
  };
}

async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const newToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A synced feed comes with an edit token for the curator's browser; only its hash is stored.
async function createFeed(request, env) {
  const body = await request.json().catch(() => null);
  const feed = cleanFeed(body);
  if (!feed) return json({ error: 'Invalid feed' }, 400);
  const id = newFeedId();
  if (body.live === true) {
    const token = newToken();
    await env.FEEDS.put(id, JSON.stringify({ ...feed, live: true, key: await sha256hex(token) }));
    return json({ id, url: `https://${CANONICAL}/f/${id}`, token });
  }
  await env.FEEDS.put(id, JSON.stringify(feed));
  return json({ id, url: `https://${CANONICAL}/f/${id}` });
}

// The curator's edits to a synced feed
async function updateFeed(request, env, id) {
  const raw = await env.FEEDS.get(id);
  if (!raw) return json({ error: 'Not found' }, 404);
  const stored = JSON.parse(raw);
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!stored.live || !stored.key || !token || (await sha256hex(token)) !== stored.key) return json({ error: 'Forbidden' }, 403);
  const feed = cleanFeed(await request.json().catch(() => null));
  if (!feed) return json({ error: 'Invalid feed' }, 400);
  await env.FEEDS.put(id, JSON.stringify({ ...feed, live: true, key: stored.key }));
  return json({ ok: true });
}

async function feedPage(request, env, id) {
  const raw = await env.FEEDS.get(id);
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  if (!raw) return withSecurityHeaders(page);
  const f = JSON.parse(raw);
  const count = `${f.m.length} ${f.m.length === 1 ? 'account' : 'accounts'}`;
  const who = f.names.length ? `: ${f.names.map((n) => '@' + n).join(', ')}${f.m.length > f.names.length ? ` and ${f.m.length - f.names.length} more` : ''}` : '';
  const title = `${f.e} ${f.n}`;
  // The curator's own description if there is one; otherwise who's in it
  const desc = f.d || `A TabbyCats feed on ${SOURCE_TAG[f.src]}, ${count}${who}. Add it to your board in one click, meow!`;
  const set = (attr) => ({ element: (el) => el.setAttribute('content', attr) });
  const rewritten = new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(`${title} · TabbyCats`) })
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[name="twitter:description"]', set(desc))
    .on('meta[name="description"]', set(desc))
    .on('meta[property="og:url"]', set(`https://${CANONICAL}/f/${id}`))
    .transform(page);
  return withSecurityHeaders(rewritten);
}

// ---- Channels: Farcaster's channel list, kept in KV and searched here ----
// (browsers can't call Farcaster's API directly; a daily refresh keeps it current, and the
// last saved copy keeps working if Farcaster's API refuses us)
const CHANNEL_KEY = 'channel-list'; // not 8 alphanumerics, so it can't collide with a feed id
let channelCache; // { updatedAt, list } per Worker instance

async function channelList(env, ctx) {
  if (!channelCache) channelCache = JSON.parse((await env.FEEDS.get(CHANNEL_KEY)) ?? '{"updatedAt":0,"list":[]}');
  if (Date.now() - channelCache.updatedAt > 24 * 3600 * 1000) {
    channelCache.updatedAt = Date.now(); // one refresh attempt per instance per day
    ctx.waitUntil(
      (async () => {
        const res = await fetch('https://api.farcaster.xyz/v2/all-channels', { headers: { 'user-agent': 'TabbyCats (+https://tabbycats.party)' } });
        if (!res.ok) return;
        const list = ((await res.json())?.result?.channels ?? [])
          .filter((c) => c.url)
          .map((c) => ({ id: c.id, n: c.name ?? '', u: c.url, i: c.imageUrl ?? '', f: c.followerCount ?? 0 }))
          .sort((a, b) => b.f - a.f);
        if (list.length > 1000) {
          channelCache = { updatedAt: Date.now(), list };
          await env.FEEDS.put(CHANNEL_KEY, JSON.stringify(channelCache));
        }
      })().catch(() => {}),
    );
  }
  return channelCache.list;
}

async function searchChannels(url, env, ctx) {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().replace(/^\//, '').slice(0, 40);
  const list = await channelList(env, ctx);
  const out = !q
    ? list.slice(0, 8)
    : [
        ...list.filter((c) => c.id === q),
        ...list.filter((c) => c.id !== q && c.id.startsWith(q)),
        ...list.filter((c) => !c.id.startsWith(q) && c.n.toLowerCase().includes(q)),
      ].slice(0, 8);
  return new Response(JSON.stringify(out.map(({ id, n, u, i }) => ({ id, name: n, url: u, image: i }))), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'strict-transport-security': HSTS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Always encrypted, always on the main domain (a tampered plain-HTTP page could capture a recovery phrase)
    if (url.protocol === 'http:' || (url.hostname !== CANONICAL && url.hostname.endsWith('.party'))) {
      url.protocol = 'https:';
      if (url.hostname.endsWith('.party')) url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (request.method === 'POST' && url.pathname === '/api/signer-request') {
      // Only TabbyCats' own pages may start a sign-in (raises the bar for look-alike sites).
      if (request.headers.get('origin') !== `https://${CANONICAL}`) return json({ error: 'Forbidden' }, 403);
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (env.SIGNIN_LIMIT && !(await env.SIGNIN_LIMIT.limit({ key: ip })).success)
        return json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429);
      return signerRequest(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/feeds') {
      if (request.headers.get('origin') !== `https://${CANONICAL}`) return json({ error: 'Forbidden' }, 403);
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (env.SHARE_LIMIT && !(await env.SHARE_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many shares. Try again in a minute.' }, 429);
      return createFeed(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/channels') return searchChannels(url, env, ctx);
    const feedApi = url.pathname.match(/^\/api\/feeds\/([A-Za-z0-9]{8})$/);
    if (request.method === 'GET' && feedApi) {
      const raw = await env.FEEDS.get(feedApi[1]);
      if (!raw) return json({ error: 'Not found' }, 404);
      const { key, ...feed } = JSON.parse(raw); // never hand out the edit token's hash
      return new Response(JSON.stringify(feed), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${feed.live ? 30 : 300}` },
      });
    }
    if (request.method === 'PUT' && feedApi) {
      if (request.headers.get('origin') !== `https://${CANONICAL}`) return json({ error: 'Forbidden' }, 403);
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (env.SHARE_LIMIT && !(await env.SHARE_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many updates. Try again in a minute.' }, 429);
      return updateFeed(request, env, feedApi[1]);
    }
    const feedLink = url.pathname.match(/^\/f\/([A-Za-z0-9]{8})$/);
    if (request.method === 'GET' && feedLink && FEED_ID.test(feedLink[1])) return feedPage(request, env, feedLink[1]);
    if (request.method === 'POST' && url.pathname === '/api/submit') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (env.SUBMIT_LIMIT && !(await env.SUBMIT_LIMIT.limit({ key: ip })).success) return json({ error: 'Slow down a little' }, 429);
      return submit(request);
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
