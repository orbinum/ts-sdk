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
        it('derives the ephemeral from the shared secret so the recipient can hash-lookup', async () => {
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            const expected = derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, OTHER_IVK), 0);
            expect(buildArgs()['ephSkOverride']).toEqual(expected);
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

            // Both are the first payment to their respective counterparty.
            const second = mocks.build.mock.calls[1]?.[0] as { ephSkOverride: Uint8Array };
            expect(second.ephSkOverride).toEqual(
                derivePairwiseEphSk(derivePairwiseSharedSecret(ivsk, third), 0)
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
                    counterpartyPk: 333n,
                },
                { keys: KEYS }
            );

            expect(buildArgs()).toMatchObject({
                assetId: 7n,
                ownerPk: 111n,
                spendingKey: 222n,
                counterpartyPk: 333n,
                circuitVersion: 2,
            });
        });

        it('omits an absent counterparty rather than passing undefined', async () => {
            // The builder distinguishes "no recipient" from an explicit value.
            await buildZkNote({ value: 5n, circuitVersion: 1 }, { keys: KEYS });

            expect('counterpartyPk' in buildArgs()).toBe(false);
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
