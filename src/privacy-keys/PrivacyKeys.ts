/**
 * PrivacyKeys
 *
 * Pure cryptographic derivation for the Orbinum shielded pool identity: turns a
 * wallet signature into key material, and key material into the public values
 * that make up a privacy address. Protocol-level only — no storage, UI or
 * session concerns. What the user *signs* to produce that signature lives in
 * `SpendingKeyRequest`.
 *
 * Full derivation chain:
 *
 *   signature ──HKDF(info="orbinum-sk-{version}:{chainId}:{address}")──► masterBytes (32B)
 *                                                                            │
 *          ┌─────────────────────────────────────────────────────────────────┤
 *          ▼                                                                 ▼
 *   spendingKey = BigInt(masterBytes) % BABYJUB_SUBORDER            vaultKey (see vault/)
 *          │                                     = HKDF(masterBytes, "orbinum-vault-key-v1")
 *          ├──► ownerPk = BJJ_mul(Base8, spendingKey).Ax                    (public)
 *          │
 *          └──► ivsk = HKDF(LE32(spendingKey), info="orbinum-ivk-v1")       (secret)
 *                 └──► ivk = packPoint(BJJ_mul(Base8, ivsk_scalar))         (public)
 *
 * VERSIONING: the HKDF `info` carries the identity version, so v1 and v2 are
 * cryptographically disjoint even given identical signature bytes. This is the
 * layer that still separates the identities when the message-level defense fails
 * — see the security model in `SpendingKeyRequest`.
 *
 * MODULUS: reduce mod BABYJUB_SUBORDER, never BN254_R. circomlib's BabyPbk uses
 * Num2Bits(253), asserting spending_key < 2^253. BABYJUB_SUBORDER < 2^252
 * satisfies it; BN254_R ≈ 2^254.8 does not — ~34% of values would fail at runtime.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mulPointEscalar, Base8, packPoint } from '@zk-kit/baby-jubjub';
import { bigintTo32Le } from '../utils/bytes';
import { fromHex, toHex } from '../utils/hex';
import { BABYJUB_SUBORDER } from '../utils/crypto-constants';
import { canonicalAccountId } from './accountIdentity';

const IVK_DOMAIN = new TextEncoder().encode('orbinum-ivk-v1');

/**
 * Identity version, folded into the HKDF `info` so a future scheme is disjoint
 * from this one by construction. Only v2 exists: v1 derived from a harvestable
 * `personal_sign` and was removed, not deprecated, so no caller can reach it.
 */
const KEY_VERSION = 'v2';

/**
 * Shortest signature any supported signer produces: sr25519 VRF output is 32
 * bytes, ed25519 is 64, ECDSA `personal_sign` is 65. Anything shorter is not a
 * signature, so it must never reach the KDF.
 */
export const MIN_SIGNATURE_BYTES = 32;

/**
 * Rejects input that is not a real signature before it seeds the identity.
 *
 * HKDF accepts any-length IKM, including zero bytes, so without this an empty
 * or stub signature still yields a perfectly usable spending key — one derived
 * entirely from PUBLIC inputs (chainId, address), i.e. reproducible by anyone.
 * A wallet that returns `''`, `'0x'` or an error string instead of signing would
 * silently mint that key and let the user shield funds into it.
 *
 * Fail closed: an unusable signature is a bug or a hostile signer, never a
 * degraded-but-acceptable identity.
 */
function assertUsableSignature(sigBytes: Uint8Array): void {
    if (sigBytes.length < MIN_SIGNATURE_BYTES) {
        throw new Error(
            `Cannot derive a spending key: signature is ${sigBytes.length} bytes, ` +
                `expected at least ${MIN_SIGNATURE_BYTES}. The wallet did not return a signature.`
        );
    }
}

// ─── Key derivation from wallet signature ─────────────────────────────────────

/**
 * Derives the 32-byte master key bytes from a wallet signature.
 *
 * masterBytes = HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v2:{chainId}:{address}")
 *
 * These bytes are the stable root for ALL derived keys:
 *   - spendingKey (circuit scalar) = BigInt(masterBytes) % BABYJUB_SUBORDER
 *   - viewingSecretKey              = HKDF(bigintTo32Le(spendingKey), info="orbinum-ivk-v1")
 *   - vaultKey                     = HKDF(masterBytes, info="orbinum-vault-key-v1")
 *
 * Separating masterBytes from the circuit scalar means the viewingSecretKey and
 * vault key are STABLE across any future change to the modulus — they never
 * depend on which prime field the circuit uses.
 *
 * @throws If the signature is not valid hex, or carries less entropy than the
 *         shortest real signing scheme (see {@link MIN_SIGNATURE_BYTES}).
 */
export async function deriveMasterKeyBytes(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<Uint8Array> {
    const sigBytes = fromHex(signatureHex);
    assertUsableSignature(sigBytes);
    const info = new TextEncoder().encode(
        `orbinum-sk-${KEY_VERSION}:${chainId}:${canonicalAccountId(address)}`
    );
    return hkdf(sha256, sigBytes, new Uint8Array(0), info, 32);
}

/**
 * Derives an Orbinum spending key from a wallet signature.
 *
 * Uses HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v2:{chainId}:{address}")
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
 * @throws If the signature is not valid hex or is shorter than
 *         {@link MIN_SIGNATURE_BYTES} — see `deriveMasterKeyBytes`.
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
