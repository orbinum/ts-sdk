import {
    CircuitType,
    generateProof,
    WebArtifactProvider,
    type ArtifactProvider,
    type ProofResult,
} from '@orbinum/proof-generator';
import { randomBytes } from '@noble/ciphers/utils.js';
import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import { poseidon4 } from 'poseidon-lite';
import { leHexToBigint, bytesToBigintLE } from '../utils/bytes';
import { merkleProofToCircuit } from './merkle';

export { CircuitType, WebArtifactProvider };
export type { ArtifactProvider, ProofResult };

/**
 * Inputs required to generate an Unshield proof.
 *
 * All BigInt values must be BN254 scalar field elements.
 * All hex strings must be 0x-prefixed 32-byte little-endian values (as
 * returned by the node RPC).
 */
export interface UnshieldProofInputs {
    /** Merkle root (0x-prefixed, 32-byte LE). */
    merkleRoot: string;
    /** Nullifier as bigint. */
    nullifier: bigint;
    /** Net withdrawal amount (recipient receives this, planck). */
    amount: bigint;
    /** Asset ID. */
    assetId: bigint;
    /**
     * Recipient encoded as a BN254 field element.
     * For Substrate addresses: Poseidon(le32(accountId32)).
     */
    recipient: bigint;
    /** Note blinding factor. */
    blinding: bigint;
    /** Spending key used to derive the nullifier. */
    spendingKey: bigint;
    /** Sibling hashes (0x-prefixed, 32-byte LE), one per tree level. */
    pathSiblings: string[];
    /** Leaf index of the commitment in the Merkle tree. */
    leafIndex: number;
    /** Gasless fee in planck (default 0n). note_value == amount + fee + changeValue in circuit. */
    fee?: bigint;
    /**
     * Value of the change note in planck (default 0n = total unshield).
     * Must satisfy: note_value == amount + fee + changeValue.
     */
    changeValue?: bigint;
    /**
     * Blinding scalar for the change note commitment.
     * Auto-generated with CSPRNG when changeValue > 0n and not provided.
     */
    changeBlinding?: bigint;
    /**
     * BabyJubJub Ax coordinate of the change note owner (default: derived from spendingKey,
     * i.e. the change stays with the same owner).
     */
    changeOwnerPubkey?: bigint;
}

/**
 * Result of `generateUnshieldProof`.
 *
 * Extends `ProofResult` with the change note commitment, value, blinding, and owner pubkey
 * so the caller can pass them directly to the `unshield` extrinsic and generate the
 * encrypted memo for change note recovery.
 */
export interface UnshieldProofResult extends ProofResult {
    /** Poseidon4(changeValue, assetId, changeOwnerPubkey, changeBlinding). 0n for total unshield. */
    changeCommitment: bigint;
    /** Change value used (mirrors inputs.changeValue ?? 0n). */
    changeValue: bigint;
    /** Blinding factor for the change note (0n for total unshield). */
    changeBlinding: bigint;
    /** Owner pubkey for the change note (derived from spendingKey if not provided). */
    changeOwnerPubkey: bigint;
}

/**
 * Generate a Groth16 proof for an Unshield operation.
 *
 * @param inputs - All private and public inputs for the unshield circuit.
 * @param options.provider - Override the artifact provider (default: CDN).
 * @param options.verbose - Log proof generation steps to console.
 */
export async function generateUnshieldProof(
    inputs: UnshieldProofInputs,
    options: { provider?: ArtifactProvider; verbose?: boolean } = {}
): Promise<UnshieldProofResult> {
    const { elements, indices } = merkleProofToCircuit(inputs.pathSiblings, inputs.leafIndex);

    const fee = inputs.fee ?? 0n;
    const changeValue = inputs.changeValue ?? 0n;
    const noteValue = inputs.amount + fee + changeValue;

    if (inputs.amount <= 0n) {
        throw new Error('Unshield amount must be greater than zero.');
    }
    if (changeValue < 0n) {
        throw new Error('changeValue must be >= 0.');
    }

    // Derive ownerPk from spendingKey for the change note default.
    const changeOwnerPubkey =
        inputs.changeOwnerPubkey ?? mulPointEscalar(Base8, inputs.spendingKey)[0];

    // Auto-generate a cryptographically random blinding when needed.
    const changeBlinding =
        inputs.changeBlinding ?? (changeValue > 0n ? bytesToBigintLE(randomBytes(32)) : 0n);

    // change_commitment = Poseidon4(changeValue, assetId, changeOwnerPubkey, changeBlinding)
    // Must be 0n when changeValue == 0 (circuit constraint: change_commitment * has_no_change.out === 0).
    const changeCommitment =
        changeValue > 0n
            ? poseidon4([changeValue, inputs.assetId, changeOwnerPubkey, changeBlinding])
            : 0n;

    const circuitInputs = {
        merkle_root: leHexToBigint(inputs.merkleRoot).toString(),
        nullifier: inputs.nullifier.toString(),
        amount: inputs.amount.toString(),
        recipient: inputs.recipient.toString(),
        asset_id: inputs.assetId.toString(),
        fee: fee.toString(),
        change_commitment: changeCommitment.toString(),
        note_value: noteValue.toString(),
        note_asset_id: inputs.assetId.toString(),
        note_blinding: inputs.blinding.toString(),
        spending_key: inputs.spendingKey.toString(),
        path_elements: elements,
        path_indices: indices,
        change_value: changeValue.toString(),
        change_blinding: changeBlinding.toString(),
        change_owner_pubkey: changeOwnerPubkey.toString(),
    };

    const provider = options.provider ?? new WebArtifactProvider();
    const opts: { provider: ArtifactProvider; verbose?: boolean } = { provider };
    if (options.verbose !== undefined) opts.verbose = options.verbose;
    const proofResult = await generateProof(CircuitType.Unshield, circuitInputs, opts);
    return { ...proofResult, changeCommitment, changeValue, changeBlinding, changeOwnerPubkey };
}
