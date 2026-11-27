export type Network = 'farcaster' | 'hypersnap';

export const NETWORKS: Record<Network, { label: string; node: string }> = {
  farcaster: { label: 'Farcaster', node: 'https://snap.farcaster.xyz:3381' },
  hypersnap: { label: 'Hypersnap', node: 'https://haatz.quilibrium.com' },
};

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
  const data = msg?.data;
  if (data?.type !== 'MESSAGE_TYPE_CAST_ADD' || !data.castAddBody) return null;
  const body = data.castAddBody;
  return {
    network,
    hash: msg.hash,
    signer: msg.signer,
    fid: data.fid,
    ts: (FC_EPOCH + data.timestamp) * 1000,
    text: body.text ?? '',
    mentions: body.mentions ?? [],
    mentionsPositions: body.mentionsPositions ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embeds: (body.embeds ?? []).map((e: any) => (e.castId ? { castId: e.castId } : { url: e.url })),
    parent: body.parentCastId ?? undefined,
    parentUrl: body.parentUrl ?? undefined,
  };
}

export async function getCastsByFid(network: Network, fid: number, pageSize: number): Promise<Cast[]> {
  const d = await limited(() =>
    get<{ messages: unknown[] }>(network, `/v1/castsByFid?fid=${fid}&pageSize=${pageSize}&reverse=true`),
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
