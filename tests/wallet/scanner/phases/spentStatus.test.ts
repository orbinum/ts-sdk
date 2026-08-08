/**
 * Phase 2 — which nullifiers to ask about, and what happens when the answer
 * cannot be obtained.
 *
 * Two behaviours carry real weight. `collectNullifiersToQuery` decides the query
 * set, and it must include vault notes whose memo did NOT decrypt this pass —
 * those were not re-scanned but may well have been spent, and omitting them
 * leaves a spent note showing as spendable. `resolveSpentStatus` decides what a
 * feed failure means, and the only safe answer is "unknown": marking notes spent
 * on a network error would hide funds the wallet still owns.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    collectNullifiersToQuery,
    resolveSpentStatus,
} from '../../../../src/wallet/scanner/phases/spentStatus';
import { MemoryVaultStorage } from '../../../../src/index';
import { scanAbortError } from '../../../../src/foundation/errors/abort';
import type { NullifierSource } from '../../../../src/wallet/scanner/feed/sources';
import type { ZkNote } from '../../../../src/protocol/types';

const note = (over: Partial<ZkNote> = {}): ZkNote =>
    ({
        commitmentHex: '0xc1',
        nullifierHex: '0xN1',
        value: 100n,
        spent: false,
        ...over,
    }) as ZkNote;

describe('collectNullifiersToQuery', () => {
    it('includes every note scanned this pass', () => {
        const entries = [{ note: note({ nullifierHex: '0xaa' }) }];

        expect([...collectNullifiersToQuery(entries, new Set(), [])]).toEqual(['0xaa']);
    });

    it('lowercases, since the set is intersected by exact match', () => {
        const entries = [{ note: note({ nullifierHex: '0xABCDEF' }) }];

        expect([...collectNullifiersToQuery(entries, new Set(), [])]).toEqual(['0xabcdef']);
    });

    it('includes a vault note that is on-chain but did not decrypt this pass', () => {
        // The case this exists for: the memo failed, so the note was not
        // re-scanned — but it is confirmed on-chain and may have been spent.
        const vaultNote = note({ commitmentHex: '0xc9', nullifierHex: '0xn9' });

        const queried = collectNullifiersToQuery([], new Set(['0xc9']), [vaultNote]);

        expect([...queried]).toEqual(['0xn9']);
    });

    it('skips a vault note absent from the on-chain set', () => {
        // Not confirmed in this window — the ghost purge handles it, and asking
        // about it would only widen the query set.
        const vaultNote = note({ commitmentHex: '0xc9', nullifierHex: '0xn9' });

        expect(collectNullifiersToQuery([], new Set(), [vaultNote]).size).toBe(0);
    });

    it('does not ask twice about a note that was also scanned', () => {
        const scanned = note({ commitmentHex: '0xc1', nullifierHex: '0xn1' });

        const queried = collectNullifiersToQuery([{ note: scanned }], new Set(['0xc1']), [scanned]);

        expect(queried.size).toBe(1);
    });

    it('skips a vault note with no nullifier', () => {
        const broken = note({ commitmentHex: '0xc9', nullifierHex: '' });

        expect(collectNullifiersToQuery([], new Set(['0xc9']), [broken]).size).toBe(0);
    });

    it('is empty when nothing was scanned and nothing is on-chain', () => {
        expect(collectNullifiersToQuery([], new Set(), []).size).toBe(0);
    });
});

describe('resolveSpentStatus', () => {
    const source = (over: Partial<NullifierSource> = {}): NullifierSource => ({
        manifest: vi.fn().mockResolvedValue({ generation: 'g1', chunks: [] }),
        chunk: vi.fn(),
        tail: vi.fn().mockResolvedValue({ data: [], afterChunks: 0 }),
        ...over,
    });

    it('does not touch the feed when there is nothing to ask about', async () => {
        // A wallet with no notes must not produce a request at all — an empty
        // scan should be indistinguishable from no scan to whoever serves it.
        const feed = source();

        const spent = await resolveSpentStatus({
            source: feed,
            cache: new MemoryVaultStorage(),
            nullifiers: new Set(),
        });

        expect(spent.size).toBe(0);
        expect(feed.manifest).not.toHaveBeenCalled();
    });

    it('returns the spent members found in the tail', async () => {
        const feed = source({
            tail: vi.fn().mockResolvedValue({
                data: ['0xn1'],
                timestampsMs: [111],
                txHashes: ['0xtx'],
                afterChunks: 0,
            }),
        });

        const spent = await resolveSpentStatus({
            source: feed,
            cache: new MemoryVaultStorage(),
            nullifiers: new Set(['0xn1', '0xn2']),
        });

        expect(spent.get('0xn1')).toEqual({ spentAt: 111, txHash: '0xtx' });
        expect(spent.has('0xn2')).toBe(false);
    });

    it('degrades to unknown when the feed fails, leaving notes unspent', async () => {
        // Never the other way round: reporting spent on a network error would
        // hide funds the wallet still holds.
        const onWarning = vi.fn();

        const spent = await resolveSpentStatus({
            source: source({ manifest: vi.fn().mockRejectedValue(new Error('feed down')) }),
            cache: new MemoryVaultStorage(),
            nullifiers: new Set(['0xn1']),
            onWarning,
        });

        expect(spent.size).toBe(0);
        expect(onWarning).toHaveBeenCalledOnce();
        expect(onWarning.mock.calls[0]?.[0]).toMatch(/spent status left unverified/);
    });

    it('propagates an abort instead of swallowing it as a feed failure', async () => {
        // An aborted scan must stop, not quietly continue with empty results.
        await expect(
            resolveSpentStatus({
                source: source({ manifest: vi.fn().mockRejectedValue(scanAbortError()) }),
                cache: new MemoryVaultStorage(),
                nullifiers: new Set(['0xn1']),
            })
        ).rejects.toThrow(/Scan aborted/);
    });

    it('never asks the feed about one specific nullifier', async () => {
        // The privacy property of the whole phase: the request the server sees
        // must not depend on what the wallet holds.
        const feed = source();

        await resolveSpentStatus({
            source: feed,
            cache: new MemoryVaultStorage(),
            nullifiers: new Set(['0xsecret']),
        });

        const allArgs = [
            ...(feed.manifest as ReturnType<typeof vi.fn>).mock.calls,
            ...(feed.tail as ReturnType<typeof vi.fn>).mock.calls,
            ...(feed.chunk as ReturnType<typeof vi.fn>).mock.calls,
        ].flat();
        expect(JSON.stringify(allArgs)).not.toContain('0xsecret');
    });
});
