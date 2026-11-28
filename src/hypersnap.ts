// Hypersnap sign-in: turn a recovery phrase into a TabbyCats posting key, entirely in the browser.
// The phrase is used once and never stored or sent anywhere; only the new posting key is kept.
// Message formats match Quilcast (quilcast.com), the reference Hypersnap client.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { blake3 } from '@noble/hashes/blake3';
import { keccak_256 } from '@noble/hashes/sha3';
import { NETWORKS, hypersnapNodeReady } from './api';
import { createKey, deleteKey, getSigner } from './vault';

const node = () => NETWORKS.hypersnap.node; // read each time: it can switch to a backup node
const FARCASTER_EPOCH = 1609459200;
const KEY_TTL = 7776000; // 90 days, same as Quilcast
const SCOPES = [1, 2, 3, 4]; // only what TabbyCats does: casts and reactions (add/remove)

export interface HypersnapKey {
  fid: number;
  signer: string; // public key; the private half stays in this browser's vault
  expiresAt: number; // ms
}

// ---- small helpers ----
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const fromHex = (h: string) => {
  const s = h.replace(/^0x/, '');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const toHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: number | bigint) => fromHex(BigInt(n).toString(16).padStart(64, '0'));
const varint = (n: number | bigint) => {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 128n) {
    out.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
};
type Field = [number, number | bigint | string | Uint8Array | number[] | undefined];
const proto = (...fields: Field[]) =>
  cat(
    ...fields.flatMap(([f, v]) => {
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return [];
      if (typeof v === 'number' || typeof v === 'bigint') return [varint(f << 3), varint(v)];
      const b = typeof v === 'string' ? utf8(v) : Array.isArray(v) ? cat(...v.map(varint)) : v;
      return [varint((f << 3) | 2), varint(b.length), b];
    }),
  );
const farcasterNow = () => Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;

// ---- EIP-712 (only the types these messages use) ----
type TypedField = { name: string; type: string };
function encodeValue(type: string, value: unknown): Uint8Array {
  if (type.endsWith('[]')) return keccak_256(cat(...(value as unknown[]).map((v) => encodeValue(type.slice(0, -2), v))));
  if (type === 'string') return keccak_256(utf8(value as string));
  if (type === 'bytes') return keccak_256(fromHex(value as string));
  if (type === 'bytes32') return fromHex(value as string);
  return word(BigInt(value as string | number | bigint)); // uint*, address
}
const hashStruct = (name: string, fields: TypedField[], data: Record<string, unknown>) =>
  keccak_256(
    cat(
      keccak_256(utf8(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`)),
      ...fields.map((f) => encodeValue(f.type, data[f.name])),
    ),
  );
function signTypedData(
  privateKey: Uint8Array,
  domain: { name: string; version: string; chainId: number },
  primaryType: string,
  fields: TypedField[],
  message: Record<string, unknown>,
) {
  const domainFields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ];
  const digest = keccak_256(
    cat(Uint8Array.of(0x19, 0x01), hashStruct('EIP712Domain', domainFields, domain), hashStruct(primaryType, fields, message)),
  );
  const sig = secp256k1.sign(digest, privateKey);
  return cat(sig.toCompactRawBytes(), Uint8Array.of(27 + sig.recovery));
}

// ---- phrase → custody wallet ----
export function normalizePhrase(phrase: string) {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidPhrase(phrase: string) {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

function custodyFromPhrase(phrase: string) {
  const seed = mnemonicToSeedSync(normalizePhrase(phrase));
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive("m/44'/60'/0'/0/0");
  const key = Uint8Array.from(child.privateKey!);
  // wipe everything derived along the way; only the one key we need is kept, and it's wiped after signing
  child.wipePrivateData();
  master.wipePrivateData();
  seed.fill(0);
  const pub = secp256k1.getPublicKey(key, false).slice(1);
  const address = toHex(keccak_256(pub).slice(12));
  return { privateKey: key, address };
}

async function findFid(address: string): Promise<number> {
  // Accounts from before the Nov 2026 split are known by their Optimism registration…
  const reg = await fetch(`${node()}/v1/onChainIdRegistryEventByAddress?address=${address}`).then((r) => (r.ok ? r.json() : null));
  if (reg?.fid) return Number(reg.fid);
  // …and native Hypersnap accounts by their custody address.
  const res = await fetch(`${node()}/v1/nativeAccount?custody=${address}`);
  if (res.ok) return Number((await res.json()).fid);
  return 0;
}

async function submit(bytes: Uint8Array) {
  const res = await fetch(`${node()}/v1/submitMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.details ?? j.error_detail ?? j.message ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(`Hypersnap rejected it: ${String(detail).slice(0, 160)}`);
  }
}

// `onPhraseUsed` fires as soon as the phrase has been turned into a key, so the page can
// forget it right away (before the network round-trips).
export async function unlockHypersnap(
  phrase: string,
  onStep: (msg: string) => void,
  onPhraseUsed: () => void = () => {},
): Promise<HypersnapKey> {
  if (!isValidPhrase(phrase)) throw new Error("That doesn't look like a valid recovery phrase. Check the words and their order.");
  onStep('Finding your account…');
  const custody = custodyFromPhrase(phrase);
  onPhraseUsed();
  try {
    await hypersnapNodeReady(); // if the usual node is down, use the backup it switched to
    return await addKey(custody, onStep);
  } catch (e) {
    if (e instanceof TypeError) {
      // fetch() failing outright means the node didn't answer, not that the phrase is wrong
      throw new Error("Couldn't reach the Hypersnap node. Try again, or switch nodes in About.");
    }
    throw e;
  } finally {
    custody.privateKey.fill(0); // whatever happens, the wallet key doesn't outlive this call
  }
}

async function addKey(custody: { privateKey: Uint8Array; address: string }, onStep: (msg: string) => void): Promise<HypersnapKey> {
  const fid = await findFid(custody.address);
  if (!fid) {
    throw new Error('No Hypersnap account uses this phrase. Accounts created on Farcaster after Nov 12, 2026 need a separate Hypersnap account.');
  }

  onStep('Creating your posting key…');
  const signerHex = await createKey(); // made non-exportable by the browser, kept in its vault
  const signer = (await getSigner(signerHex))!;
  const pub = signer.pub;
  const domain = { name: 'Farcaster KeyAdd', version: '1', chainId: 1 };
  const deadline = farcasterNow() + 3600;
  const nonce = Math.floor(Date.now() / 1000);
  const requestSig = signTypedData(
    custody.privateKey,
    domain,
    'SignedKeyRequest',
    [
      { name: 'requestFid', type: 'uint256' },
      { name: 'key', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    { requestFid: fid, key: toHex(pub), deadline },
  );
  const custodySig = signTypedData(
    custody.privateKey,
    domain,
    'KeyAdd',
    [
      { name: 'fid', type: 'uint256' },
      { name: 'key', type: 'bytes' },
      { name: 'keyType', type: 'uint32' },
      { name: 'scopes', type: 'uint32[]' },
      { name: 'ttl', type: 'uint32' },
      { name: 'nonce', type: 'uint32' },
      { name: 'deadline', type: 'uint256' },
    ],
    { fid, key: toHex(pub), keyType: 1, scopes: SCOPES, ttl: KEY_TTL, nonce, deadline },
  );
  custody.privateKey.fill(0); // done with the wallet key (also wiped by the caller, in case of errors)

  const metadata = cat(word(32), word(fid), word(BigInt(custody.address)), word(128), word(deadline), word(65), requestSig, new Uint8Array(31));
  const body = proto([1, pub], [2, 1], [3, custodySig], [4, deadline], [5, nonce], [6, metadata], [7, 1], [9, SCOPES], [10, KEY_TTL]);
  const data = proto([1, 16], [2, fid], [3, farcasterNow()], [4, 1], [19, body]);
  const hash = blake3(data, { dkLen: 20 });
  try {
    await submit(proto([1, data], [2, hash], [3, 1], [4, await signer.sign(hash)], [5, 1], [6, pub], [7, data]));
  } catch (e) {
    await deleteKey(signerHex); // never approved: don't keep it
    throw e;
  }

  onStep('Waiting for Hypersnap to confirm…');
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${node()}/v1/signer?fid=${fid}&signer=${toHex(pub)}`);
    if (r.ok) return { fid, signer: signerHex, expiresAt: Date.now() + KEY_TTL * 1000 };
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("Your key was sent but hasn't shown up yet. Try again in a minute.");
}

