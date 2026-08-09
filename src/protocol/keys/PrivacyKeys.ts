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
 *   ovk = HKDF(masterBytes, info="orbinum-ovk-v1")                          (secret)
 *
 * The `ovk` (outgoing viewing key) hangs off masterBytes, NOT the reduced
 * spendingKey scalar — same root as the vault key. It is a long-term outgoing
 * auditing key: deriving it from masterBytes keeps it stable across any future
 * change of the circuit modulus, and — unlike the ivsk — it is a SIBLING of the
 * ivsk, not a descendant. Neither derives from the other, so incoming-audit
 * (ivsk) and outgoing-audit (ovk) capabilities can be delegated independently.
 * Tradeoff: an ovk is not bound to the spending identity, so rotating the
 * spending key (were that ever possible) would not invalidate it. Deliberate for
 * an auditing key; documented, not mitigated.
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
import { packPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le } from '../../foundation/encoding/bytes';
import { toHex } from '../../foundation/encoding/hex';
import { BABYJUB_SUBORDER } from '../../foundation/crypto/constants';

const IVK_DOMAIN = new TextEncoder().encode('orbinum-ivk-v1');
const OVK_DOMAIN = new TextEncoder().encode('orbinum-ovk-v1');

/**
 * Identity version, folded into the HKDF `info` so a future scheme is disjoint
 * from this one by construction. Only v2 exists: v1 derived from a harvestable
 * `personal_sign` and was removed, not deprecated, so no caller can reach it.
 */
/** Derivation-scheme version, part of the HKDF info. Shared with spendingKeyDerivation. */
export const KEY_VERSION = 'v2';

// ─── Key derivation from wallet signature ─────────────────────────────────────

/**
 * Reduces master key bytes to the circuit's spending-key scalar.
 *
 * The reduction is what separates the two: the master is the stable root that
 * the vault key and the viewing key hang off, and the scalar is bound to the
 * curve currently in use. Deriving the vault key from the scalar instead would
 * make a stored vault unreadable after a modulus change.
 *
 * @returns bigint in [1, BABYJUB_SUBORDER)
 */
export function deriveSpendingKeyFromMaster(masterBytes: Uint8Array): bigint {
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
 *   ivk_point   = fastMulBase(ivsk_scalar)                  → [Ax, Ay]
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
    const ivkPoint = fastMulBase(ivskScalar);
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
        const pubPoint = fastMulBase(spendingKey);
        return pubPoint[0];
    } catch {
        return 0n;
    }
}

/**
 * Derive the 32-byte outgoing viewing key (ovk) from master bytes.
 *   ovk = HKDF-SHA256(ikm=masterBytes, info="orbinum-ovk-v1")
 *
 * Mirror of the vault-key derivation: rooted at masterBytes, not the spendingKey
 * scalar (see the derivation chain above for why). The ovk lets the SENDER of a
 * private transfer recover what they sent — it wraps the memo's shared secret so
 * a cold restore rebuilds the outgoing history. Sibling of the ivsk, delegable
 * independently.
 *
 * SECRET. Never embed it in a shareable address — it stays out of
 * encodePrivacyAddress by construction (there is no public component to derive).
 */
export function deriveOutgoingViewingKey(masterBytes: Uint8Array): Uint8Array {
    return hkdf(sha256, masterBytes, undefined, OVK_DOMAIN, 32);
}
