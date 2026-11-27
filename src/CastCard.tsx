import { memo, useEffect, useMemo, useState } from 'react';
import { type Cast, type Network, type Profile, getProfile, peekProfile } from './api';
import { openLinks, primaryLink } from './clients';
import { useWrite } from './account';

export function useProfile(network: Network, fid: number): Profile | undefined {
  const [profile, setProfile] = useState(() => peekProfile(network, fid));
  useEffect(() => {
    let live = true;
    const cached = peekProfile(network, fid);
    if (cached) setProfile(cached);
    else getProfile(network, fid).then((p) => live && setProfile(p));
    return () => {
      live = false;
    };
  }, [network, fid]);
  return profile;
}

function timeAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function Mention({ network, fid }: { network: Network; fid: number }) {
  const p = useProfile(network, fid);
  return <span className="mention">@{p?.username ?? `fid:${fid}`}</span>;
}

function CastText({ cast }: { cast: Cast }) {
  // Mentions are stored as UTF-8 byte offsets into the text.
  const segments = useMemo(() => {
    if (!cast.mentions.length) return [{ text: cast.text }];
    const bytes = new TextEncoder().encode(cast.text);
    const dec = new TextDecoder();
    const out: { text?: string; fid?: number }[] = [];
    let last = 0;
    cast.mentionsPositions.forEach((pos, i) => {
      out.push({ text: dec.decode(bytes.slice(last, pos)) });
      out.push({ fid: cast.mentions[i] });
      last = pos;
    });
    out.push({ text: dec.decode(bytes.slice(last)) });
    return out;
  }, [cast]);
  return (
    <p className="cast-text">
      {segments.map((s, i) =>
        s.fid !== undefined ? <Mention key={i} network={cast.network} fid={s.fid} /> : <Linkified key={i} text={s.text!} />,
      )}
    </p>
  );
}

const IMG_RE = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;

function Embeds({ cast }: { cast: Cast }) {
  if (!cast.embeds.length) return null;
  return (
    <div className="embeds">
      {cast.embeds.map((e, i) => {
        if (e.castId) {
          return (
            <a key={i} className="embed-link" href={primaryLink(cast.network, e.castId)} target="_blank" rel="noreferrer noopener">
              💬 Quoted cast ↗
            </a>
          );
        }
        if (!e.url) return null;
        if (IMG_RE.test(e.url) || e.url.includes('imagedelivery.net')) {
          return (
            <a key={i} className="embed-img-link" href={e.url} target="_blank" rel="noreferrer noopener">
              <img className="embed-img" src={e.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </a>
          );
        }
        let host = e.url;
        try {
          host = new URL(e.url).hostname.replace(/^www\./, '');
        } catch {
          /* keep raw */
        }
        return (
          <a key={i} className="embed-link" href={e.url} target="_blank" rel="noreferrer noopener">
            🔗 {host}
          </a>
        );
      })}
    </div>
  );
}

function ReplyTo({ cast }: { cast: Cast }) {
  const p = useProfile(cast.network, cast.parent!.fid);
  return <div className="reply-to">↳ replying to @{p?.username ?? '…'}</div>;
}

export const CastCard = memo(function CastCard({
  cast,
  onMute,
}: {
  cast: Cast;
  onMute: (fid: number, username?: string) => void;
}) {
  const p = useProfile(cast.network, cast.fid);
  const [openMenu, setOpenMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const write = useWrite();
  const [done, setDone] = useState<{ like?: boolean; recast?: boolean }>({});
  const [failed, setFailed] = useState('');
  const canWrite = cast.network === 'farcaster';
  const doReact = async (kind: 'like' | 'recast') => {
    if (done[kind]) return;
    setFailed('');
    setDone((d) => ({ ...d, [kind]: true }));
    try {
      await write.react(kind, cast);
    } catch (e) {
      setDone((d) => ({ ...d, [kind]: false }));
      if (write.account) setFailed((e as Error).message);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(primaryLink(cast.network, cast, p?.username));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <article className="cast">
      {p?.pfp ? (
        <img className="pfp" src={p.pfp} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="pfp pfp-empty">🐈</div>
      )}
      <div className="cast-body">
        <header className="cast-head">
          <span className="display">{p?.display || p?.username || `fid ${cast.fid}`}</span>
          {p?.username && <span className="handle">@{p.username}</span>}
          <span className="dot">·</span>
          <time dateTime={new Date(cast.ts).toISOString()} title={new Date(cast.ts).toLocaleString()}>
            {timeAgo(cast.ts)}
          </time>
        </header>
        {cast.parent && <ReplyTo cast={cast} />}
        <CastText cast={cast} />
        <Embeds cast={cast} />
        {canWrite && (
          <div className="cast-write">
            <button onClick={() => write.compose(cast)} title="Reply">
              💬 Reply
            </button>
            <button className={done.recast ? 'on' : ''} onClick={() => doReact('recast')} title="Recast">
              🔁 {done.recast ? 'Recasted' : 'Recast'}
            </button>
            <button className={done.like ? 'on' : ''} onClick={() => doReact('like')} title="Like">
              {done.like ? '❤️ Liked' : '🤍 Like'}
            </button>
          </div>
        )}
        {failed && <div className="error">{failed}</div>}
        <footer className="cast-actions">
          <button className="open-toggle" aria-expanded={openMenu} onClick={() => setOpenMenu(!openMenu)}>
            Open in… {openMenu ? '▴' : '▾'}
          </button>
          <button className="quiet" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button
            className="quiet mute"
            title="Hide this account's casts everywhere on this device"
            onClick={() => {
              const who = p?.username ? `@${p.username}` : `fid ${cast.fid}`;
              if (confirm(`Mute ${who}? Their casts will be hidden in every feed.`)) onMute(cast.fid, p?.username);
            }}
          >
            Mute
          </button>
        </footer>
        {openMenu && (
          <nav className="open-menu" aria-label="Open this cast in">
            {openLinks(cast.network, cast, p?.username).map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener" onClick={() => setOpenMenu(false)}>
                {l.label}
              </a>
            ))}
            <span className="open-credit">
              Client list from{' '}
              <a href="https://forkcaster.xyz" target="_blank" rel="noreferrer noopener">
                Forkcaster
              </a>
            </span>
          </nav>
        )}
      </div>
    </article>
  );
});
