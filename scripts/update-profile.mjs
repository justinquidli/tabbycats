// Update the @tabbycats profile. Uses the account's posting key in ~/.tabbycats/signer.json.
//
//   node scripts/update-profile.mjs --display "TabbyCats" --bio "…" --url "https://tabbycats.party" --pfp "https://…/cat.png"
//
// Only the fields you pass are changed. Sent to the Farcaster node, and to Hypersnap
// (which only accepts it once Hypersnap has synced the account).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { hexToBytes } from 'viem';
import * as fc from '@farcaster/core';

const FID = 3359500;
const NODES = ['https://snap.farcaster.xyz:3381', process.env.HYPERSNAP_NODE ?? 'https://haatz.quilibrium.com'];
const FIELDS = {
  display: fc.UserDataType.DISPLAY,
  bio: fc.UserDataType.BIO,
  url: fc.UserDataType.URL,
  pfp: fc.UserDataType.PFP,
  username: fc.UserDataType.USERNAME,
};

const { values } = parseArgs({ options: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, { type: 'string' }])) });
if (!Object.keys(values).length) {
  console.log('Pass at least one of: ' + Object.keys(FIELDS).map((k) => `--${k}`).join(' '));
  process.exit(1);
}

const { privateKey } = JSON.parse(fs.readFileSync(`${process.env.HOME}/.tabbycats/signer.json`, 'utf8'));
const signer = new fc.NobleEd25519Signer(hexToBytes(privateKey));

for (const [field, value] of Object.entries(values)) {
  const msg = (
    await fc.makeUserDataAdd({ type: FIELDS[field], value }, { fid: FID, network: fc.FarcasterNetwork.MAINNET }, signer)
  )._unsafeUnwrap();
  const body = fc.Message.encode(msg).finish();
  for (const node of NODES) {
    const res = await fetch(`${node}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    const text = await res.text();
    console.log(`${field} → ${new URL(node).hostname}: ${res.ok ? 'ok' : `${res.status} ${text.slice(0, 120)}`}`);
  }
}
