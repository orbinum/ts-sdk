import type { NoteInput, ZkNote } from '../types';
import { EncryptedMemo } from './EncryptedMemo';
import { toHex } from '../utils/hex';
import { bigintTo32Le } from '../utils/bytes';
import { poseidon2, poseidon4 } from 'poseidon-lite';

// ─── NoteBuilder ─────────────────────────────────────────────────────────────

/**
 * Builds ZK notes (commitment + nullifier) and encrypted memos locally.
 *
 * All computation is off-chain — no network calls are made.
 *
 * Hash scheme (Poseidon, circomlibjs):
 *   commitment = Poseidon(value, assetId, ownerPk, blinding)
 *   nullifier  = Poseidon(commitment, spendingKey)
 *
 * Memo scheme (EncryptedMemo — native TypeScript, no WASM):
 *   ChaCha20-Poly1305 with key = SHA256(recipientVk || commitment || domain)
 *   Result: nonce(12) || ciphertext(76 + 16 MAC) = 104 bytes
 */
export class NoteBuilder {
    /**
     * Build a ZkNote from the given inputs.
     *
     * @param input.value       Amount in planck (required).
     * @param input.assetId     Asset ID — default 0n (native ORB-Privacy).
     * @param input.ownerPk     BabyJubJub Ax — default 0n.
     * @param input.blinding    Random scalar — defaults to BigInt(Date.now()).
     * @param input.spendingKey Secret key for nullifier — default 0n.
     */
    static async build(input: NoteInput): Promise<ZkNote> {
        const value = input.value;
        const assetId = input.assetId ?? 0n;
        const ownerPk = input.ownerPk ?? 0n;
        const blinding = input.blinding ?? BigInt(Date.now());
        const spendingKey = input.spendingKey ?? 0n;

        const commitment = poseidon4([value, assetId, ownerPk, blinding]);
        const nullifier = poseidon2([commitment, spendingKey]);

        const commitmentBytes = bigintTo32Le(commitment);
        const nullifierBytes = bigintTo32Le(nullifier);

        const memo: number[] =
            input.viewingKey !== undefined
                ? Array.from(
                      EncryptedMemo.encrypt(
                          value,
                          bigintTo32Le(ownerPk),
                          bigintTo32Le(blinding),
                          Number(assetId),
                          commitmentBytes,
                          input.viewingKey
                      )
                  )
                : Array.from(EncryptedMemo.dummy());

        const note: ZkNote = {
            value,
            assetId,
            ownerPk,
            blinding,
            spendingKey,
            spent: false,
            spentAt: null,
            commitment,
            nullifier,
            commitmentHex: toHex(commitmentBytes),
            nullifierHex: toHex(nullifierBytes),
            memo,
        };
        return note;
    }

    /**
     * Build the 104-byte encrypted memo for a note.
     *
     * Pure TypeScript implementation — no WASM dependency.
     * Uses ChaCha20-Poly1305 with SHA-256 key derivation.
     *
     * @param note         The ZkNote whose fields populate the plaintext.
     * @param recipientVk  32-byte recipient viewing key.
     *                     Pass `new Uint8Array(32)` (default) for a public/dummy memo.
     */
    static buildMemo(note: ZkNote, recipientVk?: Uint8Array): Uint8Array {
        return EncryptedMemo.encrypt(
            note.value,
            bigintTo32Le(note.ownerPk),
            bigintTo32Le(note.blinding),
            Number(note.assetId),
            bigintTo32Le(note.commitment),
            recipientVk ?? new Uint8Array(32)
        );
    }
}
