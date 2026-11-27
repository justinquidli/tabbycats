// Share a custom feed as a link: the whole list lives in the URL fragment, so there's no
// server involved and the list never leaves the people who pass the link around.
import { useEffect, useState } from 'react';
import { NETWORKS, type Network, type Profile, getProfile } from './api';
import type { Column } from './store';

export interface SharedFeed {
  name: string;
  emoji: string;
  network: Network;
  fids: number[];
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

export function shareLink(col: Column, by?: { network: Network; fid: number }) {
  const data = {
    v: 1,
    n: col.name,
    e: col.emoji,
    net: col.network,
    m: (col.members ?? []).map((m) => m.fid).slice(0, MAX_MEMBERS),
    ...(by ? { by: [by.network === 'farcaster' ? 'f' : 'h', by.fid] } : {}),
  };
  return `${location.origin}/#feed=${toBase64Url(JSON.stringify(data))}`;
}

export function readSharedFeed(): SharedFeed | null {
  const m = location.hash.match(/^#feed=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const d = JSON.parse(fromBase64Url(m[1]));
    const network: Network = d.net === 'hypersnap' ? 'hypersnap' : 'farcaster';
    const fids = Array.isArray(d.m)
      ? [...new Set<number>(d.m.filter((x: unknown) => Number.isInteger(x) && (x as number) > 0))].slice(0, MAX_MEMBERS)
      : [];
    if (!fids.length) return null;
    const by =
      Array.isArray(d.by) && Number.isInteger(d.by[1])
        ? { network: (d.by[0] === 'h' ? 'hypersnap' : 'farcaster') as Network, fid: d.by[1] as number }
        : undefined;
    return { name: String(d.n || 'Shared feed').slice(0, 60), emoji: String(d.e || '📋').slice(0, 8), network, fids, by };
  } catch {
    return null;
  }
}

export function clearSharedFeedFromUrl() {
  history.replaceState(null, '', location.pathname + location.search);
}

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
  const [curator, setCurator] = useState<Profile>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all(feed.fids.slice(0, 5).map((fid) => getProfile(feed.network, fid))).then(setPreview);
    if (feed.by) getProfile(feed.by.network, feed.by.fid).then(setCurator);
  }, [feed]);

  const add = async () => {
    setBusy(true);
    const profiles = await Promise.all(feed.fids.map((fid) => getProfile(feed.network, fid)));
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
        <p className="shared-meta">
          <span className={`net net-${feed.network}`}>{NETWORKS[feed.network].label}</span>
          {feed.fids.length} {feed.fids.length === 1 ? 'account' : 'accounts'}
          {curator && <> · shared by @{curator.username ?? curator.fid}</>}
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
