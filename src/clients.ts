import type { CastId, Network } from './api';

export interface Client {
  id: string;
  label: string;
  url: (cast: CastId, username?: string) => string;
}

// Formats checked against live pages on 2026-11-27.
export const CLIENTS: Record<Network, Client[]> = {
  farcaster: [
    {
      id: 'farcaster',
      label: 'Farcaster',
      url: (c, u) =>
        u ? `https://farcaster.xyz/${u}/${c.hash.slice(0, 10)}` : `https://farcaster.xyz/~/conversations/${c.hash}`,
    },
    {
      id: 'forkcaster',
      label: 'Forkcaster',
      url: (c, u) =>
        u ? `https://forkcaster.xyz/${u}/${c.hash.slice(0, 10)}` : `https://farcaster.xyz/~/conversations/${c.hash}`,
    },
  ],
  hypersnap: [{ id: 'quilcast', label: 'Quilcast', url: (c) => `https://quilcast.com/c/${c.hash}` }],
};

export function clientFor(network: Network, id: string): Client {
  return CLIENTS[network].find((c) => c.id === id) ?? CLIENTS[network][0];
}
