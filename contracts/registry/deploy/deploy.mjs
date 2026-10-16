// Deploys the registry contract to Midnight Preprod, following
// https://docs.midnight.network/guides/deploy-and-operate and
// https://docs.midnight.network/guides/acquire-tokens
//
// Needs: a Blockfrost "Midnight Preprod" project ID in .env.preprod, a proof
// server on localhost:6300, and the contract compiled with proving keys
// (npm run compile:keys -w contracts/registry).
//
// Secrets (wallet seed, registry admin secret, private-state password) are
// generated on first run and written to .env.preprod, which is gitignored.
// They are never printed. Back that file up: it is the only way to control
// the wallet and the deployed registry.
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

// Midnight's RPC client logs its full endpoint URL, which carries the Blockfrost
// project ID. Mask it in everything this process prints.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map((a) => (typeof a === 'string' ? a.replace(/project_id=[^&"\s]+/g, 'project_id=REDACTED') : a)));
}

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Rx from 'rxjs';
import {
  HDWallet, Roles, generateRandomSeed, WalletFacade, ShieldedWallet, DustWallet, UnshieldedWallet,
  createKeystore, PublicKey, NoOpTransactionHistoryStorage, DustAddress, MidnightBech32m,
} from '@midnightntwrk/wallet-sdk';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { toHex, ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, '.env.preprod');
const COMPILED_SRC = join(HERE, '..', 'src', 'managed', 'registry');
// A copy inside this folder, so the compiled module resolves the same
// compact-runtime instance as Midnight.js (two copies break instanceof checks).
const COMPILED = join(HERE, 'managed', 'registry');
const DEPLOYMENT_FILE = join(HERE, '..', 'deployments', 'preprod.json');
// Serialized wallet sync state, so an interrupted sync resumes instead of
// restarting from the beginning of the chain. Private: holds wallet data.
const STATE_FILE = join(HERE, 'wallet-state.json');
const PROOF_SERVER = 'http://localhost:6300';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const fail = (msg) => { console.error(`\nError: ${msg}`); process.exit(1); };

// ---- configuration and secrets ----------------------------------------------
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (!projectId) fail(`BLOCKFROST_PROJECT_ID is not set. Add your Blockfrost "Midnight Preprod" project ID to ${ENV_FILE}:\n  BLOCKFROST_PROJECT_ID=nightpreprod...`);
if (!projectId.startsWith('nightpreprod')) fail('BLOCKFROST_PROJECT_ID must be a Midnight Preprod project ID (it starts with "nightpreprod").');

function ensureSecret(name, make) {
  if (!process.env[name]) {
    process.env[name] = make();
    // A hand-edited file may lack a final newline; never glue a new key onto its last line.
    const needsNewline = existsSync(ENV_FILE) && !/\n$/.test(readFileSync(ENV_FILE, 'utf8'));
    appendFileSync(ENV_FILE, `${needsNewline ? '\n' : ''}${name}=${process.env[name]}\n`, { mode: 0o600 });
    log(`Generated ${name} and saved it to .env.preprod (not printed).`);
  }
  return process.env[name];
}
const walletSeed = ensureSecret('WALLET_SEED', () => toHex(Buffer.from(generateRandomSeed())));
const adminSecret = Buffer.from(ensureSecret('REGISTRY_ADMIN_SECRET', () => randomBytes(32).toString('hex')), 'hex');
// The private-state store needs 16+ characters from at least three character classes.
const storePassword = ensureSecret('PRIVATE_STATE_PASSWORD', () => `Cg-${randomBytes(24).toString('base64url')}-7a`);

setNetworkId('preprod');
const withKey = (url) => `${url}?project_id=${encodeURIComponent(projectId)}`;
const CONFIG = {
  indexerHttpUrl: withKey('https://midnight-preprod.blockfrost.io/api/v0'),
  indexerWsUrl: withKey('wss://midnight-preprod.blockfrost.io/api/v0/ws'),
  node: withKey('https://rpc.midnight-preprod.blockfrost.io'),
};

// ---- preflight ----------------------------------------------------------------
if (!existsSync(join(COMPILED_SRC, 'keys', 'attest.prover'))) {
  fail('Compiled contract with proving keys not found. Run: npm run compile:keys -w contracts/registry');
}
mkdirSync(dirname(COMPILED), { recursive: true });
cpSync(COMPILED_SRC, COMPILED, { recursive: true });

try {
  const res = await fetch(`${PROOF_SERVER}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (error) {
  fail(`No proof server at ${PROOF_SERVER} (${error.message}). Start it with:\n  docker run -p 6300:6300 midnightntwrk/proof-server:8.1.3 midnight-proof-server -v`);
}

// ---- wallet -------------------------------------------------------------------
const hd = HDWallet.fromSeed(Buffer.from(walletSeed, 'hex'));
if (hd.type !== 'seedOk') fail('WALLET_SEED in .env.preprod is not a valid seed.');
const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
if (derived.type !== 'keysDerived') fail('Key derivation failed.');
hd.hdWallet.clear();
const keys = derived.keys;

const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
const indexerClientConnection = { indexerHttpUrl: CONFIG.indexerHttpUrl, indexerWsUrl: CONFIG.indexerWsUrl };
const shieldedConfig = {
  networkId: getNetworkId(),
  indexerClientConnection,
  provingServerUrl: new URL(PROOF_SERVER),
  relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
};
const address = String(unshieldedKeystore.getBech32Address());
let saved;
if (existsSync(STATE_FILE)) {
  saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (saved.address !== address) {
    log('Ignoring wallet-state.json: it belongs to a different wallet.');
    saved = undefined;
  } else {
    log(`Resuming wallet sync from state saved at ${saved.savedAt}.`);
  }
}
const wallet = await WalletFacade.init({
  configuration: {
    ...shieldedConfig,
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  },
  shielded: (cfg) => saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
  unshielded: (cfg) => saved ? UnshieldedWallet(cfg).restore(saved.unshielded) : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
  dust: (cfg) => saved ? DustWallet(cfg).restore(saved.dust) : DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
});
await wallet.start(shieldedSecretKeys, dustSecretKey);

let latest;
wallet.state().subscribe((s) => { latest = s; });

async function saveState() {
  try {
    const state = {
      address,
      savedAt: new Date().toISOString(),
      shielded: await wallet.shielded.serializeState(),
      unshielded: await wallet.unshielded.serializeState(),
      dust: await wallet.dust.serializeState(),
    };
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (error) {
    log(`Could not save wallet state: ${error.message}`);
  }
}

function progressLine() {
  if (!latest) return 'no wallet state yet';
  return ['shielded', 'unshielded', 'dust'].map((part) => {
    const p = latest[part]?.progress;
    if (!p) return `${part} ?`;
    // Shielded and DUST track ledger indices; unshielded tracks transaction IDs.
    const applied = p.appliedIndex ?? p.appliedId ?? 0n;
    // Shielded and DUST learn the tip from each event's maxId (highestRelevantWalletIndex).
    const tips = [p.highestIndex, p.highestRelevantIndex, p.highestRelevantWalletIndex, p.highestTransactionId].filter((v) => typeof v === 'bigint');
    const tip = tips.length ? tips.reduce((a, b) => (b > a ? b : a)) : 0n;
    const pct = tip > 0n ? `${Number((applied * 1000n) / tip) / 10}%` : 'tip unknown';
    return `${part} ${applied}/${tip} (${pct})${p.isConnected === false ? ' disconnected' : ''}`;
  }).join(', ');
}

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 60000)} min`;

// The SDK's indexer subscriptions sometimes die after a network drop and never
// resume. If sync makes no progress for STALL_MS, save state and exit with
// STALL_EXIT so a wrapper loop can restart from the saved state.
const STALL_MS = 10 * 60_000;
const STALL_EXIT = 75;
const appliedSum = () => !latest ? 0n : ['shielded', 'unshielded', 'dust']
  .map((part) => latest[part]?.progress?.appliedIndex ?? latest[part]?.progress?.appliedId ?? 0n)
  .reduce((a, b) => a + b, 0n);
let lastApplied = -1n;
let lastMovedAt = Date.now();
let syncDone = false;

const heartbeat = setInterval(async () => {
  await saveState();
  log(`Still working (${elapsed()} elapsed). Sync: ${progressLine()}`);
}, 5 * 60_000);
const watchdog = setInterval(async () => {
  if (syncDone) return;
  const applied = appliedSum();
  if (applied !== lastApplied) { lastApplied = applied; lastMovedAt = Date.now(); return; }
  if (Date.now() - lastMovedAt >= STALL_MS) {
    await saveState();
    log(`Sync made no progress for ${STALL_MS / 60000} min; saved state, exiting to restart.`);
    process.exit(STALL_EXIT);
  }
}, 60_000);
// Transient indexer errors can surface as uncaught errors from inside the wallet
// SDK. Before the deploy transaction, they are safe to retry from saved state.
// During the deploy, stop instead: a blind retry could deploy a second contract.
let deploying = false;
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, async (error) => {
    log(`Unexpected error: ${error?.message ?? error}`);
    if (deploying) { log('Error during the deploy step; not restarting automatically.'); process.exit(1); }
    await saveState();
    process.exit(STALL_EXIT);
  });
}

setTimeout(() => log(`Sync: ${progressLine()}`), 60_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await saveState(); log('Saved wallet state; exiting.'); process.exit(130); });
}

const formatNight = (raw) => `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, '0')}`;
const nightOf = (s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n;

log(`Wallet address (unshielded): ${address}`);
const current = await Rx.firstValueFrom(wallet.state());
if (nightOf(current) === 0n) {
  log('No tNIGHT yet. Request tokens for the address above at https://midnight-tmnight-preprod.nethermind.dev/');
  log('Waiting for the faucet transfer to arrive...');
}
const night = await Rx.firstValueFrom(wallet.state().pipe(Rx.map(nightOf), Rx.filter((b) => b > 0n)));
log(`tNIGHT balance: ${formatNight(night)}`);

log('Waiting for the wallet to finish syncing...');
const synced = await wallet.waitForSyncedState();
syncDone = true;
clearInterval(watchdog);
await saveState();
log(`Wallet synced after ${elapsed()}.`);

// ---- DUST registration (pays transaction fees) -------------------------------
const unregistered = synced.unshielded.availableCoins.filter((c) => c.meta?.registeredForDustGeneration !== true);
if (unregistered.length) {
  log(`Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...`);
  const target = String(DustAddress.encodePublicKey(getNetworkId(), synced.dust.publicKey));
  const dustReceiver = MidnightBech32m.parse(target).decode(DustAddress, getNetworkId());
  const { fee } = await wallet.estimateRegistration(unregistered);
  await wallet.waitForGeneratedDust(unregistered, fee);
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    unregistered, unshieldedKeystore.getPublicKey(), (payload) => unshieldedKeystore.signData(payload), dustReceiver,
  );
  await wallet.submitTransaction(await wallet.finalizeRecipe(recipe));
} else {
  log('NIGHT is already registered for DUST generation.');
}
await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n)));
log('DUST available for fees.');

// ---- providers and deploy -----------------------------------------------------
const zkConfigProvider = new NodeZkConfigProvider(COMPILED);
const walletProvider = {
  getCoinPublicKey: () => shieldedSecretKeys.coinPublicKey,
  getEncryptionPublicKey: () => shieldedSecretKeys.encryptionPublicKey,
  balanceTx: async (tx, ttl = ttlOneHour()) => {
    const recipe = await wallet.balanceUnboundTransaction(tx, { shieldedSecretKeys, dustSecretKey }, { ttl });
    return wallet.finalizeRecipe(recipe);
  },
  submitTx: (tx) => wallet.submitTransaction(tx),
};
const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: 'cg-registry-private-state',
    signingKeyStoreName: 'cg-registry-signing-keys',
    privateStoragePasswordProvider: () => storePassword,
    accountId: address,
  }),
  publicDataProvider: indexerPublicDataProvider(CONFIG.indexerHttpUrl, CONFIG.indexerWsUrl),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
  walletProvider,
  midnightProvider: walletProvider,
};

// Same witnesses as the unit tests: the caller's secret key, and per-contract report openings.
const witnesses = {
  localSecretKey: ({ privateState }) => [privateState, privateState.secretKey],
  reportOpening: ({ privateState }, contractHash) => {
    const opening = privateState.openings?.[toHex(contractHash)];
    if (!opening) throw new Error('No stored report opening for this contract hash.');
    return [privateState, opening];
  },
};
const { Contract } = await import(pathToFileURL(join(COMPILED, 'contract', 'index.js')).href);
const compiledContract = CompiledContract.withCompiledFileAssets(
  CompiledContract.withWitnesses(CompiledContract.make('registry', Contract), witnesses),
  COMPILED,
);

log('Deploying the registry (proving the constructor, then submitting)...');
deploying = true;
const deployed = await deployContract(providers, {
  compiledContract,
  privateStateId: 'registryPrivateState',
  initialPrivateState: { secretKey: adminSecret, openings: {} },
});
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

clearInterval(heartbeat);
log(`Deployed. Contract address: ${pub.contractAddress}`);
log(`Recorded in contracts/registry/deployments/preprod.json`);
await wallet.stop();
process.exit(0);
