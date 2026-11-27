import { useMemo, useState } from 'react';
import { type Cast, NETWORKS, type Network, peekProfile } from './api';
import { react } from './write';
import { AboutModal } from './About';
import { type SharedFeed, SharedFeedModal, clearSharedFeedFromUrl, readSharedFeed } from './share';
import { useProfile } from './CastCard';
import { type Account, type Accounts, Composer, FarcasterSignIn, HypersnapSignIn, SignInChooser, WriteContext, loadAccounts, saveAccount } from './account';
import { ColumnView } from './Column';
import { type Column, type ColumnKind, presetColumn, starterColumns, useAppState } from './store';

const ALL_NETWORKS = Object.keys(NETWORKS) as Network[];

function NetworkPicker({ value, onChange }: { value: Network; onChange: (n: Network) => void }) {
  return (
    <div className="switch" role="radiogroup" aria-label="Network">
      {ALL_NETWORKS.map((n) => (
        <button key={n} role="radio" aria-checked={n === value} className={n === value ? 'on' : ''} onClick={() => onChange(n)}>
          {NETWORKS[n].label}
        </button>
      ))}
    </div>
  );
}

function AddColumn({ network, onNetwork, onAdd }: { network: Network; onNetwork: (n: Network) => void; onAdd: (kind: ColumnKind) => void }) {
  return (
    <section className="column add-column">
      <h2>Create a new feed</h2>
      <NetworkPicker value={network} onChange={onNetwork} />
      <button onClick={() => onAdd('all')}>
        <span>🌊</span>
        <b>All</b>
        <small>Every new {NETWORKS[network].label} cast, the moment it lands</small>
      </button>
      <button onClick={() => onAdd('following')}>
        <span>👥</span>
        <b>Following</b>
        <small>Casts from everyone someone keeps an eye on</small>
      </button>
      <button onClick={() => onAdd('list')}>
        <span>📋</span>
        <b>Custom</b>
        <small>Hand-pick the accounts yourself</small>
      </button>
    </section>
  );
}

function Welcome({ onPick }: { onPick: (networks: Network[]) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src="/pfp-2.png" alt="TabbyCats" />
        <h1>Welcome to TabbyCats</h1>
        <p>Your feeds, side by side. Which network do you prowl?</p>
        <div className="welcome-actions">
          <button className="btn" onClick={() => onPick(['farcaster'])}>
            Farcaster
          </button>
          <button className="btn" onClick={() => onPick(['hypersnap'])}>
            Hypersnap
          </button>
          <button className="btn-quiet" onClick={() => onPick(['farcaster', 'hypersnap'])}>
            Both
          </button>
        </div>
        <p className="hint">You can add or remove feeds from either network any time. No herding required.</p>
        <p className="hint">
          News and updates:{' '}
          <a href="https://farcaster.xyz/tabbycats" target="_blank" rel="noreferrer noopener">
            @tabbycats
          </a>
        </p>
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
  const [composing, setComposing] = useState<{ parent?: Cast } | null>(null);
  const hasAccount = Object.keys(accounts).length > 0;
  const setAccount = (network: Network, a: Account | null) => {
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
  const writeApi = useMemo(
    () => ({
      accounts,
      signIn: (network?: Network) => setSigningIn(network ?? 'choose'),
      compose: (parent?: Cast) => {
        const needed = parent?.network;
        if (needed ? accounts[needed] : hasAccount) setComposing({ parent });
        else setSigningIn(needed ?? 'choose');
      },
      react: async (kind: 'like' | 'recast', cast: Cast) => {
        const account = accounts[cast.network];
        if (!account) {
          setSigningIn(cast.network);
          throw new Error('signed out');
        }
        await react(account, cast.network, kind, { fid: cast.fid, hash: cast.hash });
      },
    }),
    [accounts, hasAccount],
  );
  const { columns } = state;
  const mutedSet = useMemo(() => new Set(state.muted.map((m) => `${m.network}:${m.fid}`)), [state.muted]);
  const mute = (network: Network, fid: number, username?: string) =>
    setState((s) =>
      s.muted.some((m) => m.network === network && m.fid === fid) ? s : { ...s, muted: [...s.muted, { network, fid, username }] },
    );

  const setColumns = (fn: (cols: Column[]) => Column[]) => setState((s) => ({ ...s, columns: fn(s.columns) }));

  const add = (kind: ColumnKind) => {
    const col = presetColumn(state.lastNetwork, kind);
    setJustAdded(kind === 'list' ? col.id : null);
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
            const col = { ...presetColumn(incoming.network, 'list'), name: incoming.name, emoji: incoming.emoji, members };
            // First visit straight from a share link: start them with the basics plus this feed
            setState((s) =>
              s.onboarded
                ? { ...s, columns: [...s.columns, col] }
                : { ...s, onboarded: true, lastNetwork: incoming.network, columns: [...starterColumns([incoming.network]), col] },
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
          onPick={(networks) =>
            setState((s) => ({ ...s, onboarded: true, lastNetwork: networks[0], columns: starterColumns(networks) }))
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
                  if (confirm(`Sign out of ${NETWORKS[n].label} on this device? Your board stays put.`)) setAccount(n, null);
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
            network={col.network}
            col={col}
            index={i}
            count={columns.length}
            startEditing={col.id === justAdded}
            muted={mutedSet}
            onMute={(fid, username) => mute(col.network, fid, username)}
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
        <AddColumn network={state.lastNetwork} onNetwork={(n) => setState((s) => ({ ...s, lastNetwork: n }))} onAdd={add} />
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
          defaultNetwork={state.lastNetwork}
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
