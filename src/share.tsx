// Share a custom feed as a link: the whole list lives in the URL fragment, so there's no
// server involved and the list never leaves the people who pass the link around.
import { useEffect, useState } from 'react';
import { type Network, type Profile, getProfile } from './api';
import { SOURCES, type Source } from './sources';
import type { Column } from './store';

export interface SharedFeed {
  name: string;
  emoji: string;
  source: Source;
  fids: number[];
  description?: string;
  by?: { network: Network; fid: number };
}

const MAX_MEMBERS = 1000;

const toBase64Url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64Url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

// Short link (tabbycats.party/f/<id>) with its own link preview; falls back to a long link
// that carries the whole list in the URL if the short-link service is unavailable.
export async function shareLink(col: Column): Promise<string> {
  const members = (col.members ?? []).slice(0, MAX_MEMBERS);
  const data = { v: 1, n: col.name, e: col.emoji, d: col.description?.trim() || undefined, src: col.source, m: members.map((m) => m.fid) };
  try {
    const res = await fetch('/api/feeds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...data, names: members.map((m) => m.username).filter(Boolean).slice(0, 3) }),
    });
    if (res.ok) return (await res.json()).url;
  } catch {
    /* fall back below */
  }
  return `${location.origin}/#feed=${toBase64Url(JSON.stringify(data))}`;
}

// Short links: /f/<id>
export async function fetchSharedFeed(): Promise<SharedFeed | null> {
  const m = location.pathname.match(/^\/f\/([A-Za-z0-9]{8})$/);
  if (!m) return null;
  try {
    const res = await fetch(`/api/feeds/${m[1]}`);
    if (!res.ok) return null;
    return parseFeed(await res.json());
  } catch {
    return null;
  }
}

export function readSharedFeed(): SharedFeed | null {
  const m = location.hash.match(/^#feed=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    return parseFeed(JSON.parse(fromBase64Url(m[1])));
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFeed(d: any): SharedFeed | null {
  try {
    const source: Source = d.src === 'farcaster' || d.src === 'hypersnap' ? d.src : 'combined'; // older links had no source
    const fids = Array.isArray(d.m)
      ? [...new Set<number>(d.m.filter((x: unknown) => Number.isInteger(x) && (x as number) > 0))].slice(0, MAX_MEMBERS)
      : [];
    if (!fids.length) return null;
    const by =
      Array.isArray(d.by) && Number.isInteger(d.by[1])
        ? { network: (d.by[0] === 'h' ? 'hypersnap' : 'farcaster') as Network, fid: d.by[1] as number }
        : undefined;
    const description = typeof d.d === 'string' ? d.d.trim().slice(0, 200) : '';
    return { name: String(d.n || 'Shared feed').slice(0, 60), emoji: String(d.e || '📋').slice(0, 8), description: description || undefined, source, fids, by };
  } catch {
    return null;
  }
}

export function clearSharedFeedFromUrl() {
  history.replaceState(null, '', location.pathname.startsWith('/f/') ? '/' : location.pathname + location.search);
}

const profileNet = (feed: SharedFeed, fid: number): Network =>
  feed.source === 'hypersnap' || fid >= 4294967296 ? 'hypersnap' : 'farcaster';

export function SharedFeedModal({
  feed,
  onAdd,
  onClose,
}: {
  feed: SharedFeed;
  onAdd: (members: { fid: number; username?: string }[]) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all(feed.fids.slice(0, 5).map((fid) => getProfile(profileNet(feed, fid), fid))).then(setPreview);
  }, [feed]);

  const add = async () => {
    setBusy(true);
    const profiles = await Promise.all(feed.fids.map((fid) => getProfile(profileNet(feed, fid), fid)));
    onAdd(profiles.map((p) => ({ fid: p.fid, username: p.username })));
  };

  const names = preview.map((p) => `@${p.username ?? p.fid}`);
  const more = feed.fids.length - names.length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shared-feed" role="dialog" aria-modal="true" aria-label="Add shared feed" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="shared-emoji">{feed.emoji}</div>
        <h2>{feed.name}</h2>
        {feed.description && <p className="shared-description">{feed.description}</p>}
        <p className="shared-meta">
          <span className={`net net-${feed.source}`}>{SOURCES[feed.source].tag}</span>
          {feed.fids.length} {feed.fids.length === 1 ? 'account' : 'accounts'}
        </p>
        {names.length > 0 && (
          <p className="hint">
            {names.join(', ')}
            {more > 0 && ` and ${more} more`}
          </p>
        )}
        <div className="shared-actions">
          <button className="btn-quiet" onClick={onClose}>
            No thanks
          </button>
          <button className="btn" disabled={busy} onClick={add}>
            {busy ? 'Adding…' : 'Add feed'}
          </button>
        </div>
        <p className="hint">It becomes your own copy. Edit it however you like.</p>
      </div>
    </div>
  );
}
