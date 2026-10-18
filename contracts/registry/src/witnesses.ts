// Witness implementations for the registry contract. Witnesses run on the
// caller's machine and supply private data to the circuits; nothing here is
// sent to the network except through the proofs the circuits produce.
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, Witnesses } from './managed/registry/contract/index.js';

/** Private state kept by the admin or an attester. */
export type RegistryPrivateState = {
  /** The secret key whose domain-separated hash identifies the caller on-chain. */
  readonly secretKey: Uint8Array;
  /** Commitment opening per contract hash (hex), kept so a report can be revealed later. */
  readonly openings: Readonly<Record<string, Uint8Array>>;
};

export function createRegistryPrivateState(secretKey: Uint8Array): RegistryPrivateState {
  return { secretKey, openings: {} };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns a private state that also holds `opening` for `contractHash`. */
export function withOpening(state: RegistryPrivateState, contractHash: Uint8Array, opening: Uint8Array): RegistryPrivateState {
  return { ...state, openings: { ...state.openings, [toHex(contractHash)]: opening } };
}

export const witnesses: Witnesses<RegistryPrivateState> = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, RegistryPrivateState>) => [privateState, privateState.secretKey],
  reportOpening: ({ privateState }: WitnessContext<Ledger, RegistryPrivateState>, contractHash: Uint8Array) => {
    const opening = privateState.openings[toHex(contractHash)];
    if (!opening) throw new Error('No stored report opening for this contract hash.');
    return [privateState, opening];
  },
};
