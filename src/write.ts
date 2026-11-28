// Posting to Farcaster and Hypersnap. Both use the same message format.
import { NETWORKS } from './api';
import type { CastId, Network } from './api';
import { MessageType, ReactionType, buildMessage, castAddBody, reactionBody } from './message';
import { getSigner } from './vault';

export interface WriteAccount {
  fid: number;
  signer: string; // public key of the posting key, which lives in this browser's vault
}

async function signerFor(account: WriteAccount) {
  const s = await getSigner(account.signer);
  if (!s) throw new Error("This browser doesn't hold your posting key anymore. Sign out and sign in again.");
  return s;
}

export const CAST_LIMIT = 320; // bytes, for a standard cast

const hexToBytes = (hex: string) => {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export const castBytes = (text: string) => new TextEncoder().encode(text).length;

async function submit(network: Network, bytes: Uint8Array) {
  // Farcaster's node blocks browser requests, so it goes through our Worker; Hypersnap's allows them.
  const url = network === 'farcaster' ? '/api/submit' : `${NETWORKS.hypersnap.node}/v1/submitMessage`;
  const res = await fetch(url, {
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
    throw new Error(`${NETWORKS[network].label} rejected it: ${String(detail).slice(0, 140)}`);
  }
}

// Turn "@name" into real mentions where the name exists; leave the rest as plain text.
async function extractMentions(network: Network, text: string) {
  const re = /(^|\s)@([a-z0-9][a-z0-9.-]{0,30}[a-z0-9]|[a-z0-9])(?=$|[\s.,!?:;)])/gi;
  const found: { start: number; end: number; name: string }[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    found.push({ start, end: start + 1 + m[2].length, name: m[2].toLowerCase() });
  }
  const fids = await Promise.all(
    found.map((f) =>
      fetch(`${NETWORKS[network].node}/v1/userNameProofByName?name=${encodeURIComponent(f.name)}`)
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

export const MAX_EMBEDS = 2;

/** Links typed in the text, so other apps can show a preview card (photos come first and share the 2 slots). */
export function linksIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?)\]}'"]+$/, '')))].filter((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  });
}

/** What a cast will carry: photos first, then links from the text (minus any you removed), 2 at most. */
export const castEmbeds = (text: string, photos: string[], removed: Set<string> = new Set()) =>
  [...new Set([...photos, ...linksIn(text).filter((u) => !removed.has(u))])].slice(0, MAX_EMBEDS);

export async function postCast(account: WriteAccount, network: Network, rawText: string, parent?: CastId, embeds: string[] = []) {
  const text = rawText.trim();
  if (!text && !embeds.length) throw new Error('Write something first');
  if (castBytes(text) > CAST_LIMIT) throw new Error('Too long');
  const body = await extractMentions(network, text);
  const msg = await buildMessage(
    MessageType.CAST_ADD,
    account.fid,
    5,
    castAddBody({ ...body, embeds, parentCastId: parent ? { fid: parent.fid, hash: hexToBytes(parent.hash) } : undefined }),
    await signerFor(account),
  );
  await submit(network, msg.bytes);
  return bytesToHex(msg.hash);
}

export async function react(account: WriteAccount, network: Network, kind: 'like' | 'recast', target: CastId) {
  const msg = await buildMessage(
    MessageType.REACTION_ADD,
    account.fid,
    7,
    reactionBody(kind === 'like' ? ReactionType.LIKE : ReactionType.RECAST, { fid: target.fid, hash: hexToBytes(target.hash) }),
    await signerFor(account),
  );
  await submit(network, msg.bytes);
}
