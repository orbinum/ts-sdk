/**
 * Stealth addresses — a one-time owner key per note, from a shared secret.
 *
 * A recipient publishes ONE privacy address and every payment to it commits to
 * a DIFFERENT owner key, so an observer cannot group two notes as belonging to
 * the same person. Both sides reach the same value from opposite directions:
 * the sender from the ECDH secret it just sealed the memo with, the recipient
 * from the same secret recovered out of that memo.
 *
 * The whole scheme rests on one identity, which is what makes it work with an
 * UNMODIFIED circuit:
 *
 *   BabyPbk(stealthSk).Ax === deriveStealthOwnerPk(sharedSecret, ownerPk, point)
 *
 * The circuit already checks that a spender's key derives the commitment's
 * owner. Because the stealth scalar is added on both sides — to the base point
 * on one, to the spending key on the other — that check passes unchanged.
 *
 * The salt is the recipient's GLOBAL ownerPk, so a shared secret reused across
 * two recipients still yields different stealth keys.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { mulPointEscalar, Base8, addPoint } from '@zk-kit/baby-jubjub';
import { bigintTo32Le, bytesToBigintLE } from '../encoding/bytes';
import { BABYJUB_SUBORDER } from './constants';

const STEALTH_INFO = new TextEncoder().encode('orbinum-stealth-v1');

/**
 * Derive the scalar component used in stealth address construction.
 *
 *   stealthBytes  = HKDF-SHA256(ikm=sharedSecret, salt=bigintTo32Le(ownerPkBigint), info="orbinum-stealth-v1")
 *   stealthScalar = bytesToBigintLE(stealthBytes) % BABYJUB_SUBORDER  (|| 1n)
 *
 * Internal — callers use deriveStealthOwnerPk / deriveStealthSk.
 */
function deriveStealthScalar(sharedSecret: Uint8Array, ownerPkBigint: bigint): bigint {
    const salt = bigintTo32Le(ownerPkBigint);
    const stealthBytes = hkdf(sha256, sharedSecret, salt, STEALTH_INFO, 32);
    return bytesToBigintLE(stealthBytes) % BABYJUB_SUBORDER || 1n;
}

/**
 * Derive the stealth owner public key (Ax) for a recipient note.
 *
 *   stealthScalar = HKDF(sharedSecret, salt=ownerPk_LE, info="orbinum-stealth-v1") % suborder
 *   stealthPoint  = stealthScalar × Base8 + ownerPkPoint
 *   return stealthPoint[0]  (Ax coordinate)
 *
 * The sender calls this with sharedSecret from ECDH (EncryptedMemo.encrypt side).
 * The recipient calls this with sharedSecret from EncryptedMemo.extractSharedSecret.
 *
 * @param sharedSecret   32-byte LE Ax of the ECDH shared point.
 * @param ownerPkBigint  Recipient's global ownerPk (BJJ Ax as bigint).
 * @param ownerPkPoint   Recipient's global BJJ point [Ax, Ay]. Must match ownerPkBigint.
 * @returns Stealth owner public key (Ax bigint). Used as ownerPk in the note commitment.
 */
export function deriveStealthOwnerPk(
    sharedSecret: Uint8Array,
    ownerPkBigint: bigint,
    ownerPkPoint: [bigint, bigint]
): bigint {
    const stealthScalar = deriveStealthScalar(sharedSecret, ownerPkBigint);
    const stealthPt = addPoint(mulPointEscalar(Base8, stealthScalar), ownerPkPoint);
    return stealthPt[0];
}

/**
 * Derive the stealth spending key for a received note.
 *
 *   stealthScalar = HKDF(sharedSecret, salt=ownerPk_LE, info="orbinum-stealth-v1") % suborder
 *   stealthSk     = (stealthScalar + spendingKey) % BABYJUB_SUBORDER  (|| 1n)
 *
 * Security property: BabyPbk(stealthSk).Ax == deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint)
 * This means the ZK circuit validates ownership correctly without modification.
 *
 * @param sharedSecret  32-byte LE Ax of the ECDH shared point.
 * @param ownerPkBigint Recipient's global ownerPk (BJJ Ax as bigint) — used as HKDF salt.
 * @param spendingKey   Recipient's global spending key scalar.
 * @returns Stealth spending key — use as ZkNote.spendingKey for received notes.
 */
export function deriveStealthSk(
    sharedSecret: Uint8Array,
    ownerPkBigint: bigint,
    spendingKey: bigint
): bigint {
    const stealthScalar = deriveStealthScalar(sharedSecret, ownerPkBigint);
    return (stealthScalar + spendingKey) % BABYJUB_SUBORDER || 1n;
}
