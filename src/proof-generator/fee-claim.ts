import {
    CircuitType,
    generateProof,
    WebArtifactProvider,
    type ArtifactProvider,
} from '@orbinum/proof-generator';
import { bigintTo32Le } from '../utils/bytes';

export { WebArtifactProvider };
export type { ArtifactProvider };

/**
 * Inputs required to generate a fee-claim proof.
 *
 * The proof demonstrates that the caller knows the preimage of `commitment`,
 * specifically that `commitment = Poseidon4(amount, assetId, ownerPubkey, blinding)`.
 * Both `amount` and `assetId` are revealed as public signals so the pallet can
 * verify consistency with the extrinsic arguments.
 */
export interface FeeClaimProofInputs {
    /** Fee amount to claim in planck (must fit in u64). */
    amount: bigint;
    /** Asset ID of the fee note. */
    assetId: bigint;
    /** Owner public key (BabyJubJub Ax component). */
    ownerPubkey: bigint;
    /** Note blinding factor. */
    blinding: bigint;
    /** Note commitment as bigint (Poseidon4(amount, assetId, ownerPubkey, blinding)). */
    commitment: bigint;
}

/**
 * Proof output ready to submit with `claim_shielded_fees`.
 */
export interface FeeClaimProofOutput {
    /** 128-byte compressed Groth16 proof as 0x-prefixed hex. */
    proof: string;
    /**
     * Compact 76-byte public signals as `number[]` (SCALE-compatible).
     *
     * Layout: commitment[0..32] | value[32..40] | asset_id[40..44] | owner_hash[44..76]
     *
     * Pass directly as the `public_signals` argument of `claim_shielded_fees`.
     */
    publicSignals: number[];
}

/**
 * Generate a Groth16 fee-claim proof using the value_proof circuit.
 *
 * The resulting proof convinces the pallet that:
 *   1. The caller knows (amount, assetId, ownerPubkey, blinding) such that
 *      `commitment = Poseidon4(amount, assetId, ownerPubkey, blinding)`.
 *   2. The revealed `amount` and `assetId` match what will be submitted
 *      on-chain, preventing inflation attacks.
 *
 * @param inputs - Note preimage and commitment.
 * @param options.provider - Override the artifact provider (default: CDN).
 * @param options.verbose  - Log proof generation steps to console.
 */
export async function generateFeeClaimProof(
    inputs: FeeClaimProofInputs,
    options: { provider?: ArtifactProvider; verbose?: boolean } = {}
): Promise<FeeClaimProofOutput> {
    if (inputs.amount <= 0n) {
        throw new Error('Fee claim amount must be greater than zero.');
    }

    const circuitInputs = {
        commitment: inputs.commitment.toString(),
        value: inputs.amount.toString(),
        asset_id: inputs.assetId.toString(),
        owner_pubkey: inputs.ownerPubkey.toString(),
        blinding: inputs.blinding.toString(),
    };

    const provider = options.provider ?? new WebArtifactProvider();
    const opts: { provider: ArtifactProvider; verbose?: boolean } = { provider };
    if (options.verbose !== undefined) opts.verbose = options.verbose;

    const proofResult = await generateProof(CircuitType.ValueProof, circuitInputs, opts);

    // Public signals order: [commitment, value, asset_id, owner_hash]
    const [sigCommitment, sigValue, sigAssetId, sigOwnerHash] =
        proofResult.publicSignals.map(BigInt);

    // Build the 76-byte public signals buffer
    // Layout: commitment[0..32] | value[32..40] | asset_id[40..44] | owner_hash[44..76]
    const buf = new Uint8Array(76);
    buf.set(bigintTo32Le(sigCommitment!), 0); // [0..32]  commitment
    buf.set(bigintTo32Le(sigValue!).subarray(0, 8), 32); // [32..40] value (u64 LE)
    buf.set(bigintTo32Le(sigAssetId!).subarray(0, 4), 40); // [40..44] asset_id (u32 LE)
    buf.set(bigintTo32Le(sigOwnerHash!), 44); // [44..76] owner_hash

    return {
        proof: proofResult.proof,
        publicSignals: Array.from(buf),
    };
}
