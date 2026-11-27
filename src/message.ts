// Minimal Farcaster message builder: protobuf encoding, BLAKE3 hash, ed25519 signature.
// Covers only what TabbyCats writes (casts and reactions); the full @farcaster/core
// library is ~1 MB gzipped, this is a few KB. Checked byte-for-byte against @farcaster/core.
import { ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import type { Signer } from './vault';

const FARCASTER_EPOCH = 1609459200;
const MAINNET = 1;
export const MessageType = { CAST_ADD: 1, REACTION_ADD: 3 } as const;
export const ReactionType = { LIKE: 1, RECAST: 2 } as const;

export interface CastIdBytes {
  fid: number;
  hash: Uint8Array;
}

class Writer {
  private bytes: number[] = [];
  varint(n: number | bigint) {
    let v = BigInt(n);
    while (v > 0x7fn) {
      this.bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.bytes.push(Number(v));
    return this;
  }
  tag(field: number, wire: number) {
    return this.varint((field << 3) | wire);
  }
  uint(field: number, n: number | bigint) {
    if (BigInt(n) === 0n) return this; // proto3 omits defaults
    return this.tag(field, 0).varint(n);
  }
  bytesField(field: number, b: Uint8Array) {
    if (!b.length) return this;
    this.tag(field, 2).varint(b.length);
    this.bytes.push(...b);
    return this;
  }
  string(field: number, s: string) {
    return this.bytesField(field, new TextEncoder().encode(s));
  }
  message(field: number, w: Writer) {
    // embedded messages are written even when empty
    const b = w.finish();
    this.tag(field, 2).varint(b.length);
    this.bytes.push(...b);
    return this;
  }
  packed(field: number, values: number[]) {
    // @farcaster/core (ts-proto) writes packed lists even when empty; match it exactly
    const inner = new Writer();
    values.forEach((v) => inner.varint(v));
    const b = inner.finish();
    this.tag(field, 2).varint(b.length);
    this.bytes.push(...b);
    return this;
  }
  finish() {
    return Uint8Array.from(this.bytes);
  }
}

const castId = (c: CastIdBytes) => new Writer().uint(1, c.fid).bytesField(2, c.hash);

export function castAddBody(b: { text: string; mentions: number[]; mentionsPositions: number[]; parentCastId?: CastIdBytes }) {
  const w = new Writer().packed(2, b.mentions);
  if (b.parentCastId) w.message(3, castId(b.parentCastId));
  return w.string(4, b.text).packed(5, b.mentionsPositions);
}

export function reactionBody(type: number, target: CastIdBytes) {
  return new Writer().uint(1, type).message(2, castId(target));
}

// MessageData body field numbers: cast_add_body = 5, reaction_body = 7
export async function buildMessage(type: number, fid: number, bodyField: 5 | 7, body: Writer, key: Signer, timestamp?: number) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;
  const data = new Writer().uint(1, type).uint(2, fid).uint(3, ts).uint(4, MAINNET).message(bodyField, body).finish();
  const hash = blake3(data, { dkLen: 20 });
  const signature = await key.sign(hash);
  const signer = key.pub;
  // Message: data=1, hash=2, hash_scheme=3 (BLAKE3=1), signature=4, signature_scheme=5 (ED25519=1), signer=6, data_bytes=7
  const msg = new Writer();
  msg.tag(1, 2).varint(data.length);
  return {
    hash,
    bytes: concat(msg.finish(), data, new Writer().bytesField(2, hash).uint(3, 1).bytesField(4, signature).uint(5, 1).bytesField(6, signer).bytesField(7, data).finish()),
  };
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const publicKey = (privateKey: Uint8Array) => ed25519.getPublicKey(privateKey);
