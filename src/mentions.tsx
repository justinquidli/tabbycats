// @mention suggestions for the composer. Farcaster nodes have no user search, so suggestions
// come from people you follow (loaded in the background, remembered on this device), anyone
// already loaded in your feeds, and an exact-name check for whatever you've typed.
import { useEffect, useRef, useState } from 'react';
import { type Network, type Profile, getFollowing, getProfile, loadedProfiles, resolveHandle } from './api';

const KEY = 'tabbycats:mention-names';
const MAX_FOLLOWS = 400;

type Known = Record<string, { fid: number; display?: string; pfp?: string; followed?: boolean }>;

function readKnown(): Known {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}
function writeKnown(k: Known) {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    /* ignore */
  }
}

const loadedFor = new Set<string>();

// Learn the usernames of the people this account follows (once per page load).
async function learnFollows(network: Network, fid: number, onUpdate: () => void) {
  const k = `${network}:${fid}`;
  if (loadedFor.has(k)) return;
  loadedFor.add(k);
  try {
    const fids = (await getFollowing(network, fid)).slice(0, MAX_FOLLOWS);
    const known = readKnown();
    const have = new Set(Object.values(known).map((v) => v.fid));
    let n = 0;
    await Promise.all(
      fids.map(async (f) => {
        if (have.has(f)) {
          const entry = Object.values(known).find((v) => v.fid === f);
          if (entry) entry.followed = true;
          return;
        }
        const p = await getProfile(network, f);
        if (p.username) known[p.username] = { fid: f, display: p.display, pfp: p.pfp, followed: true };
        if (++n % 40 === 0) {
          writeKnown(known);
          onUpdate();
        }
      }),
    );
    writeKnown(known);
    onUpdate();
  } catch {
    loadedFor.delete(k);
  }
}

export interface Suggestion {
  username: string;
  fid: number;
  display?: string;
  pfp?: string;
}

export function useMentionSuggestions(query: string | null, network: Network, accountFid?: number) {
  const [version, setVersion] = useState(0);
  const [exact, setExact] = useState<Suggestion | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (accountFid) learnFollows(network, accountFid, () => setVersion((v) => v + 1));
  }, [network, accountFid]);

  // Exact match for what's typed, so any existing username can be picked
  useEffect(() => {
    setExact(null);
    clearTimeout(timer.current);
    const q = query?.toLowerCase();
    if (!q || q.length < 2) return;
    timer.current = setTimeout(async () => {
      try {
        const fid = await resolveHandle(network, q);
        const p: Profile = await getProfile(network, fid);
        setExact({ username: p.username ?? q, fid, display: p.display, pfp: p.pfp });
      } catch {
        /* no such name */
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query, network]);

  if (query === null) return [];
  const q = query.toLowerCase();
  const pool = new Map<string, Suggestion & { followed?: boolean }>();
  for (const [username, v] of Object.entries(readKnown())) pool.set(username, { username, ...v });
  for (const p of loadedProfiles()) if (p.username && !pool.has(p.username)) pool.set(p.username, { username: p.username, fid: p.fid, display: p.display, pfp: p.pfp });
  const matches = [...pool.values()]
    .filter((s) => s.username.toLowerCase().startsWith(q) || (q.length >= 2 && s.display?.toLowerCase().includes(q)))
    .sort((a, b) => Number(!!b.followed) - Number(!!a.followed) || Number(b.username.toLowerCase().startsWith(q)) - Number(a.username.toLowerCase().startsWith(q)) || a.username.length - b.username.length)
    .slice(0, 6);
  if (exact && !matches.some((m) => m.username === exact.username)) matches.unshift(exact);
  void version;
  return matches.slice(0, 6);
}

// The "@partial" right before the caret, if any
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|\s)@([a-z0-9][a-z0-9.-]{0,30})?$/i);
  if (!m) return null;
  return { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? '' };
}
