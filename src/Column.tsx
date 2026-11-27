import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Cast, type Network, getCastsByFid, getFollowing, getProfile, resolveHandle } from './api';
import { CastBoundary, CastCard } from './CastCard';
import type { Column } from './store';
import { useWrite } from './account';
import { FIRST_NATIVE_FID, SOURCES, type Source, mergeByHash, useCombinedFirehose, useSourceFilter } from './sources';
import { shareLink } from './share';

const MAX_HISTORY_FIDS = 300;
const PAGE = 50;

const EMOJI = ['🌊', '👥', '📋', '🐈', '🔥', '😂', '🪙', '🛠️', '🎨', '🎵', '⚽', '📰', '🧠', '💼', '🌱', '⭐', '🚀', '🍿', '👀', '💬', '🎩', '⛩️', '🫰', '🐸', '🏗️'];

interface FidState {
  fids?: number[];
  loading: boolean;
  error?: string;
}

const followCache = new Map<string, number[]>();

// Handles and follow lists come from Farcaster's node (shared history), except for
// Hypersnap-only feeds and native Hypersnap accounts, which only Hypersnap knows.
const graphNetwork = (source: Source, fid?: number): Network =>
  source === 'hypersnap' || (fid !== undefined && fid >= FIRST_NATIVE_FID) ? 'hypersnap' : 'farcaster';

function useColumnFids(source: Source, col: Column): FidState {
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
    const cacheKey = `${source}:${col.handle.toLowerCase()}`;
    const cached = followCache.get(cacheKey);
    if (cached) {
      setState({ fids: cached, loading: false });
      return;
    }
    let live = true;
    setState({ loading: true });
    (async () => {
      try {
        const fid = await resolveHandle(graphNetwork(source), col.handle!);
        const fids = await getFollowing(graphNetwork(source, fid), fid);
        followCache.set(cacheKey, fids);
        if (live) setState({ fids, loading: false });
      } catch (e) {
        if (live) setState({ loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [source, col.kind, col.handle, listKey]);
  return state;
}

// Recent casts for a set of accounts: native Hypersnap accounts from Hypersnap's node,
// everyone else from Farcaster's (which has nearly every cast).
function useHistory(source: Source, fids?: number[]) {
  const key = fids?.join(',') ?? '';
  const [casts, setCasts] = useState<Cast[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setCasts([]);
    if (!fids?.length) return;
    let live = true;
    const target = fids.slice(0, MAX_HISTORY_FIDS);
    const pageSize = target.length <= 20 ? 25 : target.length <= 100 ? 10 : 5;
    const jobs = target.map((fid) => ({ network: (fid >= FIRST_NATIVE_FID ? 'hypersnap' : 'farcaster') as Network, fid }));
    const found: Record<Network, Cast[]> = { farcaster: [], hypersnap: [] };
    const publish = () =>
      setCasts(mergeByHash([
        { network: 'farcaster', casts: found.farcaster },
        { network: 'hypersnap', casts: found.hypersnap },
      ]));
    let done = 0;
    setLoading(true);
    Promise.all(
      jobs.map((j) =>
        getCastsByFid(j.network, j.fid, pageSize)
          .then((cs) => found[j.network].push(...cs))
          .catch(() => {})
          .finally(() => {
            done++;
            if (live && done % 15 === 0) publish();
          }),
      ),
    ).then(() => {
      if (!live) return;
      publish();
      setLoading(false);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key]);
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

function HandleForm({ initial, label, onSubmit, autoFocus }: { initial?: string; label: string; onSubmit: (h: string) => void; autoFocus?: boolean }) {
  const [v, setV] = useState(initial ?? '');
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim().replace(/^@/, ''));
      }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="@handle" aria-label="Handle" autoFocus={autoFocus} />
      <button className="btn">{label}</button>
    </form>
  );
}

function MemberEditor({ source, col, onChange }: { source: Source; col: Column; onChange: (p: Partial<Column>) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const members = col.members ?? [];
  const add = async (handle: string) => {
    setError('');
    setBusy(true);
    try {
      const fid = await resolveHandle(graphNetwork(source), handle);
      if (!members.some((m) => m.fid === fid)) {
        const p = await getProfile(graphNetwork(source, fid), fid);
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
      <HandleForm label={busy ? 'Adding…' : 'Add'} onSubmit={add} key={members.length} autoFocus={!members.length} />
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
  col: Column;
  index: number;
  count: number;
  justAdded: boolean; // newly created: bring it into view
  onChange: (patch: Partial<Column>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  muted: Set<string>;
  onMute: (fid: number, username?: string) => void;
}

export function ColumnView({ col, index, count, justAdded, onChange, onRemove, onMove, muted, onMute }: Props) {
  const source = col.source;
  const fh = useCombinedFirehose();
  const { accounts } = useWrite();
  const account = source === 'hypersnap' ? accounts.hypersnap ?? accounts.farcaster : accounts.farcaster ?? accounts.hypersnap;
  // A Following feed with no handle shows the signed-in user's follows.
  const autoFollow = col.kind === 'following' && !col.handle && account;
  const effective = useMemo(
    () => (autoFollow ? { ...col, handle: String(account.fid) } : col),
    [col, autoFollow, account?.fid],
  );
  const fids = useColumnFids(source, effective);
  const history = useHistory(source, col.kind === 'all' ? undefined : fids.fids);
  // Custom feeds open their settings right away so you can add accounts
  const [editing, setEditing] = useState(justAdded && col.kind === 'list');
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    // New feeds land at the end of the board, often off-screen (always on phones)
    if (justAdded) section.current?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // New casts wait behind a "new casts" button instead of pushing the column around.
  const [cutoff, setCutoff] = useState(() => Date.now());
  const body = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(PAGE);
  const [shared, setShared] = useState<'' | 'making' | 'copied'>('');

  const merged = useMemo(() => {
    let list: Cast[];
    if (col.kind === 'all') list = fh.casts;
    else if (!fids.fids) list = [];
    else {
      const set = new Set(fids.fids);
      list = mergeByHash([
        { network: 'farcaster', casts: history.casts },
        { network: 'farcaster', casts: fh.casts.filter((c) => set.has(c.fid)) },
      ]);
    }
    return list.filter(
      (c) =>
        !fh.removed.has(c.hash) &&
        !muted.has(`farcaster:${c.fid}`) &&
        !muted.has(`hypersnap:${c.fid}`) &&
        !(col.hideReplies && c.parent),
    );
  }, [col.kind, col.hideReplies, fh.casts, fh.removed, fids.fids, history.casts, muted]);
  const { shown: live, checking } = useSourceFilter(merged, source);

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
    notice = <div className="empty error">Couldn't reach the network nodes. Circling back…</div>;
  }

  return (
    <section className="column" ref={section}>
      <header className="col-head">
        <button className="col-move" title="Move left" aria-label="Move feed left" disabled={index === 0} onClick={() => onMove(-1)}>
          ‹
        </button>
        <span className="col-emoji">{col.emoji || '📋'}</span>
        <h2 title={col.name}>{col.name || 'Untitled'}</h2>
        <span className={`net net-${source}`} title={SOURCES[source].about}>
          {SOURCES[source].tag}
        </span>
        {col.kind === 'all' && fh.status === 'live' && <span className="live-dot" title="Live" />}
        <div className="col-tools">
          <button title="Edit feed" aria-label="Edit feed" className={editing ? 'on' : ''} onClick={() => setEditing(!editing)}>
            ⚙
          </button>
        </div>
        <button className="col-move" title="Move right" aria-label="Move feed right" disabled={index === count - 1} onClick={() => onMove(1)}>
          ›
        </button>
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
          {col.kind === 'list' && (
            <div className="field">
              <label>Description</label>
              <textarea
                className="feed-description"
                value={col.description ?? ''}
                maxLength={200}
                rows={2}
                placeholder="What's this feed about? Shown when you share it."
                onChange={(e) => onChange({ description: e.target.value })}
                aria-label="Feed description"
              />
            </div>
          )}
          {col.kind === 'list' && <MemberEditor source={source} col={col} onChange={onChange} />}
          <label className="check">
            <input type="checkbox" checked={!!col.hideReplies} onChange={(e) => onChange({ hideReplies: e.target.checked })} />
            Hide replies
          </label>
          <div className="field">
            <label>Show</label>
            <div className="switch small source-switch" role="radiogroup" aria-label="Which casts">
              {(['combined', 'farcaster', 'hypersnap'] as Source[]).map((s) => (
                <button key={s} role="radio" aria-checked={s === source} className={s === source ? 'on' : ''} title={SOURCES[s].about} onClick={() => onChange({ source: s })}>
                  {SOURCES[s].label}
                </button>
              ))}
            </div>
          </div>
          {col.kind === 'list' && (col.members ?? []).length > 0 && (
            <div className="field">
              <label>Share this feed</label>
              <div className="share-row">
                <button
                  className="btn-quiet"
                  onClick={async () => {
                    setShared('making');
                    const url = await shareLink(col);
                    try {
                      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
                        setShared('');
                        await navigator.share({ title: col.name, url });
                      } else {
                        await navigator.clipboard.writeText(url);
                        setShared('copied');
                        setTimeout(() => setShared(''), 2000);
                      }
                    } catch {
                      setShared(''); /* share sheet dismissed or clipboard blocked */
                    }
                  }}
                >
                  {shared === 'copied' ? 'Link copied ✓' : shared === 'making' ? 'Making link…' : '🔗 Copy share link'}
                </button>
                <span className="hint">Anyone with the link can add a copy of this feed.</span>
              </div>
            </div>
          )}
          <div className="settings-actions">
            {justAdded && col.kind === 'list' && !(col.members ?? []).length ? (
              // A custom feed that was just created and is still empty: one tap backs out of it
              <button
                className="btn-quiet"
                onClick={() => {
                  section.current?.previousElementSibling?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
                  onRemove();
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                className="btn-danger"
                onClick={() => {
                  if (confirm(`Remove the "${col.name}" feed?`)) onRemove();
                }}
              >
                Remove
              </button>
            )}
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
          <div className="empty">{loading || checking ? 'Pouncing on the latest casts…' : source === 'hypersnap' ? 'Quiet as a cat nap. Nobody has posted from a Hypersnap app in this window yet.' : 'Quiet as a cat nap. No casts yet.'}</div>
        )}
        {shown.slice(0, limit).map((c) => (
          <CastBoundary key={c.hash}>
            <CastCard cast={c} onMute={onMute} />
          </CastBoundary>
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
