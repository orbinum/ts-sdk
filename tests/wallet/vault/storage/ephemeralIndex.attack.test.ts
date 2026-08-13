/**
 * Attacks on the pairwise counter.
 *
 * The counter decides which ephemeral key a payment publishes, and publishing
 * one twice links two notes in public. So the question here is not "does the
 * happy path work" but "what input makes it hand back an index it already
 * used, or hand the same index to two callers".
 *
 * Two threat sources, and neither is a remote attacker:
 *
 *   - **the stored config**, which is attacker-influenced in the sense that it
 *     survives restores, migrations, backups and hand-editing, and comes back
 *     as whatever JSON was on disk;
 *   - **the counterparty's viewing key**, which is a string this wallet accepts
 *     from outside when someone hands over a privacy address.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    reservePairwiseIndex,
    reserveSelfEphIndex,
} from '../../../../src/wallet/vault/storage/ephemeralIndex';
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { buildConfig, mergeCounters } from '../../../../src/wallet/vault/storage/config';
import type { VaultConfigRecord } from '../../../../src/wallet/vault/storage/contract';

const IVK = '0xAABB';

let storage: MemoryVaultStorage;

beforeEach(async () => {
    storage = new MemoryVaultStorage();
    await storage.putConfig(buildConfig(null));
});

/** Write a counterparty entry directly, as a restore or migration would. */
async function seed(entry: unknown, key = '0xaabb'): Promise<void> {
    const config = (await storage.getConfig())!;
    (config.pairwiseCounterparties as Record<string, unknown>) = { [key]: entry };
    await storage.putConfig(config);
}

// ─── A corrupted stored counter must never yield a used index ────────────────

describe('a hostile stored counter', () => {
    it('treats a negative nextIndex as no history', () => {
        // Arithmetic on a negative counter would return a negative index, which
        // `derivePairwiseEphSk` feeds to a u32 DataView write — it wraps to a
        // huge index rather than throwing, so the note becomes unfindable by the
        // recipient's window instead of failing loudly.
        return seed({ nextIndex: -5, addedAt: 1 }).then(async () => {
            expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
        });
    });

    it('treats a fractional nextIndex as no history', async () => {
        // 2.5 would derive an ephSk from a non-integer index. The u32 write
        // truncates, so 2.5 and 2 produce the SAME ephPk — a silent collision.
        await seed({ nextIndex: 2.5, addedAt: 1 });
        expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
    });

    it('treats NaN and Infinity as no history', async () => {
        for (const bad of [NaN, Infinity, -Infinity]) {
            await seed({ nextIndex: bad, addedAt: 1 });
            expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
        }
    });

    it('treats a non-numeric nextIndex as no history', async () => {
        // JSON round-trips and hand-edited backups produce these.
        for (const bad of ['3', null, undefined, {}, [], true]) {
            await seed({ nextIndex: bad, addedAt: 1 });
            expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
        }
    });

    it('treats an entry that is not an object as no history', async () => {
        for (const bad of [null, 5, 'nope', []]) {
            await seed(bad);
            expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
        }
    });

    it('refuses an index past the safe-integer range instead of wrapping', async () => {
        // At 2^53 the +1 is a no-op: the counter stops advancing and every
        // later payment reuses the same index forever.
        await seed({ nextIndex: Number.MAX_SAFE_INTEGER, addedAt: 1 });
        const first = await reservePairwiseIndex(storage, IVK);
        const second = await reservePairwiseIndex(storage, IVK);

        expect(first === null || first !== second).toBe(true);
    });

    it('never returns the same index twice across a corrupted-then-repaired counter', async () => {
        // The composite case: a broken entry, then normal use. Whatever the
        // repair does, no index may be handed out twice.
        await seed({ nextIndex: -1, addedAt: 1 });
        const seen = new Set<number>();
        for (let i = 0; i < 10; i++) {
            const idx = await reservePairwiseIndex(storage, IVK);
            if (idx !== null) {
                expect(seen.has(idx)).toBe(false);
                seen.add(idx);
            }
        }
    });
});

// ─── The self counter has the same exposure, with no null to fall back on ────

describe('a hostile self counter', () => {
    async function seedSelf(value: unknown): Promise<void> {
        const config = (await storage.getConfig())!;
        (config as unknown as Record<string, unknown>)['selfEphCounter'] = value;
        await storage.putConfig(config);
    }

    it('restarts the sequence rather than deriving from a corrupt counter', async () => {
        // Every one of these corrupts an index silently rather than failing:
        // 2.5 truncates onto 2 on the u32 write, '3' + 1 concatenates to '31',
        // a negative wraps to a huge index outside the recipient's window.
        // The counter is repaired to a fresh sequence, so the index is 0 — a
        // value this wallet has NOT published, because a corrupt counter means
        // the published history is unknown either way.
        for (const bad of [2.5, NaN, Infinity, -1, '3', null, {}]) {
            await seedSelf(bad);
            expect(await reserveSelfEphIndex(storage)).toBe(0);
        }
    });

    it('a repaired counter counts up normally from there', async () => {
        await seedSelf('garbage');
        expect(await reserveSelfEphIndex(storage)).toBe(0);
        expect(await reserveSelfEphIndex(storage)).toBe(1);
        expect(await reserveSelfEphIndex(storage)).toBe(2);
    });

    it('refuses a counter past the u32 range the derivation writes', async () => {
        // deriveSelfEphSk writes the index as a u32. At 2^32 the value aliases
        // onto an index already used, so the counter is restarted instead.
        await seedSelf(0xffff_ffff);
        expect(await reserveSelfEphIndex(storage)).toBe(0);
    });

    it('a valid counter is never restarted', async () => {
        // The repair must not fire on good data: that would be the leak it
        // exists to prevent, reached by the fix itself.
        await seedSelf(7);
        expect(await reserveSelfEphIndex(storage)).toBe(7);
        expect(await reserveSelfEphIndex(storage)).toBe(8);
    });

    it('never hands out the same index twice under concurrency', async () => {
        const indexes = await Promise.all(
            Array.from({ length: 100 }, () => reserveSelfEphIndex(storage))
        );

        expect(new Set(indexes).size).toBe(100);
    });
});

// ─── The counterparty key comes from outside the wallet ──────────────────────

describe('a hostile counterparty key', () => {
    it('does not collide with Object.prototype keys', async () => {
        // `pairwiseCounterparties` is a plain object, so a counterparty whose
        // hex spells a prototype member would read a function instead of an
        // entry. `?.nextIndex` on that is undefined → treated as no history,
        // which is safe, but it must not throw or poison the map either.
        for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            expect(await reservePairwiseIndex(storage, key)).toBeNull();
        }
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('keeps prototype-named counterparties on their own counters', async () => {
        // Having established they are safe on the first call, they must also
        // count up independently rather than sharing one sequence.
        await reservePairwiseIndex(storage, 'constructor');
        await reservePairwiseIndex(storage, 'toString');

        expect(await reservePairwiseIndex(storage, 'constructor')).toBe(1);
        expect(await reservePairwiseIndex(storage, 'toString')).toBe(1);
    });

    it('treats keys differing only in case as one counterparty', async () => {
        // Two entries for one recipient would each start at index 0 and publish
        // the same ephPk twice — the leak, reached by a casing difference.
        await reservePairwiseIndex(storage, '0xAABB');
        await reservePairwiseIndex(storage, '0xaAbB');
        await reservePairwiseIndex(storage, '0xAAbb');

        const parties = (await storage.getConfig())?.pairwiseCounterparties ?? {};
        expect(Object.keys(parties)).toEqual(['0xaabb']);
        expect(parties['0xaabb']?.nextIndex).toBe(3);
    });

    it('never throws on an empty or absurd key', async () => {
        for (const key of ['', ' ', '0x', 'x'.repeat(100_000), '💥']) {
            await expect(reservePairwiseIndex(storage, key)).resolves.not.toThrow;
        }
    });
});

// ─── mergeCounters is the other writer, and it must not roll back ────────────

describe('merge cannot roll a counter backwards', () => {
    const parties = (
        n: number
    ): NonNullable<VaultConfigRecord['pairwiseCounterparties']> => ({
        '0xaabb': { nextIndex: n, addedAt: 100 },
    });

    it('keeps the higher index when a stale snapshot is merged in', async () => {
        const merged = mergeCounters(
            { createdAt: 1, pairwiseCounterparties: parties(9) },
            { createdAt: 1, pairwiseCounterparties: parties(2) }
        );

        expect(merged.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(9);
    });

    it('keeps the stored index when the snapshot has no entry at all', async () => {
        // A restore that dropped the entry must not erase a counter that is
        // still present in storage.
        const merged = mergeCounters(
            { createdAt: 1, pairwiseCounterparties: parties(9) },
            { createdAt: 1 }
        );

        expect(merged.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(9);
    });

    it('a merged-back counter resumes the sequence rather than restarting', async () => {
        // End to end: merge a surviving counter into the config, then reserve.
        // The next index must continue from 9, not from null.
        const config = (await storage.getConfig())!;
        config.pairwiseCounterparties = parties(9);
        await storage.putConfig(config);

        expect(await reservePairwiseIndex(storage, IVK)).toBe(9);
    });
});

// ─── Concurrency: the property that matters most ─────────────────────────────

describe('no two callers ever share an index', () => {
    it('holds across 200 concurrent reservations', async () => {
        const results = await Promise.all(
            Array.from({ length: 200 }, () => reservePairwiseIndex(storage, IVK))
        );

        const indexes = results.filter((r): r is number => r !== null);
        expect(new Set(indexes).size).toBe(indexes.length);
        expect(indexes).not.toContain(0);
    });

    it('holds when several counterparties are paid at once', async () => {
        const keys = ['0xa1', '0xb2', '0xc3'];
        const rounds = await Promise.all(
            keys.flatMap((k) =>
                Array.from({ length: 20 }, async () => ({ key: k, idx: await reservePairwiseIndex(storage, k) }))
            )
        );

        for (const key of keys) {
            const forKey = rounds
                .filter((r) => r.key === key)
                .map((r) => r.idx)
                .filter((i): i is number => i !== null);
            expect(new Set(forKey).size).toBe(forKey.length);
        }
    });

    it('a failed reservation does not consume an index for the next caller', async () => {
        // The lock must not be left poisoned by a throw: the reservation after
        // a failure has to succeed, or a transient storage error would strand
        // the counter.
        await reservePairwiseIndex(storage, IVK);
        const before = (await storage.getConfig())?.pairwiseCounterparties?.['0xaabb']?.nextIndex;

        const original = storage.updateConfig.bind(storage);
        storage.updateConfig = async () => {
            throw new Error('transient');
        };
        await expect(reservePairwiseIndex(storage, IVK)).rejects.toThrow('transient');
        storage.updateConfig = original;

        expect(await reservePairwiseIndex(storage, IVK)).toBe(before);
    });
});
