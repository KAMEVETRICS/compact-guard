// Reads the deployed registry's public state from the Preprod indexer.
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
process.loadEnvFile('.env.preprod');
setNetworkId('preprod');
const id = encodeURIComponent(process.env.BLOCKFROST_PROJECT_ID.trim());
const { contractAddress } = JSON.parse(readFileSync('../deployments/preprod.json', 'utf8'));
const provider = indexerPublicDataProvider(
  `https://midnight-preprod.blockfrost.io/api/v0?project_id=${id}`,
  `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${id}`,
);
const state = await provider.queryContractState(contractAddress);
if (!state) { console.log('No contract state found at', contractAddress); process.exit(1); }
const { ledger } = await import(pathToFileURL('managed/registry/contract/index.js').href);
const s = ledger(state.data);
console.log('contract:', contractAddress);
console.log('admin key set:', s.admin.length === 32 ? 'yes (32-byte hash)' : 'no');
console.log('attesters:', s.attesters.size().toString());
console.log('attestations:', s.attestations.size().toString());
console.log('totalAttestations:', s.totalAttestations.toString());
process.exit(0);
