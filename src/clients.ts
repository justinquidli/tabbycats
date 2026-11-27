import type { CastId, Network } from './api';

export interface Client {
  id: string;
  label: string;
  hint: string;
  url: (cast: CastId, username?: string) => string;
}

// One "Open" link per cast. Forkcaster shows the cast and lets people continue in
// Farcaster, Quilcast and other clients, so it covers everyone with a single link.
// Formats checked against live pages on 2026-11-27.
export const CLIENTS: Record<Network, Client> = {
  farcaster: {
    id: 'forkcaster',
    label: 'Forkcaster',
    hint: 'Open on Forkcaster, then continue in Farcaster, Quilcast or another client',
    url: (c, u) =>
      u ? `https://forkcaster.xyz/${u}/${c.hash.slice(0, 10)}` : `https://farcaster.xyz/~/conversations/${c.hash}`,
  },
  hypersnap: {
    id: 'quilcast',
    label: 'Quilcast',
    hint: 'Open on Quilcast',
    url: (c) => `https://quilcast.com/c/${c.hash}`,
  },
};

export const clientFor = (network: Network, _id?: string): Client => CLIENTS[network];
