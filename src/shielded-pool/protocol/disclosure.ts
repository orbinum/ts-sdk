/**
 * Selective disclosure helpers for the Orbinum shielded pool (ECDH Baby Jubjub protocol).
 *
 * ## Public signals layout (256 bytes on-chain)
 * ```
 *  [0..32]   commitment      — Poseidon4(value, asset_id, owner_pk, blinding) LE
 *  [32..64]  auditor_pk_x   — Baby Jubjub pk_A.x LE
 *  [64..96]  auditor_pk_y   — Baby Jubjub pk_A.y LE
 *  [96..128] epk_x          — r·G x-coordinate LE
 *  [128..160] epk_y         — r·G y-coordinate LE
 *  [160..192] enc_value     — masked_value + k0
 *  [192..224] enc_asset_id  — masked_asset_id + k1
 *  [224..256] enc_owner_hash — masked_owner_hash + k2
 * ```
 *
 * The runtime verifies the Groth16 proof against the ciphertext.
 * It never decrypts. Decryption is off-chain with the auditor's BJJ sk.
 */

export {
    generateDisclosureProof,
    type ArtifactProvider,
    type DisclosureProofOutput,
    type DisclosureMask as DisclosureFlags,
} from '@orbinum/proof-generator';

import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import { poseidon1, poseidon3 } from 'poseidon-lite';
import type { DisclosureProofOutput } from '@orbinum/proof-generator';
import { BN254_R } from '../../utils/crypto-constants';
import { bigintTo32Le } from '../../utils/bytes';
import { fromHex } from '../../utils/hex';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Converts a 0x-prefixed or raw LE hex field element to a 32-byte Uint8Array. */
function hexFieldToBytes32(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    return fromHex(clean.padStart(64, '0'));
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derives a Baby Jubjub keypair deterministically from a Substrate signing key.
 *
 * ```
 * bjj_sk = Poseidon(substrate_signing_key)   // one-way; does not expose the substrate key
 * bjj_pk = bjj_sk · G                         // Baby Jubjub base point
 * ```
 *
 * The `bjj_pk` is registered in `DisclosureRequest` on-chain so the note owner
 * knows which key to encrypt to.
 *
 * @param substrateSigningKey - Raw 32-byte Substrate signing key (sr25519 or ed25519).
 * @returns `{ sk, pkX, pkY }` — Baby Jubjub secret scalar and public key coordinates.
 */
export function deriveBabyJubjubKeypair(substrateSigningKey: Uint8Array): {
    sk: bigint;
    pkX: bigint;
    pkY: bigint;
} {
    // Convert signing key bytes (big-endian interpretation) to a bigint for hashing.
    let keyBigInt = 0n;
    for (let i = 0; i < substrateSigningKey.length; i++) {
        keyBigInt = (keyBigInt << 8n) | BigInt(substrateSigningKey[i]!);
    }
    // One-way: bjj_sk = Poseidon(substrate_signing_key)
    const sk = poseidon1([keyBigInt]);
    // bjj_pk = sk · G (Baby Jubjub scalar multiplication)
    const pk = mulPointEscalar(Base8, sk);
    return { sk, pkX: pk[0], pkY: pk[1] };
}

// ─── Public signals buffer ────────────────────────────────────────────────────

/**
 * Packs the 8 public signals into the 256-byte buffer for the `disclose` extrinsic.
 *
 * Layout:
 * ```
 *  [0..32]   commitment      — 32-byte LE (0x-hex string)
 *  [32..64]  auditor_pk_x   — 32-byte LE bigint
 *  [64..96]  auditor_pk_y   — 32-byte LE bigint
 *  [96..128] epk_x          — from proofOutput.encryptedData.epkX
 *  [128..160] epk_y         — from proofOutput.encryptedData.epkY
 *  [160..192] enc_value     — from proofOutput.encryptedData.encValue
 *  [192..224] enc_asset_id  — from proofOutput.encryptedData.encAssetId
 *  [224..256] enc_owner_hash — from proofOutput.encryptedData.encOwnerHash
 * ```
 *
 * @param commitment   - 0x-prefixed 32-byte hex commitment.
 * @param auditorPkX   - Auditor's Baby Jubjub pk x-coordinate (bigint LE).
 * @param auditorPkY   - Auditor's Baby Jubjub pk y-coordinate (bigint LE).
 * @param proofOutput  - Output of `generateDisclosureProof`.
 * @returns `number[]` — 256 bytes, SCALE-compatible.
 */
export function buildDisclosurePublicSignals(
    commitment: string,
    auditorPkX: bigint,
    auditorPkY: bigint,
    proofOutput: DisclosureProofOutput
): number[] {
    const buf = new Uint8Array(256);
    buf.set(hexFieldToBytes32(commitment), 0); // [0..32]   commitment
    buf.set(bigintTo32Le(auditorPkX), 32); // [32..64]  auditor_pk_x
    buf.set(bigintTo32Le(auditorPkY), 64); // [64..96]  auditor_pk_y
    buf.set(hexFieldToBytes32(proofOutput.encryptedData.epkX), 96); // [96..128] epk_x
    buf.set(hexFieldToBytes32(proofOutput.encryptedData.epkY), 128); // [128..160] epk_y
    buf.set(hexFieldToBytes32(proofOutput.encryptedData.encValue), 160); // [160..192] enc_value
    buf.set(hexFieldToBytes32(proofOutput.encryptedData.encAssetId), 192); // [192..224] enc_asset_id
    buf.set(hexFieldToBytes32(proofOutput.encryptedData.encOwnerHash), 224); // [224..256] enc_owner_hash
    return Array.from(buf);
}

// ─── Off-chain decryption ─────────────────────────────────────────────────────

/**
 * Decrypts encrypted disclosure signals using the auditor's Baby Jubjub secret key.
 *
 * ```
 * shared = sk_A · epk              (ECDH — Baby Jubjub scalar mult)
 * k_i = Poseidon(shared.x, shared.y, i)
 * plaintext_i = (enc_i - k_i + BN254_R) % BN254_R
 * ```
 *
 * Only the intended auditor (holder of `auditorBjjSk`) can decrypt.
 * This runs entirely off-chain — the runtime never sees or derives `sk`.
 *
 * @param auditorBjjSk - Auditor's Baby Jubjub secret scalar (from `deriveBabyJubjubKeypair`).
 * @param enc          - Encrypted signals from `DisclosureRecord.signals` (as bigints).
 * @returns `{ value, assetId, ownerHash }` — decrypted field elements.
 *   If a field was not disclosed, its ciphertext is `k_i` and the plaintext decrypts to `0`.
 */
export function decryptDisclosureSignals(
    auditorBjjSk: bigint,
    enc: {
        epkX: bigint;
        epkY: bigint;
        encValue: bigint;
        encAssetId: bigint;
        encOwnerHash: bigint;
    }
): { value: bigint; assetId: bigint; ownerHash: bigint } {
    // shared = sk_A · epk
    const shared = mulPointEscalar([enc.epkX, enc.epkY], auditorBjjSk);
    const sharedX = shared[0];
    const sharedY = shared[1];

    // Poseidon keystream: k_i = Poseidon(shared.x, shared.y, i)
    const k0 = poseidon3([sharedX, sharedY, 0n]);
    const k1 = poseidon3([sharedX, sharedY, 1n]);
    const k2 = poseidon3([sharedX, sharedY, 2n]);

    // Decrypt mod BN254_R
    return {
        value: (enc.encValue - k0 + BN254_R) % BN254_R,
        assetId: (enc.encAssetId - k1 + BN254_R) % BN254_R,
        ownerHash: (enc.encOwnerHash - k2 + BN254_R) % BN254_R,
    };
}
