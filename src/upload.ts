// Photo uploads for casts. Files go straight from the browser to free public image hosts
// (Blossom servers, https://github.com/hzrd149/blossom), never through TabbyCats.
// Each upload is signed with a throwaway key made for that upload alone, so nothing links
// one upload to another or to the account that posts it.
import { schnorr } from '@noble/curves/secp256k1';

interface Host {
  upload: string; // where to send the file
  label: string; // shown under the photo: "via …"
  serves: (hostname: string) => boolean; // the photo URL it returns must be on its own domain
}

export const HOSTS: Host[] = [
  { upload: 'https://blossom.primal.net', label: 'blossom.primal.net', serves: (h) => h === 'blossom.primal.net' },
  { upload: 'https://nostr.download', label: 'nostr.download', serves: (h) => h === 'nostr.download' },
  { upload: 'https://blossom.band', label: 'blossom.band', serves: (h) => h === 'blossom.band' || h.endsWith('.blossom.band') },
];

export const MAX_PHOTOS = 2; // a cast carries at most 2 embeds
const MAX_SIDE = 2048;
const MAX_GIF = 10 * 1024 * 1024;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array | ArrayBuffer) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** Redraw the photo so it carries no hidden data (location, camera), capped at 2048px. GIFs stay as they are to keep them moving. */
async function prepare(file: File): Promise<Blob> {
  if (file.type === 'image/gif') {
    if (file.size > MAX_GIF) throw new Error('That GIF is over 10 MB');
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("Couldn't read that image");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'; // keep PNG for transparency
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
  if (!blob) throw new Error("Couldn't read that image");
  return blob;
}

/** Blossom's upload permission: a short-lived note signed by a key made just for this upload. */
async function authHeader(fileHash: string): Promise<string> {
  const priv = schnorr.utils.randomPrivateKey();
  const pubkey = hex(schnorr.getPublicKey(priv));
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 24242;
  const tags = [['t', 'upload'], ['x', fileHash], ['expiration', String(created_at + 300)]];
  const content = 'Upload photo';
  const id = hex(await sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = hex(schnorr.sign(id, priv));
  const json = JSON.stringify({ id, pubkey, created_at, kind, tags, content, sig });
  return 'Nostr ' + btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

export async function uploadPhoto(file: File): Promise<{ url: string; host: string }> {
  if (!file.type.startsWith('image/')) throw new Error('Photos only for now');
  const blob = await prepare(file);
  const body = new Uint8Array(await blob.arrayBuffer());
  const fileHash = hex(await sha256(body));
  let lastError = 'Upload failed';
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(`${host.upload}/upload`, {
        method: 'PUT',
        headers: { authorization: await authHeader(fileHash), 'content-type': blob.type, 'x-sha-256': fileHash },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        lastError = res.headers.get('x-reason') || `Upload failed (${res.status})`;
        continue;
      }
      const d = await res.json();
      const url = typeof d?.url === 'string' ? new URL(d.url) : null;
      // Only accept a link to the file we sent, on the host we sent it to
      if (url && url.protocol === 'https:' && host.serves(url.hostname) && url.pathname.includes(fileHash)) {
        return { url: url.href, host: host.label };
      }
      lastError = 'Upload failed';
    } catch {
      lastError = "Couldn't reach the photo host";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}
