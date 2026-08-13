/**
 * mergeProvenance — what a rescan is allowed to overwrite.
 *
 * The failure this guards against is silent and unrecoverable: reconstruction
 * runs after every scan over records the wallet wrote itself, and a payment
 * slip is cheap to re-issue, but the amount and recipient are not. Losing them
 * loses it for good.
 */
import { describe, it, expect } from 'vitest';
import { mergeProvenance, outranks } from '../../../src/wallet/provenance/index';
import type { NoteProvenanceRecord } from '../../../src/wallet/provenance/index';

function record(over: Partial<NoteProvenanceRecord> = {}): NoteProvenanceRecord {
    return {
        id: '0xtx',
        hash: '0xtx',
        blockNumber: 100,
        timestampMs: 1_000,
        direction: 'out',
        kind: 'private_transfer',
        origin: 'transfer-change',
        source: 'inferred',
        peer: { pk: 0xabcn, scope: 'stealth' },
        amount: { value: 500n, exact: false },
        assetId: 0n,
        status: 'success',
        ...over,
    };
}

describe('outranks', () => {
    it('ranks witnessed above every recovered source', () => {
        expect(outranks('witnessed', 'memo')).toBe(true);
        expect(outranks('witnessed', 'chain')).toBe(true);
        expect(outranks('witnessed', 'inferred')).toBe(true);
    });

    it('ranks a decrypted fact above a public lookup, and both above arithmetic', () => {
        expect(outranks('memo', 'chain')).toBe(true);
        expect(outranks('memo', 'inferred')).toBe(true);
        expect(outranks('chain', 'inferred')).toBe(true);
    });

    it('is strict — an equal source does not outrank itself', () => {
        expect(outranks('memo', 'memo')).toBe(false);
    });
});

describe('mergeProvenance', () => {
    it('a stronger incoming record replaces a weaker one', () => {
        const existing = record({ source: 'inferred', amount: { value: 500n, exact: false } });
        const incoming = record({ source: 'memo', amount: { value: 512n, exact: true } });

        const merged = mergeProvenance(existing, incoming);

        expect(merged.source).toBe('memo');
        expect(merged.amount).toEqual({ value: 512n, exact: true });
    });

    it('a weaker incoming record never overwrites what the wallet witnessed', () => {
        const witnessed = record({ source: 'witnessed', amount: { value: 512n, exact: true } });
        const backfill = record({ source: 'inferred', amount: { value: 500n, exact: false } });

        const merged = mergeProvenance(witnessed, backfill);

        expect(merged.source).toBe('witnessed');
        expect(merged.amount).toEqual({ value: 512n, exact: true });
    });

    it('KEEPS a payment slip a backfill knows nothing about', () => {
        // The regression that motivates this function: a slip is sealed toward
        // the recipient; the local record is the only one carrying the amount.
        const witnessed = record({ source: 'witnessed', slip: { encoded: 'orbslip1:abc' } });
        const backfill = record({ source: 'inferred' });

        expect(mergeProvenance(witnessed, backfill).slip).toEqual({ encoded: 'orbslip1:abc' });
    });

    it('keeps the slip even when the INCOMING record is the stronger one', () => {
        // Rank decides the facts; absence never overwrites presence.
        const existing = record({ source: 'inferred', slip: { encoded: 'orbslip1:abc' } });
        const stronger = record({ source: 'memo' });

        const merged = mergeProvenance(existing, stronger);

        expect(merged.source).toBe('memo');
        expect(merged.slip).toEqual({ encoded: 'orbslip1:abc' });
    });

    it('fills a gap the winner left — fee, public recipient, note facts', () => {
        const existing = record({
            source: 'inferred',
            feePlanck: 42n,
            publicRecipient: '5Grwva',
        });
        const stronger = record({ source: 'memo' });

        const merged = mergeProvenance(existing, stronger);

        expect(merged.feePlanck).toBe(42n);
        expect(merged.publicRecipient).toBe('5Grwva');
    });

    it('backfills an unknown peer — the whole point of re-running reconstruction', () => {
        const existing = record({ source: 'witnessed', peer: null });
        const backfill = record({ source: 'inferred', peer: { pk: 0xdefn, scope: 'stealth' } });

        expect(mergeProvenance(existing, backfill).peer).toEqual({ pk: 0xdefn, scope: 'stealth' });
    });

    it('omits absent optionals instead of writing undefined into them', () => {
        // exactOptionalPropertyTypes: an explicit `undefined` would make "no fee
        // recovered" indistinguishable from "the fee is undefined".
        const merged = mergeProvenance(record(), record({ source: 'memo' }));

        expect('feePlanck' in merged).toBe(false);
        expect('slip' in merged).toBe(false);
        expect('note' in merged).toBe(false);
    });
});
