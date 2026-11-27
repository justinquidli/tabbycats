import type { CastId, Network } from './api';

export interface Client {
  label: string;
  url: (cast: CastId, username?: string) => string | null; // null when the client needs a username we don't have
}

const bare = (h: string) => h.replace(/^0x/, '');
const short = (h: string) => h.slice(0, 10);

// "Open this cast in…" list, adapted from Forkcaster (github.com/artlu99/forkcaster_xyz, MIT).
// Link formats checked against Forkcaster's live page on 2026-11-27.
const ALL: Record<string, Client> = {
  farcaster: { label: 'Farcaster', url: (c, u) => (u ? `https://farcaster.xyz/${u}/${short(c.hash)}` : `https://farcaster.xyz/~/conversations/${c.hash}`) },
  quilcast: { label: 'Quilcast', url: (c) => `https://quilcast.com/c/${bare(c.hash)}` },
  renegade: { label: 'Renegade', url: (c, u) => (u ? `https://www.hyperenegade.xyz/${u}/${bare(c.hash)}` : null) },
  firefly: { label: 'Firefly', url: (c) => `https://firefly.social/post/farcaster/${c.hash}` },
  terminus: { label: 'Terminus', url: (c, u) => (u ? `https://app.onterminus.com/@${u}/${c.hash}` : null) },
  opencaster: { label: 'Opencaster', url: (c) => `https://opencaster.org/cast/${c.hash}` },
  homiehouse: { label: 'HomieHouse', url: (c) => `https://homiehouse.app/cast/${c.hash}` },
  linkcast: { label: 'Linkcast', url: (c) => `https://linkcast.xyz/cast/${bare(c.hash)}` },
  vibeshift: { label: 'Vibeshift', url: (c) => `https://vibeshift.onchain.cooking/?view=cast&castHash=${c.hash}&castFid=${c.fid}` },
  genycaster: { label: 'GenyCaster', url: (c) => `https://genycaster.xyz/?cast=${c.hash}` },
  forkcaster: { label: 'Forkcaster', url: (c, u) => (u ? `https://forkcaster.xyz/${u}/${short(c.hash)}` : null) },
  neynar: { label: 'Neynar Explorer', url: (c) => `https://explorer.neynar.com/${c.hash}` },
};

// Hypersnap-first clients lead the list for Hypersnap casts.
const ORDER: Record<Network, string[]> = {
  farcaster: ['farcaster', 'firefly', 'quilcast', 'renegade', 'terminus', 'opencaster', 'homiehouse', 'linkcast', 'vibeshift', 'genycaster', 'forkcaster', 'neynar'],
  hypersnap: ['quilcast', 'renegade', 'farcaster', 'firefly', 'terminus', 'opencaster', 'homiehouse', 'linkcast', 'vibeshift', 'genycaster', 'forkcaster', 'neynar'],
};

export function openLinks(network: Network, cast: CastId, rawUsername?: string) {
  // Hashes and usernames come from the network: only use well-formed ones in links
  if (!/^0x[0-9a-f]{40}$/i.test(cast.hash)) return [];
  const username = rawUsername && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(rawUsername) ? rawUsername : undefined;
  return ORDER[network]
    .map((id) => ({ label: ALL[id].label, href: ALL[id].url(cast, username) }))
    .filter((l): l is { label: string; href: string } => !!l.href);
}

// The link "Copy link" copies and quoted casts open: the network's home client.
export const primaryLink = (network: Network, cast: CastId, username?: string) => openLinks(network, cast, username)[0]?.href ?? '#';
