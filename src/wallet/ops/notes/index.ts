/**
 * Creating notes and moving them between a user's own devices.
 *
 * No chain access: everything here is offline note construction. The one
 * decision that matters is which ephemeral a new note publishes, because that
 * decides how — and how cheaply — it is found again later.
 */
export { buildZkNote } from './buildNote';
export type { BuildNoteParams, BuildNoteDeps, NoteBuildKeys } from './buildNote';
export { recoverSelfStealthNote } from './selfStealthNote';
export type { SelfStealthKeys } from './selfStealthNote';
export {
    encodeNoteTransferPages,
    decodeNoteTransferPage,
    assembleNoteTransfer,
    noteToTransferEntry,
    NOTE_TRANSFER_URI_SCHEME,
    QR_PAGE_MAX_CHARS,
} from './noteTransfer';
export type { NoteTransferEntry, NoteTransferPayload } from './noteTransfer';
export {
    encodeNoteBackup,
    decodeNoteBackup,
    importNotesFromBackup,
    NOTE_BACKUP_VERSION,
} from './noteBackup';
export type { NoteBackup, NoteBackupEntry, BackupImportKeys } from './noteBackup';
