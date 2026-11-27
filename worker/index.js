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
  "img-src 'self' https: data:",
  "connect-src 'self' https://snap.farcaster.xyz:3381 https://haatz.quilibrium.com https://api.farcaster.xyz",
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
    e: text(d.e, 8) || '📋',
    src: ['combined', 'farcaster', 'hypersnap'].includes(d.src) ? d.src : 'combined',
    m: fids,
    names,
  };
}

async function createFeed(request, env) {
  const feed = cleanFeed(await request.json().catch(() => null));
  if (!feed) return json({ error: 'Invalid feed' }, 400);
  const id = newFeedId();
  await env.FEEDS.put(id, JSON.stringify(feed));
  return json({ id, url: `https://${CANONICAL}/f/${id}` });
}

async function feedPage(request, env, id) {
  const raw = await env.FEEDS.get(id);
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  if (!raw) return withSecurityHeaders(page);
  const f = JSON.parse(raw);
  const count = `${f.m.length} ${f.m.length === 1 ? 'account' : 'accounts'}`;
  const who = f.names.length ? `: ${f.names.map((n) => '@' + n).join(', ')}${f.m.length > f.names.length ? ` and ${f.m.length - f.names.length} more` : ''}` : '';
  const title = `${f.e} ${f.n}`;
  const desc = `A TabbyCats feed on ${SOURCE_TAG[f.src]}, ${count}${who}. Add it to your board in one click, meow!`;
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

export default {
  async fetch(request, env) {
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
    const feedApi = url.pathname.match(/^\/api\/feeds\/([A-Za-z0-9]{8})$/);
    if (request.method === 'GET' && feedApi) {
      const raw = await env.FEEDS.get(feedApi[1]);
      return raw ? new Response(raw, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } }) : json({ error: 'Not found' }, 404);
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
