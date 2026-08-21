/**
 * Attacks on the ephemeral counters.
 *
 * A counter decides which ephemeral key a note publishes, and publishing one
 * twice links two notes in public. So the question here is not "does the happy
 * path work" but "what input makes it hand back an index it already used, or
 * hand the same index to two callers".
 *
 * Two threat sources, and neither is a remote attacker:
 *
 *   - **the stored config**, which is attacker-influenced in the sense that it
 *     survives restores, migrations, backups and hand-editing, and comes back
 *     as whatever JSON was on disk;
 *   - **a counter rebuilt from chain data**, which is only as honest as the
 *     feed that served it, and where hiding the highest published index is
 *     exactly the way to force a reuse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    registerPairwiseCounterparty,
    reserveOutgoingIndex,
    reserveSelfEphIndex,
} from '../../../../src/wallet/vault/storage/ephemeralIndex';
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { buildConfig, mergeCounters } from '../../../../src/wallet/vault/storage/config';
import type { VaultConfigRecord } from '../../../../src/wallet/vault/storage/contract';

const IVK = '0xAABB';

/** The last index the u32 derivation can write without aliasing. */
const MAX_EPH_INDEX = 0xffff_fffe;

let storage: MemoryVaultStorage;

beforeEach(async () => {
    storage = new MemoryVaultStorage();
    await storage.putConfig(buildConfig(null));
});

/** Write a counter directly, as a restore or a hand-edited backup would. */
async function seedOutgoing(value: unknown): Promise<void> {
    const config = (await storage.getConfig())!;
    (config as unknown as Record<string, unknown>)['outgoingEphCounter'] = value;
    await storage.putConfig(config);
}

/** Write a counterparty entry directly, as a restore or migration would. */
async function seed(entry: unknown, key = '0xaabb'): Promise<void> {
    const config = (await storage.getConfig())!;
    (config.pairwiseCounterparties as Record<string, unknown>) = { [key]: entry };
    await storage.putConfig(config);
}

// ─── A corrupted stored counter must never yield a used index ────────────────

describe('a hostile outgoing counter', () => {
    /** Every index this counter hands out over `n` reservations. */
    async function reserved(n: number): Promise<number[]> {
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(await reserveOutgoingIndex(storage));
        return out;
    }

    it('restarts the sequence rather than deriving from a corrupt counter', async () => {
        // Every one of these corrupts an INDEX rather than failing loudly: a
        // fraction truncates onto an index already used, a string concatenates
        // ('3' + 1 === '31'), and NaN derives from nothing at all.
        for (const bad of [-5, 2.5, NaN, Infinity, -Infinity, '3', null, {}, [], true]) {
            await seedOutgoing(bad);
            expect(await reserveOutgoingIndex(storage)).toBe(0);
        }
    });

    it('a valid counter is never restarted', async () => {
        // The mirror of the repair: a wallet mid-sequence must keep its place,
        // or it re-issues every index it already published.
        await seedOutgoing(7);

        expect(await reserveOutgoingIndex(storage)).toBe(7);
    });

    it('never hands out the same index twice across a corrupted-then-repaired counter', async () => {
        await seedOutgoing(-1);

        const indexes = await reserved(10);

        expect(new Set(indexes).size).toBe(10);
    });

    it('never hands out the same index twice under concurrency', async () => {
        const results = await Promise.all(
            Array.from({ length: 50 }, () => reserveOutgoingIndex(storage))
        );

        expect(new Set(results).size).toBe(50);
    });

    it('AT THE CEILING it refuses rather than wrapping to index 0', async () => {
        // The subtle path: the mutator writes ceiling+1, which is no longer a
        // usable counter, so a `?? 0` style fallback would read it as "start
        // over" and hand back index 0 — the very first index this wallet
        // published. Refusing is the only safe answer; the caller degrades to a
        // random ephemeral, which costs a scan and leaks nothing.
        await seedOutgoing(MAX_EPH_INDEX);

        await expect(reserveOutgoingIndex(storage)).rejects.toThrow(/exhausted/);
        await expect(reserveOutgoingIndex(storage)).rejects.toThrow(/exhausted/);
    });

    it('refuses even when the pre-read fails, since the check is inside the mutator', async () => {
        // The failure this closes: an exhaustion check placed BEFORE the atomic
        // write is advisory only. A transient read error skipped it, the mutator
        // then read the spent counter as merely corrupt, "repaired" it to 0, and
        // handed back the first index this wallet ever published.
        await seedOutgoing(0xffff_ffff);
        const broken = Object.create(storage) as MemoryVaultStorage;
        broken.getConfig = async () => {
            throw new Error('storage unavailable');
        };

        await expect(reserveOutgoingIndex(broken)).rejects.toThrow(/exhausted/);
        // And the spent counter must survive: repairing it away would restart
        // the whole published sequence on the next call.
        expect((await storage.getConfig())?.outgoingEphCounter).toBe(0xffff_ffff);
    });

    it('a counter already past the ceiling also refuses', async () => {
        // What the previous bug persisted, and what a u32 alias would mean:
        // `deriveOutgoingEphSk` writes the index as a u32, so 2^32 and 0 derive
        // the same ephPk. Reading it as a fresh sequence would republish every
        // index from 0 upward.
        await seedOutgoing(0xffff_ffff);

        await expect(reserveOutgoingIndex(storage)).rejects.toThrow(/exhausted/);
    });
});

// ─── A counter rebuilt from a feed that may be lying ─────────────────────────

describe('a hostile reconstruction', () => {
    it('ignores a reconstruction that is not a usable counter', async () => {
        for (const bad of [NaN, Infinity, -1, 2.5, '9' as unknown as number]) {
            const fresh = new MemoryVaultStorage();
            await fresh.putConfig(buildConfig(null));

            expect(await reserveOutgoingIndex(fresh, bad)).toBe(0);
        }
    });

    it('cannot drag a stored counter backwards', async () => {
        // The attack: a feed hides the highest published outputs so the sweep
        // reports a lower index, and the wallet republishes an ephPk. The stored
        // counter is what refuses it.
        await seedOutgoing(20);

        expect(await reserveOutgoingIndex(storage, 0)).toBe(20);
    });

    it('leaves a gap when it DOES advance the counter', async () => {
        // After a restore there is no stored counter to defend with, so the
        // sequence resumes past a run of unused indexes: hiding one top index is
        // then not enough to force a collision.
        const reserved = await reserveOutgoingIndex(storage, 5);

        expect(reserved).toBeGreaterThan(5);
    });

    it('never yields an index below the reconstruction it accepted', async () => {
        const first = await reserveOutgoingIndex(storage, 100);
        const second = await reserveOutgoingIndex(storage);

        expect(first).toBeGreaterThan(100);
        expect(second).toBeGreaterThan(first);
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
        // entry. It must neither throw nor poison the map.
        for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            await expect(registerPairwiseCounterparty(storage, key)).resolves.not.toThrow();
        }
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('treats keys differing only in case as one counterparty', async () => {
        // Two entries for one recipient would only waste window slots, but the
        // map is what the scan iterates, so it must not grow per casing.
        await registerPairwiseCounterparty(storage, '0xAABB');
        await registerPairwiseCounterparty(storage, '0xaAbB');
        await registerPairwiseCounterparty(storage, '0xAAbb');

        const parties = (await storage.getConfig())?.pairwiseCounterparties ?? {};
        expect(Object.keys(parties)).toEqual(['0xaabb']);
    });

    it('never throws on an empty or absurd key', async () => {
        for (const key of ['', ' ', '0x', 'x'.repeat(100_000), '💥']) {
            await expect(registerPairwiseCounterparty(storage, key)).resolves.not.toThrow();
        }
    });
});

// ─── mergeCounters is the other writer, and it must not roll back ────────────

describe('merge cannot roll a counter backwards', () => {
    const parties = (n: number): NonNullable<VaultConfigRecord['pairwiseCounterparties']> => ({
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

    it('keeps the higher OUTGOING counter, whichever side holds it', () => {
        // The counter that now decides what a payment publishes: a stale
        // snapshot merged over it would re-issue a published index.
        expect(
            mergeCounters(
                { createdAt: 1, outgoingEphCounter: 9 },
                { createdAt: 1, outgoingEphCounter: 2 }
            ).outgoingEphCounter
        ).toBe(9);
        expect(
            mergeCounters(
                { createdAt: 1, outgoingEphCounter: 2 },
                { createdAt: 1, outgoingEphCounter: 9 }
            ).outgoingEphCounter
        ).toBe(9);
    });

    it('a merged-back outgoing counter resumes the sequence rather than restarting', async () => {
        // End to end: merge a surviving counter into the config, then reserve.
        const config = (await storage.getConfig())!;
        config.outgoingEphCounter = 9;
        await storage.putConfig(config);

        expect(await reserveOutgoingIndex(storage)).toBe(9);
    });
});

// ─── Concurrency: the property that matters most ─────────────────────────────

describe('no two callers ever share an index', () => {
    it('holds across 200 concurrent outgoing reservations', async () => {
        const results = await Promise.all(
            Array.from({ length: 200 }, () => reserveOutgoingIndex(storage))
        );

        expect(new Set(results).size).toBe(200);
    });

    it('holds when outgoing and self reservations race each other', async () => {
        // Two independent sequences sharing one config record: a lost update on
        // either would re-issue an index that sequence already published.
        const [outgoing, self] = await Promise.all([
            Promise.all(Array.from({ length: 50 }, () => reserveOutgoingIndex(storage))),
            Promise.all(Array.from({ length: 50 }, () => reserveSelfEphIndex(storage))),
        ]);

        expect(new Set(outgoing).size).toBe(50);
        expect(new Set(self).size).toBe(50);
    });

    it('a failed reservation does not consume an index for the next caller', async () => {
        // The lock must not be left poisoned by a throw: the reservation after
        // a failure has to succeed, or a transient storage error would strand
        // the counter.
        const before = await reserveOutgoingIndex(storage);

        const original = storage.updateConfig.bind(storage);
        storage.updateConfig = async () => {
            throw new Error('transient');
        };
        await expect(reserveOutgoingIndex(storage)).rejects.toThrow('transient');
        storage.updateConfig = original;

        expect(await reserveOutgoingIndex(storage)).toBe(before + 1);
    });
});
describe('reservas concurrentes', () => {
    // Reutilizar un índice republica un ephPk, que es un enlace público entre
    // los dos pagos que lo llevan. Dos transferencias en vuelo a la vez es lo
    // normal en una UI, así que la exclusión no puede depender de que el
    // llamador serialice.
    it('32 reservas salientes simultáneas dan 32 índices distintos', async () => {
        const storage = new MemoryVaultStorage();
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });

        const indexes = await Promise.all(
            Array.from({ length: 32 }, () => reserveOutgoingIndex(storage, undefined))
        );

        expect(new Set(indexes).size).toBe(32);
    });

    it('lo mismo para la secuencia de notas propias', async () => {
        const storage = new MemoryVaultStorage();
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });

        const indexes = await Promise.all(
            Array.from({ length: 32 }, () => reserveSelfEphIndex(storage))
        );

        expect(new Set(indexes).size).toBe(32);
    });
});
