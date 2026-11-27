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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Ask the Farcaster app to let a user approve a new posting key for TabbyCats.
async function signerRequest(request, env) {
  const { key } = await request.json().catch(() => ({}));
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) return json({ error: 'Invalid key' }, 400);
  const account = privateKeyToAccount(env.APP_CUSTODY_KEY);
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
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
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && url.hostname.endsWith('.party')) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (request.method === 'POST' && url.pathname === '/api/signer-request') return signerRequest(request, env);
    if (request.method === 'POST' && url.pathname === '/api/submit') return submit(request);
    return env.ASSETS.fetch(request);
  },
};
