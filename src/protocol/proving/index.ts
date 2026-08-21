/**
 * Proof generation for the three spending circuits.
 *
 * Each module turns a caller's bigints into the decimal-string witness the
 * prover wants, then hands it to `@orbinum/proof-generator`. The artifacts
 * (wasm + zkey) come from an injected `ArtifactProvider`, so a browser fetches
 * them and a Node host reads them off disk.
 *
 * None of these validate the witness. The circuit owns every constraint, and an
 * inconsistent witness fails at proof time rather than producing a bad proof.
 */
export { CircuitType, WebArtifactProvider, generateUnshieldProof } from './unshield';
export type {
    ArtifactProvider,
    ProofResult,
    UnshieldProofInputs,
    UnshieldProofResult,
} from './unshield';

export { generateTransferProof } from './transfer';
export type { TransferInputNote, TransferOutputNote, PrivateTransferProofInputs } from './transfer';

export { generateFeeClaimProof } from './fee-claim';
export type { FeeClaimProofInputs, FeeClaimProofOutput } from './fee-claim';
export type { ProofOptions } from './options';
export { shouldProveSingleThreaded } from '@orbinum/proof-generator';
