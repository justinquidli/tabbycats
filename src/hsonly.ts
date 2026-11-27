// "Hypersnap-only" accounts: native Hypersnap accounts, which can't exist on Farcaster.
//
// Older accounts that left or were banned from Farcaster's app look identical on the network
// (same account, same posts on both nodes). The only public signal is Farcaster's app API,
// which blocks both browsers (no CORS) and Cloudflare Workers (HTTP 429), so they can't be
// detected here; a hand-made feed is the way to follow them.
const FIRST_NATIVE_FID = 4294967296;

export const isHypersnapNative = (fid: number) => fid >= FIRST_NATIVE_FID;
