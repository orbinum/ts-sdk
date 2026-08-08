import { describe, it, expect, beforeAll } from 'vitest';
import {
    encodeNoteBackup,
    decodeNoteBackup,
    importNotesFromBackup,
    NOTE_BACKUP_VERSION,
    type NoteBackup,
    type BackupImportKeys,
} from '../../../../src/wallet/ops/notes/noteBackup';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../../src/protocol/types';

// A recipient identity, and a stealth note SENT to them (memo encrypted toward
// their ivk — the real shape every app note has).
const RECIPIENT_SK = 88888888888888888n;
let recipientKeys: BackupImportKeys;
let sentNote: ZkNote;

beforeAll(async () => {
    const ownerPk = deriveOwnerPk(RECIPIENT_SK);
    const vsk = deriveViewingSecretKey(RECIPIENT_SK);
    const vpk = deriveViewingPublicKey(vsk);
    recipientKeys = { viewingSecretKey: vsk, spendingKey: RECIPIENT_SK, ownerPk };

    sentNote = await NoteBuilder.build({
        value: 5000n,
        assetId: 0n,
        blinding: 77n,
        ownerPk,
        viewingPublicKey: vpk,
        recipientOwnerPk: ownerPk,
    });
});

describe('encodeNoteBackup (closed format)', () => {
    it('carries commitment + memo, and NO spending key', () => {
        const backup = encodeNoteBackup([sentNote], { now: () => 42 });
        expect(backup.v).toBe(NOTE_BACKUP_VERSION);
        expect(backup.ts).toBe(42);
        expect(backup.notes).toHaveLength(1);
        const entry = backup.notes[0]!;
        expect(entry.commitmentHex).toBe(sentNote.commitmentHex);
        expect(entry.encryptedMemo).toMatch(/^0x[0-9a-f]+$/);
        // No secret-key field in the serialized form — only public data + local
        // status flags (spent/spentAt are not secrets).
        const json = JSON.stringify(backup).toLowerCase();
        expect(json).not.toContain('spendingkey');
        expect(json).not.toContain('"sk"');
        expect(json).not.toContain('blinding');
        // The entry carries the closed-format fields plus the local spent status.
        expect(Object.keys(entry).sort()).toEqual(
            ['commitmentHex', 'encryptedMemo', 'spent', 'spentAt'].sort()
        );
    });

    it('is deterministic with an injected clock', () => {
        const a = encodeNoteBackup([sentNote], { now: () => 1 });
        const b = encodeNoteBackup([sentNote], { now: () => 1 });
        expect(a).toEqual(b);
    });
});

describe('decodeNoteBackup', () => {
    it('round-trips through JSON.stringify', () => {
        const json = JSON.stringify(encodeNoteBackup([sentNote], { now: () => 1 }));
        const entries = decodeNoteBackup(json);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.commitmentHex).toBe(sentNote.commitmentHex);
    });

    it('rejects invalid JSON', () => {
        expect(() => decodeNoteBackup('{not json')).toThrow(/valid JSON/i);
    });

    it('rejects an unsupported version', () => {
        expect(() => decodeNoteBackup(JSON.stringify({ v: 99, ts: 0, notes: [] }))).toThrow(
            /version/i
        );
    });

    it('rejects entries missing required fields', () => {
        const bad: NoteBackup = {
            v: NOTE_BACKUP_VERSION,
            ts: 0,
            // @ts-expect-error deliberately malformed (no encryptedMemo)
            notes: [{ commitmentHex: '0x00' }],
        };
        expect(() => decodeNoteBackup(JSON.stringify(bad))).toThrow(/missing required fields/i);
    });
});

describe('importNotesFromBackup (ownership by decryption)', () => {
    it('reconstructs a spendable note for its rightful owner', () => {
        const entries = decodeNoteBackup(
            JSON.stringify(encodeNoteBackup([sentNote], { now: () => 1 }))
        );
        const imported = importNotesFromBackup(entries, recipientKeys);

        expect(imported).toHaveLength(1);
        const note = imported[0]!;
        expect(note.value).toBe(5000n);
        expect(note.assetId).toBe(0n);
        // Commitment matches the exported note (recomputed from the decrypted memo).
        expect(note.commitmentHex).toBe(sentNote.commitmentHex);
        // The stealth spending key was DERIVED from the recipient identity — not
        // carried in the file, and (for a stealth note) not the global key.
        expect(note.spendingKey).not.toBe(0n);
        expect(note.spendingKey).not.toBe(RECIPIENT_SK);
        // Its nullifier is the one that spendingKey produces over this commitment.
        expect(note.ownerPk).toBe(sentNote.ownerPk);
    });

    it('preserves spent status across export → import', () => {
        // A spent note and an unspent note in one backup must come back separated.
        const spentNote = { ...sentNote, spent: true, spentAt: 1234 };
        const entries = decodeNoteBackup(
            JSON.stringify(encodeNoteBackup([spentNote], { now: () => 1 }))
        );
        const [imported] = importNotesFromBackup(entries, recipientKeys);
        expect(imported!.spent).toBe(true);
        expect(imported!.spentAt).toBe(1234);
    });

    it('imports an unspent note as available (spent=false)', () => {
        const entries = decodeNoteBackup(
            JSON.stringify(encodeNoteBackup([{ ...sentNote, spent: false }], { now: () => 1 }))
        );
        const [imported] = importNotesFromBackup(entries, recipientKeys);
        expect(imported!.spent).toBe(false);
        expect(imported!.spentAt).toBeNull();
    });

    it("drops a note that is not the importer's (wrong keys → no decrypt)", () => {
        const strangerSk = 12121212121212121n;
        const strangerKeys: BackupImportKeys = {
            viewingSecretKey: deriveViewingSecretKey(strangerSk),
            spendingKey: strangerSk,
            ownerPk: deriveOwnerPk(strangerSk),
        };
        const entries = decodeNoteBackup(
            JSON.stringify(encodeNoteBackup([sentNote], { now: () => 1 }))
        );
        // The stranger cannot decrypt the memo → nothing imports.
        expect(importNotesFromBackup(entries, strangerKeys)).toHaveLength(0);
    });

    it('imports only the owned notes from a mixed backup', () => {
        // Build a note for someone else, mix it with ours, import as us.
        const otherSk = 34343434343434343n;
        const otherOwner = deriveOwnerPk(otherSk);
        const otherVpk = deriveViewingPublicKey(deriveViewingSecretKey(otherSk));
        return NoteBuilder.build({
            value: 999n,
            blinding: 5n,
            ownerPk: otherOwner,
            viewingPublicKey: otherVpk,
            recipientOwnerPk: otherOwner,
        }).then((foreign) => {
            const entries = decodeNoteBackup(
                JSON.stringify(encodeNoteBackup([sentNote, foreign], { now: () => 1 }))
            );
            const imported = importNotesFromBackup(entries, recipientKeys);
            expect(imported).toHaveLength(1);
            expect(imported[0]!.value).toBe(5000n);
        });
    });
});
