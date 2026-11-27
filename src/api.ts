export type Network = 'farcaster' | 'hypersnap';

// Public Hypersnap nodes; the one in use can be switched in About (saved in this browser).
export const HYPERSNAP_NODES = ['https://haatz.quilibrium.com', 'https://hypersnap.rainonmeproductions.com'];
const NODE_KEY = 'tabbycats:hypersnap-node';

function chosenHypersnapNode(): string {
  try {
    const saved = localStorage.getItem(NODE_KEY);
    if (saved && HYPERSNAP_NODES.includes(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return HYPERSNAP_NODES[0];
}

/** Switch Hypersnap nodes; reloads so every feed refetches from the new one. */
export function switchHypersnapNode(url: string) {
  if (!HYPERSNAP_NODES.includes(url)) return;
  try {
    localStorage.setItem(NODE_KEY, url);
  } catch {
    /* storage unavailable */
  }
  location.reload();
}

export const NETWORKS: Record<Network, { label: string; node: string }> = {
  farcaster: { label: 'Farcaster', node: 'https://snap.farcaster.xyz:3381' },
  hypersnap: { label: 'Hypersnap', node: chosenHypersnapNode() },
};

// If the chosen Hypersnap node doesn't answer, quietly use the first one that does.
// Hypersnap reads wait for this check, so feeds never sit on a dead node.
const hypersnapReady: Promise<void> = (async () => {
  const preferred = NETWORKS.hypersnap.node;
  const alive = async (url: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      return (await fetch(`${url}/v1/info`, { signal: ctrl.signal })).ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (await alive(preferred)) return;
  for (const url of HYPERSNAP_NODES.filter((u) => u !== preferred)) {
    if (await alive(url)) {
      NETWORKS.hypersnap.node = url;
      return;
    }
  }
})();

/** Resolves once the Hypersnap node in use has been checked (and swapped if it was down). */
export const hypersnapNodeReady = () => hypersnapReady;

const FC_EPOCH = 1609459200; // Farcaster timestamps count seconds from 2021-01-01

export interface CastId {
  fid: number;
  hash: string;
}

export interface Cast {
  network: Network;
  hash: string;
  fid: number;
  ts: number; // ms
  text: string;
  mentions: number[];
  mentionsPositions: number[];
  embeds: { url?: string; castId?: CastId }[];
  parent?: CastId;
  parentUrl?: string;
  on?: Network[]; // networks this cast was seen on (set when feeds merge both networks)
  signer?: string; // the posting key that signed it (tells which kind of app wrote it)
}

export interface Profile {
  fid: number;
  username?: string;
  display?: string;
  pfp?: string;
}

async function get<T>(network: Network, path: string): Promise<T> {
  if (network === 'hypersnap') await hypersnapReady;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(NETWORKS[network].node + path, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Node returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Shared concurrency limit so a big Following column doesn't flood the node.
const MAX_ACTIVE = 8;
let active = 0;
const waiting: (() => void)[] = [];
function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          waiting.shift()?.();
        });
    };
    if (active < MAX_ACTIVE) run();
    else waiting.push(run);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCast(network: Network, msg: any): Cast | null {
  // Everything here comes from strangers via a node: check every field's shape before using it.
  const data = msg?.data;
  if (data?.type !== 'MESSAGE_TYPE_CAST_ADD' || !data.castAddBody) return null;
  const body = data.castAddBody;
  const isHash = (h: unknown): h is string => typeof h === 'string' && /^0x[0-9a-f]{40}$/i.test(h);
  const isId = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  const castId = (c: any): CastId | undefined => (c && isId(c.fid) && isHash(c.hash) ? { fid: c.fid, hash: c.hash } : undefined);
  if (!isHash(msg.hash) || !isId(data.fid) || !Number.isSafeInteger(data.timestamp)) return null;
  const ts = (FC_EPOCH + data.timestamp) * 1000;
  if (!Number.isFinite(new Date(ts).getTime())) return null;
  const text = typeof body.text === 'string' ? body.text : '';
  let mentions: number[] = Array.isArray(body.mentions) ? body.mentions : [];
  let mentionsPositions: number[] = Array.isArray(body.mentionsPositions) ? body.mentionsPositions : [];
  const textBytes = new TextEncoder().encode(text).length;
  const positionsOk =
    mentions.length === mentionsPositions.length &&
    mentions.every(isId) &&
    mentionsPositions.every((p, i) => Number.isSafeInteger(p) && p >= 0 && p <= textBytes && (i === 0 || p >= mentionsPositions[i - 1]));
  if (!positionsOk) mentions = mentionsPositions = []; // malformed mentions: show the plain text
  const embeds = (Array.isArray(body.embeds) ? body.embeds : [])
    .map((e: any) => (e?.castId ? (castId(e.castId) ? { castId: castId(e.castId) } : null) : typeof e?.url === 'string' ? { url: e.url } : null))
    .filter(Boolean) as Cast['embeds'];
  return {
    network,
    hash: msg.hash,
    signer: typeof msg.signer === 'string' ? msg.signer : undefined,
    fid: data.fid,
    ts,
    text,
    mentions,
    mentionsPositions,
    embeds,
    parent: castId(body.parentCastId),
    parentUrl: typeof body.parentUrl === 'string' ? body.parentUrl : undefined,
  };
}

export async function getCastsByFid(network: Network, fid: number, pageSize: number): Promise<Cast[]> {
  const d = await limited(() =>
    get<{ messages: unknown[] }>(network, `/v1/castsByFid?fid=${fid}&pageSize=${pageSize}&reverse=true`),
  );
  return (d.messages ?? []).map((m) => toCast(network, m)).filter((c): c is Cast => !!c);
}

// Casts posted in a channel (identified by its parent URL), newest first
export async function getCastsByChannel(network: Network, url: string, pageSize: number): Promise<Cast[]> {
  const d = await limited(() =>
    get<{ messages: unknown[] }>(network, `/v1/castsByParent?url=${encodeURIComponent(url)}&pageSize=${pageSize}&reverse=true`),
  );
  return (d.messages ?? []).map((m) => toCast(network, m)).filter((c): c is Cast => !!c);
}

export async function resolveHandle(network: Network, handle: string): Promise<number> {
  const name = handle.trim().replace(/^@/, '').toLowerCase();
  if (!name) throw new Error('Enter a handle');
  if (/^\d+$/.test(name)) return Number(name);
  try {
    const d = await get<{ fid: number }>(network, `/v1/userNameProofByName?name=${encodeURIComponent(name)}`);
    if (!d.fid) throw new Error();
    return d.fid;
  } catch {
    throw new Error(`Couldn't find @${name}`);
  }
}

export async function getFollowing(network: Network, fid: number): Promise<number[]> {
  const fids: number[] = [];
  let token = '';
  for (let i = 0; i < 10; i++) {
    const d = await get<{ messages: { data: { linkBody: { targetFid: number } } }[]; nextPageToken?: string }>(
      network,
      `/v1/linksByFid?fid=${fid}&link_type=follow&pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
    );
    for (const m of d.messages ?? []) if (m.data?.linkBody?.targetFid) fids.push(m.data.linkBody.targetFid);
    if (!d.nextPageToken) break;
    token = d.nextPageToken;
  }
  return [...new Set(fids)];
}

const profiles = new Map<string, Profile>();
const profileRequests = new Map<string, Promise<Profile>>();

/** Every profile loaded so far on this page (used for @mention suggestions). */
export const loadedProfiles = (): Profile[] => [...profiles.values()];

export function peekProfile(network: Network, fid: number): Profile | undefined {
  return profiles.get(`${network}:${fid}`);
}

export function getProfile(network: Network, fid: number): Promise<Profile> {
  const key = `${network}:${fid}`;
  let req = profileRequests.get(key);
  if (!req) {
    req = limited(() =>
      get<{ messages: { data: { userDataBody: { type: string; value: string } } }[] }>(
        network,
        `/v1/userDataByFid?fid=${fid}`,
      ),
    )
      .then((d) => {
        const p: Profile = { fid };
        for (const m of d.messages ?? []) {
          const { type, value } = m.data.userDataBody;
          if (type === 'USER_DATA_TYPE_USERNAME') p.username = value;
          else if (type === 'USER_DATA_TYPE_DISPLAY') p.display = value;
          else if (type === 'USER_DATA_TYPE_PFP') p.pfp = value;
        }
        profiles.set(key, p);
        return p;
      })
      .catch(() => {
        profileRequests.delete(key);
        return { fid };
      });
    profileRequests.set(key, req);
  }
  return req;
}

export async function getShardHeads(network: Network): Promise<{ shard: number; height: number }[]> {
  const d = await get<{ shardInfos: { shardId: number; maxHeight: number }[] }>(network, '/v1/info');
  return d.shardInfos.filter((s) => s.shardId !== 0).map((s) => ({ shard: s.shardId, height: s.maxHeight }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getEvents(network: Network, shard: number, fromId: number): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await get<{ events?: any[] }>(
    network,
    `/v1/events?from_event_id=${fromId}&shard_index=${shard}&pageSize=1000`,
  );
  return d.events ?? [];
}
