import { createContext, useContext, useEffect, useRef, useState } from 'react';
import QR from 'qrcode';
import { type Cast, NETWORKS, type Network, getProfile } from './api';
import { CAST_LIMIT, postCast } from './write';
import { createKey, deleteKey, importKey } from './vault';
import { mentionAt, useMentionSuggestions } from './mentions';

export interface Account {
  fid: number;
  signer: string; // public key of the posting key; the key itself is non-exportable, in the browser's vault
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
      if (a?.fid && (a?.signer || a?.privateKey) && !(a.expiresAt && a.expiresAt < Date.now())) out[n] = a;
    } catch {
      /* ignore */
    }
  }
  return out;
}

// Older versions kept the raw posting key in localStorage. Move any such key into the vault
// (non-exportable) and drop the readable copy. Runs once per key; nobody has to sign in again.
export async function migrateKeys(accounts: Accounts): Promise<Accounts | null> {
  let changed = false;
  const next: Accounts = { ...accounts };
  for (const n of Object.keys(accounts) as Network[]) {
    const legacy = accounts[n] as (Account & { privateKey?: string }) | undefined;
    if (!legacy?.privateKey) continue;
    try {
      const signer = await importKey(legacy.privateKey);
      const { privateKey: _drop, ...rest } = legacy; // eslint-disable-line @typescript-eslint/no-unused-vars
      next[n] = { ...rest, signer };
      saveAccount(n, next[n]!);
      changed = true;
    } catch {
      /* vault unavailable (e.g. private mode); keep working as before */
    }
  }
  return changed ? next : null;
}

export function forgetKey(a: Account | undefined) {
  if (a?.signer) deleteKey(a.signer);
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
        const key = await createKey(); // non-exportable, kept in the browser's vault
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
              if (live) done.current({ fid: req.userFid, signer: key, username: p.username });
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
      const key = await unlockHypersnap(phrase, setBusy, () => setPhrase('')); // forgotten as soon as it's been used
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
        <li>⏳ The posting key can only cast, reply, like and recast, for 90 days. It can't follow, edit your profile, or move your account or funds.</li>
        <li>🐾 TabbyCats is open source, so you can check exactly what it does with your phrase.</li>
      </ul>
    </Modal>
  );
}

const COMPOSER_EMOJI = [
  '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🐈', '🐈‍⬛', '🐾',
  '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤔', '🫠', '🥲', '😭', '😤',
  '🙏', '👏', '🙌', '👀', '🫡', '🤝', '💪', '👋', '🫰', '✌️', '👍', '👎',
  '❤️', '🧡', '💛', '💜', '🔥', '✨', '⭐', '🎉', '💯', '✅', '❌', '⚡',
  '🚀', '🌊', '⛩️', '🎩', '🪙', '💸', '📈', '📉', '🧠', '🛠️', '☕', '🍿',
];

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

  // @mention autocomplete
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const at = mentionAt(text, caret);
  const open = at && dismissed !== at.start ? at : null;
  const suggestions = useMentionSuggestions(open ? open.query : null, network, account.fid);
  const showList = !!open && suggestions.length > 0;
  useEffect(() => setPicked(0), [open?.query]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const insert = (snippet: string) => {
    const el = box.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    const pos = start + snippet.length;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(pos, pos);
    });
  };
  const choose = (username: string) => {
    if (!open) return;
    const next = text.slice(0, open.start) + '@' + username + ' ' + text.slice(caret);
    const pos = open.start + username.length + 2;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(pos, pos);
    });
  };

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
      <div className="composer-box">
        <textarea
          ref={box}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (showList) {
              if (e.key === 'ArrowDown') return e.preventDefault(), setPicked((picked + 1) % suggestions.length);
              if (e.key === 'ArrowUp') return e.preventDefault(), setPicked((picked - 1 + suggestions.length) % suggestions.length);
              if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), choose(suggestions[picked].username);
              if (e.key === 'Escape') return e.stopPropagation(), setDismissed(open!.start);
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder={parent ? 'Write your reply…' : 'What has your whiskers twitching?'}
          rows={5}
          aria-autocomplete="list"
        />
        {showList && (
          <ul className="mention-list" role="listbox" aria-label="Mention suggestions">
            {suggestions.map((s, i) => (
              <li key={s.username}>
                <button
                  role="option"
                  aria-selected={i === picked}
                  className={i === picked ? 'on' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep the cursor in the box
                    choose(s.username);
                  }}
                >
                  {s.pfp ? <img src={s.pfp} alt="" referrerPolicy="no-referrer" /> : <span className="mention-dot">🐈</span>}
                  <b>@{s.username}</b>
                  {s.display && <span>{s.display}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {emojiOpen && (
        <div className="emoji-picker" role="listbox" aria-label="Emoji">
          {COMPOSER_EMOJI.map((e) => (
            <button
              key={e}
              onMouseDown={(ev) => {
                ev.preventDefault(); // keep the cursor where it was
                insert(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      <div className="composer-foot">
        <button
          className={`emoji-toggle ${emojiOpen ? 'on' : ''}`}
          title="Emoji"
          aria-label="Emoji"
          aria-expanded={emojiOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEmojiOpen(!emojiOpen)}
        >
          😺
        </button>
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
