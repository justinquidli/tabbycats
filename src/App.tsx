import { useMemo, useState } from 'react';
import { type Cast, NETWORKS, type Network, peekProfile } from './api';
import { react } from './write';
import { useProfile } from './CastCard';
import { Composer, type FcAccount, SignInModal, WriteContext, loadAccount, saveAccount } from './account';
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
      <h2>Add a column</h2>
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
        <b>New list</b>
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
        <p className="hint">You can add or remove columns from either network any time. No herding required.</p>
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

function AccountPfp({ fid }: { fid: number }) {
  const p = useProfile('farcaster', fid);
  return p?.pfp ? <img className="account-pfp" src={p.pfp} alt="" referrerPolicy="no-referrer" /> : null;
}

export default function App() {
  const [state, setState] = useAppState();
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [showMuted, setShowMuted] = useState(false);
  const [account, setAccount] = useState<FcAccount | null>(loadAccount);
  const [signingIn, setSigningIn] = useState(false);
  const [composing, setComposing] = useState<{ parent?: Cast } | null>(null);
  const [toast, setToast] = useState('');
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };
  const writeApi = useMemo(
    () => ({
      account,
      signIn: () => setSigningIn(true),
      compose: (parent?: Cast) => (account ? setComposing({ parent }) : setSigningIn(true)),
      react: async (kind: 'like' | 'recast', cast: Cast) => {
        if (!account) {
          setSigningIn(true);
          throw new Error('signed out');
        }
        await react(account, kind, { fid: cast.fid, hash: cast.hash });
      },
    }),
    [account],
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

  if (!state.onboarded) {
    return (
      <div className="app">
        <Welcome
          onPick={(networks) =>
            setState((s) => ({ ...s, onboarded: true, lastNetwork: networks[0], columns: starterColumns(networks) }))
          }
        />
      </div>
    );
  }

  return (
    <WriteContext.Provider value={writeApi}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src="/pfp-2.png" alt="" />
          <span className="wordmark">TabbyCats</span>
        </div>
        <div className="prefs">
          {account ? (
            <>
              <button className="btn small" onClick={() => setComposing({})}>
                ＋ Cast
              </button>
              <span className="chip">
                <AccountPfp fid={account.fid} />
                @{account.username ?? account.fid}
                <button
                  title="Sign out"
                  aria-label="Sign out"
                  onClick={() => {
                    if (confirm('Sign out of Farcaster on this device? Your board stays put.')) {
                      saveAccount(null);
                      setAccount(null);
                    }
                  }}
                >
                  ⎋
                </button>
              </span>
            </>
          ) : (
            <button className="btn small" onClick={() => setSigningIn(true)}>
              Sign in with Farcaster
            </button>
          )}
          <button className="btn-quiet small" onClick={() => setShowMuted(!showMuted)} aria-expanded={showMuted}>
            Muted ({state.muted.length})
          </button>
          <a className="follow-link" href="https://farcaster.xyz/tabbycats" target="_blank" rel="noreferrer noopener">
            Follow @tabbycats
          </a>
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

      {signingIn && (
        <SignInModal
          onClose={() => setSigningIn(false)}
          onDone={(a) => {
            saveAccount(a);
            setAccount(a);
            setSigningIn(false);
            flash(`Welcome in, @${a.username ?? a.fid} 🐾`);
          }}
        />
      )}
      {composing && account && (
        <Composer
          account={account}
          parent={composing.parent}
          parentName={composing.parent ? peekProfile('farcaster', composing.parent.fid)?.username : undefined}
          onClose={() => setComposing(null)}
          onSent={() => flash(composing.parent ? 'Reply sent 🐾' : 'Cast sent 🐾')}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
    </WriteContext.Provider>
  );
}
