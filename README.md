# 🐈 TabbyCats

A simple, column-based reader for **Farcaster** and **Hypersnap**. Line up the feeds you care about side by side, like a board.

- **🌊 All**: every new cast on the network, live and newest first
- **👥 Following**: casts from the accounts someone follows
- **📋 Lists**: pick the accounts yourself (teammates, meme kings, token projects…)
- Mix Farcaster and Hypersnap columns on one board; each column is labelled with its network
- Rename columns, give them an emoji, reorder, hide replies, pause, remove
- Mute accounts across every column
- Open any cast in your preferred client (Farcaster, Forkcaster, Quilcast)

Everything is saved in your browser. There is no backend and no account; TabbyCats reads straight from public nodes:

| Network | Node |
|---|---|
| Farcaster | `https://snap.farcaster.xyz:3381` |
| Hypersnap | `https://haatz.quilibrium.com` |

**Posting (Farcaster):** sign in with Farcaster by scanning a QR code and approving TabbyCats in the Farcaster app. TabbyCats then holds a posting key in your browser that can cast, reply, like and recast, but can't move your account. Remove it any time in Farcaster's settings under Connected apps. Hypersnap posting is next.

The app's own account is [@tabbycats](https://farcaster.xyz/tabbycats) (FID 3359500). Its keys live outside the repo; `scripts/update-profile.mjs` updates its profile.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # static site in dist/
```

## License

MIT

## Deploy

Hosted on Cloudflare Workers (static assets). `worker/index.js` serves the app and redirects `tabbycat.party` and `www.*` to `tabbycats.party`.

```sh
npm run build && npx wrangler deploy
```
