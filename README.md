# 🐈 TabbyCats

A simple, column-based reader for **Farcaster** and **Hypersnap**. Line up the feeds you care about side by side, like a board.

- **🌊 All**: every new cast on the network, live and newest first
- **👥 Following**: casts from the accounts someone follows
- **📋 Lists**: pick the accounts yourself (teammates, meme kings, token projects…)
- Mix Farcaster and Hypersnap columns on one board; each column is labelled with its network
- Rename columns, give them an emoji, reorder, hide replies, pause, remove
- Mute accounts across every column
- Open any cast in another client: Farcaster, Quilcast, Firefly and more (list adapted from [Forkcaster](https://github.com/artlu99/forkcaster_xyz), MIT)

Everything is saved in your browser. There is no backend and no account; TabbyCats reads straight from public nodes:

| Network | Node |
|---|---|
| Farcaster | `https://snap.farcaster.xyz:3381` |
| Hypersnap | `https://haatz.quilibrium.com` |

**Posting (Farcaster):** sign in with Farcaster by scanning a QR code and approving TabbyCats in the Farcaster app. TabbyCats then holds a posting key in your browser that can cast, reply, like and recast, but can't move your account. Remove it any time in Farcaster's settings under Connected apps. 

**Posting (Hypersnap):** unlock with your account's recovery phrase. The phrase is used once, in your browser, to sign a 90-day posting key, and is never saved or sent anywhere (see `src/hypersnap.ts`). Works for accounts created before the Nov 12, 2026 split and for native Hypersnap accounts.

The app's own accounts are [@tabbycats](https://farcaster.xyz/tabbycats) on Farcaster (FID 3359500) and [TabbyCats](https://quilcast.com/u/4294967372) on Hypersnap (FID 4294967372). Its keys live outside the repo; `scripts/update-profile.mjs` updates its profile.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # static site in dist/
```

## License

MIT. The @tabbycats profile picture uses the 🐈 from Google's [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0).

## Deploy

Hosted on Cloudflare Workers (static assets). `worker/index.js` serves the app and redirects `tabbycat.party` and `www.*` to `tabbycats.party`.

```sh
npm run build && npx wrangler deploy
```
