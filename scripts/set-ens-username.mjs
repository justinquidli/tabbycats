// Prove an ENS name to a network and make it the account's username.
//
//   node scripts/set-ens-username.mjs hypersnap tabbycats.eth
//   node scripts/set-ens-username.mjs farcaster tabbycats.eth
//
// The ENS name must resolve to the account's custody wallet (the recovery-phrase wallet).
import fs from 'node:fs';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as fc from '@farcaster/core';

const [network, name] = process.argv.slice(2);
const SETUP = {
  farcaster: { node: 'https://snap.farcaster.xyz:3381', fid: 3359500, keyFile: 'signer.json' },
  hypersnap: { node: 'https://haatz.quilibrium.com', fid: 4294967372, keyFile: 'hypersnap-signer.json' },
}[network];
if (!SETUP || !name?.endsWith('.eth')) {
  console.log('Usage: node scripts/set-ens-username.mjs <farcaster|hypersnap> <name.eth>');
  process.exit(1);
}

const DIR = `${process.env.HOME}/.tabbycats`;
const custody = privateKeyToAccount(JSON.parse(fs.readFileSync(`${DIR}/custody.json`, 'utf8')).privateKey); // the phrase wallet's key
const signer = new fc.NobleEd25519Signer(hexToBytes(JSON.parse(fs.readFileSync(`${DIR}/${SETUP.keyFile}`, 'utf8')).privateKey));
const options = { fid: SETUP.fid, network: fc.FarcasterNetwork.MAINNET };

async function submit(msg) {
  msg.dataBytes = fc.MessageData.encode(msg.data).finish(); // send exactly the bytes that were hashed
  const res = await fetch(`${SETUP.node}/v1/submitMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: fc.Message.encode(msg).finish(),
  });
  const text = await res.text();
  return res.ok ? 'ok' : `${res.status} ${text.slice(0, 260)}`;
}

// 1. Username proof: the custody wallet signs (name, timestamp, owner)
const timestamp = Math.floor(Date.now() / 1000);
const claim = fc.makeUserNameProofClaim({ name, owner: custody.address, timestamp });
const signature = (await new fc.ViemLocalEip712Signer(custody).signUserNameProofClaim(claim))._unsafeUnwrap();
const proof = (
  await fc.makeUsernameProof(
    {
      timestamp,
      name: new TextEncoder().encode(name),
      owner: hexToBytes(custody.address),
      signature,
      fid: SETUP.fid,
      type: fc.UserNameType.USERNAME_TYPE_ENS_L1,
    },
    { ...options, timestamp: timestamp - 1609459200 }, // must match the proof's own timestamp
    signer,
  )
)._unsafeUnwrap();
console.log('proof', name, '→', network, ':', await submit(proof));

// 2. Use it as the username
const userData = (await fc.makeUserDataAdd({ type: fc.UserDataType.USERNAME, value: name }, options, signer))._unsafeUnwrap();
console.log('username', ':', await submit(userData));
console.log('signature', bytesToHex(signature).slice(0, 18) + '…');
