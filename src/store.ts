import { useEffect, useState } from 'react';
import type { Network } from './api';
import type { Source } from './sources';

export type ColumnKind = 'all' | 'following' | 'list';

export interface Member {
  fid: number;
  username?: string;
}

export interface Column {
  id: string;
  source: Source; // combined, or only what's exclusive to one network
  kind: ColumnKind;
  name: string;
  emoji: string;
  handle?: string; // following: whose follows to show
  members?: Member[]; // list
  hideReplies?: boolean;
}

export interface MutedAccount {
  network: Network;
  fid: number;
  username?: string;
}

export interface AppState {
  columns: Column[];
  muted: MutedAccount[];
  onboarded: boolean;
  lastSource: Source; // default for the next "Create a new feed"
}

const KEY = 'tabbycats:v3';
const PREVIOUS = 'tabbycats:v2'; // feeds tied to one network (before combined feeds)

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function presetColumn(source: Source, kind: ColumnKind): Column {
  if (kind === 'all') {
    if (source === 'farcaster') return { id: newId(), source, kind, name: 'Farcaster', emoji: '⛩️' };
    if (source === 'hypersnap') return { id: newId(), source, kind, name: 'Hypersnap', emoji: '🫰' };
    return { id: newId(), source, kind, name: 'All', emoji: '🌊' };
  }
  if (kind === 'following') return { id: newId(), source, kind, name: 'Following', emoji: '👥' };
  return { id: newId(), source, kind, name: 'Custom feed', emoji: '📋', members: [] };
}

export const starterColumns = (): Column[] => [
  presetColumn('combined', 'all'),
  presetColumn('farcaster', 'all'),
  presetColumn('hypersnap', 'all'),
];

function initial(): AppState {
  const fallback: AppState = { columns: [], muted: [], onboarded: false, lastSource: 'combined' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved?.columns)) {
      // Swap the first default icons for the network ones, unless someone picked their own
      const icons: Record<string, [string, string]> = { farcaster: ['🟣', '⛩️'], hypersnap: ['🟠', '🫰'] };
      const renamed: Record<string, [string, string]> = { farcaster: ['Farcaster only', 'Farcaster'], hypersnap: ['Hypersnap only', 'Hypersnap'] };
      const columns = (saved.columns as Column[]).map((c) => {
        if (c.kind !== 'all' || !icons[c.source]) return c;
        const emoji = c.emoji === icons[c.source][0] ? icons[c.source][1] : c.emoji;
        const name = c.name === renamed[c.source][0] ? renamed[c.source][1] : c.name; // feeds now show where posts were written
        return { ...c, emoji, name };
      });
      return { ...fallback, ...saved, columns };
    }

    // Upgrade from per-network feeds: start with the new defaults, keep one Following feed
    // and every custom feed (now combined), and drop the near-duplicate per-network "All" feeds.
    const old = JSON.parse(localStorage.getItem(PREVIOUS) ?? 'null');
    if (Array.isArray(old?.columns)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oldCols = old.columns as any[];
      const following = oldCols.find((c) => c.kind === 'following');
      const keep: Column[] = [
        ...(following
          ? [{ ...presetColumn('combined', 'following'), name: following.name, emoji: following.emoji, handle: following.handle, hideReplies: following.hideReplies }]
          : []),
        ...oldCols
          .filter((c) => c.kind === 'list')
          .map((c) => ({ id: c.id, source: 'combined' as Source, kind: 'list' as ColumnKind, name: c.name, emoji: c.emoji, members: c.members ?? [], hideReplies: c.hideReplies })),
      ];
      return { ...fallback, onboarded: true, muted: old.muted ?? [], columns: [...starterColumns(), ...keep] };
    }
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return fallback;
}

export function useAppState() {
  const [state, setState] = useState<AppState>(initial);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private mode etc. — board just won't persist */
    }
  }, [state]);
  return [state, setState] as const;
}
