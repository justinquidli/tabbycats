// Move your whole board (feeds, their order, mutes) to another device with a one-time link.
// Sign-ins stay behind: each device makes its own posting key.
import type { Network } from './api';
import type { AppState, Column, ColumnKind, Member, MutedAccount } from './store';
import type { Source } from './sources';

export interface Board {
  columns: Column[];
  muted: MutedAccount[];
}

export async function makeBoardLink(state: AppState): Promise<string> {
  const res = await fetch('/api/boards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ columns: state.columns, muted: state.muted }),
  }).catch(() => null);
  if (!res?.ok) throw new Error((await res?.json().catch(() => null))?.error ?? "Couldn't make a link right now");
  return (await res.json()).url;
}

export const boardIdFromUrl = () => location.pathname.match(/^\/b\/([A-Za-z0-9]{12})$/)?.[1];

/** Fetch a board link's contents. Opening it uses it up. */
export async function takeBoard(id: string): Promise<Board> {
  const res = await fetch(`/api/boards/${id}`, { method: 'POST' }).catch(() => null);
  if (!res?.ok) throw new Error((await res?.json().catch(() => null))?.error ?? "Couldn't open this link");
  const board = cleanBoard(await res.json());
  if (!board) throw new Error("This link doesn't hold a board");
  return board;
}

// Anyone can make a board link, so treat its contents as untrusted: keep only well-formed fields.
const SOURCES: Source[] = ['combined', 'farcaster', 'hypersnap'];
const KINDS: ColumnKind[] = ['all', 'following', 'list', 'channel'];
const NETS: Network[] = ['farcaster', 'hypersnap'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : undefined);
const isFid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const username = (v: unknown) => (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(v) ? v : undefined);
const https = (v: unknown) => {
  const s = str(v, 500);
  return s && /^https:\/\//i.test(s) ? s : undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanColumn(c: any): Column | null {
  if (!c || !SOURCES.includes(c.source) || !KINDS.includes(c.kind)) return null;
  const col: Column = {
    id: str(c.id, 64) || Math.random().toString(36).slice(2),
    source: c.source,
    kind: c.kind,
    name: str(c.name, 60) ?? '',
    emoji: str(c.emoji, 8) || '📋',
  };
  if (c.hideReplies === true) col.hideReplies = true;
  if (c.kind === 'following') {
    const h = str(c.handle, 64);
    if (h) col.handle = h;
  }
  if (c.kind === 'list') {
    col.members = (Array.isArray(c.members) ? c.members : [])
      .filter((m: Member) => isFid(m?.fid))
      .slice(0, 1000)
      .map((m: Member) => ({ fid: m.fid, username: username(m.username) }));
    const d = str(c.description, 200);
    if (d) col.description = d;
    if (c.live && /^[A-Za-z0-9]{8}$/.test(c.live.id)) {
      col.live = { id: c.live.id };
      if (typeof c.live.token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(c.live.token)) col.live.token = c.live.token;
    }
  }
  if (c.kind === 'channel') {
    const url = https(c.channel?.url) ?? str(c.channel?.url, 500);
    if (!url) return null;
    col.channel = { id: str(c.channel.id, 64) ?? '', name: str(c.channel.name, 60) ?? '', url, image: https(c.channel.image) };
  }
  return col;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanBoard(d: any): Board | null {
  if (!Array.isArray(d?.columns)) return null;
  const columns = d.columns.map(cleanColumn).filter(Boolean).slice(0, 100) as Column[];
  // Fresh ids keep React keys unique even if the link repeated one
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.id)) c.id = Math.random().toString(36).slice(2);
    seen.add(c.id);
  }
  const muted = (Array.isArray(d.muted) ? d.muted : [])
    .filter((m: MutedAccount) => NETS.includes(m?.network) && isFid(m?.fid))
    .slice(0, 5000)
    .map((m: MutedAccount) => ({ network: m.network, fid: m.fid, username: username(m.username) }));
  return columns.length ? { columns, muted } : null;
}
