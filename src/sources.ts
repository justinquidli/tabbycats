// Feeds read from both networks at once. Accounts from before the Nov 12, 2026 split post to
// both, so ~98% of casts exist on both nodes with the same hash; feeds show each one once.
//
// The Farcaster and Hypersnap feeds split casts by where they were *written*:
//  - Hypersnap: native Hypersnap accounts, and posts signed with a key from Hypersnap's free
//    ("offchain") key system, which is what Hypersnap apps like Quorum and Quilcast use.
//  - Farcaster: posts signed with keys registered on Optimism, which Farcaster-side apps use.
import { useEffect, useMemo, useState } from 'react';
import { type Cast, NETWORKS, type Network } from './api';
import { useFirehose } from './firehose';

export type Source = 'combined' | 'farcaster' | 'hypersnap';

export const SOURCES: Record<Source, { label: string; tag: string; about: string }> = {
  combined: { label: 'Combined', tag: 'Both', about: 'Farcaster and Hypersnap together, without duplicates' },
  farcaster: { label: 'Farcaster', tag: 'Farcaster', about: 'Posts written in Farcaster apps' },
  hypersnap: { label: 'Hypersnap', tag: 'Hypersnap', about: 'Posts written in Hypersnap apps, plus native Hypersnap accounts' },
};

export const ALL_SOURCES = Object.keys(SOURCES) as Source[];
export const FIRST_NATIVE_FID = 4294967296; // Hypersnap-native accounts can't exist on Farcaster

// Combine per-network lists by hash, remembering where each cast was seen. Farcaster's copy is
// kept as the main one (its profile data and links are the most widely supported).
export function mergeByHash(lists: { network: Network; casts: Cast[] }[]): Cast[] {
  const byHash = new Map<string, Cast>();
  for (const { network, casts } of lists) {
    for (const c of casts) {
      const seenOn = c.on ?? [network]; // already-merged casts carry their own list
      const prev = byHash.get(c.hash);
      if (!prev) byHash.set(c.hash, { ...c, on: seenOn });
      else {
        const on = [...new Set([...(prev.on ?? []), ...seenOn])];
        byHash.set(c.hash, c.network === 'farcaster' && prev.network !== 'farcaster' ? { ...c, on } : { ...prev, on });
      }
    }
  }
  return [...byHash.values()].sort((a, b) => b.ts - a.ts);
}

// ---- where was a cast written? (one lookup per account+key, remembered) ----
const KEY = 'tabbycats:key-origins';
const origins = new Map<string, Network>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(KEY) ?? '{}'))) origins.set(k, v as Network);
} catch {
  /* ignore */
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...origins].slice(-5000))));
    } catch {
      /* ignore */
    }
  }, 1000);
};

let active = 0;
const queue: (() => void)[] = [];
const slot = (fn: () => Promise<void>) => {
  const run = () => {
    active++;
    fn().finally(() => {
      active--;
      queue.shift()?.();
    });
  };
  if (active < 6) run();
  else queue.push(run);
};

function lookup(fid: number, signer: string) {
  const k = `${fid}:${signer}`;
  if (origins.has(k) || pending.has(k)) return;
  pending.add(k);
  slot(async () => {
    try {
      const r = await fetch(`${NETWORKS.farcaster.node}/v1/signer?fid=${fid}&signer=${signer}`);
      const source = r.ok ? (await r.json()).signer?.source : undefined;
      if (source) {
        origins.set(k, source === 'SIGNER_SOURCE_OFFCHAIN' ? 'hypersnap' : 'farcaster');
        persist();
        listeners.forEach((l) => l());
      }
    } finally {
      pending.delete(k);
    }
  });
}

export function originOf(c: Cast): Network | undefined {
  if (c.fid >= FIRST_NATIVE_FID) return 'hypersnap';
  if (!c.signer) return undefined;
  return origins.get(`${c.fid}:${c.signer}`);
}

// Keep the casts a feed wants, looking up any keys it hasn't seen yet. Returns how many are
// still being checked so the feed can say so.
export function useSourceFilter(casts: Cast[], source: Source) {
  const [, bump] = useState(0);
  const unknown = useMemo(
    () => (source === 'combined' ? [] : casts.filter((c) => originOf(c) === undefined && c.signer)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [casts, source, origins.size],
  );
  useEffect(() => {
    if (source === 'combined') return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    for (const c of unknown.slice(0, 400)) lookup(c.fid, c.signer!);
    return () => {
      listeners.delete(l);
    };
  }, [unknown, source]);
  const shown = source === 'combined' ? casts : casts.filter((c) => originOf(c) === source);
  return { shown, checking: unknown.length };
}

// Both live streams, merged.
export function useCombinedFirehose() {
  const fc = useFirehose('farcaster');
  const hs = useFirehose('hypersnap');
  return useMemo(() => {
    const casts = mergeByHash([
      { network: 'farcaster', casts: fc.casts },
      { network: 'hypersnap', casts: hs.casts },
    ]);
    const removed = new Set([...fc.removed, ...hs.removed]);
    const status: 'loading' | 'live' | 'error' =
      fc.status === 'live' || hs.status === 'live' ? 'live' : fc.status === 'error' && hs.status === 'error' ? 'error' : 'loading';
    return { casts, removed, status };
  }, [fc, hs]);
}
