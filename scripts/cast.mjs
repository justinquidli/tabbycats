// Post a cast as @tabbycats on Farcaster, using the account's posting key in ~/.tabbycats/signer.json.
//
//   node scripts/cast.mjs "🐈"
import fs from 'node:fs';
import { hexToBytes, bytesToHex } from 'viem';
import * as fc from '@farcaster/core';

const FID = 3359500;
const NODE = 'https://snap.farcaster.xyz:3381';
const text = process.argv[2];
if (!text) {
  console.log('Usage: node scripts/cast.mjs "text"');
  process.exit(1);
}

const { privateKey } = JSON.parse(fs.readFileSync(`${process.env.HOME}/.tabbycats/signer.json`, 'utf8'));
const signer = new fc.NobleEd25519Signer(hexToBytes(privateKey));
const msg = (
  await fc.makeCastAdd(
    { text, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: fc.CastType.CAST },
    { fid: FID, network: fc.FarcasterNetwork.MAINNET },
    signer,
  )
)._unsafeUnwrap();
// Send the exact bytes that were hashed; the node's own re-encoding differs for empty lists.
msg.dataBytes = fc.MessageData.encode(msg.data).finish();
const res = await fetch(`${NODE}/v1/submitMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: fc.Message.encode(msg).finish(),
});
console.log(res.ok ? `posted ${bytesToHex(msg.hash)}` : `${res.status} ${(await res.text()).slice(0, 200)}`);
