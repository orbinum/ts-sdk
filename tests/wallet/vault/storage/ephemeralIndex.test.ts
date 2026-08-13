/**
 * Ephemeral-index reservation.
 *
 * The property under test is monotonicity, and it is a privacy requirement
 * rather than bookkeeping: handing the same index out twice republishes the
 * same ephPk on chain, which publicly links the two notes as sharing a creator.
 * The concurrency test is the one that matters — a sequential caller is easy to
 * get right, and the leak appears when two spends overlap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    reserveSelfEphIndex,
    reservePairwiseIndex,
} from '../../../../src/wallet/vault/storage/ephemeralIndex';
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { buildConfig, writeConfig, mergeCounters } from '../../../../src/wallet/vault/storage/config';
import type { EphemeralCounters } from '../../../../src/wallet/vault/storage/config';

const IVK = '0xAABB';

describe('reserveSelfEphIndex', () => {
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        await storage.putConfig(buildConfig(null));
    });

    it('hands out 0 first, then counts up', async () => {
        expect(await reserveSelfEphIndex(storage)).toBe(0);
        expect(await reserveSelfEphIndex(storage)).toBe(1);
        expect(await reserveSelfEphIndex(storage)).toBe(2);
    });

    it('persists the counter, so a reload never re-issues an index', async () => {
        await reserveSelfEphIndex(storage);
        await reserveSelfEphIndex(storage);

        expect((await storage.getConfig())?.selfEphCounter).toBe(2);
    });

    it('never issues the same index twice under concurrent reservation', async () => {
        // Two spends racing is the real scenario. A non-atomic updateConfig
        // would let both read the same counter and return the same index.
        const indexes = await Promise.all(
            Array.from({ length: 20 }, () => reserveSelfEphIndex(storage))
        );

        expect(new Set(indexes).size).toBe(20);
        expect([...indexes].sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
    });

    it('throws when no vault config exists', async () => {
        // The caller must fall back to a random ephemeral rather than assume
        // zero — assuming zero is exactly how an index gets reused.
        await expect(reserveSelfEphIndex(new MemoryVaultStorage())).rejects.toThrow(
            'vault not initialized'
        );
    });
});

describe('reservePairwiseIndex', () => {
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        await storage.putConfig(buildConfig(null));
    });

    it('returns null for a counterparty it has no history for', async () => {
        // Not "index 0". A vault with no entry cannot tell a first payment from
        // a counter it lost to a restore, and index 0 on a restored wallet
        // republishes an ephPk. The caller degrades to a random ephemeral.
        expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
    });

    it('counts up once there IS history', async () => {
        // The first call registers the entry and returns null, so the sequence
        // starts at 1 — index 0 is never handed out at all. That is deliberate:
        // 0 is the value a restored vault would have collided on.
        await reservePairwiseIndex(storage, IVK);
        expect(await reservePairwiseIndex(storage, IVK)).toBe(1);
        expect(await reservePairwiseIndex(storage, IVK)).toBe(2);
    });

    it('keeps each counterparty on its own counter', async () => {
        await reservePairwiseIndex(storage, IVK);
        await reservePairwiseIndex(storage, IVK);

        expect(await reservePairwiseIndex(storage, '0xCCDD')).toBeNull();
    });

    it('treats the key case-insensitively', async () => {
        // Same counterparty written either way must not get two counters —
        // that would issue index 0 twice to the same recipient.
        await reservePairwiseIndex(storage, '0xAABB');

        expect(await reservePairwiseIndex(storage, '0xaabb')).toBe(1);
    });

    it('THE LEAK: a wiped counter never resumes at an index it already published', async () => {
        // The scenario this whole change exists for. A wallet pays a
        // counterparty several times, then the vault is restored from seed and
        // the entry is gone. Handing back 0 here would re-derive the ephSk of
        // the first payment and republish its ephPk on chain, letting anyone
        // reading the public feed group the two notes as sharing a sender and a
        // recipient.
        await reservePairwiseIndex(storage, IVK);
        for (let i = 0; i < 5; i++) await reservePairwiseIndex(storage, IVK);
        expect((await storage.getConfig())?.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(6);

        // Restore: the config survives, the counterparty entry does not.
        const config = (await storage.getConfig())!;
        delete config.pairwiseCounterparties!['0xaabb'];
        await storage.putConfig(config);

        expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
    });

    it('a wiped counter for ONE counterparty leaves the others intact', async () => {
        await reservePairwiseIndex(storage, '0xAABB');
        await reservePairwiseIndex(storage, '0xAABB');
        await reservePairwiseIndex(storage, '0xCCDD');
        await reservePairwiseIndex(storage, '0xCCDD');

        const config = (await storage.getConfig())!;
        delete config.pairwiseCounterparties!['0xaabb'];
        await storage.putConfig(config);

        expect(await reservePairwiseIndex(storage, '0xAABB')).toBeNull();
        expect(await reservePairwiseIndex(storage, '0xCCDD')).toBe(2);
    });

    it('registers the counterparty, which makes their payments to us cheap', async () => {
        await reservePairwiseIndex(storage, IVK);

        const entry = (await storage.getConfig())?.pairwiseCounterparties?.['0xaabb'];
        expect(entry).toMatchObject({ nextIndex: 1 });
        expect(typeof entry?.addedAt).toBe('number');
    });

    it('keeps the original addedAt across later reservations', async () => {
        await reservePairwiseIndex(storage, IVK);
        const first = (await storage.getConfig())?.pairwiseCounterparties?.['0xaabb']?.addedAt;

        await reservePairwiseIndex(storage, IVK);

        expect((await storage.getConfig())?.pairwiseCounterparties?.['0xaabb']?.addedAt).toBe(
            first
        );
    });

    it('never issues the same index twice under concurrent reservation', async () => {
        const indexes = await Promise.all(
            Array.from({ length: 20 }, () => reservePairwiseIndex(storage, IVK))
        );

        expect(new Set(indexes).size).toBe(20);
    });

    it('leaves other counterparties untouched when one is bumped', async () => {
        await reservePairwiseIndex(storage, '0xaaaa');
        await reservePairwiseIndex(storage, '0xbbbb');
        await reservePairwiseIndex(storage, '0xaaaa');

        const parties = (await storage.getConfig())?.pairwiseCounterparties;
        expect(parties?.['0xaaaa']?.nextIndex).toBe(2);
        expect(parties?.['0xbbbb']?.nextIndex).toBe(1);
    });

    it('throws when no vault config exists', async () => {
        await expect(reservePairwiseIndex(new MemoryVaultStorage(), IVK)).rejects.toThrow(
            'vault not initialized'
        );
    });

    it('survives a backend that calls the mutator more than once', async () => {
        // The contract requires updateConfig to be ATOMIC, not that it invokes
        // `mutate` exactly once — an optimistic backend may retry on contention.
        // A verdict derived from a flag set inside the mutator would then read
        // an attempt that lost. This asserts the verdict comes off the result.
        const inner = new MemoryVaultStorage();
        await inner.putConfig(buildConfig(null));
        const retrying = Object.create(inner) as MemoryVaultStorage;
        retrying.updateConfig = async (mutate) => {
            const committed = await inner.updateConfig(mutate);
            // A losing attempt replayed AFTER the winner, against the state as
            // it was BEFORE. This is what a retry-on-contention backend does,
            // and it leaves any flag written inside `mutate` describing the
            // attempt that did not commit.
            mutate({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
            return committed;
        };

        expect(await reservePairwiseIndex(retrying, IVK)).toBeNull();
        expect(await reservePairwiseIndex(retrying, IVK)).toBe(1);
    });

    it('a config with an explicit nextIndex of 0 is treated as no history', async () => {
        // Defensive: nothing writes 0 today, but a hand-edited or migrated
        // record could. Zero means "nothing published yet", so the same rule
        // applies — never hand back an index that was already on chain.
        const config = (await storage.getConfig())!;
        config.pairwiseCounterparties = { '0xaabb': { nextIndex: 0, addedAt: 1 } };
        await storage.putConfig(config);

        expect(await reservePairwiseIndex(storage, IVK)).toBeNull();
    });

    it('resumes correctly from a counter restored by mergeCounters', async () => {
        // The recovery path that DOES work: a config write merges counters
        // forward, so a vault whose entry survived keeps its place in the
        // sequence instead of dropping back to null.
        const config = (await storage.getConfig())!;
        config.pairwiseCounterparties = { '0xaabb': { nextIndex: 9, addedAt: 1 } };
        await storage.putConfig(config);

        expect(await reservePairwiseIndex(storage, IVK)).toBe(9);
        expect(await reservePairwiseIndex(storage, IVK)).toBe(10);
    });

    it('under concurrency, exactly one caller gets null and the rest get distinct indexes', async () => {
        // Twenty racing first-payments to the same counterparty. Only the one
        // that created the entry may return null; every other must get its own
        // index, because two callers sharing one index is the leak itself.
        const results = await Promise.all(
            Array.from({ length: 20 }, () => reservePairwiseIndex(storage, IVK))
        );

        const nulls = results.filter((r) => r === null);
        const indexes = results.filter((r): r is number => r !== null);
        expect(nulls).toHaveLength(1);
        expect(new Set(indexes).size).toBe(19);
        expect(indexes).not.toContain(0);
    });
});

describe('counter survival', () => {
    it('carries both counters through a config rebuild', async () => {
        // buildConfig runs on every unlock. Dropping a counter here would
        // restart it at zero and re-issue indexes already published.
        const storage = new MemoryVaultStorage();
        await storage.putConfig(buildConfig(null));
        await reserveSelfEphIndex(storage);
        await reservePairwiseIndex(storage, IVK);

        const before = await storage.getConfig();
        await storage.putConfig(buildConfig(before, '0xchain'));
        const after = await storage.getConfig();

        expect(after?.selfEphCounter).toBe(1);
        expect(after?.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(1);
    });
});

describe('writeConfig — a stale snapshot must not roll a counter back', () => {
    // The failure this closes: `unlock` reads the config, then decrypts every
    // note and may await an RPC before writing it back. A shield reserving an
    // index inside that window was rolled back by the write, and the NEXT
    // reservation handed out the same index — republishing one ephPk, which
    // publicly links both notes as sharing a creator. Nothing local repairs it.
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        await storage.putConfig(buildConfig(null));
    });

    it('keeps a reservation made after the snapshot was taken', async () => {
        const stale = await storage.getConfig();
        await reserveSelfEphIndex(storage);

        await writeConfig(storage, stale);

        expect((await storage.getConfig())?.selfEphCounter).toBe(1);
    });

    it('never hands out the same self index twice across a write', async () => {
        for (let i = 0; i < 5; i++) await reserveSelfEphIndex(storage);
        const stale = await storage.getConfig();
        const reserved = await reserveSelfEphIndex(storage);

        await writeConfig(storage, stale);

        expect(await reserveSelfEphIndex(storage)).not.toBe(reserved);
    });

    it('keeps a pairwise reservation made after the snapshot', async () => {
        const stale = await storage.getConfig();
        await reservePairwiseIndex(storage, IVK);

        await writeConfig(storage, stale);

        expect((await storage.getConfig())?.pairwiseCounterparties?.['0xaabb']?.nextIndex).toBe(1);
    });

    it('keeps a counterparty registered entirely inside the window', async () => {
        const stale = await storage.getConfig();
        await reservePairwiseIndex(storage, '0xnew');

        await writeConfig(storage, stale);

        expect((await storage.getConfig())?.pairwiseCounterparties?.['0xnew']).toBeDefined();
    });

    it('takes the higher counter when the snapshot is AHEAD of storage', async () => {
        // The reverse direction: a caller holding a further-along config must
        // not be dragged backwards either.
        const ahead = { ...buildConfig(null), selfEphCounter: 9 };

        await writeConfig(storage, ahead);

        expect((await storage.getConfig())?.selfEphCounter).toBe(9);
    });

    it('preserves createdAt from storage', async () => {
        const born = (await storage.getConfig())?.createdAt;

        await writeConfig(storage, null, '0xchain');

        expect((await storage.getConfig())?.createdAt).toBe(born);
    });

    it('writes the fingerprint it was given', async () => {
        await writeConfig(storage, await storage.getConfig(), '0xchain');

        expect((await storage.getConfig())?.chainFingerprint).toBe('0xchain');
    });

    it('falls back to a plain write when no config exists yet', async () => {
        // First run: nothing to merge against, and no counters to lose.
        const empty = new MemoryVaultStorage();

        await writeConfig(empty, null, '0xchain');

        expect(await empty.getConfig()).toMatchObject({ id: 'main', chainFingerprint: '0xchain' });
    });
});

/**
 * `mergeCounters` — the arithmetic `writeConfig` rests on.
 *
 * Tested directly because it is pure: proving each case through `writeConfig`
 * would need a storage fake per scenario, and the property that matters is
 * simply that no monotonic counter ever moves backwards.
 */
describe('mergeCounters', () => {
    const at = (selfEphCounter?: number, createdAt = 1000): EphemeralCounters => ({
        createdAt,
        ...(selfEphCounter !== undefined ? { selfEphCounter } : {}),
    });

    it('takes the higher self counter, whichever side holds it', () => {
        expect(mergeCounters(at(7), at(3)).selfEphCounter).toBe(7);
        expect(mergeCounters(at(3), at(7)).selfEphCounter).toBe(7);
    });

    it('keeps a counter present on only one side', () => {
        expect(mergeCounters(at(5), at(undefined)).selfEphCounter).toBe(5);
        expect(mergeCounters(at(undefined), at(5)).selfEphCounter).toBe(5);
    });

    it('omits the key entirely when neither side has a counter', () => {
        // Storing an explicit undefined would round-trip through structured
        // clone as a present key and read back as a counter of zero.
        expect(mergeCounters(at(undefined), at(undefined))).not.toHaveProperty('selfEphCounter');
    });

    it('lets the stored createdAt win — it is not a counter', () => {
        expect(mergeCounters(at(1, 500), at(1, 900)).createdAt).toBe(500);
    });

    it('fills createdAt from the snapshot when storage has none', () => {
        const current = { selfEphCounter: 1 } as EphemeralCounters;

        expect(mergeCounters(current, at(1, 900)).createdAt).toBe(900);
    });

    it('tolerates a null snapshot', () => {
        expect(mergeCounters(at(4), null).selfEphCounter).toBe(4);
    });
});

describe('mergeCounters — counterparties', () => {
    const withParties = (
        parties: Record<string, { nextIndex: number; addedAt: number }>
    ): EphemeralCounters => ({ createdAt: 1, pairwiseCounterparties: parties });

    it('takes the higher nextIndex per counterparty', () => {
        const merged = mergeCounters(
            withParties({ '0xaa': { nextIndex: 9, addedAt: 100 } }),
            withParties({ '0xaa': { nextIndex: 4, addedAt: 100 } })
        );

        expect(merged.pairwiseCounterparties?.['0xaa']?.nextIndex).toBe(9);
    });

    it('keeps the EARLIER addedAt — it records first contact', () => {
        const merged = mergeCounters(
            withParties({ '0xaa': { nextIndex: 1, addedAt: 900 } }),
            withParties({ '0xaa': { nextIndex: 1, addedAt: 100 } })
        );

        expect(merged.pairwiseCounterparties?.['0xaa']?.addedAt).toBe(100);
    });

    it('unions counterparties known to only one side', () => {
        const merged = mergeCounters(
            withParties({ '0xaa': { nextIndex: 1, addedAt: 1 } }),
            withParties({ '0xbb': { nextIndex: 2, addedAt: 1 } })
        );

        expect(Object.keys(merged.pairwiseCounterparties ?? {}).sort()).toEqual(['0xaa', '0xbb']);
    });

    it('omits the key when neither side knows any counterparty', () => {
        expect(mergeCounters({ createdAt: 1 }, null)).not.toHaveProperty('pairwiseCounterparties');
    });
});
