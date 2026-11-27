import { createContext, useContext, useEffect, useRef, useState } from 'react';
import QR from 'qrcode';
import { type Cast, NETWORKS, type Network, getProfile } from './api';
import { CAST_LIMIT, newPostingKey, postCast, publicKeyOf } from './write';

export interface Account {
  fid: number;
  privateKey: string; // posting key for TabbyCats; it can post but can't move the account
  username?: string;
  expiresAt?: number; // Hypersnap keys expire (ms)
}

export type Accounts = Partial<Record<Network, Account>>;

const KEYS: Record<Network, string> = {
  farcaster: 'tabbycats:farcaster-account',
  hypersnap: 'tabbycats:hypersnap-account',
};

export function loadAccounts(): Accounts {
  const out: Accounts = {};
  for (const n of Object.keys(KEYS) as Network[]) {
    try {
      const a = JSON.parse(localStorage.getItem(KEYS[n]) ?? 'null');
      if (a?.fid && a?.privateKey && !(a.expiresAt && a.expiresAt < Date.now())) out[n] = a;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function saveAccount(network: Network, a: Account | null) {
  try {
    if (a) localStorage.setItem(KEYS[network], JSON.stringify(a));
    else localStorage.removeItem(KEYS[network]);
  } catch {
    /* storage blocked: stays signed in for this visit only */
  }
}

export interface WriteApi {
  accounts: Accounts;
  signIn: (network?: Network) => void;
  compose: (parent?: Cast) => void;
  react: (kind: 'like' | 'recast', cast: Cast) => Promise<void>;
}

export const WriteContext = createContext<WriteApi>({
  accounts: {},
  signIn: () => {},
  compose: () => {},
  react: async () => {},
});

export const useWrite = () => useContext(WriteContext);

function Modal({ label, onClose, className = '', children }: { label: string; onClose: () => void; className?: string; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

// Pick a network to sign in to.
export function SignInChooser({ accounts, onPick, onClose }: { accounts: Accounts; onPick: (n: Network) => void; onClose: () => void }) {
  return (
    <Modal label="Sign in" onClose={onClose} className="chooser">
      <h2>Sign in to post</h2>
      <p className="hint">Sign in to one network or both. Each gives TabbyCats its own posting key.</p>
      <button className="choice" disabled={!!accounts.farcaster} onClick={() => onPick('farcaster')}>
        <span className="net net-farcaster">Farcaster</span>
        <b>{accounts.farcaster ? 'Signed in' : 'Approve with the Farcaster app'}</b>
        <small>Scan a QR code and approve on your phone.</small>
      </button>
      <button className="choice" disabled={!!accounts.hypersnap} onClick={() => onPick('hypersnap')}>
        <span className="net net-hypersnap">Hypersnap</span>
        <b>{accounts.hypersnap ? 'Signed in' : 'Unlock with your recovery phrase'}</b>
        <small>Used once in this browser to create a posting key, then forgotten.</small>
      </button>
    </Modal>
  );
}

type Step =
  | { kind: 'starting' }
  | { kind: 'waiting'; qr: string; link: string }
  | { kind: 'approved' }
  | { kind: 'error'; message: string };

export function FarcasterSignIn({ onClose, onDone }: { onClose: () => void; onDone: (a: Account) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    (async () => {
      try {
        const privateKey = newPostingKey();
        const key = await publicKeyOf(privateKey);
        const res = await fetch('/api/signer-request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) throw new Error("Couldn't reach Farcaster. Give it a moment and try again.");
        const { token, deeplinkUrl } = await res.json();
        const qr = await QR.toDataURL(deeplinkUrl, { margin: 1, width: 240, color: { dark: '#2b1700', light: '#fff8ea' } });
        if (!live) return;
        setStep({ kind: 'waiting', qr, link: deeplinkUrl });
        const started = Date.now();
        const poll = async () => {
          if (!live) return;
          if (Date.now() - started > 10 * 60 * 1000) {
            setStep({ kind: 'error', message: 'This request wandered off. Try again.' });
            return;
          }
          try {
            const r = await fetch(`https://api.farcaster.xyz/v2/signed-key-request?token=${encodeURIComponent(token)}`);
            const req = (await r.json())?.result?.signedKeyRequest;
            if (req?.state === 'completed' && req.userFid) {
              const p = await getProfile('farcaster', req.userFid);
              if (live) done.current({ fid: req.userFid, privateKey, username: p.username });
              return;
            }
            if (req?.state === 'approved' && live) setStep({ kind: 'approved' });
          } catch {
            /* keep polling */
          }
          timer = setTimeout(poll, 2000);
        };
        timer = setTimeout(poll, 2000);
      } catch (e) {
        if (live) setStep({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [attempt]);

  return (
    <Modal label="Sign in with Farcaster" onClose={onClose}>
      <h2>Sign in with Farcaster</h2>
      {step.kind === 'starting' && <p className="hint">Stretching… preparing your request</p>}
      {step.kind === 'waiting' && (
        <>
          <p>Scan with your phone's camera and approve TabbyCats in the Farcaster app.</p>
          <img className="qr" src={step.qr} alt="QR code to approve TabbyCats in Farcaster" />
          <a className="btn" href={step.link}>
            On your phone? Open Farcaster
          </a>
          <p className="hint">
            TabbyCats gets a key that can post as you. It can't move your account or funds, and you can remove it any time in
            Farcaster's settings under Connected apps.
          </p>
        </>
      )}
      {step.kind === 'approved' && <p>Approved! Purring along while Farcaster confirms… just a few seconds.</p>}
      {step.kind === 'error' && (
        <>
          <p className="error">{step.message}</p>
          <button className="btn" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </>
      )}
    </Modal>
  );
}

export function HypersnapSignIn({ onClose, onDone }: { onClose: () => void; onDone: (a: Account) => void }) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;

  const unlock = async () => {
    if (busy) return;
    setError('');
    setBusy('Checking your phrase…');
    try {
      const { unlockHypersnap } = await import('./hypersnap');
      const key = await unlockHypersnap(phrase, setBusy);
      setPhrase(''); // forget it straight away
      const p = await getProfile('hypersnap', key.fid);
      onDone({ ...key, username: p.username ?? p.display });
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  };

  return (
    <Modal label="Unlock Hypersnap" onClose={onClose} className="unlock">
      <h2>Unlock Hypersnap</h2>
      <p>Enter your account's recovery phrase to let TabbyCats post for you on Hypersnap.</p>
      <textarea
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="12 or 24 words, separated by spaces"
        rows={3}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={!!busy}
        aria-label="Recovery phrase"
      />
      <div className="unlock-foot">
        <span className="hint">{words ? `${words} words` : ''}</span>
        <button className="btn" disabled={!!busy || (words !== 12 && words !== 24)} onClick={unlock}>
          {busy || 'Unlock'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="unlock-promises">
        <li>🔒 Your phrase stays in this browser. It's used once to create a posting key, then forgotten. It's never saved or sent anywhere.</li>
        <li>⏳ The posting key can cast, reply, like and follow for 90 days. It can't move your account or funds.</li>
        <li>🐾 TabbyCats is open source, so you can check exactly what it does with your phrase.</li>
      </ul>
    </Modal>
  );
}

export function Composer({
  accounts,
  parent,
  parentName,
  replyNetwork,
  onClose,
  onSent,
}: {
  accounts: Accounts;
  parent?: Cast;
  parentName?: string;
  replyNetwork?: Network; // replies go to the network chosen for the cast
  onClose: () => void;
  onSent: (network: Network) => void;
}) {
  const available = (Object.keys(NETWORKS) as Network[]).filter((n) => accounts[n]);
  const [network, setNetwork] = useState<Network>(replyNetwork ?? (accounts.farcaster ? 'farcaster' : available[0]));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const limit = CAST_LIMIT;
  const bytes = new TextEncoder().encode(text).length;
  const account = accounts[network]!;

  const send = async () => {
    if (busy || !text.trim() || bytes > limit) return;
    setBusy(true);
    setError('');
    try {
      await postCast(account, network, text, parent ? { fid: parent.fid, hash: parent.hash } : undefined);
      onSent(network);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal label={parent ? 'Reply' : 'New cast'} onClose={onClose} className="composer">
      <h2>{parent ? `Reply to @${parentName ?? parent.fid}` : 'New cast'}</h2>
      {parent && <blockquote className="quote">{parent.text.slice(0, 200)}</blockquote>}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
        placeholder={parent ? 'Write your reply…' : 'What has your whiskers twitching?'}
        rows={5}
      />
      <div className="composer-foot">
        {limit - bytes <= 60 && (
          <span className={bytes > limit ? 'error' : 'hint'}>
            {bytes > limit ? `${bytes - limit} over the limit` : `${limit - bytes} characters left`}
          </span>
        )}
        {error && <span className="error">{error}</span>}
        <button className="btn" disabled={busy || !text.trim() || bytes > limit} onClick={send}>
          {busy ? 'Sending…' : parent ? 'Reply' : 'Cast'}
        </button>
      </div>
      {!parent && available.length > 1 ? (
        <div className="composer-network">
          <span className="hint">Post to</span>
          <div className="switch small" role="radiogroup" aria-label="Network">
            {available.map((n) => (
              <button key={n} role="radio" aria-checked={n === network} className={n === network ? 'on' : ''} onClick={() => setNetwork(n)}>
                {NETWORKS[n].label}
              </button>
            ))}
          </div>
          <span className="hint">as @{account.username ?? account.fid}</span>
        </div>
      ) : (
        <p className="hint">
          Posting to {NETWORKS[network].label} as @{account.username ?? account.fid}
        </p>
      )}
    </Modal>
  );
}
