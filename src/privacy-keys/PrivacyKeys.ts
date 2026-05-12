/**
 * PrivacyKeys
 *
 * Pure cryptographic derivation functions for the Orbinum shielded pool identity.
 * These are protocol-level operations — independent of storage, UI, or session.
 *
 * Derivation scheme (ECDH viewing key — v2):
 *   viewingSecretKey (ivsk) = HKDF-SHA256(ikm=spendingKey_bytes, info="orbinum-ivk-v1") → 32 bytes
 *   ivsk_scalar             = BigInt(ivsk_BE) % BABYJUB_SUBORDER  (clamped to [1, ∞))
 *   viewingPublicKey (ivk)  = BJJ_mul(Base8, ivsk_scalar)  →  packPoint([Ax, Ay])  → 32-byte bigint stored LE
 *   ownerPk                 = BabyJubJub Ax from (spendingKey * Base8)  → bigint
 *
 * Spending key derivation (from wallet signature):
 *   message     = "orbinum-spending-key-v1\n${chainId}\n${address.toLowerCase()}"
 *   skBytes     = HKDF-SHA256(ikm=sig_bytes, salt=empty, info="orbinum-sk-v1:${chainId}:${address}")
 *   spendingKey = BigInt(skBytes_as_big_endian) % BABYJUB_SUBORDER  (if 0 → 1)
 *
 * IMPORTANT: must reduce mod BABYJUB_SUBORDER (not BN254_R). circomlib's BabyPbk uses
 * Num2Bits(253) which asserts spending_key < 2^253. BABYJUB_SUBORDER < 2^252 satisfies
 * this. BN254_R ≈ 2^254.8 does not — ~34% of values would exceed 2^253 at runtime.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mulPointEscalar, Base8, packPoint } from '@zk-kit/baby-jubjub';
import { bigintTo32Le } from '../utils/bytes';
import { fromHex, toHex } from '../utils/hex';
import { BABYJUB_SUBORDER } from '../utils/crypto-constants';

const IVK_DOMAIN = new TextEncoder().encode('orbinum-ivk-v1');

// ─── Key derivation from wallet signature ─────────────────────────────────────

/**
 * Returns the message string the user must sign with their wallet to derive
 * a deterministic Orbinum spending key.
 */
export function deriveSpendingKeyMessage(chainId: number, address: string): string {
    return `orbinum-spending-key-v1\n${chainId}\n${address.toLowerCase()}`;
}

/**
 * Derives the 32-byte master key bytes from a wallet signature.
 *
 * masterBytes = HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v1:{chainId}:{address}")
 *
 * These bytes are the stable root for ALL derived keys:
 *   - spendingKey (circuit scalar) = BigInt(masterBytes) % BABYJUB_SUBORDER
 *   - viewingSecretKey              = HKDF(bigintTo32Le(spendingKey), info="orbinum-ivk-v1")
 *   - vaultKey                     = HKDF(masterBytes, info="orbinum-vault-key-v1")
 *
 * Separating masterBytes from the circuit scalar means the viewingSecretKey and
 * vault key are STABLE across any future change to the modulus — they never
 * depend on which prime field the circuit uses.
 */
export async function deriveMasterKeyBytes(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<Uint8Array> {
    const sigBytes = fromHex(signatureHex);
    const info = new TextEncoder().encode(`orbinum-sk-v1:${chainId}:${address.toLowerCase()}`);
    return hkdf(sha256, sigBytes, new Uint8Array(0), info, 32);
}

/**
 * Derives an Orbinum spending key from a wallet signature.
 *
 * Uses HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v1:{chainId}:{address}")
 * and reduces the resulting 32-byte value modulo BABYJUB_SUBORDER.
 *
 * IMPORTANT: viewingSecretKey and vaultKey must be derived from masterBytes (via
 * deriveMasterKeyBytes), NOT from this spending key scalar. This ensures those
 * keys remain stable if the circuit's modulus ever changes again.
 *
 * @param signatureHex  0x-prefixed or bare hex of the wallet signature.
 * @param chainId       Chain ID used when building the signing message.
 * @param address       Signer address (EVM or SS58) used in the signing message.
 * @returns bigint in [1, BABYJUB_SUBORDER)
 */
export async function deriveSpendingKeyFromSignature(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<bigint> {
    const masterBytes = await deriveMasterKeyBytes(signatureHex, chainId, address);
    const skBigint = BigInt(toHex(masterBytes)) % BABYJUB_SUBORDER;
    return skBigint === 0n ? 1n : skBigint;
}

// ─── Key derivation from master bytes / spending key ─────────────────────────

/**
 * Derive a 32-byte viewing secret key (ivsk) from the spending key.
 *   ivsk = HKDF-SHA256(ikm=bigintTo32Le(spendingKey), info="orbinum-ivk-v1")
 *
 * The ivsk is intentionally derived from the already-reduced spending key scalar
 * (not from masterBytes) so that it stays bound to the specific key identity
 * loaded in this session. The spendingKey must already be in [1, BABYJUB_SUBORDER).
 *
 * SECURITY: This is a symmetric secret — never embed it in a shareable address.
 * Use deriveViewingPublicKey() to obtain the public component for sharing.
 */
export function deriveViewingSecretKey(spendingKey: bigint): Uint8Array {
    const ikm = bigintTo32Le(spendingKey);
    return hkdf(sha256, ikm, undefined, IVK_DOMAIN, 32);
}

/**
 * Derive the packed BabyJubJub viewing public key (ivk) from ivsk bytes.
 *
 *   ivsk_scalar = BigInt(ivsk_bytes_BE) % BABYJUB_SUBORDER  (clamped to [1, ∞))
 *   ivk_point   = mulPointEscalar(Base8, ivsk_scalar)       → [Ax, Ay]
 *   result      = bigintTo32Le(packPoint([Ax, Ay]))          → 32-byte Uint8Array (LE)
 *
 * The packed bigint is stored in little-endian so it is consistent with the
 * rest of the SDK's 32-byte scalar encoding (bigintTo32Le / bytesToBigintLE).
 *
 * @param ivsk 32-byte HKDF output from deriveViewingSecretKey().
 * @returns 32-byte LE-encoded packed BJJ point (goes in the privacy address).
 */
export function deriveViewingPublicKey(ivsk: Uint8Array): Uint8Array {
    const ivskScalar = BigInt(toHex(ivsk)) % BABYJUB_SUBORDER || 1n;
    const ivkPoint = mulPointEscalar(Base8, ivskScalar);
    const packed = packPoint(ivkPoint) as bigint;
    return bigintTo32Le(packed);
}

/**
 * Derive the BabyJubJub Ax (x-coordinate of the public key) from a spending key.
 *   ownerPk = (spendingKey * BabyJubJub.Base8)[0]
 *
 * Returns 0n if BabyJubJub computation fails (e.g. invalid scalar).
 */
export function deriveOwnerPk(spendingKey: bigint): bigint {
    try {
        const pubPoint = mulPointEscalar(Base8, spendingKey);
        return pubPoint[0];
    } catch {
        return 0n;
    }
}
