import {
    generateDisclosureProof,
    type ArtifactProvider,
    type DisclosureProofOutput,
} from '@orbinum/proof-generator';

export type { ArtifactProvider, DisclosureProofOutput };

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
 * Parse a 0x-prefixed little-endian 32-byte hex signal to raw bytes.
 * The proof-generator emits signals in LE order; bytes can be used directly
 * as the pallet expects LE layout in its 76-byte public_signals buffer.
 */
function hexSignalToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    const padded = clean.padStart(64, '0');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Generate a Groth16 fee-claim proof using the disclosure circuit.
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
/**
 * @deprecated Tech debt — `fees.rs` uses the OLD 76-byte plaintext disclosure layout,
 * but the disclosure circuit now uses ECDH encryption (256-byte layout).
 * This function compiles but the resulting proof WILL BE REJECTED by the pallet.
 * See `frame/shielded-pool/src/operations/fees.rs` comment for resolution options A/B/C.
 */
export async function generateFeeClaimProof(
    inputs: FeeClaimProofInputs,
    options: { provider?: ArtifactProvider; verbose?: boolean } = {}
): Promise<FeeClaimProofOutput> {
    // Tech debt: fee-claim uses dummy BJJ pk (Baby Jubjub base point) and r=1.
    // The circuit now encrypts fields with ECDH — the pallet's claim_shielded
    // still expects the old 76-byte plaintext layout and will reject this proof.
    const result: DisclosureProofOutput = await generateDisclosureProof(
        inputs.amount,
        inputs.ownerPubkey,
        inputs.blinding,
        inputs.assetId,
        inputs.commitment,
        // Baby Jubjub base point G — placeholder, no real auditor for fee claiming
        5299619240641551281634865583518297030282874472190772894086521144482721001553n,
        16950150798460657717958625567821834550301663161624707787222815936182638968203n,
        1n, // r — placeholder ephemeral scalar (NOT cryptographically secure)
        { discloseValue: true, discloseAssetId: true, discloseOwner: false },
        options
    );

    // New signal order: [0]=epk_x [1]=epk_y [2]=enc_value [3]=enc_asset_id
    //                   [4]=enc_owner_hash [5]=commitment [6]=auditor_pk_x [7]=auditor_pk_y
    // NOTE: enc_value and enc_asset_id are now ENCRYPTED (not plaintext) — pallet will reject.
    const [, , sigEncValue, sigEncAssetId, sigEncOwnerHash, sigCommitment] =
        result.publicSignals.map(hexSignalToBytes);

    // Build the compact 76-byte buffer (layout expected by the OLD pallet — now incompatible).
    const compact = new Uint8Array(76);
    compact.set(sigCommitment!); // [0..32]  commitment LE
    compact.set(sigEncValue!.subarray(0, 8), 32); // [32..40] enc_value (NOT plaintext)
    compact.set(sigEncAssetId!.subarray(0, 4), 40); // [40..44] enc_asset_id (NOT plaintext)
    compact.set(sigEncOwnerHash!, 44); // [44..76] enc_owner_hash (NOT plaintext)

    return {
        proof: result.proof,
        publicSignals: Array.from(compact),
    };
}
