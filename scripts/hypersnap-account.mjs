// Create TabbyCats' native Hypersnap account (free: a signed onboarding message plus a small
// proof of work), add a posting key, and set the profile. Uses the same recovery-phrase wallet
// as @tabbycats on Farcaster. Idempotent: safe to re-run.
//
// Message formats follow Quilcast's client (quilcast.com), which talks to the same node.
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { mnemonicToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';

const DIR = `${process.env.HOME}/.tabbycats`;
const NODE = 'https://haatz.quilibrium.com';
const FARCASTER_EPOCH = 1609459200;
const PROFILE = {
  2: 'TabbyCats', // DISPLAY
  1: 'https://tabbycats.party/pfp-2.png', // PFP
  3: 'Curate multiple feeds on Farcaster & Hypersnap in a single client, meow! 😺', // BIO
  5: 'https://tabbycats.party', // URL
};

// --- tiny protobuf helpers (same semantics as Quilcast's) ---
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const toHex = (b) => '0x' + Buffer.from(b).toString('hex');
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  while (v >= 128n) {
    out.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
};
const proto = (...fields) =>
  cat(
    ...fields.flatMap(([f, v]) => {
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return [];
      if (typeof v === 'number' || typeof v === 'bigint') return [varint(f << 3), varint(v)];
      const b = typeof v === 'string' ? utf8(v) : Array.isArray(v) ? cat(...v.map(varint)) : v;
      return [varint((f << 3) | 2), varint(b.length), b];
    }),
  );
const uint256 = (n) => hex(BigInt(n).toString(16).padStart(64, '0'));
const now = () => Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;
const sha256 = (b) => createHash('sha256').update(b).digest();

async function submit(msg) {
  const res = await fetch(`${NODE}/v1/submitMessage`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: msg });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text;
}

async function nativeFid(address) {
  const res = await fetch(`${NODE}/v1/nativeAccount?custody=${address}`);
  const body = await res.json().catch(() => ({}));
  if (res.ok) return Number(body.fid);
  if (/NotFound/.test(body.error_detail ?? '')) return 0;
  throw new Error(body.error ?? `HTTP ${res.status}`);
}

const custody = mnemonicToAccount(fs.readFileSync(`${DIR}/recovery-phrase.txt`, 'utf8').trim());
console.log('custody', custody.address);

// 1. Register the account
let fid = await nativeFid(custody.address);
if (!fid) {
  const reg = await fetch(`${NODE}/v1/nativeRegistration`).then((r) => r.json());
  if (!reg.active) throw new Error('Hypersnap is not taking new accounts right now');
  const bits = reg.minDifficultyBits;
  if (!(bits >= 1 && bits <= 28)) throw new Error(`Unexpected difficulty ${bits}`);

  // Proof of work: sha256(prefix || address || anchorHash || nonce8) must start with `bits` zero bits
  const prefix = cat(utf8('hyper.onboard.pow:'), hex(custody.address), hex(reg.anchorBlockHash));
  const leadingZeros = (h) => {
    const full = bits >> 3;
    for (let i = 0; i < full; i++) if (h[i]) return false;
    return !(bits & 7) || h[full] < 1 << (8 - (bits & 7));
  };
  const buf = Buffer.alloc(prefix.length + 8);
  buf.set(prefix);
  const t0 = Date.now();
  let nonce;
  for (let i = 0; ; i++) {
    buf.writeUInt32BE(Math.floor(i / 2 ** 32), prefix.length);
    buf.writeUInt32BE(i >>> 0, prefix.length + 4);
    if (leadingZeros(sha256(buf))) {
      nonce = Uint8Array.from(buf.subarray(prefix.length));
      console.log(`proof of work: ${i + 1} tries, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      break;
    }
  }

  const commitment = sha256(cat(utf8('hyper.onboard.pow.commitment:'), nonce, uint256(bits).slice(28)));
  const signature = await custody.signTypedData({
    domain: { name: 'HypersnapNativeOnboard', version: '1', chainId: 10 },
    primaryType: 'HyperNativeOnboard',
    types: {
      HyperNativeOnboard: [
        { name: 'custody', type: 'address' },
        { name: 'anchor_block_height', type: 'uint64' },
        { name: 'anchor_block_hash', type: 'bytes32' },
        { name: 'gate_commitment', type: 'bytes32' },
      ],
    },
    message: {
      custody: custody.address,
      anchor_block_height: BigInt(reg.anchorBlockHeight),
      anchor_block_hash: reg.anchorBlockHash,
      gate_commitment: toHex(commitment),
    },
  });
  const body = proto([1, hex(custody.address)], [2, hex(signature)], [3, reg.anchorBlockHeight], [4, hex(reg.anchorBlockHash)], [5, proto([1, nonce], [2, bits])]);
  const data = proto([1, 160], [3, now()], [4, 1], [1160, body]);
  const hash = blake3(data, { dkLen: 20 });
  await submit(proto([1, data], [2, hash], [3, 1], [7, data]));
  for (let i = 0; i < 20 && !(fid = await nativeFid(custody.address)); i++) await new Promise((r) => setTimeout(r, 3000));
  if (!fid) throw new Error('Registered, but the account has not appeared yet; re-run in a minute');
  console.log('registered Hypersnap account', fid);
} else console.log('Hypersnap account', fid);

// 2. Posting key (expires after 90 days, like Quilcast's; re-run this script to renew)
const keyFile = `${DIR}/hypersnap-signer.json`;
let keyInfo = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : null;
if (!keyInfo || keyInfo.fid !== fid || keyInfo.expiresAt < Date.now() + 7 * 864e5) {
  const priv = randomBytes(32);
  const pub = ed25519.getPublicKey(priv);
  const KEY_DOMAIN = { name: 'Farcaster KeyAdd', version: '1', chainId: 1 };
  const deadline = now() + 3600;
  const ttl = 7776000;
  const nonce = Math.floor(Date.now() / 1000);
  const scopes = [1, 2, 3, 4, 5, 6, 11]; // casts, reactions, follows, profile
  const requestSig = await custody.signTypedData({
    domain: KEY_DOMAIN,
    primaryType: 'SignedKeyRequest',
    types: { SignedKeyRequest: [{ name: 'requestFid', type: 'uint256' }, { name: 'key', type: 'bytes' }, { name: 'deadline', type: 'uint256' }] },
    message: { requestFid: BigInt(fid), key: toHex(pub), deadline: BigInt(deadline) },
  });
  const metadata = cat(uint256(32), uint256(fid), uint256(BigInt(custody.address)), uint256(128), uint256(deadline), uint256(65), hex(requestSig), new Uint8Array(31));
  const custodySig = await custody.signTypedData({
    domain: KEY_DOMAIN,
    primaryType: 'KeyAdd',
    types: {
      KeyAdd: [
        { name: 'fid', type: 'uint256' },
        { name: 'key', type: 'bytes' },
        { name: 'keyType', type: 'uint32' },
        { name: 'scopes', type: 'uint32[]' },
        { name: 'ttl', type: 'uint32' },
        { name: 'nonce', type: 'uint32' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: { fid: BigInt(fid), key: toHex(pub), keyType: 1, scopes, ttl, nonce, deadline: BigInt(deadline) },
  });
  const body = proto([1, pub], [2, 1], [3, hex(custodySig)], [4, deadline], [5, nonce], [6, metadata], [7, 1], [9, scopes], [10, ttl]);
  const data = proto([1, 16], [2, fid], [3, now()], [4, 1], [19, body]);
  const hash = blake3(data, { dkLen: 20 });
  await submit(proto([1, data], [2, hash], [3, 1], [4, ed25519.sign(hash, priv)], [5, 1], [6, pub], [7, data]));
  keyInfo = { fid, privateKey: toHex(priv), publicKey: toHex(pub), expiresAt: Date.now() + ttl * 1000 };
  fs.writeFileSync(keyFile, JSON.stringify(keyInfo, null, 2), { mode: 0o600 });
  console.log('added posting key', keyInfo.publicKey);
  await new Promise((r) => setTimeout(r, 5000));
} else console.log('posting key valid until', new Date(keyInfo.expiresAt).toISOString());

// 3. Profile
const priv = hex(keyInfo.privateKey);
const pub = ed25519.getPublicKey(priv);
for (const [type, value] of Object.entries(PROFILE)) {
  const data = proto([1, 11], [2, fid], [3, now()], [4, 1], [12, proto([1, Number(type)], [2, value])]);
  const hash = blake3(data, { dkLen: 20 });
  for (let i = 0; i < 6; i++) {
    try {
      await submit(proto([1, data], [2, hash], [3, 1], [4, ed25519.sign(hash, priv)], [5, 1], [6, pub], [7, data]));
      console.log('profile field', type, 'ok');
      break;
    } catch (e) {
      if (i === 5) console.log('profile field', type, 'failed:', e.message);
      else await new Promise((r) => setTimeout(r, 5000)); // new key may still be propagating
    }
  }
}
