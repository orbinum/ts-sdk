/**
 * Recovery of a stealth note a wallet just created for itself.
 *
 * ── Why a freshly built stealth note cannot be stored as-is ──────────────────
 * `NoteBuilder.build` returns a note whose `ownerPk` is the one-time
 * stealthOwnerPk (that is what the commitment covers), but whose `spendingKey`
 * is the GLOBAL key it was handed — the stealth secret is never derived on the
 * build side, because the builder's job is to produce something the RECIPIENT
 * can open. Its nullifier is therefore computed from the wrong key and will
 * never appear on chain.
 *
 * Storing that object makes an UNSPENDABLE note: every spend path recomputes the
 * commitment as Poseidon(value, assetId, BabyPbk(spendingKey).Ax, blinding) and
 * gets something other than the on-chain commitment, so the note is rejected.
 * Only a full rescan repaired it, since an incremental pass merges without
 * touching cryptographic fields.
 *
 * The recovery is the same work the scan does: decrypt the memo the wallet
 * authored with its GLOBAL keys, which re-derives the stealth spending key and
 * the real nullifier. Doing it at build time makes the note spendable
 * immediately instead of after a rescan.
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
