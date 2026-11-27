import { useMemo, useState } from 'react';
import { NETWORKS, type Network } from './api';
import { CLIENTS } from './clients';
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
        <small>Every new {NETWORKS[network].label} cast, newest first</small>
      </button>
      <button onClick={() => onAdd('following')}>
        <span>👥</span>
        <b>Following</b>
        <small>Casts from the accounts someone follows</small>
      </button>
      <button onClick={() => onAdd('list')}>
        <span>📋</span>
        <b>New list</b>
        <small>Pick the accounts yourself</small>
      </button>
    </section>
  );
}

function Welcome({ onPick }: { onPick: (networks: Network[]) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">🐈</div>
        <h1>Welcome to TabbyCats</h1>
        <p>Your feeds, side by side. Which network do you read?</p>
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
        <p className="hint">You can add or remove columns from either network any time.</p>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useAppState();
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [showMuted, setShowMuted] = useState(false);
  const { columns } = state;
  const mutedSet = useMemo(() => new Set(state.muted.map((m) => `${m.network}:${m.fid}`)), [state.muted]);
  const mute = (network: Network, fid: number, username?: string) =>
    setState((s) =>
      s.muted.some((m) => m.network === network && m.fid === fid) ? s : { ...s, muted: [...s.muted, { network, fid, username }] },
    );
  const inUse = ALL_NETWORKS.filter((n) => columns.some((c) => c.network === n));

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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🐈</span>
          <span className="wordmark">TabbyCats</span>
        </div>
        <div className="prefs">
          {inUse.map((n) => (
            <label key={n}>
              Open {NETWORKS[n].label} casts in
              <select
                value={state.openIn[n]}
                onChange={(e) => setState((s) => ({ ...s, openIn: { ...s.openIn, [n]: e.target.value } }))}
              >
                {CLIENTS[n].map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button className="btn-quiet small" onClick={() => setShowMuted(!showMuted)} aria-expanded={showMuted}>
            Muted ({state.muted.length})
          </button>
          <span className="badge" title="Your board is saved in this browser only">
            Read-only · saved on this device
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
            openInId={state.openIn[col.network]}
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
    </div>
  );
}
