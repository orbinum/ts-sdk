/**
 * Makes a stealth note the wallet just built for ITSELF spendable right away.
 *
 * `NoteBuilder.build` produces a note whose `ownerPk` is the one-time stealth
 * key (what the commitment covers) but whose `spendingKey` is the GLOBAL one it
 * was handed: the builder's job is to make something the RECIPIENT can open, so
 * it never derives the stealth secret. Its nullifier is computed from the wrong
 * key and never appears on chain.
 *
 * Stored as-is that note is UNSPENDABLE — every spend path recomputes the
 * commitment from `BabyPbk(spendingKey).Ax` and gets a different value, so the
 * note is rejected. Only a full rescan repaired it, since an incremental pass
 * merges without touching cryptographic fields.
 *
 * The fix is the work a scan already does: open the memo with the wallet's
 * global keys, which re-derives the stealth spending key and the real nullifier.
 */
import { tryDecryptNote } from '../../../protocol/note/index';
import { toHex } from '../../../foundation/encoding/hex';
import type { ZkNote } from '../../../protocol/types';

export interface SelfStealthKeys {
    viewingSecretKey: Uint8Array;
    spendingKey: bigint;
    ownerPk: bigint;
}

/**
 * The spendable form of a stealth note this wallet authored, or null when the
 * memo does not open with its keys.
 *
 * Null is not an error to paper over: it means this wallet cannot derive the
 * note's spending key, so persisting the built note would store something
 * unspendable. Leave it out and let a scan recover it.
 *
 * `leafIndex` is a placeholder — spends re-fetch the Merkle proof by commitment,
 * so the position at build time is never read back.
 */
export function recoverSelfStealthNote(note: ZkNote, keys: SelfStealthKeys): ZkNote | null {
    const recovered = tryDecryptNote(
        {
            commitmentHex: note.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(new Uint8Array(note.memo)),
        },
        keys.viewingSecretKey,
        keys.spendingKey,
        keys.ownerPk
    );

    // A zero-value note is the change output of an exact-amount spend. The
    // circuit treats a value-0 input as a dummy and forces its nullifier to 0,
    // so it is unspendable and must never reach the vault.
    if (!recovered || recovered.value === 0n) return null;
    return recovered;
}
