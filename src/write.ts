// Posting to Farcaster. Loaded on demand so read-only visitors don't download it.
import { NETWORKS } from './api';
import type { CastId } from './api';
import { MessageType, ReactionType, buildMessage, castAddBody, publicKey, reactionBody } from './message';

export interface WriteAccount {
  fid: number;
  privateKey: string; // hex ed25519 posting key, approved by the user in the Farcaster app
}

export const CAST_LIMIT = 320; // bytes, for a standard cast

const hexToBytes = (hex: string) => {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export const newPostingKey = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export const publicKeyOf = async (privateKey: string) => bytesToHex(publicKey(hexToBytes(privateKey)));
export const castBytes = (text: string) => new TextEncoder().encode(text).length;

async function submit(bytes: Uint8Array) {
  const res = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.details ?? j.message ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(`Farcaster rejected it: ${String(detail).slice(0, 140)}`);
  }
}

// Turn "@name" into real mentions where the name exists; leave the rest as plain text.
async function extractMentions(text: string) {
  const re = /(^|\s)@([a-z0-9][a-z0-9.-]{0,30}[a-z0-9]|[a-z0-9])(?=$|[\s.,!?:;)])/gi;
  const found: { start: number; end: number; name: string }[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    found.push({ start, end: start + 1 + m[2].length, name: m[2].toLowerCase() });
  }
  const fids = await Promise.all(
    found.map((f) =>
      fetch(`${NETWORKS.farcaster.node}/v1/userNameProofByName?name=${encodeURIComponent(f.name)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d?.fid as number | undefined) ?? null)
        .catch(() => null),
    ),
  );
  let out = '';
  let last = 0;
  const mentions: number[] = [];
  const mentionsPositions: number[] = [];
  found.forEach((f, i) => {
    if (fids[i] === null || mentions.length >= 10) return;
    out += text.slice(last, f.start);
    mentions.push(fids[i]!);
    mentionsPositions.push(castBytes(out));
    last = f.end;
  });
  out += text.slice(last);
  return { text: out, mentions, mentionsPositions };
}

export async function postCast(account: WriteAccount, rawText: string, parent?: CastId) {
  const text = rawText.trim();
  if (!text) throw new Error('Write something first');
  if (castBytes(text) > CAST_LIMIT) throw new Error('Too long');
  const body = await extractMentions(text);
  const msg = buildMessage(
    MessageType.CAST_ADD,
    account.fid,
    5,
    castAddBody({ ...body, parentCastId: parent ? { fid: parent.fid, hash: hexToBytes(parent.hash) } : undefined }),
    hexToBytes(account.privateKey),
  );
  await submit(msg.bytes);
  return bytesToHex(msg.hash);
}

export async function react(account: WriteAccount, kind: 'like' | 'recast', target: CastId) {
  const msg = buildMessage(
    MessageType.REACTION_ADD,
    account.fid,
    7,
    reactionBody(kind === 'like' ? ReactionType.LIKE : ReactionType.RECAST, { fid: target.fid, hash: hexToBytes(target.hash) }),
    hexToBytes(account.privateKey),
  );
  await submit(msg.bytes);
}
