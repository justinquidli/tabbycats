// Finds links in cast text: full ones (https://…) and bare addresses like tabbycats.party,
// which the Farcaster app also turns into links.

// Common web endings, so "node.js" or "e.g." aren't mistaken for addresses
const TLDS =
  'com|net|org|io|xyz|party|app|dev|co|me|ai|gg|so|fm|tv|info|biz|art|wtf|lol|fun|club|site|online|tech|space|world|news|blog|link|page|social|cash|money|finance|market|shop|store|studio|design|xyz|one|pro|ly|sh|to|us|uk|ca|de|fr|jp|kr|in|au|nl|es|it|br|ch|se|no|eu|cc|vc|is|im|gl|run|build|wiki|edu|gov|church|cat|cafe|zone|city|land|life|live|today|network|systems|tools|works|digital|media|games|game|chat|email|website|computer|garden|farm|cool|best|top|ninja|rocks|team|global|vip|limo|to';

const FULL = /https?:\/\/[^\s<>"'`]+/gi;
const BARE = new RegExp(`(?<![\\w@./-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?![\\w-])(/[^\\s<>"'\`]*)?`, 'gi');
const TRAIL = /[.,;:!?)\]}'"]+$/;

export interface FoundLink {
  start: number;
  end: number;
  href: string; // always https?://…
  label: string; // as typed
}

export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of text.matchAll(FULL)) {
    const label = m[0].replace(TRAIL, '');
    out.push({ start: m.index!, end: m.index! + label.length, href: label, label });
  }
  for (const m of text.matchAll(BARE)) {
    const start = m.index!;
    if (out.some((l) => start >= l.start && start < l.end)) continue; // part of a full link
    const label = m[0].replace(TRAIL, '');
    out.push({ start, end: start + label.length, href: `https://${label}`, label });
  }
  return out
    .filter((l) => {
      try {
        return /^https?:$/.test(new URL(l.href).protocol);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.start - b.start);
}
