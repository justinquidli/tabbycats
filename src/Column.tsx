import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Cast, type Network, NETWORKS, getCastsByFid, getFollowing, getProfile, resolveHandle } from './api';
import { CastCard } from './CastCard';
import { useFirehose } from './firehose';
import type { Column } from './store';
import { useWrite } from './account';
import { isHypersnapNative } from './hsonly';
import { shareLink } from './share';

const MAX_HISTORY_FIDS = 300;
const PAGE = 50;

const EMOJI = ['🌊', '👥', '📋', '🐈', '🔥', '😂', '🪙', '🛠️', '🎨', '🎵', '⚽', '📰', '🧠', '💼', '🌱', '⭐', '🚀', '🍿', '👀', '💬', '🎩', '🟣', '🐸', '🏗️'];

interface FidState {
  fids?: number[];
  loading: boolean;
  error?: string;
}

const followCache = new Map<string, number[]>();

function useColumnFids(network: Network, col: Column): FidState {
  const listKey = (col.members ?? []).map((m) => m.fid).join(',');
  const [state, setState] = useState<FidState>({ loading: false });
  useEffect(() => {
    if (col.kind === 'list') {
      setState({ fids: col.members?.map((m) => m.fid) ?? [], loading: false });
      return;
    }
    if (col.kind !== 'following' || !col.handle) {
      setState({ loading: false });
      return;
    }
    const cacheKey = `${network}:${col.handle.toLowerCase()}`;
    const cached = followCache.get(cacheKey);
    if (cached) {
      setState({ fids: cached, loading: false });
      return;
    }
    let live = true;
    setState({ loading: true });
    (async () => {
      try {
        const fid = await resolveHandle(network, col.handle!);
        const fids = await getFollowing(network, fid);
        followCache.set(cacheKey, fids);
        if (live) setState({ fids, loading: false });
      } catch (e) {
        if (live) setState({ loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [network, col.kind, col.handle, listKey]);
  return state;
}

function useHistory(network: Network, fids?: number[]) {
  const key = fids?.join(',') ?? '';
  const [casts, setCasts] = useState<Cast[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setCasts([]);
    if (!fids?.length) return;
    let live = true;
    const target = fids.slice(0, MAX_HISTORY_FIDS);
    const pageSize = target.length <= 20 ? 25 : target.length <= 100 ? 10 : 5;
    const found: Cast[] = [];
    let done = 0;
    setLoading(true);
    Promise.all(
      target.map((fid) =>
        getCastsByFid(network, fid, pageSize)
          .then((cs) => found.push(...cs))
          .catch(() => {})
          .finally(() => {
            done++;
            if (live && done % 15 === 0) setCasts([...found]);
          }),
      ),
    ).then(() => {
      if (!live) return;
      setCasts(found);
      setLoading(false);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, key]);
  return { casts, loading };
}

function EmojiField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>Icon</label>
      <div className="emoji-row">
        <input className="emoji-input" value={value} maxLength={8} onChange={(e) => onChange(e.target.value)} aria-label="Feed icon" />
        <span className="hint">Type any emoji, or pick one:</span>
      </div>
      <div className="emoji-grid">
        {EMOJI.map((e) => (
          <button key={e} className={e === value ? 'on' : ''} onClick={() => onChange(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function HandleForm({ initial, label, onSubmit }: { initial?: string; label: string; onSubmit: (h: string) => void }) {
  const [v, setV] = useState(initial ?? '');
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim().replace(/^@/, ''));
      }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="@handle" aria-label="Handle" />
      <button className="btn">{label}</button>
    </form>
  );
}

function MemberEditor({ network, col, onChange }: { network: Network; col: Column; onChange: (p: Partial<Column>) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const members = col.members ?? [];
  const add = async (handle: string) => {
    setError('');
    setBusy(true);
    try {
      const fid = await resolveHandle(network, handle);
      if (!members.some((m) => m.fid === fid)) {
        const p = await getProfile(network, fid);
        onChange({ members: [...members, { fid, username: p.username ?? handle }] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <label>Accounts in this feed</label>
      <HandleForm label={busy ? 'Adding…' : 'Add'} onSubmit={add} key={members.length} />
      {error && <div className="error">{error}</div>}
      <div className="chips">
        {members.map((m) => (
          <span key={m.fid} className="chip">
            @{m.username ?? m.fid}
            <button aria-label={`Remove ${m.username}`} onClick={() => onChange({ members: members.filter((x) => x.fid !== m.fid) })}>
              ×
            </button>
          </span>
        ))}
        {!members.length && <span className="hint">No accounts yet.</span>}
      </div>
    </div>
  );
}

interface Props {
  network: Network;
  col: Column;
  index: number;
  count: number;
  startEditing: boolean;
  onChange: (patch: Partial<Column>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  muted: Set<string>;
  onMute: (fid: number, username?: string) => void;
}

export function ColumnView({ network, col, index, count, startEditing, onChange, onRemove, onMove, muted, onMute }: Props) {
  const fh = useFirehose(network);
  const { accounts } = useWrite();
  // Pre-split accounts share their number on both networks, so a Farcaster sign-in also works here.
  const account = accounts[network] ?? accounts.farcaster;
  // A Following column with no handle shows the signed-in user's follows.
  const autoFollow = col.kind === 'following' && !col.handle && account; // same FID on Hypersnap, which shares Farcaster's history
  const effective = useMemo(
    () => (autoFollow ? { ...col, handle: String(account.fid) } : col),
    [col, autoFollow, account?.fid],
  );
  const fids = useColumnFids(network, effective);
  const history = useHistory(network, col.kind === 'all' ? undefined : fids.fids);
  const [editing, setEditing] = useState(startEditing);
  // New casts wait behind a "new casts" button instead of pushing the column around.
  const [cutoff, setCutoff] = useState(() => Date.now());
  const body = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(PAGE);
  const [shared, setShared] = useState(false);

  const baseLive = useMemo(() => {
    let list: Cast[];
    if (col.kind === 'all') list = fh.casts;
    else if (!fids.fids) list = [];
    else {
      const set = new Set(fids.fids);
      const byHash = new Map<string, Cast>();
      for (const c of history.casts) byHash.set(c.hash, c);
      for (const c of fh.casts) if (set.has(c.fid)) byHash.set(c.hash, c);
      list = [...byHash.values()].sort((a, b) => b.ts - a.ts);
    }
    return list.filter(
      (c) => !fh.removed.has(c.hash) && !muted.has(`${network}:${c.fid}`) && !(col.hideReplies && c.parent),
    );
  }, [network, col.kind, col.hideReplies, fh.casts, fh.removed, fids.fids, history.casts, muted]);

  // Optional: only native Hypersnap accounts
  const hsOnly = network === 'hypersnap' && !!col.hsOnly;
  const live = hsOnly ? baseLive.filter((c) => isHypersnapNative(c.fid)) : baseLive;

  const settled = live.filter((c) => c.ts <= cutoff);
  const shown = settled.length ? settled : live; // nothing to hold back yet: just show what's there
  const waiting = live.length - shown.length;
  const catchUp = () => {
    setCutoff(Math.max(Date.now(), live[0]?.ts ?? 0));
    body.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const loading = fids.loading || history.loading || (col.kind === 'all' && fh.status === 'loading');

  let notice: ReactNode = null;
  if (col.kind === 'following' && !effective.handle) {
    notice = (
      <div className="empty">
        <p>Whose follows should this feed keep an eye on?</p>
        <HandleForm label="Show" onSubmit={(h) => onChange({ handle: h })} />
      </div>
    );
  } else if (col.kind === 'list' && !(col.members ?? []).length && !editing) {
    notice = (
      <div className="empty">
        <p>An empty basket. Add accounts to fill this feed.</p>
        <button className="btn" onClick={() => setEditing(true)}>
          Add accounts
        </button>
      </div>
    );
  } else if (fids.error) {
    notice = <div className="empty error">{fids.error}</div>;
  } else if (col.kind === 'all' && fh.status === 'error') {
    notice = <div className="empty error">Couldn't reach the {NETWORKS[network].label} node. Circling back…</div>;
  }

  return (
    <section className="column">
      <header className="col-head">
        <span className="col-emoji">{col.emoji || '📋'}</span>
        <h2 title={col.name}>{col.name || 'Untitled'}</h2>
        <span className={`net net-${network}`} title={`Reading from ${NETWORKS[network].node.replace('https://', '')}`}>
          {NETWORKS[network].label}
        </span>
        {col.kind === 'all' && fh.status === 'live' && <span className="live-dot" title="Live" />}
        <div className="col-tools">
          <button title="Edit feed" aria-label="Edit feed" className={editing ? 'on' : ''} onClick={() => setEditing(!editing)}>
            ⚙
          </button>
        </div>
      </header>

      {editing && (
        <div className="col-settings">
          <div className="field">
            <label>Name</label>
            <input value={col.name} onChange={(e) => onChange({ name: e.target.value })} aria-label="Feed name" />
          </div>
          <EmojiField value={col.emoji} onChange={(emoji) => onChange({ emoji })} />
          {col.kind === 'following' && (
            <div className="field">
              <label>Show follows of</label>
              <HandleForm initial={col.handle} label="Update" onSubmit={(h) => onChange({ handle: h })} />
            </div>
          )}
          {col.kind === 'list' && <MemberEditor network={network} col={col} onChange={onChange} />}
          <label className="check">
            <input type="checkbox" checked={!!col.hideReplies} onChange={(e) => onChange({ hideReplies: e.target.checked })} />
            Hide replies
          </label>
          {network === 'hypersnap' && (
            <label className="check" title="Only accounts created on Hypersnap. People who moved over from Farcaster can't be told apart automatically; add them to a custom feed.">
              <input type="checkbox" checked={!!col.hsOnly} onChange={(e) => onChange({ hsOnly: e.target.checked })} />
              Native Hypersnap accounts only
            </label>
          )}
          {col.kind === 'list' && (col.members ?? []).length > 0 && (
            <div className="field">
              <label>Share this feed</label>
              <div className="share-row">
                <button
                  className="btn-quiet"
                  onClick={async () => {
                    const by = accounts[network] ? { network, fid: accounts[network]!.fid } : undefined;
                    const url = shareLink(col, by);
                    try {
                      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: col.name, url });
                      else {
                        await navigator.clipboard.writeText(url);
                        setShared(true);
                        setTimeout(() => setShared(false), 2000);
                      }
                    } catch {
                      /* share sheet dismissed or clipboard blocked */
                    }
                  }}
                >
                  {shared ? 'Link copied ✓' : '🔗 Copy share link'}
                </button>
                <span className="hint">Anyone with the link can add a copy of this feed.</span>
              </div>
            </div>
          )}
          <div className="settings-actions">
            <button className="btn-quiet" disabled={index === 0} onClick={() => onMove(-1)}>
              ← Move
            </button>
            <button className="btn-quiet" disabled={index === count - 1} onClick={() => onMove(1)}>
              Move →
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                if (confirm(`Remove the "${col.name}" feed?`)) onRemove();
              }}
            >
              Remove
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {col.kind === 'following' && fids.fids && fids.fids.length > MAX_HISTORY_FIDS && (
        <div className="note">
          Catching up on {MAX_HISTORY_FIDS} of {fids.fids.length} follows. New casts from all of them land here live.
        </div>
      )}

      {waiting > 0 && (
        <button className="new-pill" onClick={catchUp}>
          ↑ {waiting} new {waiting === 1 ? 'cast' : 'casts'}
        </button>
      )}

      <div className="col-body" ref={body}>
        {notice}
        {!notice && shown.length === 0 && (
          <div className="empty">{loading ? 'Pouncing on the latest casts…' : hsOnly ? 'Quiet as a cat nap. Native Hypersnap accounts are still few. To follow people who moved over from Farcaster, add them to a custom feed.' : 'Quiet as a cat nap. No casts yet.'}</div>
        )}
        {shown.slice(0, limit).map((c) => (
          <CastCard key={c.hash} cast={c} onMute={onMute} />
        ))}
        {shown.length > limit && (
          <button className="btn-quiet more" onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        )}
        {shown.length > 0 && shown.length <= limit && col.kind === 'all' && (
          <div className="note">That's everything since you curled up here, plus the 30 minutes before.</div>
        )}
      </div>
    </section>
  );
}
