/**
 * Attacks on the counter merge.
 *
 * `mergeCounters` is the OTHER writer of the ephemeral counters — every
 * `writeConfig` goes through it, so unlock and vault rebuild both do. Its job
 * is monotonicity: take the higher of two values so a counter never moves
 * backwards, because a counter that moves backwards re-derives an index that is
 * already published on chain.
 *
 * `Math.max` does not hold that property against hostile input. `Math.max(NaN,
 * 5)` is `NaN`, so one corrupt side does not lose the comparison — it POISONS
 * it, and the result is then persisted as the wallet's counter. That turns a
 * bad value on one side into a bad value on both, which is worse than either.
 *
 * The corrupt side is realistic: the fallback is a snapshot a caller passes in,
 * and the stored side comes back from whatever JSON was on disk.
 */
import { describe, it, expect } from 'vitest';
import { mergeCounters } from '../../../../src/wallet/vault/storage/config';
import type { VaultConfigRecord } from '../../../../src/wallet/vault/storage/contract';

type Parties = NonNullable<VaultConfigRecord['pairwiseCounterparties']>;

const parties = (nextIndex: unknown, addedAt = 100): Parties =>
    ({ '0xaabb': { nextIndex, addedAt } }) as unknown as Parties;

describe('a corrupt side cannot poison the merged counter', () => {
    it('keeps the good self counter when the other side is not finite', () => {
        // THE POISON. Math.max(NaN, 9) is NaN, so without a guard the corrupt
        // side wins and the wallet persists NaN as its counter.
        for (const bad of [NaN, Infinity, -Infinity]) {
            const fromStored = mergeCounters(
                { createdAt: 1, selfEphCounter: bad as number },
                { createdAt: 1, selfEphCounter: 9 }
            );
            const fromFallback = mergeCounters(
                { createdAt: 1, selfEphCounter: 9 },
                { createdAt: 1, selfEphCounter: bad as number }
            );

            expect(fromStored.selfEphCounter).toBe(9);
            expect(fromFallback.selfEphCounter).toBe(9);
        }
    });

    it('never merges a non-finite self counter into the result', () => {
        // Both sides corrupt: there is no good value to keep, so the counter
        // must be dropped rather than persisted as garbage. A dropped counter
        // restarts the sequence, which is the same repair `reserveSelfEphIndex`
        // applies — safe, because a corrupt counter means the published history
        // is unknown either way.
        const merged = mergeCounters(
            { createdAt: 1, selfEphCounter: NaN },
            { createdAt: 1, selfEphCounter: Infinity }
        );

        expect(merged.selfEphCounter === undefined || Number.isFinite(merged.selfEphCounter)).toBe(
            true
        );
    });

    it('ignores a non-numeric self counter instead of comparing against it', () => {
        // `Math.max('50', 9)` is 50 — a string side can WIN the comparison and
        // land in the config as a number that was never reserved.
        const merged = mergeCounters(
            { createdAt: 1, selfEphCounter: '50' as unknown as number },
            { createdAt: 1, selfEphCounter: 9 }
        );

        expect(merged.selfEphCounter).toBe(9);
    });

    it('keeps the good pairwise index when the other side is corrupt', () => {
        // Same poison, one level deeper: this one decides which ephemeral a
        // payment to that counterparty publishes.
        for (const bad of [NaN, Infinity, '50', null, undefined]) {
            const merged = mergeCounters(
                { createdAt: 1, pairwiseCounterparties: parties(bad) },
                { createdAt: 1, pairwiseCounterparties: parties(9) }
            );

            expect(merged.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(9);
        }
    });

    it('never merges a non-finite pairwise index into the result', () => {
        const merged = mergeCounters(
            { createdAt: 1, pairwiseCounterparties: parties(NaN) },
            { createdAt: 1, pairwiseCounterparties: parties(NaN) }
        );

        const entry = merged.pairwiseCounterparties?.['0xaabb'];
        expect(entry === undefined || Number.isFinite(entry.nextIndex)).toBe(true);
    });

    it('does not let a corrupt addedAt poison the earlier stamp', () => {
        // `Math.min(NaN, 100)` is NaN too. Less severe — addedAt is metadata,
        // not an index — but it is persisted and read back all the same.
        const merged = mergeCounters(
            { createdAt: 1, pairwiseCounterparties: parties(5, NaN) },
            { createdAt: 1, pairwiseCounterparties: parties(9, 100) }
        );

        const entry = merged.pairwiseCounterparties?.['0xaabb'];
        expect(Number.isFinite(entry?.addedAt)).toBe(true);
    });

    it('survives an entry that is not an object at all', () => {
        // A hand-edited backup can put anything under a counterparty key.
        for (const bad of [null, 5, 'nope', []]) {
            const merged = mergeCounters(
                { createdAt: 1, pairwiseCounterparties: { '0xaabb': bad } as unknown as Parties },
                { createdAt: 1, pairwiseCounterparties: parties(9) }
            );

            const entry = merged.pairwiseCounterparties?.['0xaabb'];
            expect(entry === undefined || Number.isFinite(entry.nextIndex)).toBe(true);
        }
    });

    it('still takes the higher of two valid counters', () => {
        // The guards must not break the property the function exists for.
        const merged = mergeCounters(
            { createdAt: 1, selfEphCounter: 2, pairwiseCounterparties: parties(2, 500) },
            { createdAt: 1, selfEphCounter: 9, pairwiseCounterparties: parties(9, 100) }
        );

        expect(merged.selfEphCounter).toBe(9);
        expect(merged.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(9);
        expect(merged.pairwiseCounterparties?.['0xaabb']?.addedAt).toBe(100);
    });
});
