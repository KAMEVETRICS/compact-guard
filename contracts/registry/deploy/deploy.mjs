// Deploys the registry contract to Midnight Preprod. Needs a Blockfrost
// "Midnight Preprod" project ID in .env.preprod, a proof server on
// localhost:6300, and the contract compiled with proving keys
// (npm run compile:keys -w contracts/registry). See session.mjs for the wallet,
// restart and secret-handling behaviour.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { createRegistryPrivateState } from '../src/witnesses.ts';
import { DEPLOYMENT_FILE, PRIVATE_STATE_ID, log, openSession } from './session.mjs';

const session = await openSession();

log('Deploying the registry (proving the constructor, then submitting)...');
// A blind retry here could deploy a second contract, so errors are not retried.
const deployed = await session.critically(() => deployContract(session.providers, {
  compiledContract: session.compiledContract,
  privateStateId: PRIVATE_STATE_ID,
  initialPrivateState: createRegistryPrivateState(session.adminSecret),
}));
const pub = deployed.deployTxData.public;
const record = {
  network: 'preprod',
  contractAddress: pub.contractAddress,
  txId: pub.txId,
  blockHeight: pub.blockHeight,
  deployedAt: new Date().toISOString(),
  compiler: '0.31.1',
  midnightJs: '4.1.1',
  // Search for contractAddress on either explorer.
  explorers: ['https://preprod.midnightexplorer.com/', 'https://midnight-preprod.subscan.io/'],
};
mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);

log(`Deployed. Contract address: ${pub.contractAddress}`);
log('Recorded in contracts/registry/deployments/preprod.json');
await session.close(0);
