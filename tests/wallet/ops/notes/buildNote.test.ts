/**
 * buildZkNote — which ephemeral a new note publishes.
 *
 * That choice decides how the note is found later, and getting it wrong is
 * expensive in one direction and dangerous in the other: a missed reservation
 * costs the recipient a trial scan, while a REUSED index republishes an ephPk
 * and publicly links two notes as sharing a creator.
 *
 * The reservation runs against a real MemoryVaultStorage, so these also cover
 * the atomic read-modify-write the counters depend on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildZkNote } from '../../../../src/wallet/ops/notes/buildNote';
import { MemoryVaultStorage } from '../../../../src/index';
import { deriveSelfEphSk } from '../../../../src/protocol/eph/selfEph';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { buildConfig } from '../../../../src/wallet/vault/storage/config';
import {
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
} from '../../../../src/protocol/eph/pairwiseEph';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import type { NoteBuildKeys } from '../../../../src/wallet/ops/notes/buildNote';

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../../../src/protocol/note/NoteBuilder', () => ({
    NoteBuilder: { build: mocks.build },
}));

const SPENDING_KEY = 12345678901234567890n;
const ivsk = deriveViewingSecretKey(SPENDING_KEY);

const KEYS: NoteBuildKeys = {
    ownerPk: deriveOwnerPk(SPENDING_KEY),
    spendingKey: SPENDING_KEY,
    viewingPublicKey: deriveViewingPublicKey(ivsk),
    viewingSecretKey: ivsk,
};

/** The recipient of a pairwise payment: a different wallet's viewing key. */
const OTHER_IVK = deriveViewingPublicKey(deriveViewingSecretKey(999n));

const buildArgs = () => mocks.build.mock.calls[0]?.[0] as Record<string, unknown>;

describe('buildZkNote', () => {
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.build.mockResolvedValue({ commitmentHex: '0xnote' });
        storage = new MemoryVaultStorage();
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    describe('self notes', () => {
        it('derives a deterministic ephemeral from the reserved index', async () => {
            // A cold restore then recognises the note by ephPk lookup, with no
            // trial ECDH at all.
            await buildZkNote({ value: 10n, circuitVersion: 1 }, { keys: KEYS, storage });

            expect(buildArgs()['ephSkOverride']).toEqual(deriveSelfEphSk(SPENDING_KEY, 0));
            expect((await storage.getConfig())?.selfEphCounter).toBe(1);
        });

        it('never reuses an index across notes', async () => {
            // Reuse republishes the same ephPk, which links both notes on chain.
            await buildZkNote({ value: 10n, circuitVersion: 1 }, { keys: KEYS, storage });
            await buildZkNote({ value: 20n, circuitVersion: 1 }, { keys: KEYS, storage });

            const first = mocks.build.mock.calls[0]?.[0] as { ephSkOverride: Uint8Array };
            const second = mocks.build.mock.calls[1]?.[0] as { ephSkOverride: Uint8Array };
            expect(first.ephSkOverride).not.toEqual(second.ephSkOverride);
            expect(second.ephSkOverride).toEqual(deriveSelfEphSk(SPENDING_KEY, 1));
        });

        it('reserves distinct indexes under concurrent builds', async () => {
            // Two builds racing must not read the same counter — that is exactly
            // what updateConfig's atomicity is for.
            await Promise.all([
                buildZkNote({ value: 1n, circuitVersion: 1 }, { keys: KEYS, storage }),
                buildZkNote({ value: 2n, circuitVersion: 1 }, { keys: KEYS, storage }),
                buildZkNote({ value: 3n, circuitVersion: 1 }, { keys: KEYS, storage }),
            ]);

            const used = mocks.build.mock.calls.map((c) =>
                (c[0] as { ephSkOverride: Uint8Array }).ephSkOverride.join(',')
            );
            expect(new Set(used).size).toBe(3);
            expect((await storage.getConfig())?.selfEphCounter).toBe(3);
        });

        it('falls back to a random ephemeral when no vault config exists', async () => {
            // Degrading to random is correct; degrading to index zero would reuse
            // an ephemeral the wallet may already have published.
            const empty = new MemoryVaultStorage();

            await buildZkNote({ value: 10n, circuitVersion: 1 }, { keys: KEYS, storage: empty });

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('falls back to a random ephemeral when no storage is given', async () => {
            await buildZkNote({ value: 10n, circuitVersion: 1 }, { keys: KEYS });

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });
    });

    describe('paying a known privacy address', () => {
        it('uses a RANDOM ephemeral on the first payment to a counterparty', async () => {
            // The vault has no counter for them yet, and "no counter" is
            // indistinguishable from "counter lost to a restore". Index 0 on a
            // restored wallet republishes an ephPk, so the ambiguity is resolved
            // the safe way: this payment costs the recipient a trial scan.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('derives the ephemeral from the shared secret once the counter exists', async () => {
            // Second payment onward: the entry is there, so the recipient gets
            // the hash-lookup fast path back.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            mocks.build.mockClear();

            await buildZkNote(
                { value: 20n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const expected = derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, OTHER_IVK), 1);
            expect(buildArgs()['ephSkOverride']).toEqual(expected);
        });

        it('THE LEAK: a restored vault never republishes an ephemeral it already used', async () => {
            // The regression this change exists to prevent. Pay a counterparty
            // twice, wipe the counter as a seed restore would, pay again — and
            // the third note must not carry an ephSk either of the first two
            // published. Reverting reservePairwiseIndex to return 0 makes this
            // fail, which is the point.
            await buildZkNote(
                { value: 1n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            await buildZkNote(
                { value: 2n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            const published = mocks.build.mock.calls
                .map((c) => (c[0] as { ephSkOverride?: Uint8Array }).ephSkOverride)
                .filter((e): e is Uint8Array => e !== undefined)
                .map((e) => e.join(','));
            expect(published.length).toBeGreaterThan(0);

            // Restore: config survives, the counterparty entry does not.
            const config = (await storage.getConfig())!;
            delete config.pairwiseCounterparties![toHex(OTHER_IVK).toLowerCase()];
            await storage.putConfig(config);
            mocks.build.mockClear();

            await buildZkNote(
                { value: 3n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const after = buildArgs()['ephSkOverride'] as Uint8Array | undefined;
            expect(after).toBeUndefined();
            // And explicitly: whatever it uses, it is not one already on chain.
            if (after) expect(published).not.toContain(after.join(','));
        });

        it('registers the counterparty, which makes the reverse direction cheap too', async () => {
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const counterparties = (await storage.getConfig())?.pairwiseCounterparties ?? {};
            expect(Object.keys(counterparties)).toHaveLength(1);
        });

        it('advances that counterparty index per payment', async () => {
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            await buildZkNote(
                { value: 20n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const second = mocks.build.mock.calls[1]?.[0] as { ephSkOverride: Uint8Array };
            expect(second.ephSkOverride).toEqual(
                derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, OTHER_IVK), 1)
            );
        });

        it('falls back to random when the reservation throws', async () => {
            // A locked or unreachable vault must not take index 0 either. The
            // catch already did this; the test pins that null and throw share
            // one outcome, so a future refactor cannot split them.
            const broken = new MemoryVaultStorage();
            await broken.putConfig(buildConfig(null));
            broken.updateConfig = async () => {
                throw new Error('storage unavailable');
            };

            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage: broken }
            );

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('still registers the counterparty on the payment that returns null', async () => {
            // The entry has to be written even though this payment goes random,
            // or every payment to that address would stay on the slow path.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const parties = (await storage.getConfig())?.pairwiseCounterparties ?? {};
            expect(parties[toHex(OTHER_IVK).toLowerCase()]?.nextIndex).toBe(1);
        });

        it('never derives index 0, which is the value a restore would collide on', async () => {
            // Five payments to the same counterparty: the first goes random and
            // the rest walk 1,2,3,4. Index 0 is not in the sequence at all.
            for (let i = 0; i < 5; i++) {
                await buildZkNote(
                    { value: BigInt(i + 1), circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                    { keys: KEYS, storage }
                );
            }

            const pairSecret = derivePairwiseSharedSecret(ivsk, OTHER_IVK);
            const zero = derivePairwiseEphSk(pairSecret, 0).join(',');
            const used = mocks.build.mock.calls
                .map((c) => (c[0] as { ephSkOverride?: Uint8Array }).ephSkOverride)
                .filter((e): e is Uint8Array => e !== undefined)
                .map((e) => e.join(','));

            expect(used).toHaveLength(4);
            expect(used).not.toContain(zero);
            expect(used[0]).toEqual(derivePairwiseEphSk(pairSecret, 1).join(','));
        });

        it('keeps counters separate per counterparty', async () => {
            const third = deriveViewingPublicKey(deriveViewingSecretKey(777n));

            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: third },
                { keys: KEYS, storage }
            );
            mocks.build.mockClear();

            // A second payment to each: their counters must be independent, so
            // both resume at index 1 rather than sharing one sequence.
            await buildZkNote(
                { value: 20n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            await buildZkNote(
                { value: 20n, circuitVersion: 1, viewingPublicKey: third },
                { keys: KEYS, storage }
            );

            const toOther = mocks.build.mock.calls[0]?.[0] as { ephSkOverride: Uint8Array };
            const toThird = mocks.build.mock.calls[1]?.[0] as { ephSkOverride: Uint8Array };
            expect(toOther.ephSkOverride).toEqual(
                derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, OTHER_IVK), 1)
            );
            expect(toThird.ephSkOverride).toEqual(
                derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, third), 1)
            );
        });

        it('falls back to random without a viewing secret key', async () => {
            // Pairwise needs both halves; without ours there is no shared secret.
            const { viewingSecretKey: _omitted, ...rest } = KEYS;

            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: rest, storage }
            );

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('falls back to random when the key is not a curve point', async () => {
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: new Uint8Array(32).fill(0xff) },
                { keys: KEYS, storage }
            );

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });
    });

    describe('note fields', () => {
        it('defaults ownerPk, spendingKey and viewing key to the wallet', async () => {
            await buildZkNote({ value: 20n, circuitVersion: 1, blinding: 33n }, { keys: KEYS });

            expect(buildArgs()).toMatchObject({
                value: 20n,
                assetId: 0n,
                ownerPk: KEYS.ownerPk,
                blinding: 33n,
                spendingKey: SPENDING_KEY,
                viewingPublicKey: KEYS.viewingPublicKey,
                circuitVersion: 1,
            });
        });

        it('lets explicit values override the wallet defaults', async () => {
            await buildZkNote(
                {
                    value: 5n,
                    circuitVersion: 2,
                    assetId: 7n,
                    ownerPk: 111n,
                    spendingKey: 222n,
                    sourcePk: 333n,
                },
                { keys: KEYS }
            );

            expect(buildArgs()).toMatchObject({
                assetId: 7n,
                ownerPk: 111n,
                spendingKey: 222n,
                sourcePk: 333n,
                circuitVersion: 2,
            });
        });

        it('omits an absent counterparty rather than passing undefined', async () => {
            // The builder distinguishes "no recipient" from an explicit value.
            await buildZkNote({ value: 5n, circuitVersion: 1 }, { keys: KEYS });

            expect('sourcePk' in buildArgs()).toBe(false);
            expect('recipientOwnerPk' in buildArgs()).toBe(false);
        });

        it('generates a random blinding when none is given', async () => {
            await buildZkNote({ value: 30n, circuitVersion: 1 }, { keys: KEYS });

            expect(typeof buildArgs()['blinding']).toBe('bigint');
            expect(buildArgs()['blinding'] as bigint).toBeGreaterThan(0n);
        });

        it('stamps a creation time', async () => {
            const note = await buildZkNote({ value: 30n, circuitVersion: 1 }, { keys: KEYS });

            expect((note as { createdAt?: number }).createdAt).toBeTypeOf('number');
        });
    });
});
