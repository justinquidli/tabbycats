// Feeds read from both networks at once. Since the split, accounts from before Nov 12, 2026
// post to both, so ~98% of casts show up on both nodes with the same hash. A feed's source
// picks what to show: everything (deduplicated), or only what exists on one network.
import { useMemo } from 'react';
import type { Cast, Network } from './api';
import { useFirehose } from './firehose';

export type Source = 'combined' | 'farcaster' | 'hypersnap';

export const SOURCES: Record<Source, { label: string; tag: string; about: string }> = {
  combined: { label: 'Combined', tag: 'Both', about: 'Farcaster and Hypersnap together, without duplicates' },
  farcaster: { label: 'Farcaster only', tag: 'Farcaster only', about: 'Only casts that exist on Farcaster and not on Hypersnap' },
  hypersnap: { label: 'Hypersnap only', tag: 'Hypersnap only', about: 'Only casts that exist on Hypersnap and not on Farcaster' },
};

export const ALL_SOURCES = Object.keys(SOURCES) as Source[];
export const FIRST_NATIVE_FID = 4294967296; // Hypersnap-native accounts can't exist on Farcaster

// A cast can reach one node a few seconds before the other; wait before calling it exclusive.
const GRACE_MS = 30_000;

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

// Keep the casts a source wants. `knownSince` is the earliest time both networks are fully
// covered; older casts can't be judged exclusive (the other network's copy may be out of range).
export function pickSource(casts: Cast[], source: Source, knownSince: number, alwaysJudged?: Set<string>) {
  if (source === 'combined') return casts;
  const now = Date.now();
  return casts.filter((c) => {
    const on = c.on ?? [c.network];
    if (on.length !== 1 || on[0] !== source) return false;
    if (alwaysJudged?.has(c.hash)) return true;
    return now - c.ts > GRACE_MS && c.ts >= knownSince;
  });
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
    const knownSince = Math.max(fc.since ?? Infinity, hs.since ?? Infinity) + 60_000;
    const status: 'loading' | 'live' | 'error' =
      fc.status === 'live' || hs.status === 'live' ? 'live' : fc.status === 'error' && hs.status === 'error' ? 'error' : 'loading';
    return { casts, removed, knownSince, status, fcStatus: fc.status, hsStatus: hs.status };
  }, [fc, hs]);
}
