// One-time setup of the @tabbycats Farcaster account, straight from the Optimism contracts.
// Idempotent: safe to re-run. Keys live in ~/.tabbycats (never in the repo).
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, bytesToHex, hexToBytes } from 'viem';
import { optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import * as fc from '@farcaster/core';

const DIR = `${process.env.HOME}/.tabbycats`;
const RECOVERY = process.env.RECOVERY;
const USERNAME = 'tabbycats';
const NODES = ['https://snap.farcaster.xyz:3381', 'https://haatz.quilibrium.com'];

const custody = JSON.parse(fs.readFileSync(`${DIR}/custody.json`, 'utf8'));
const account = privateKeyToAccount(custody.privateKey);
const pub = createPublicClient({ chain: optimism, transport: http('https://mainnet.optimism.io') });
const wallet = createWalletClient({ account, chain: optimism, transport: http('https://mainnet.optimism.io') });
const eip712 = new fc.ViemLocalEip712Signer(account);

// 1. Register the FID
let fid = await pub.readContract({ address: fc.ID_REGISTRY_ADDRESS, abi: fc.idRegistryABI, functionName: 'idOf', args: [account.address] });
if (fid === 0n) {
  if (!RECOVERY) throw new Error('Set RECOVERY');
  const price = await pub.readContract({ address: fc.ID_GATEWAY_ADDRESS, abi: fc.idGatewayABI, functionName: 'price' });
  const hash = await wallet.writeContract({
    address: fc.ID_GATEWAY_ADDRESS, abi: fc.idGatewayABI, functionName: 'register',
    args: [RECOVERY], value: (price * 105n) / 100n, // overpayment is refunded
  });
  await pub.waitForTransactionReceipt({ hash });
  fid = await pub.readContract({ address: fc.ID_REGISTRY_ADDRESS, abi: fc.idRegistryABI, functionName: 'idOf', args: [account.address] });
  console.log('registered fid', fid, 'tx', hash);
} else console.log('fid', fid);

// 2. Add an ed25519 posting key for the account itself
const signerFile = `${DIR}/signer.json`;
if (!fs.existsSync(signerFile)) {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  fs.writeFileSync(signerFile, JSON.stringify({ privateKey: bytesToHex(priv) }, null, 2), { mode: 0o600 });
}
const signer = new fc.NobleEd25519Signer(hexToBytes(JSON.parse(fs.readFileSync(signerFile, 'utf8')).privateKey));
const key = (await signer.getSignerKey())._unsafeUnwrap();
const keyData = await pub.readContract({ address: fc.KEY_REGISTRY_ADDRESS, abi: fc.keyRegistryABI, functionName: 'keyDataOf', args: [fid, bytesToHex(key)] });
if (keyData.state === 0) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const metadata = (await eip712.getSignedKeyRequestMetadata({ requestFid: fid, key, deadline }))._unsafeUnwrap();
  const hash = await wallet.writeContract({
    address: fc.KEY_GATEWAY_ADDRESS, abi: fc.keyGatewayABI, functionName: 'add',
    args: [1, bytesToHex(key), 1, bytesToHex(metadata)],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log('added posting key', bytesToHex(key), 'tx', hash);
} else console.log('posting key already added');

// 3. Claim the fname
const cur = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${USERNAME}`).then((r) => r.json());
if (!cur.transfer) {
  const timestamp = Math.floor(Date.now() / 1000);
  const claim = fc.makeUserNameProofClaim({ name: USERNAME, owner: account.address, timestamp });
  const sig = (await eip712.signUserNameProofClaim(claim))._unsafeUnwrap();
  const res = await fetch('https://fnames.farcaster.xyz/transfers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: USERNAME, from: 0, to: Number(fid), fid: Number(fid), owner: account.address, timestamp, signature: bytesToHex(sig) }),
  });
  console.log('fname claim', res.status, await res.text());
} else console.log('fname owner fid', cur.transfer.to);

// 4. Profile
const profile = [
  [fc.UserDataType.USERNAME, USERNAME],
  [fc.UserDataType.DISPLAY, 'TabbyCats'],
  [fc.UserDataType.BIO, '🐈 Your feeds, side by side. A simple column reader for Farcaster and Hypersnap. tabbycats.party'],
  [fc.UserDataType.URL, 'https://tabbycats.party'],
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const node of NODES) {
  for (const [type, value] of profile) {
    const msg = (await fc.makeUserDataAdd({ type, value }, { fid: Number(fid), network: fc.FarcasterNetwork.MAINNET }, signer))._unsafeUnwrap();
    let out = '';
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${node}/v1/submitMessage`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: fc.Message.encode(msg).finish(),
      });
      out = `${res.status} ${(await res.text()).slice(0, 160)}`;
      if (res.ok) break;
      await wait(10000); // node may not have seen the onchain events yet
    }
    console.log(node, fc.UserDataType[type], out);
  }
}
