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

Currently read-only. Posting is planned.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # static site in dist/
```

## License

MIT
