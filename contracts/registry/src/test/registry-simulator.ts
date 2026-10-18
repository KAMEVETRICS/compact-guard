// Runs the registry off-chain through the compiler's JavaScript output, with no
// node, indexer or proof server, following
// https://docs.midnight.network/guides/compact-javascript-runtime
import { randomBytes } from 'node:crypto';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, type Ledger } from '../managed/registry/contract/index.js';
import { createRegistryPrivateState, withOpening, witnesses, type RegistryPrivateState } from '../witnesses.ts';

const COIN = '0'.repeat(64);

export type Counts = { errors?: bigint; warnings?: bigint; reviews?: bigint };

export class RegistrySimulator {
  readonly contract = new Contract(witnesses);
  private context: RT.CircuitContext<RegistryPrivateState>;

  /** Deploys a fresh registry whose admin is the holder of `adminSecret`. */
  constructor(adminSecret: Uint8Array) {
    const initial = createRegistryPrivateState(adminSecret);
    const ctor = this.contract.initialState(RT.createConstructorContext(initial, COIN));
    this.context = RT.createCircuitContext(RT.sampleContractAddress(), COIN, ctor.currentContractState, initial);
  }

  static attesterPublicKey(secretKey: Uint8Array): Uint8Array {
    return pureCircuits.attesterPublicKey(secretKey);
  }

  /** Acts as the holder of `secretKey` for the following calls, keeping stored openings. */
  as(secretKey: Uint8Array): this {
    this.context = { ...this.context, currentPrivateState: { ...this.context.currentPrivateState, secretKey } };
    return this;
  }

  get ledger(): Ledger {
    return ledger(this.context.currentQueryContext.state);
  }

  get privateState(): RegistryPrivateState {
    return this.context.currentPrivateState;
  }

  // Each call replaces the context only on success, so a rejected call leaves state unchanged.
  addAttester(attesterPk: Uint8Array): void {
    this.context = this.contract.impureCircuits.addAttester(this.context, attesterPk).context;
  }

  removeAttester(attesterPk: Uint8Array): void {
    this.context = this.contract.impureCircuits.removeAttester(this.context, attesterPk).context;
  }

  /** Attests with a fresh opening, the way a real attester would, and keeps it in private state. */
  attest(contractHash: Uint8Array, reportHash: Uint8Array, counts: Counts = {}, toolVersion: Uint8Array = new Uint8Array(32)): void {
    const opening = new Uint8Array(randomBytes(32));
    const context = { ...this.context, currentPrivateState: withOpening(this.context.currentPrivateState, contractHash, opening) };
    const { errors = 0n, warnings = 0n, reviews = 0n } = counts;
    this.context = this.contract.impureCircuits.attest(context, contractHash, reportHash, errors, warnings, reviews, toolVersion).context;
  }

  revealReport(contractHash: Uint8Array, reportHash: Uint8Array): void {
    this.context = this.contract.impureCircuits.revealReport(this.context, contractHash, reportHash).context;
  }

  isClean(contractHash: Uint8Array): boolean {
    const call = this.contract.impureCircuits.isClean(this.context, contractHash);
    this.context = call.context;
    return call.result;
  }
}
