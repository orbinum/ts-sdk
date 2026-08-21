/**
 * Reconstruct a note from a payment slip, without scanning the pool.
 *
 * An `orbslip1:` string carries the note's public locators — commitment,
 * encrypted memo, leaf index. Those feed the SAME path a scan uses
 * (`tryDecryptNote`), which opens the memo, derives the stealth spending key
 * and verifies the commitment. Out comes a fully spendable `ZkNote`.
 */
import type { ZkNote, ScanCommitment } from '../../../protocol/types';
import { tryDecryptNote } from '../../../protocol/note/NoteDecryptor';
import { assertSecretKeyBytes } from '../../../foundation/crypto/keyGuards';
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
    // The KEY throws; the SLIP returns null. A bad slip is untrusted input and
    // "not mine" answers it — but a bad viewing key is a wiring bug, and the
    // same null would report "no slip is yours" for every slip ever opened.
    assertSecretKeyBytes(keys.viewingSecretKey, 'importPaymentSlip: viewingSecretKey');

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

    // Origin tx, so the note does not show a blank "created tx". Informational.
    return fields.txHash ? stampCreatedTxHash(note, fields.txHash) : note;
}
