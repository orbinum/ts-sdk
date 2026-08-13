import { describe, it, expect } from 'vitest';
import type { ZkNote } from '../../../../src/protocol/types';
import {
    noteOrigin,
    noteCreatedAt,
    stampCreatedAt,
    ensureCreatedAt,
    noteCreatedTxHash,
    noteSpentTxHash,
    noteTxKind,
    stampCreatedTxHash,
    stampSpentTxHash,
    stampOrigin,
} from '../../../../src/wallet/vault/notes/meta';

const note = (over: Partial<ZkNote>): ZkNote => ({ sourcePk: 0n, ...over }) as ZkNote;

describe('noteMeta', () => {
    it('origin: a stamped note reports exactly what produced it', () => {
        expect(noteOrigin(stampOrigin(note({}), 'unshield-change'))).toBe('unshield-change');
        expect(noteOrigin(stampOrigin(note({}), 'fee-claim'))).toBe('fee-claim');
        expect(noteOrigin(stampOrigin(note({}), 'transfer-change'))).toBe('transfer-change');
    });

    it('origin: an unshield-change note is NOT reported as a shield deposit', () => {
        // The bug this field removes: both carry sourcePk = 0n, so the old
        // inference called an unshield's change (and a claimed fee) a "Shield".
        const unshieldChange = stampOrigin(note({ sourcePk: 0n }), 'unshield-change');
        const feeClaim = stampOrigin(note({ sourcePk: 0n }), 'fee-claim');

        expect(noteOrigin(unshieldChange)).not.toBe('shield');
        expect(noteOrigin(feeClaim)).not.toBe('shield');
    });

    it('origin: falls back to inference for notes stamped before the field existed', () => {
        expect(noteOrigin(note({ sourcePk: 0n }))).toBe('shield');
        expect(noteOrigin(note({ sourcePk: 123n }))).toBe('transfer-in');
    });

    it('origin: a stamped value always wins over what inference would say', () => {
        // sourcePk is zero here, so inference would answer 'shield'.
        expect(noteOrigin(stampOrigin(note({ sourcePk: 0n }), 'fee-claim'))).toBe('fee-claim');
    });

    it('origin: survives a spread, like the other meta fields', () => {
        const stamped = stampOrigin(note({}), 'transfer-change');
        expect(noteOrigin({ ...stamped })).toBe('transfer-change');
    });

    it('createdAt: absent → null, stamped → value, survives spread', () => {
        expect(noteCreatedAt(note({}))).toBeNull();
        const stamped = stampCreatedAt(note({}), 1_700_000_000_000);
        expect(noteCreatedAt(stamped)).toBe(1_700_000_000_000);
        expect(noteCreatedAt({ ...stamped })).toBe(1_700_000_000_000);
        expect(noteCreatedAt(stampCreatedAt(note({}), null))).toBeNull();
    });

    it('ensureCreatedAt: stamps only never-stamped notes; explicit null is preserved', () => {
        // undefined → local creation that bypassed buildZkNote → stamp now.
        expect(noteCreatedAt(ensureCreatedAt(note({})))).toBeTypeOf('number');
        // Explicit null → scan said "chain timestamp unknown" → never invent a date.
        expect(noteCreatedAt(ensureCreatedAt(stampCreatedAt(note({}), null)))).toBeNull();
        // Already stamped → untouched.
        const stamped = stampCreatedAt(note({}), 123);
        expect(ensureCreatedAt(stamped)).toBe(stamped);
    });

    it('createdTxHash: absent → null; stamped → value + kind, survives spread', () => {
        expect(noteCreatedTxHash(note({}))).toBeNull();
        expect(noteTxKind(note({}))).toBe('substrate');

        const stamped = stampCreatedTxHash(note({}), '0xdead', 'evm');
        expect(noteCreatedTxHash(stamped)).toBe('0xdead');
        expect(noteTxKind(stamped)).toBe('evm');
        // Round-trips through the JSON spread the vault does on encrypt.
        expect(noteCreatedTxHash({ ...stamped })).toBe('0xdead');
    });

    it('createdTxHash: an empty/absent hash is dropped, not stored as a dead link', () => {
        const n = note({});
        expect(stampCreatedTxHash(n, '')).toBe(n);
        expect(stampCreatedTxHash(n, null)).toBe(n);
        expect(stampCreatedTxHash(n, undefined)).toBe(n);
    });

    it('spentTxHash: stamps once, then is fill-only (a rescan never clobbers it)', () => {
        expect(noteSpentTxHash(note({}))).toBeNull();

        const local = stampSpentTxHash(note({}), '0xlocal', 'evm');
        expect(noteSpentTxHash(local)).toBe('0xlocal');
        expect(noteTxKind(local)).toBe('evm');

        // Already stamped → a later (substrate) stamp is a no-op, keeping the
        // authoritative local hash and its route.
        const again = stampSpentTxHash(local, '0xfromscan');
        expect(again).toBe(local);
        expect(noteSpentTxHash(again)).toBe('0xlocal');
        expect(noteTxKind(again)).toBe('evm');
    });

    it('spentTxHash: an empty/absent hash is dropped', () => {
        const n = note({});
        expect(stampSpentTxHash(n, '')).toBe(n);
        expect(stampSpentTxHash(n, null)).toBe(n);
    });
});
