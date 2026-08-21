/**
 * Creating notes, backing them up, and rebuilding them from a payment slip.
 *
 * No chain access — everything here is offline note construction. The decision
 * that matters is which ephemeral a new note publishes, because that decides
 * how, and how cheaply, it is found again later.
 *
 * Nothing here moves a spending key: a backup is JSON carrying only public
 * locators, and a slip is a string sealed toward one recipient.
 */
export { buildZkNote, buildZkNoteWithIndex } from './buildNote';
export type { BuildNoteParams, BuildNoteDeps, NoteBuildKeys } from './buildNote';
export { recoverSelfStealthNote } from './selfStealthNote';
export type { SelfStealthKeys } from './selfStealthNote';
export {
    encodeNoteBackup,
    decodeNoteBackup,
    importNotesFromBackup,
    NOTE_BACKUP_VERSION,
} from './noteBackup';
export type { NoteBackup, NoteBackupEntry, BackupImportKeys } from './noteBackup';
export { importPaymentSlip } from './paymentSlipImport';
export type { SlipImportKeys } from './paymentSlipImport';
