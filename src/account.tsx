import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Cast } from './api';
import { getProfile } from './api';

export interface FcAccount {
  fid: number;
  privateKey: string; // posting key the user approved for TabbyCats; it can post but can't move the account
  username?: string;
}

const KEY = 'tabbycats:farcaster-account';

export function loadAccount(): FcAccount | null {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return a?.fid && a?.privateKey ? a : null;
  } catch {
    return null;
  }
}

export function saveAccount(a: FcAccount | null) {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: stays signed in for this visit only */
  }
}

export interface WriteApi {
  account: FcAccount | null;
  signIn: () => void;
  compose: (parent?: Cast) => void;
  react: (kind: 'like' | 'recast', cast: Cast) => Promise<void>;
}

export const WriteContext = createContext<WriteApi>({
  account: null,
  signIn: () => {},
  compose: () => {},
  react: async () => {},
});

export const useWrite = () => useContext(WriteContext);

type Step =
  | { kind: 'starting' }
  | { kind: 'waiting'; qr: string; link: string }
  | { kind: 'approved' }
  | { kind: 'error'; message: string };

export function SignInModal({ onClose, onDone }: { onClose: () => void; onDone: (a: FcAccount) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    (async () => {
      try {
        const [{ newPostingKey, publicKeyOf }, QR] = await Promise.all([import('./write'), import('qrcode')]);
        const privateKey = newPostingKey();
        const key = await publicKeyOf(privateKey);
        const res = await fetch('/api/signer-request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) throw new Error("Couldn't reach Farcaster. Try again in a moment.");
        const { token, deeplinkUrl } = await res.json();
        const qr = await QR.toDataURL(deeplinkUrl, { margin: 1, width: 240, color: { dark: '#2b1700', light: '#fff8ea' } });
        if (!live) return;
        setStep({ kind: 'waiting', qr, link: deeplinkUrl });
        const started = Date.now();
        const poll = async () => {
          if (!live) return;
          if (Date.now() - started > 10 * 60 * 1000) {
            setStep({ kind: 'error', message: 'The request expired. Try again.' });
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in with Farcaster" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2>Sign in with Farcaster</h2>
        {step.kind === 'starting' && <p className="hint">Preparing your request…</p>}
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
        {step.kind === 'approved' && <p>Approved! Waiting for Farcaster to confirm… this takes a few seconds.</p>}
        {step.kind === 'error' && (
          <>
            <p className="error">{step.message}</p>
            <button className="btn" onClick={() => setAttempt(attempt + 1)}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Composer({
  account,
  parent,
  parentName,
  onClose,
  onSent,
}: {
  account: FcAccount;
  parent?: Cast;
  parentName?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(320);
  const bytes = new TextEncoder().encode(text).length;

  useEffect(() => {
    import('./write').then((w) => setLimit(w.CAST_LIMIT));
  }, []);

  const send = async () => {
    if (busy || !text.trim() || bytes > limit) return;
    setBusy(true);
    setError('');
    try {
      const { postCast } = await import('./write');
      await postCast(account, text, parent ? { fid: parent.fid, hash: parent.hash } : undefined);
      onSent();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal composer" role="dialog" aria-modal="true" aria-label={parent ? 'Reply' : 'New cast'} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2>{parent ? `Reply to @${parentName ?? parent.fid}` : 'New cast'}</h2>
        {parent && <blockquote className="quote">{parent.text.slice(0, 200)}</blockquote>}
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder={parent ? 'Write your reply…' : "What's happening?"}
          rows={5}
        />
        <div className="composer-foot">
          <span className={bytes > limit ? 'error' : 'hint'}>{limit - bytes}</span>
          {error && <span className="error">{error}</span>}
          <button className="btn" disabled={busy || !text.trim() || bytes > limit} onClick={send}>
            {busy ? 'Sending…' : parent ? 'Reply' : 'Cast'}
          </button>
        </div>
        <p className="hint">Posting as @{account.username ?? account.fid} on Farcaster · ⌘↵ to send</p>
      </div>
    </div>
  );
}
