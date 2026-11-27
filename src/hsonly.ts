// "Hypersnap-only" accounts: native Hypersnap accounts, plus older accounts that haven't
// posted on Farcaster since the networks split. There's no official marker for leaving
// Farcaster, so the second part is inferred from activity.
import { useEffect, useState } from 'react';
import { NETWORKS } from './api';

const FIRST_NATIVE_FID = 4294967296; // Hypersnap's own accounts start here
const SPLIT = Date.UTC(2026, 10, 12); // Nov 12, 2026
const FARCASTER_EPOCH = 1609459200;
const KEY = 'tabbycats:hypersnap-only';
const TTL = 24 * 3600 * 1000;

type Entry = { v: boolean; at: number };
const cache = new Map<number, Entry>();
const pending = new Map<number, Promise<boolean>>();
const listeners = new Set<() => void>();

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Entry>;
  for (const [fid, e] of Object.entries(saved)) if (Date.now() - e.at < TTL) cache.set(Number(fid), e);
} catch {
  /* ignore */
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...cache].slice(-3000))));
    } catch {
      /* ignore */
    }
  }, 1000);
}

// A few lookups at a time so a busy feed doesn't flood Farcaster's node.
let active = 0;
const queue: (() => void)[] = [];
const slot = <T,>(fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < 4) run();
    else queue.push(run);
  });

export function peekHypersnapOnly(fid: number): boolean | undefined {
  if (fid >= FIRST_NATIVE_FID) return true;
  return cache.get(fid)?.v;
}

function check(fid: number): Promise<boolean> {
  let p = pending.get(fid);
  if (!p) {
    p = slot(async () => {
      const r = await fetch(`${NETWORKS.farcaster.node}/v1/castsByFid?fid=${fid}&pageSize=1&reverse=true`);
      if (!r.ok) throw new Error('lookup failed');
      const last = (await r.json()).messages?.[0]?.data?.timestamp as number | undefined;
      return last === undefined || (FARCASTER_EPOCH + last) * 1000 < SPLIT;
    })
      .then((v) => {
        cache.set(fid, { v, at: Date.now() });
        persist();
        listeners.forEach((l) => l());
        return v;
      })
      .finally(() => pending.delete(fid));
    pending.set(fid, p);
  }
  return p;
}

// Classifies the given authors; re-renders as answers come in.
export function useHypersnapOnly(fids: number[], enabled: boolean) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    for (const fid of new Set(fids)) if (peekHypersnapOnly(fid) === undefined) check(fid).catch(() => {});
    return () => {
      listeners.delete(l);
    };
  }, [enabled, fids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return peekHypersnapOnly;
}
