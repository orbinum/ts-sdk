/**
 * Witness assembly for the 2-in/2-out private-transfer circuit.
 *
 * Pure marshalling: bigints and hex in, decimal strings the prover accepts out.
 * Nothing here VALIDATES the witness — the circuit is what enforces every
 * constraint, and a caller that assembles an inconsistent one gets a proof
 * failure rather than a wrong proof.
 *
 * Always two inputs and two outputs. A single-note spend pads slot B with a
 * dummy (see `buildDummyTransferInput`), because the circuit's shape is fixed.
 */
import {
    CircuitType,
    generateProof,
    WebArtifactProvider,
    type ArtifactProvider,
    type ProofResult,
} from '@orbinum/proof-generator';
import { leHexToBigint } from '../../foundation/encoding/bytes';
import { merkleProofToCircuit } from './merkle';
import { toGenerateOptions, type ProofOptions } from './options';

export { WebArtifactProvider };
export type { ArtifactProvider, ProofResult };

/** A single input note for a private transfer. */
export interface TransferInputNote {
    nullifier: bigint;
    /** Note value (planck). */
    value: bigint;
    assetId: bigint;
    ownerPk: bigint;
    blinding: bigint;
    spendingKey: bigint;
    /** Sibling hashes (0x-prefixed, 32-byte LE). */
    pathSiblings: string[];
    leafIndex: number;
}

/** A single output note for a private transfer. */
export interface TransferOutputNote {
    /** Commitment as bigint. */
    commitment: bigint;
    value: bigint;
    assetId: bigint;
    ownerPk: bigint;
    blinding: bigint;
}

/**
 * Inputs required to generate a PrivateTransfer proof.
 * Supports exactly 2 inputs and 2 recipient outputs (circuit constraint).
 * The fee is paid to the block author (validator) by the pallet runtime.
 */
export interface PrivateTransferProofInputs {
    merkleRoot: string;
    inputs: [TransferInputNote, TransferInputNote];
    outputs: [TransferOutputNote, TransferOutputNote];
    /**
     * Gasless fee in planck (default 0n).
     *
     * The circuit constrains `input_sum == output_sum + fee`. Nothing here
     * checks it — the caller balances the amounts (`transferNotes` does, before
     * proving) and an unbalanced witness fails at proof time.
     */
    fee?: bigint;
}

/**
 * Generate a Groth16 proof for a PrivateTransfer operation.
 *
 * The merkle root arrives LITTLE-ENDIAN hex and is converted here; passing it
 * big-endian yields a root the circuit cannot match against the paths.
 */
export async function generateTransferProof(
    params: PrivateTransferProofInputs,
    options: ProofOptions = {}
): Promise<ProofResult> {
    const root = leHexToBigint(params.merkleRoot).toString();
    const [i0, i1] = params.inputs;
    const [o0, o1] = params.outputs;
    const fee = params.fee ?? 0n;

    const path0 = merkleProofToCircuit(i0.pathSiblings, i0.leafIndex);
    const path1 = merkleProofToCircuit(i1.pathSiblings, i1.leafIndex);

    const circuitInputs = {
        merkle_root: root,
        nullifiers: [i0.nullifier.toString(), i1.nullifier.toString()],
        commitments: [o0.commitment.toString(), o1.commitment.toString()],
        asset_id: i0.assetId.toString(),
        fee: fee.toString(),
        input_values: [i0.value.toString(), i1.value.toString()],
        input_asset_ids: [i0.assetId.toString(), i1.assetId.toString()],
        input_blindings: [i0.blinding.toString(), i1.blinding.toString()],
        spending_keys: [i0.spendingKey.toString(), i1.spendingKey.toString()],
        input_path_elements: [path0.elements, path1.elements],
        input_path_indices: [path0.indices, path1.indices],
        output_values: [o0.value.toString(), o1.value.toString()],
        output_asset_ids: [o0.assetId.toString(), o1.assetId.toString()],
        output_owner_pubkeys: [o0.ownerPk.toString(), o1.ownerPk.toString()],
        output_blindings: [o0.blinding.toString(), o1.blinding.toString()],
    };

    const provider = options.provider ?? new WebArtifactProvider();
    const opts = toGenerateOptions(provider, options);
    return generateProof(CircuitType.Transfer, circuitInputs, opts);
}
