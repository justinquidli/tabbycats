import { useEffect, useState } from 'react';
import { NETWORKS, type Network } from './api';

type Status = 'checking' | 'live' | 'down';

const ACCOUNTS: Record<Network, { label: string; href: string }> = {
  farcaster: { label: '@tabbycats', href: 'https://farcaster.xyz/tabbycats' },
  hypersnap: { label: 'TabbyCats', href: 'https://quilcast.com/u/4294967372' },
};

function useNodeStatus(network: Network) {
  const [status, setStatus] = useState<Status>('checking');
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(`${NETWORKS[network].node}/v1/info`, { signal: ctrl.signal })
      .then((r) => live && setStatus(r.ok ? 'live' : 'down'))
      .catch(() => live && setStatus('down'))
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [network]);
  return status;
}

function NodeRow({ network }: { network: Network }) {
  const status = useNodeStatus(network);
  const url = NETWORKS[network].node;
  return (
    <li className="node-row">
      <span className={`net net-${network}`}>{NETWORKS[network].label}</span>
      <code title={url}>{url.replace(/^https:\/\//, '')}</code>
      <span className={`node-status ${status}`}>
        <span className="node-dot" aria-hidden="true" />
        {status === 'checking' ? 'Checking…' : status === 'live' ? 'Live' : "Can't reach"}
      </span>
    </li>
  );
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about" role="dialog" aria-modal="true" aria-label="About TabbyCats" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <img className="about-logo" src="/pfp-2.png" alt="" />
        <h2>TabbyCats</h2>
        <p className="about-tagline">Curate multiple feeds on Farcaster &amp; Hypersnap in a single client, meow! 😺</p>

        <section className="about-section">
          <h3>Where your feeds come from</h3>
          <p className="hint">TabbyCats reads straight from these public nodes. No middleman, no algorithm.</p>
          <ul className="node-list">
            {(Object.keys(NETWORKS) as Network[]).map((n) => (
              <NodeRow key={n} network={n} />
            ))}
          </ul>
        </section>

        <section className="about-section">
          <h3>Your stuff stays with you</h3>
          <p className="hint">
            Your feeds, mutes and posting key live in this browser only. There's no TabbyCats account and nothing about you on our
            servers.
          </p>
        </section>

        <section className="about-section">
          <h3>Follow along</h3>
          <ul className="about-links">
            {(Object.keys(ACCOUNTS) as Network[]).map((n) => (
              <li key={n}>
                <span className={`net net-${n}`}>{NETWORKS[n].label}</span>
                <a href={ACCOUNTS[n].href} target="_blank" rel="noreferrer noopener">
                  {ACCOUNTS[n].label} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>

        <p className="about-foot">
          <a href="https://github.com/justinquidli/tabbycats" target="_blank" rel="noreferrer noopener">
            Open source on GitHub
          </a>{' '}
          · MIT · client list from{' '}
          <a href="https://forkcaster.xyz" target="_blank" rel="noreferrer noopener">
            Forkcaster
          </a>
        </p>
      </div>
    </div>
  );
}
