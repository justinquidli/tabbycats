import { useEffect, useState } from 'react';
import type { Network } from './api';

export type ColumnKind = 'all' | 'following' | 'list';

export interface Member {
  fid: number;
  username?: string;
}

export interface Column {
  id: string;
  network: Network;
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
  openIn: Record<Network, string>;
  onboarded: boolean; // has picked which networks to start with
  lastNetwork: Network; // default for the next "Add column"
}

const KEY = 'tabbycats:v2';
const OLD_KEY = 'tabbycats:v1';

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function presetColumn(network: Network, kind: ColumnKind): Column {
  if (kind === 'all') return { id: newId(), network, kind, name: 'All', emoji: '🌊' };
  if (kind === 'following') return { id: newId(), network, kind, name: 'Following', emoji: '👥' };
  return { id: newId(), network, kind, name: 'New list', emoji: '📋', members: [] };
}

export function starterColumns(networks: Network[]): Column[] {
  return networks.flatMap((n) => [presetColumn(n, 'all'), presetColumn(n, 'following')]);
}

function initial(): AppState {
  const fallback: AppState = {
    columns: [],
    muted: [],
    openIn: { farcaster: 'farcaster', hypersnap: 'quilcast' },
    onboarded: false,
    lastNetwork: 'farcaster',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved?.columns)) return { ...fallback, ...saved };
    // Carry over boards from the two-tab version.
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null');
    if (old?.boards) {
      const columns = (['farcaster', 'hypersnap'] as Network[]).flatMap((n) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (old.boards[n] ?? []).map((c: any) => ({ ...c, network: n })),
      );
      return { ...fallback, columns, openIn: { ...fallback.openIn, ...old.openIn }, onboarded: true };
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
