import { Component, type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
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
interface Preview {
  title?: string;
  description?: string;
  site?: string;
  image?: string;
}
const previews = new Map<string, Promise<Preview>>();
const getPreview = (url: string) => {
  let p = previews.get(url);
  if (!p) {
    p = fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    previews.set(url, p);
  }
  return p;
};

// A link with its page's preview card, fetched once it scrolls into view
export function LinkCard({ url, host }: { url: string; host: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        getPreview(url).then((p) => alive && setPreview(p));
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [url]);
  const image = preview?.image && /^https:\/\//i.test(preview.image) ? preview.image : undefined;
  if (!preview?.title) {
    return (
      <a ref={ref} className="embed-link" href={url} target="_blank" rel="noreferrer noopener">
        🔗 {host}
      </a>
    );
  }
  return (
    <a ref={ref} className="link-card" href={url} target="_blank" rel="noreferrer noopener">
      {image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
      <span className="link-card-text">
        <span className="link-card-site">{preview.site || host}</span>
        <b>{preview.title}</b>
        {preview.description && <span className="link-card-desc">{preview.description}</span>}
      </span>
    </a>
  );
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v|m3u8)(\?|$)/i;

// Videos: plain files play in the browser's own player. Streams (.m3u8, how Farcaster's app hosts
// video) play natively in Safari; elsewhere a small stream player loads the first time you press play.
function Video({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = /\.m3u8(\?|$)/i.test(url);
  const [started, setStarted] = useState(!stream);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!started || !v || !stream) return;
    let cancelled = false;
    let player: { destroy(): void } | undefined;
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      v.play().catch(() => {});
    } else {
      import('hls.js/light')
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) return setFailed(true);
          const hls = new Hls({ enableWorker: false });
          player = hls;
          hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setFailed(true));
          hls.loadSource(url);
          hls.attachMedia(v);
          v.play().catch(() => {});
        })
        .catch(() => setFailed(true));
    }
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [started, stream, url]);

  if (failed) {
    return (
      <a className="embed-link" href={url} target="_blank" rel="noreferrer noopener">
        🎬 Couldn't play this video here. Open it ↗
      </a>
    );
  }
  if (!started) {
    return (
      <button
        className="embed-video-start"
        onClick={(e) => {
          e.stopPropagation();
          setStarted(true);
        }}
      >
        <span aria-hidden="true">▶</span> Play video
      </button>
    );
  }
  return (
    <video
      ref={ref}
      className="embed-video"
      controls
      playsInline
      preload="metadata"
      src={stream ? undefined : url}
      onClick={(e) => e.stopPropagation()}
      onError={() => !stream && setFailed(true)}
    />
  );
}

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
        // Embeds are written by whoever posted the cast: only ever link to web pages,
        // never javascript: or other schemes that could run code on this page.
        if (!e.url || !/^https?:\/\//i.test(e.url)) return null;
        if (VIDEO_RE.test(e.url)) return <Video key={i} url={e.url} />;
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
        return <LinkCard key={i} url={e.url} host={host} />;
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
  const doReact = async (kind: 'like' | 'recast') => {
    if (done[kind]) return;
    setFailed('');
    setDone((d) => ({ ...d, [kind]: true }));
    try {
      await write.react(kind, cast);
    } catch (e) {
      setDone((d) => ({ ...d, [kind]: false }));
      if (write.accounts[cast.network]) setFailed((e as Error).message);
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
        {/* signed out: these open sign-in for this cast's network */}
        {(
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

// One malformed cast should never take the whole board down: it just disappears.
export class CastBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    return this.state.broken ? null : this.props.children;
  }
}
