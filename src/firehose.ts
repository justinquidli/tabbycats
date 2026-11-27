import { useSyncExternalStore } from 'react';
import { type Cast, type Network, getEvents, getShardHeads, toCast } from './api';

// Event ids are the block height shifted left by 14 bits.
const BLOCK_SHIFT = 16384;
const BACKFILL_BLOCKS = 1800; // roughly the last 30 minutes
const POLL_MS = 4000;
const MAX_CASTS = 3000;

export interface FirehoseSnapshot {
  casts: Cast[]; // newest first
  removed: Set<string>;
  status: 'loading' | 'live' | 'error';
  since?: number; // ms timestamp of the oldest backfilled cast
}

class Firehose {
  private cursors = new Map<number, number>();
  private seen = new Set<string>();
  private listeners = new Set<() => void>();
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  snapshot: FirehoseSnapshot = { casts: [], removed: new Set(), status: 'loading' };

  constructor(private network: Network) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    clearTimeout(this.stopTimer);
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(listener);
      // Stop polling a board nobody is looking at.
      if (this.listeners.size === 0) this.stopTimer = setTimeout(() => this.stop(), 30000);
    };
  };

  private emit(patch: Partial<FirehoseSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private start() {
    this.running = true;
    this.tick();
  }

  private stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  private async tick() {
    try {
      if (this.cursors.size === 0) {
        const heads = await getShardHeads(this.network);
        for (const h of heads) this.cursors.set(h.shard, Math.max(0, h.height - BACKFILL_BLOCKS) * BLOCK_SHIFT);
      }
      await Promise.all([...this.cursors.keys()].map((s) => this.drain(s)));
      this.emit({ status: 'live' });
    } catch {
      this.emit({ status: this.snapshot.casts.length ? 'live' : 'error' });
    }
    if (this.running) this.timer = setTimeout(() => this.tick(), POLL_MS);
  }

  private async drain(shard: number) {
    for (let page = 0; page < 10; page++) {
      const from = this.cursors.get(shard)!;
      const events = await getEvents(this.network, shard, from);
      if (!events.length) return;
      this.ingest(events);
      this.cursors.set(shard, events[events.length - 1].id + 1);
      if (events.length < 1000) return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ingest(events: any[]) {
    const fresh: Cast[] = [];
    let removed = this.snapshot.removed;
    for (const e of events) {
      if (e.type !== 'HUB_EVENT_TYPE_MERGE_MESSAGE') continue;
      const msg = e.mergeMessageBody?.message;
      const type = msg?.data?.type;
      if (type === 'MESSAGE_TYPE_CAST_ADD') {
        const cast = toCast(this.network, msg);
        if (cast && !this.seen.has(cast.hash)) {
          this.seen.add(cast.hash);
          fresh.push(cast);
        }
      } else if (type === 'MESSAGE_TYPE_CAST_REMOVE') {
        const target = msg.data.castRemoveBody?.targetHash;
        if (target) {
          if (removed === this.snapshot.removed) removed = new Set(removed);
          removed.add(target);
        }
      }
    }
    if (!fresh.length && removed === this.snapshot.removed) return;
    const casts = [...fresh, ...this.snapshot.casts].sort((a, b) => b.ts - a.ts).slice(0, MAX_CASTS);
    this.emit({ casts, removed, since: casts.length ? casts[casts.length - 1].ts : undefined });
  }
}

const hoses = new Map<Network, Firehose>();
function hose(network: Network) {
  let h = hoses.get(network);
  if (!h) hoses.set(network, (h = new Firehose(network)));
  return h;
}

export function useFirehose(network: Network): FirehoseSnapshot {
  const h = hose(network);
  return useSyncExternalStore(h.subscribe, () => h.snapshot);
}
