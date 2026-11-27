import { useEffect, useMemo, useState } from 'react';
import { type Cast, NETWORKS, type Network, peekProfile } from './api';
import { react } from './write';
import { AboutModal } from './About';
import { type SharedFeed, SharedFeedModal, clearSharedFeedFromUrl, fetchSharedFeed, readSharedFeed } from './share';
import { useProfile } from './CastCard';
import { type Account, type Accounts, Composer, FarcasterSignIn, HypersnapSignIn, SignInChooser, WriteContext, forgetKey, loadAccounts, migrateKeys, saveAccount } from './account';
import { ColumnView } from './Column';
import { type Channel, type Column, type ColumnKind, presetColumn, starterColumns, useAppState } from './store';
import { ALL_SOURCES, SOURCES, type Source } from './sources';

const ALL_NETWORKS = Object.keys(NETWORKS) as Network[];

function SourcePicker({ value, onChange }: { value: Source; onChange: (s: Source) => void }) {
  return (
    <div className="switch small source-switch" role="radiogroup" aria-label="Which casts">
      {ALL_SOURCES.map((s) => (
        <button key={s} role="radio" aria-checked={s === value} className={s === value ? 'on' : ''} title={SOURCES[s].about} onClick={() => onChange(s)}>
          {SOURCES[s].label}
        </button>
      ))}
    </div>
  );
}

// Search Farcaster channels (via TabbyCats' Worker) and pick one
function ChannelPicker({ onPick }: { onPick: (c: Channel) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Channel[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/channels?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((list: Channel[]) => live && setResults(list))
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="channel-picker">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search channels, e.g. memes" aria-label="Search channels" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <ul>
        {results.map((c) => (
          <li key={c.id}>
            <button onClick={() => onPick(c)}>
              {c.image ? <img src={c.image} alt="" referrerPolicy="no-referrer" /> : <span className="mention-dot">📺</span>}
              <b>/{c.id}</b>
              {c.name && c.name.toLowerCase() !== c.id && <span>{c.name}</span>}
            </button>
          </li>
        ))}
        {!results.length && <li className="hint">No channels found.</li>}
      </ul>
    </div>
  );
}

function AddColumn({
  source,
  onSource,
  onAdd,
}: {
  source: Source;
  onSource: (s: Source) => void;
  onAdd: (kind: ColumnKind, channel?: Channel) => void;
}) {
  const [pickingChannel, setPickingChannel] = useState(false);
  const what = source === 'combined' ? 'both networks' : `${source === 'farcaster' ? 'Farcaster' : 'Hypersnap'} apps`;
  return (
    <section className="column add-column">
      <h2>Create a new feed</h2>
      <SourcePicker value={source} onChange={onSource} />
      <button onClick={() => onAdd('all')}>
        <span>🌊</span>
        <b>Straight from Tap</b>
        <small>Every new cast from {what}, as it lands</small>
      </button>
      <button onClick={() => onAdd('following')}>
        <span>👥</span>
        <b>Following</b>
        <small>Casts from the people you follow, or anyone else's follows</small>
      </button>
      <button onClick={() => onAdd('list')}>
        <span>📋</span>
        <b>Custom</b>
        <small>Hand-pick the accounts yourself</small>
      </button>
      <button onClick={() => setPickingChannel(!pickingChannel)} aria-expanded={pickingChannel}>
        <span>📺</span>
        <b>Channel</b>
        <small>Everything posted in a channel, like /memes</small>
      </button>
      {pickingChannel && (
        <ChannelPicker
          onPick={(c) => {
            setPickingChannel(false);
            onAdd('channel', c);
          }}
        />
      )}
    </section>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src="/pfp-2.png" alt="TabbyCats" />
        <h1>Welcome to TabbyCats</h1>
        <p className="welcome-lead">Curate multiple feeds on Farcaster &amp; Hypersnap in a single client, meow!</p>
        <div className="welcome-actions">
          <button className="btn" onClick={onStart}>
            Start prowling
          </button>
        </div>
        <div className="welcome-notes">
        <p className="hint">Add, remove and rearrange feeds any time. No herding required.</p>
        <p className="hint">
          News and updates: @tabbycats on{' '}
          <a href="https://farcaster.xyz/tabbycats" target="_blank" rel="noreferrer noopener">
            Farcaster
          </a>{' '}
          &amp;{' '}
          <a href="https://quilcast.com/u/4294967372" target="_blank" rel="noreferrer noopener">
            Hypersnap
          </a>
        </p>
        </div>
      </div>
    </div>
  );
}

function AccountPfp({ network, fid }: { network: Network; fid: number }) {
  const p = useProfile(network, fid);
  return p?.pfp ? <img className="account-pfp" src={p.pfp} alt="" referrerPolicy="no-referrer" /> : null;
}

export default function App() {
  const [state, setState] = useAppState();
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [showMuted, setShowMuted] = useState(false);
  const [accounts, setAccounts] = useState<Accounts>(loadAccounts);
  // 'choose' shows the network picker; a network opens that network's sign-in
  const [signingIn, setSigningIn] = useState<Network | 'choose' | null>(null);
  const [composing, setComposing] = useState<{ parent?: Cast; network?: Network } | null>(null);
  const hasAccount = Object.keys(accounts).length > 0;
  useEffect(() => {
    fetchSharedFeed().then((f) => {
      if (f) setIncoming(f);
      else if (location.pathname.startsWith('/f/')) history.replaceState(null, '', '/'); // expired or unknown link
    });
  }, []);
  useEffect(() => {
    migrateKeys(accounts).then((next) => next && setAccounts(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setAccount = (network: Network, a: Account | null) => {
    if (!a) forgetKey(accounts[network]); // signing out deletes the key from this browser
    saveAccount(network, a);
    setAccounts((all) => {
      const next = { ...all };
      if (a) next[network] = a;
      else delete next[network];
      return next;
    });
  };
  const [toast, setToast] = useState('');
  const [showAbout, setShowAbout] = useState(false);
  const [incoming, setIncoming] = useState<SharedFeed | null>(readSharedFeed);
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };
  // Most casts live on both networks; act on the first one you're signed in to (Farcaster first).
  const writableNetwork = (cast: Cast): Network | undefined =>
    (['farcaster', 'hypersnap'] as Network[]).find((n) => (cast.on ?? [cast.network]).includes(n) && accounts[n]);
  const writeApi = useMemo(
    () => ({
      accounts,
      signIn: (network?: Network) => setSigningIn(network ?? 'choose'),
      compose: (parent?: Cast) => {
        if (!parent) return hasAccount ? setComposing({}) : setSigningIn('choose');
        // Reply on whichever network the cast is on that you're signed in to
        const network = writableNetwork(parent);
        if (network) setComposing({ parent, network });
        else setSigningIn(parent.network);
      },
      react: async (kind: 'like' | 'recast', cast: Cast) => {
        const network = writableNetwork(cast);
        if (!network) {
          setSigningIn(cast.network);
          throw new Error('signed out');
        }
        await react(accounts[network]!, network, kind, { fid: cast.fid, hash: cast.hash });
      },
    }),
    [accounts, hasAccount],
  );
  const { columns } = state;
  const mutedSet = useMemo(() => new Set(state.muted.map((m) => `${m.network}:${m.fid}`)), [state.muted]);
  const mute = (network: Network, fid: number, username?: string) => // muting applies on both networks
    setState((s) =>
      s.muted.some((m) => m.network === network && m.fid === fid) ? s : { ...s, muted: [...s.muted, { network, fid, username }] },
    );

  const setColumns = (fn: (cols: Column[]) => Column[]) => setState((s) => ({ ...s, columns: fn(s.columns) }));

  const add = (kind: ColumnKind, channel?: Channel) => {
    const base = presetColumn(state.lastSource, kind);
    const col = channel ? { ...base, name: channel.name || `/${channel.id}`, channel } : base;
    setJustAdded(col.id); // scroll to it (and open settings for custom feeds)
    setColumns((cols) => [...cols, col]);
  };

  const sharedModal = incoming && (
        <SharedFeedModal
          feed={incoming}
          onClose={() => {
            clearSharedFeedFromUrl();
            setIncoming(null);
          }}
          onAdd={(members) => {
            const col = { ...presetColumn(incoming.source, 'list'), name: incoming.name, emoji: incoming.emoji, description: incoming.description, members };
            setJustAdded(col.id);
            // First visit straight from a share link: start them with the basics plus this feed
            setState((s) =>
              s.onboarded
                ? { ...s, columns: [...s.columns, col] }
                : { ...s, onboarded: true, columns: [...starterColumns(), col] },
            );
            clearSharedFeedFromUrl();
            setIncoming(null);
            flash(`Added "${incoming.name}" 🐾`);
          }}
        />
      );

  if (!state.onboarded) {
    return (
      <div className="app">
        <Welcome
          onStart={() => setState((s) => ({ ...s, onboarded: true, columns: starterColumns() }))
          }
        />
        {sharedModal}
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  return (
    <WriteContext.Provider value={writeApi}>
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setShowAbout(true)} title="About TabbyCats">
          <img className="logo" src="/pfp-2.png" alt="" />
          <span className="wordmark">TabbyCats</span>
        </button>
        <div className="prefs">
          {hasAccount && (
            <button className="btn small" onClick={() => setComposing({})}>
              ＋ Cast
            </button>
          )}
          {ALL_NETWORKS.filter((n) => accounts[n]).map((n) => (
            <span key={n} className="chip account-chip" title={`Signed in to ${NETWORKS[n].label}`}>
              <AccountPfp network={n} fid={accounts[n]!.fid} />
              @{accounts[n]!.username ?? accounts[n]!.fid}
              <span className={`net net-${n}`}>{NETWORKS[n].label}</span>
              <button
                title={`Sign out of ${NETWORKS[n].label}`}
                aria-label={`Sign out of ${NETWORKS[n].label}`}
                onClick={() => {
                  if (
                    confirm(
                      n === 'farcaster'
                        ? 'Sign out of Farcaster on this device? Your board stays put.\n\nThis forgets the posting key here. To revoke it everywhere, remove TabbyCats in the Farcaster app under Settings → Connected apps.'
                        : 'Sign out of Hypersnap on this device? Your board stays put.\n\nThis forgets the posting key here. It stops working on its own after 90 days.',
                    )
                  )
                    setAccount(n, null);
                }}
              >
                ⎋
              </button>
            </span>
          ))}
          {ALL_NETWORKS.some((n) => !accounts[n]) && (
            <button className={hasAccount ? 'btn-quiet small' : 'btn small'} onClick={() => setSigningIn('choose')}>
              {hasAccount ? '+ Sign in' : 'Sign in'}
            </button>
          )}
          <button className="btn-quiet small" onClick={() => setShowMuted(!showMuted)} aria-expanded={showMuted}>
            Muted ({state.muted.length})
          </button>
          <button className="follow-link" onClick={() => setShowAbout(true)}>
            About
          </button>
          <span className="badge" title="Your board is saved in this browser only">
            Saved on this device
          </span>
        </div>
      </header>

      {showMuted && (
        <div className="muted-panel">
          {state.muted.length === 0 ? (
            <span className="hint">No muted accounts. Use "Mute" on any cast to hide that account everywhere.</span>
          ) : (
            <div className="chips">
              {state.muted.map((m) => (
                <span key={`${m.network}:${m.fid}`} className="chip">
                  @{m.username ?? `fid ${m.fid}`} · {NETWORKS[m.network].label}
                  <button
                    aria-label={`Unmute ${m.username ?? m.fid}`}
                    title="Unmute"
                    onClick={() =>
                      setState((s) => ({ ...s, muted: s.muted.filter((x) => !(x.network === m.network && x.fid === m.fid)) }))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <main className="board">
        {columns.map((col, i) => (
          <ColumnView
            key={col.id}
            col={col}
            index={i}
            count={columns.length}
            justAdded={col.id === justAdded}
            muted={mutedSet}
            onMute={(fid, username) => mute(col.source === 'hypersnap' ? 'hypersnap' : 'farcaster', fid, username)}
            onChange={(patch) => setColumns((cols) => cols.map((c) => (c.id === col.id ? { ...c, ...patch } : c)))}
            onRemove={() => setColumns((cols) => cols.filter((c) => c.id !== col.id))}
            onMove={(dir) =>
              setColumns((cols) => {
                const next = [...cols];
                const j = i + dir;
                [next[i], next[j]] = [next[j], next[i]];
                return next;
              })
            }
          />
        ))}
        <AddColumn source={state.lastSource} onSource={(src) => setState((s) => ({ ...s, lastSource: src }))} onAdd={add} />
      </main>

      {signingIn === 'choose' && (
        <SignInChooser accounts={accounts} onPick={(n) => setSigningIn(n)} onClose={() => setSigningIn(null)} />
      )}
      {signingIn === 'farcaster' && (
        <FarcasterSignIn
          onClose={() => setSigningIn(null)}
          onDone={(a) => {
            setAccount('farcaster', a);
            setSigningIn(null);
            flash(`Welcome in, @${a.username ?? a.fid} 🐾`);
          }}
        />
      )}
      {signingIn === 'hypersnap' && (
        <HypersnapSignIn
          onClose={() => setSigningIn(null)}
          onDone={(a) => {
            setAccount('hypersnap', a);
            setSigningIn(null);
            flash(`Hypersnap unlocked, @${a.username ?? a.fid} 🐾`);
          }}
        />
      )}
      {composing && hasAccount && (
        <Composer
          accounts={accounts}
          parent={composing.parent}
          parentName={composing.parent ? peekProfile(composing.parent.network, composing.parent.fid)?.username : undefined}
          replyNetwork={composing.network}
          onClose={() => setComposing(null)}
          onSent={() => flash(composing.parent ? 'Reply sent 🐾' : 'Cast sent 🐾')}
        />
      )}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {sharedModal}
      {toast && <div className="toast">{toast}</div>}
    </div>
    </WriteContext.Provider>
  );
}
