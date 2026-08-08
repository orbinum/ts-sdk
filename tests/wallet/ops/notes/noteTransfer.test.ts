/**
 * The `orbinum://notes/v1/` wire format.
 *
 * This is a cross-client contract — desktop encodes, mobile decodes, and they
 * ship separately. The round-trip test is what keeps the two halves honest; the
 * field-name test is what makes a rename a build failure instead of a silent
 * break in someone's already-installed scanner.
 */
import { describe, it, expect } from 'vitest';
import {
    encodeNoteTransferPages,
    decodeNoteTransferPage,
    assembleNoteTransfer,
    noteToTransferEntry,
    NOTE_TRANSFER_URI_SCHEME,
} from '../../../../src/wallet/ops/notes/noteTransfer';
import { base64UrlEncode, base64UrlDecode } from '../../../../src/foundation/encoding/base64url';
import type { ZkNote } from '../../../../src/protocol/types';

const note = (over: Partial<ZkNote> = {}): ZkNote =>
    ({
        commitmentHex: '0xc1',
        nullifierHex: '0xn1',
        value: 500n,
        assetId: 0n,
        ownerPk: 0xabcn,
        blinding: 7n,
        spendingKey: 42n,
        ...over,
    }) as ZkNote;

describe('base64url', () => {
    it.each(['', 'a', 'ab', 'abc', 'abcd', '{"v":1,"notes":[]}', 'ñ→🙂'])(
        'round-trips %j',
        (input) => {
            expect(base64UrlDecode(base64UrlEncode(input))).toBe(input);
        }
    );

    it('emits no URI-unsafe characters', () => {
        // The payload travels inside a URI; +, / or = would need escaping and a
        // scanner that failed to unescape would decode garbage.
        const encoded = base64UrlEncode(JSON.stringify({ notes: Array(50).fill('0xff') }));

        expect(encoded).not.toMatch(/[+/=]/);
    });

    it('rejects a character outside the alphabet', () => {
        expect(() => base64UrlDecode('abc!')).toThrow(/Invalid base64url/);
    });
});

describe('noteToTransferEntry', () => {
    it('zero-pads scalars to 64 chars so every encoder agrees', () => {
        const entry = noteToTransferEntry(note());

        expect(entry.opk).toBe('0x' + 'abc'.padStart(64, '0'));
        expect(entry.bld).toHaveLength(66);
        expect(entry.sk).toHaveLength(66);
    });

    it('keeps the frozen field names', () => {
        // Renaming any of these breaks every deployed scanner. The test exists
        // to make that a build failure rather than a field report.
        expect(Object.keys(noteToTransferEntry(note())).sort()).toEqual([
            'aid',
            'bld',
            'c',
            'n',
            'opk',
            'sk',
            'val',
        ]);
    });
});

describe('encode → decode round trip', () => {
    it('recovers every note through the full pipeline', () => {
        const notes = [note({ commitmentHex: '0xa' }), note({ commitmentHex: '0xb', value: 7n })];

        const pages = encodeNoteTransferPages(notes, { now: () => 1_700_000_000_000 });
        const decoded = pages.map(decodeNoteTransferPage);
        const entries = assembleNoteTransfer(decoded);

        expect(entries).toEqual(notes.map(noteToTransferEntry));
    });

    it('stamps the scheme and version on every page', () => {
        const pages = encodeNoteTransferPages([note()], { now: () => 0 });

        expect(pages[0]!.startsWith(NOTE_TRANSFER_URI_SCHEME)).toBe(true);
        expect(decodeNoteTransferPage(pages[0]!).v).toBe(1);
    });

    it('splits into pages when the notes exceed the size budget', () => {
        const notes = Array.from({ length: 40 }, (_, i) => note({ commitmentHex: `0xc${i}` }));

        const pages = encodeNoteTransferPages(notes, { now: () => 0, maxChars: 600 });

        expect(pages.length).toBeGreaterThan(1);
        // Every note survives the split.
        expect(assembleNoteTransfer(pages.map(decodeNoteTransferPage))).toHaveLength(40);
    });

    it('numbers pages consistently so a scanner can track progress', () => {
        const notes = Array.from({ length: 20 }, (_, i) => note({ commitmentHex: `0xc${i}` }));

        const decoded = encodeNoteTransferPages(notes, { now: () => 0, maxChars: 600 }).map(
            decodeNoteTransferPage
        );

        expect(decoded.map((p) => p.p)).toEqual(decoded.map((_, i) => i));
        expect(new Set(decoded.map((p) => p.pt))).toEqual(new Set([decoded.length]));
    });

    it('never drops a note that alone exceeds the budget', () => {
        // A single oversized entry has to ship on its own page rather than be
        // silently discarded — losing a note here loses the funds.
        const pages = encodeNoteTransferPages([note()], { now: () => 0, maxChars: 1 });

        expect(assembleNoteTransfer(pages.map(decodeNoteTransferPage))).toHaveLength(1);
    });
});

describe('decodeNoteTransferPage — rejects bad input', () => {
    it('rejects a foreign URI', () => {
        expect(() => decodeNoteTransferPage('https://example.com/x')).toThrow(/Not an Orbinum/);
    });

    it('rejects corrupt payload bytes', () => {
        expect(() => decodeNoteTransferPage(NOTE_TRANSFER_URI_SCHEME + 'notbase64!!')).toThrow(
            /corrupt/
        );
    });

    it('rejects an unsupported version instead of guessing', () => {
        const payload = base64UrlEncode(JSON.stringify({ v: 2, ts: 0, p: 0, pt: 1, notes: [] }));

        expect(() => decodeNoteTransferPage(NOTE_TRANSFER_URI_SCHEME + payload)).toThrow(
            /Unsupported note-transfer version/
        );
    });

    it('rejects an entry missing a field rather than importing a broken note', () => {
        // A note without its spending key is unspendable; a failed scan the user
        // can retry beats a vault entry that silently cannot move.
        const payload = base64UrlEncode(
            JSON.stringify({ v: 1, ts: 0, p: 0, pt: 1, notes: [{ c: '0xa' }] })
        );

        expect(() => decodeNoteTransferPage(NOTE_TRANSFER_URI_SCHEME + payload)).toThrow(
            /missing required fields/
        );
    });
});

describe('assembleNoteTransfer', () => {
    const pagesOf = (notes: ZkNote[], maxChars: number) =>
        encodeNoteTransferPages(notes, { now: () => 0, maxChars }).map(decodeNoteTransferPage);

    it('reorders pages scanned out of sequence', () => {
        const notes = Array.from({ length: 20 }, (_, i) => note({ commitmentHex: `0xc${i}` }));
        const pages = pagesOf(notes, 600);

        const entries = assembleNoteTransfer([...pages].reverse());

        expect(entries).toEqual(notes.map(noteToTransferEntry));
    });

    it('refuses an incomplete batch and names what is missing', () => {
        // A partial import looks like a successful one — the user would never
        // learn which notes never arrived.
        const notes = Array.from({ length: 20 }, (_, i) => note({ commitmentHex: `0xc${i}` }));
        const pages = pagesOf(notes, 600);

        expect(() => assembleNoteTransfer(pages.slice(1))).toThrow(/Missing page/);
    });

    it('refuses pages from different batches', () => {
        const a = pagesOf([note({ commitmentHex: '0xa' })], 2_000);
        const b = pagesOf(
            Array.from({ length: 20 }, (_, i) => note({ commitmentHex: `0xb${i}` })),
            600
        );

        expect(() => assembleNoteTransfer([a[0]!, b[0]!])).toThrow(/different batches/);
    });

    it('refuses an empty scan', () => {
        expect(() => assembleNoteTransfer([])).toThrow(/No pages/);
    });
});
