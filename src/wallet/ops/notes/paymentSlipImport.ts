/**
 * Reconstruct a note from a payment slip.
 *
 * The recipient of a private transfer receives an `orbslip1:` string (or the raw
 * envelope) that the sender produced. Opening it yields the note's public
 * locators — commitment, encrypted memo, leaf index — which are fed to the SAME
 * decryption path a scan uses (`tryDecryptNote`): it decrypts the memo with the
 * recipient's viewing key, derives the stealth spending key, and verifies the
 * commitment. The result is a fully spendable `ZkNote`, obtained without scanning
 * the pool.
 */
import type { ZkNote, ScanCommitment } from '../../../protocol/types';
import { tryDecryptNote } from '../../../protocol/note/NoteDecryptor';
import { stampCreatedTxHash } from '../../vault/notes/meta';
import {
    openPaymentSlip,
    decodePaymentSlip,
    type PaymentSlipFields,
} from '../../../protocol/memo/PaymentSlip';

/** Keys the recipient needs to open a slip and reconstruct the note. */
export interface SlipImportKeys {
    /** 32-byte viewing secret key (ivsk) — opens the slip envelope AND the memo. */
    viewingSecretKey: Uint8Array;
    /** Spending key scalar — derives the note's nullifier / stealth key. */
    spendingKey: bigint;
    /** The recipient's global owner pk (Ax), for stealth detection. */
    ownerPk: bigint;
}

/**
 * Open a slip and reconstruct its note, or null.
 *
 * Accepts an `orbslip1:` string or a raw envelope. Returns null when the slip is
 * not this recipient's (envelope does not decrypt), or when the memo does not
 * belong to them, or when the recomputed commitment does not match — the last
 * check (inside `tryDecryptNote`) is what stops a forged slip from planting a
 * phantom note. Never throws.
 */
export function importPaymentSlip(slip: string | Uint8Array, keys: SlipImportKeys): ZkNote | null {
    const envelope = typeof slip === 'string' ? decodePaymentSlip(slip) : slip;
    if (!envelope) return null;

    const fields: PaymentSlipFields | null = openPaymentSlip(keys.viewingSecretKey, envelope);
    if (!fields) return null;

    const commitment: ScanCommitment = {
        commitmentHex: fields.commitmentHex,
        leafIndex: fields.leafIndex ?? -1,
        encryptedMemo: fields.encryptedMemo,
    };
    // Same routine as a scan: decrypt the memo, derive the stealth spending key,
    // recompute and verify the commitment. A slip that lies fails here.
    const note = tryDecryptNote(commitment, keys.viewingSecretKey, keys.spendingKey, keys.ownerPk);
    if (!note) return null;

    // Stamp the creating tx hash from the slip so the note shows its origin
    // instead of a blank "created tx". Informational — default txKind substrate.
    return fields.txHash ? stampCreatedTxHash(note, fields.txHash) : note;
}
