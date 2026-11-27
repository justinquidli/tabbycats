// Move @tabbycats to a new custody wallet that has a 24-word recovery phrase, so the account
// can be opened in the Farcaster app. Idempotent: safe to re-run after a partial failure.
// Keys live in ~/.tabbycats (never in the repo). Already done for @tabbycats on 2026-11-27;
// the plain-text phrase was deleted afterwards, so re-running this would create a new wallet.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, bytesToHex } from 'viem';
import { optimism } from 'viem/chains';
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import * as fc from '@farcaster/core';

const DIR = `${process.env.HOME}/.tabbycats`;
const FID = 3359500n;
const USERNAME = 'tabbycats';
const RPC = 'https://mainnet.optimism.io';
const pub = createPublicClient({ chain: optimism, transport: http(RPC) });
const idOf = (address) => pub.readContract({ address: fc.ID_REGISTRY_ADDRESS, abi: fc.idRegistryABI, functionName: 'idOf', args: [address] });

// 1. New phrase wallet (created once)
const phraseFile = `${DIR}/recovery-phrase.txt`;
if (!fs.existsSync(phraseFile)) fs.writeFileSync(phraseFile, generateMnemonic(english, 256) + '\n', { mode: 0o600 });
const next = mnemonicToAccount(fs.readFileSync(phraseFile, 'utf8').trim()); // standard path m/44'/60'/0'/0/0, same as the Farcaster app
console.log('new custody', next.address);

// 2. Transfer the account (signed by both wallets, sent by the current one)
const current = JSON.parse(fs.readFileSync(`${DIR}/custody.json`, 'utf8'));
if ((await idOf(next.address)) !== FID) {
  const from = privateKeyToAccount(current.privateKey);
  if ((await idOf(from.address)) !== FID) throw new Error('Current custody wallet does not own the account');
  const nonce = await pub.readContract({ address: fc.ID_REGISTRY_ADDRESS, abi: fc.idRegistryABI, functionName: 'nonces', args: [next.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sig = (await new fc.ViemLocalEip712Signer(next).signTransfer({ fid: FID, to: next.address, nonce, deadline }))._unsafeUnwrap();
  const wallet = createWalletClient({ account: from, chain: optimism, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: fc.ID_REGISTRY_ADDRESS, abi: fc.idRegistryABI, functionName: 'transfer',
    args: [next.address, deadline, bytesToHex(sig)],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log('transfer', receipt.status, hash);
  for (let i = 0; i < 10 && (await idOf(next.address)) !== FID; i++) await new Promise((r) => setTimeout(r, 3000));
}
if ((await idOf(next.address)) !== FID) throw new Error('Transfer not visible yet; re-run in a minute');
console.log('account', FID, 'now owned by the phrase wallet');

// Keep the old key as a backup and make the new one the active custody key.
if (current.address.toLowerCase() !== next.address.toLowerCase()) {
  fs.writeFileSync(`${DIR}/custody-old.json`, JSON.stringify(current, null, 2), { mode: 0o600 });
  const pk = bytesToHex(next.getHdKey().privateKey);
  fs.writeFileSync(`${DIR}/custody.json`, JSON.stringify({ address: next.address, privateKey: pk, fromPhrase: true, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log('custody.json updated (old key kept in custody-old.json)');
}

// 3. Point the username at the new wallet
const cur = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${USERNAME}`).then((r) => r.json());
const owner = cur.transfer?.owner?.toLowerCase();
console.log('username owner', owner);
if (owner !== next.address.toLowerCase()) {
  const timestamp = Math.floor(Date.now() / 1000);
  const claim = fc.makeUserNameProofClaim({ name: USERNAME, owner: next.address, timestamp });
  const signature = bytesToHex((await new fc.ViemLocalEip712Signer(next).signUserNameProofClaim(claim))._unsafeUnwrap());
  const res = await fetch('https://fnames.farcaster.xyz/transfers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: USERNAME, from: Number(FID), to: Number(FID), fid: Number(FID), owner: next.address, timestamp, signature }),
  });
  console.log('username owner change', res.status, (await res.text()).slice(0, 300));
}
