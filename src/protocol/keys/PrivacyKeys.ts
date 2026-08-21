/**
 * PrivacyKeys
 *
 * Pure cryptographic derivation for the Orbinum shielded pool identity: turns a
 * wallet signature into key material, and key material into the public values
 * that make up a privacy address. Protocol-level only — no storage, UI or
 * session concerns. What the user *signs* to produce that signature lives in
 * `SpendingKeyRequest`.
 *
 * Full derivation chain — every secret hangs off the root, none off another:
 *
 *   signature ──HKDF(info="orbinum-sk-{version}:{chainId}:{address}")──► masterBytes (32B)
 *          │
 *          ├──► spendingKey = HKDF(masterBytes, "orbinum-spend-v3")         (secret)
 *          │       └──► ownerPk = BJJ_mul(Base8, spendingKey).Ax            (public)
 *          │
 *          ├──► ivsk = HKDF(masterBytes, "orbinum-ivk-v3")                  (secret)
 *          │       └──► ivk = packPoint(BJJ_mul(Base8, ivsk_scalar))        (public)
 *          │
 *          ├──► ovk  = HKDF(masterBytes, "orbinum-ovk-v3")                  (secret)
 *          │
 *          └──► vaultKey = HKDF(masterBytes, "orbinum-vault-key-v1")   (see vault/)
 *
 * DISJOINT BRANCHES: the viewing key no longer descends from the spending key,
 * so handing one out delegates only the ability to SEE. Under the earlier chain
 * (`spendingKey → ivsk`) that was impossible — anything that revealed the
 * viewing secret revealed the key that spends.
 *
 * VERSIONING: the HKDF `info` carries the version, the chain id and the
 * account, so two SCHEMES, two chains or two accounts stay disjoint even given
 * identical signature bytes.
 *
 * It does NOT defend against a hostile origin asking for the same signature —
 * that origin requests the current message and gets the same master. Only the
 * sr25519 VRF path binds an origin; see `SpendingKeyRequest`.
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

/**
 * Version token inside the HKDF info the SIGNATURE is bound to.
 *
 * Stays `v2` on purpose while the identity scheme is v3. The two version very
 * different things:
 *
 *   - this one names the message the user signs, `orbinum-sk-v2:{chainId}:{addr}`,
 *     and therefore the master bytes that come out of it;
 *   - `IdentityVersion` names the BRANCHES derived from those master bytes.
 *
 * v3 changed only the branches. Bumping this too would change the master for
 * the same signature, forcing every user to re-sign to reach an identity that
 * is otherwise identical — a prompt with nothing behind it. It moves when the
 * signed message itself has to change.
 */
export const KEY_VERSION = 'v2';

/**
 * The derivation scheme an identity was built under.
 *
 * Only `v3` exists. It lives here, beside the derivations themselves, rather
 * than in the wallet: the vault name and the address scheme both hang off it,
 * and having `protocol` reach up into `wallet` for the type would invert the
 * layering for a single string union.
 *
 * Kept as a named union rather than dropped: the next scheme gets added here,
 * and a bare string would let a typo pick a vault nobody ever wrote to.
 */
export type IdentityVersion = 'v3';

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
 * The v2 viewing secret key, chained off the SPENDING key.
 *   ivsk = HKDF-SHA256(ikm=bigintTo32Le(spendingKey), info="orbinum-ivk-v1")
 *
 * NOT what a v3 wallet uses. `deriveViewingSecretKeyV3(masterBytes)` is the
 * live branch, and the two produce DIFFERENT keys from one signature: deriving
 * this one beside a v3 identity yields a second wallet whose notes the first
 * cannot see. `PrivacyKeyManager` only ever calls the v3 branch.
 *
 * Chaining off the spending key is exactly what v3 removed — it made a viewing
 * key impossible to delegate, since anything that revealed it revealed the key
 * that spends. Kept for reading material derived under the older scheme.
 *
 * SECURITY: a symmetric secret — never embed it in a shareable address. Use
 * `deriveViewingPublicKey()` for the public half.
 */
export function deriveViewingSecretKey(spendingKey: bigint): Uint8Array {
    const ikm = bigintTo32Le(spendingKey);
    return hkdf(sha256, ikm, undefined, IVK_DOMAIN, 32);
}

// ─── v3: disjoint branches ───────────────────────────────────────────────────
//
// Every v3 key is HKDF(rootSecret, info=<purpose>). No branch derives from
// another, which is the whole point: in v2 the viewing key DESCENDS from the
// spending key, so there is no viewing key that can be handed out — delegating
// read access means delegating everything.
//
// Three consequences worth knowing before using these:
//
//   1. Spending needs TWO branches. The scalar that spends a received note is
//      `deriveStealthSk(sharedSecret, ownerPk, spendingKey)`, and the shared
//      secret comes from the VIEWING key. A v3 spending key alone decrypts
//      nothing and spends nothing — disjoint does not mean independently usable.
//   2. Recovery needs the ROOT. Recovering only the spending key leaves the
//      payment history unrecoverable, because the outgoing branch is gone with
//      it. "Back up your key" becomes "back up your root".
//   3. `ovk` is MORE sensitive than `ivsk`: it hands over the payment graph, not
//      just incoming amounts. It must be opt-in and separately revocable.

const SPEND_V3_DOMAIN = new TextEncoder().encode('orbinum-spend-v3');
const IVK_V3_DOMAIN = new TextEncoder().encode('orbinum-ivk-v3');
const OVK_V3_DOMAIN = new TextEncoder().encode('orbinum-ovk-v3');

/** One 32-byte v3 branch. Every branch is a sibling; none is a parent. */
const deriveBranch = (rootSecret: Uint8Array, domain: Uint8Array): Uint8Array =>
    hkdf(sha256, rootSecret, undefined, domain, 32);

/**
 * The v3 spending scalar — the authority to move funds, and nothing else.
 *
 * Reduced into the curve's scalar field like its v2 counterpart, so the circuit
 * accepts it unchanged. Unlike v2 it is a LEAF: no other key hangs off it.
 */
export function deriveSpendingKeyV3(rootSecret: Uint8Array): bigint {
    const scalar = BigInt(toHex(deriveBranch(rootSecret, SPEND_V3_DOMAIN))) % BABYJUB_SUBORDER;
    return scalar === 0n ? 1n : scalar;
}

/**
 * The v3 incoming viewing key — read what arrives, spend nothing.
 *
 * This is the branch that makes a watch-only wallet possible: it is a sibling of
 * the spending key, so holding it proves nothing about the spending key and
 * gives no path to it.
 */
export function deriveViewingSecretKeyV3(rootSecret: Uint8Array): Uint8Array {
    return deriveBranch(rootSecret, IVK_V3_DOMAIN);
}

/**
 * The v3 outgoing viewing key — read what this wallet SENT.
 *
 * Seeds the outgoing ephemerals and the recipient book, so a holder can
 * enumerate every payment the wallet made and name who received it. That is the
 * capability, not a leak — but it makes this strictly more sensitive than the
 * incoming viewing key, which only reveals what arrived.
 */
export function deriveOutgoingViewingKeyV3(rootSecret: Uint8Array): Uint8Array {
    return deriveBranch(rootSecret, OVK_V3_DOMAIN);
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
 * @param ivsk 32-byte viewing secret key — `deriveViewingSecretKeyV3` on v3.
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
