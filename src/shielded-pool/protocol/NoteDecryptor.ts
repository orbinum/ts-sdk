/**
 * NoteDecryptor
 *
 * Core logic for decrypting on-chain commitments during a shielded pool scan.
 * For each commitment, attempts to decrypt the encryptedMemo with the viewer's
 * viewing key, then verifies the recomputed commitment matches the on-chain value.
 *
 * This is protocol-level logic — independent of indexer, storage, or UI.
 * Consume via scan loops in application code.
 *
 * Hash scheme (Poseidon BN254, poseidon-lite):
 *   commitment = Poseidon4(value, assetId, ownerPk, blinding)
 *   nullifier  = Poseidon2(commitment, spendingKey)
 */

import { poseidon2, poseidon4 } from 'poseidon-lite';
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from './EncryptedMemo';
import { deriveStealthOwnerPk, deriveStealthSk } from '../../utils/stealth';
import { recoverOwnerPkPoint } from '../../utils/bjj';
import { fromHex, toHex } from '../../utils/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../utils/bytes';
import type { ScanCommitment, ZkNote } from './types';
export type { ScanCommitment };

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Computes the nullifier for a note.
 *   nullifier = Poseidon2(commitment, spendingKey)
 *
 * spendingKey must already be in [1, BABYJUB_SUBORDER) as returned by
 * deriveSpendingKeyFromSignature.
 */
export function computeNullifier(commitment: bigint, spendingKey: bigint): bigint {
    return poseidon2([commitment, spendingKey]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to decrypt an on-chain commitment using the recipient's viewing secret key.
 *
 * Returns a fully populated ZkNote if the memo decrypts correctly and the
 * recomputed commitment matches the on-chain value.
 * Returns null when the note does not belong to this viewer (wrong key, no memo,
 * or commitment mismatch).
 *
 * @param commitment       On-chain commitment record from the indexer.
 * @param viewingSecretKey 32-byte viewing secret key (from deriveViewingSecretKey / getViewingSecretKey).
 * @param spendingKey      Spending key bigint (for nullifier computation).
 * @param ownOwnerPk       The viewer's global BabyJubJub Ax (ownerPk). Required for stealth detection.
 *                         Pass 0n to disable stealth detection (legacy/own-note-only scanning).
 */
export function tryDecryptNote(
    commitment: ScanCommitment,
    viewingSecretKey: Uint8Array,
    spendingKey: bigint,
    ownOwnerPk: bigint = 0n
): ZkNote | null {
    return tryDecryptNoteVerbose(commitment, viewingSecretKey, spendingKey, ownOwnerPk).note;
}

/**
 * Like tryDecryptNote but also returns a human-readable reason for failure.
 * Useful for debugging scan issues (wrong key, corrupted memo, commitment mismatch).
 */
export function tryDecryptNoteVerbose(
    commitment: ScanCommitment,
    viewingSecretKey: Uint8Array,
    spendingKey: bigint,
    ownOwnerPk: bigint = 0n
): { note: ZkNote | null; reason?: string } {
    if (!commitment.encryptedMemo) return { note: null, reason: 'no_memo' };

    let commitmentBytes: Uint8Array;
    let memoBytes: Uint8Array;
    try {
        commitmentBytes = fromHex(commitment.commitmentHex);
        memoBytes = fromHex(commitment.encryptedMemo);
    } catch {
        return { note: null, reason: 'hex_parse_error' };
    }

    if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) {
        return {
            note: null,
            reason: `memo_size_mismatch:got_${memoBytes.length}_expected_${ENCRYPTED_MEMO_SIZE}`,
        };
    }

    const plaintext = EncryptedMemo.decrypt(memoBytes, commitmentBytes, viewingSecretKey);
    if (!plaintext) return { note: null, reason: 'decrypt_failed:wrong_key_or_corrupt_mac' };

    // Stealth detection: if the decrypted ownerPk differs from our global ownerPk, this is
    // a stealth note — the sender used our viewing key to compute a one-time stealthOwnerPk.
    // We must derive the matching stealthSk to compute the correct nullifier.
    let effectiveOwnerPk = plaintext.ownerPk;
    let effectiveSpendingKey = spendingKey;

    if (ownOwnerPk !== 0n && plaintext.ownerPk !== ownOwnerPk) {
        // Extract the sharedSecret from the memo using our viewing secret key.
        const sharedSecret = EncryptedMemo.extractSharedSecret(memoBytes, viewingSecretKey);
        if (!sharedSecret) return { note: null, reason: 'stealth_shared_secret_failed' };

        // Recover the full BJJ point [Ax, Ay] from our ownerPk (Ax only).
        const ownPkPoint = recoverOwnerPkPoint(ownOwnerPk);
        if (!ownPkPoint) return { note: null, reason: 'stealth_invalid_own_owner_pk' };

        // Derive the expected stealthOwnerPk and verify it matches the decrypted plaintext.
        const stealthOwnerPk = deriveStealthOwnerPk(sharedSecret, ownOwnerPk, ownPkPoint);
        if (stealthOwnerPk !== plaintext.ownerPk) {
            return { note: null, reason: 'commitment_mismatch' };
        }

        effectiveOwnerPk = stealthOwnerPk;
        effectiveSpendingKey = deriveStealthSk(sharedSecret, ownOwnerPk, spendingKey);
    }

    // Verify: recompute commitment and assert it matches the on-chain value.
    const recomputed = poseidon4([
        plaintext.value,
        plaintext.assetId,
        effectiveOwnerPk,
        plaintext.blinding,
    ]);
    if (recomputed !== bytesToBigintLE(commitmentBytes)) {
        return { note: null, reason: 'commitment_mismatch' };
    }

    const nullifier = poseidon2([recomputed, effectiveSpendingKey]);

    return {
        note: {
            value: plaintext.value,
            assetId: plaintext.assetId,
            ownerPk: effectiveOwnerPk,
            blinding: plaintext.blinding,
            spendingKey: effectiveSpendingKey,
            spent: false,
            spentAt: null,
            commitment: recomputed,
            nullifier,
            commitmentHex: toHex(bigintTo32Le(recomputed)),
            nullifierHex: toHex(bigintTo32Le(nullifier)),
            memo: Array.from(memoBytes),
            counterpartyPk: plaintext.counterpartyPk,
        },
    };
}
