// Posting keys live here, the way Quilcast keeps them: the browser creates each key as
// non-exportable and stores it in IndexedDB. TabbyCats can ask the browser to sign with it,
// but no script (ours, an extension's, or an attacker's) can ever read the key itself.
// Browsers without Ed25519 in WebCrypto get a fallback: the key is encrypted with a
// non-exportable AES key that also lives in IndexedDB.
import { ed25519 } from '@noble/curves/ed25519';

export interface Signer {
  pub: Uint8Array; // 32-byte public key
  sign: (hash: Uint8Array) => Promise<Uint8Array>; // 64-byte ed25519 signature
}

const toHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) ?? [], (b) => parseInt(b, 16));

// ---- tiny IndexedDB key/value store ----
let dbPromise: Promise<IDBDatabase> | undefined;
const db = () =>
  (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('tabbycats-vault', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    dbPromise = undefined;
    throw e;
  }));

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
  });
}

// ---- fallback encryption key (never leaves the browser either) ----
let sealPromise: Promise<CryptoKey> | undefined;
const seal = () =>
  (sealPromise ??= (async () => {
    const existing = await run<CryptoKey | undefined>('readonly', (s) => s.get('seal'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await run('readwrite', (s) => s.put(key, 'seal'));
    return key;
  })());

// PKCS#8 wrapper for a raw 32-byte Ed25519 private key (lets WebCrypto import existing keys)
const PKCS8_PREFIX = [48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32];

async function store(priv: Uint8Array | null): Promise<string> {
  // Preferred: a non-exportable WebCrypto key
  try {
    let key: CryptoKey;
    let pub: Uint8Array;
    if (priv) {
      key = await crypto.subtle.importKey('pkcs8', Uint8Array.from([...PKCS8_PREFIX, ...priv]), { name: 'Ed25519' }, false, ['sign']);
      pub = ed25519.getPublicKey(priv);
    } else {
      const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
      key = pair.privateKey;
      pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    }
    await run('readwrite', (s) => s.put({ key }, `ed:${toHex(pub)}`));
    return toHex(pub);
  } catch {
    // Fallback: keep the raw key, but only encrypted
    const raw = priv ?? ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(raw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await seal(), raw);
    await run('readwrite', (s) => s.put({ iv, data }, `ed:${toHex(pub)}`));
    if (!priv) raw.fill(0);
    return toHex(pub);
  }
}

/** Create a fresh posting key; returns its public key (hex). */
export const createKey = () => store(null);

/** Move an existing raw key into the vault (used once, for keys saved by older versions). */
export const importKey = (privHex: string) => store(fromHex(privHex));

/** A signer for a key in the vault, or null if this browser doesn't hold it. */
export async function getSigner(pubHex: string): Promise<Signer | null> {
  const rec = await run<{ key?: CryptoKey; iv?: Uint8Array; data?: ArrayBuffer } | undefined>('readonly', (s) => s.get(`ed:${pubHex}`));
  if (!rec) return null;
  const pub = fromHex(pubHex);
  if (rec.key) {
    const key = rec.key;
    return { pub, sign: async (hash) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, hash)) };
  }
  return {
    pub,
    sign: async (hash) => {
      const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv! }, await seal(), rec.data!));
      try {
        return ed25519.sign(hash, raw);
      } finally {
        raw.fill(0);
      }
    },
  };
}

/** Forget a key on this device. */
export const deleteKey = (pubHex: string) => run('readwrite', (s) => s.delete(`ed:${pubHex}`)).catch(() => {});
