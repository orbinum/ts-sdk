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
import { EncryptedMemo } from './EncryptedMemo';
import { fromHex, toHex } from '../utils/hex';
import { bigintTo32Le, bytesToBigintLE } from '../utils/bytes';
import type { ScanCommitment, ZkNote } from './types';
export type { ScanCommitment };

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to decrypt an on-chain commitment using a viewing key.
 *
 * Returns a fully populated ZkNote if the memo decrypts correctly and the
 * recomputed commitment matches the on-chain value.
 * Returns null when the note does not belong to this viewer (wrong key, no memo,
 * or commitment mismatch).
 *
 * @param commitment  On-chain commitment record from the indexer.
 * @param viewingKey  32-byte viewing key (from deriveViewingKey).
 * @param spendingKey Spending key bigint (for nullifier computation).
 */
export function tryDecryptNote(
    commitment: ScanCommitment,
    viewingKey: Uint8Array,
    spendingKey: bigint
): ZkNote | null {
    if (!commitment.encryptedMemo) return null;

    let commitmentBytes: Uint8Array;
    let memoBytes: Uint8Array;
    try {
        commitmentBytes = fromHex(commitment.commitmentHex);
        memoBytes = fromHex(commitment.encryptedMemo);
    } catch {
        return null;
    }

    const plaintext = EncryptedMemo.decrypt(memoBytes, commitmentBytes, viewingKey);
    if (!plaintext) return null;

    // Verify: recompute commitment and assert it matches the on-chain value.
    const recomputed = poseidon4([
        plaintext.value,
        plaintext.assetId,
        plaintext.ownerPk,
        plaintext.blinding,
    ]);
    if (recomputed !== bytesToBigintLE(commitmentBytes)) return null;

    const nullifier = poseidon2([recomputed, spendingKey]);

    return {
        value: plaintext.value,
        assetId: plaintext.assetId,
        ownerPk: plaintext.ownerPk,
        blinding: plaintext.blinding,
        spendingKey,
        spent: false,
        spentAt: null,
        commitment: recomputed,
        nullifier,
        commitmentHex: toHex(bigintTo32Le(recomputed)),
        nullifierHex: toHex(bigintTo32Le(nullifier)),
        memo: Array.from(memoBytes),
    };
}
