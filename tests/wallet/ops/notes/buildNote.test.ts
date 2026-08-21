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
import { buildZkNote, buildZkNoteWithIndex } from '../../../../src/wallet/ops/notes/buildNote';
import { MemoryVaultStorage } from '../../../../src/index';
import { deriveSelfEphSk } from '../../../../src/protocol/eph/selfEph';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { buildConfig } from '../../../../src/wallet/vault/storage/config';
import { deriveOutgoingEphSk } from '../../../../src/protocol/eph/outgoingEph';
import { deriveOutgoingViewingKeyV3 } from '../../../../src/protocol/keys/PrivacyKeys';
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

/** The outgoing viewing key — its own branch, siblings with the others. */
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x5b));

const KEYS: NoteBuildKeys = {
    ownerPk: deriveOwnerPk(SPENDING_KEY),
    spendingKey: SPENDING_KEY,
    viewingPublicKey: deriveViewingPublicKey(ivsk),
    viewingSecretKey: ivsk,
    outgoingViewingKey: OVK,
};

/** The recipient of a payment: a different wallet's viewing key. */
const OTHER_IVK = deriveViewingPublicKey(deriveViewingSecretKey(999n));
/** A second recipient, for showing the counter is per-wallet not per-person. */
const THIRD_IVK = deriveViewingPublicKey(deriveViewingSecretKey(555n));

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

            expect(buildArgs()['ephSkOverride']).toEqual(deriveSelfEphSk(ivsk, 0));
            expect((await storage.getConfig())?.selfEphCounter).toBe(1);
        });

        it('never reuses an index across notes', async () => {
            // Reuse republishes the same ephPk, which links both notes on chain.
            await buildZkNote({ value: 10n, circuitVersion: 1 }, { keys: KEYS, storage });
            await buildZkNote({ value: 20n, circuitVersion: 1 }, { keys: KEYS, storage });

            const first = mocks.build.mock.calls[0]?.[0] as { ephSkOverride: Uint8Array };
            const second = mocks.build.mock.calls[1]?.[0] as { ephSkOverride: Uint8Array };
            expect(first.ephSkOverride).not.toEqual(second.ephSkOverride);
            expect(second.ephSkOverride).toEqual(deriveSelfEphSk(ivsk, 1));
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

    describe('paying a privacy address', () => {
        it('derives the ephemeral from the outgoing sequence, starting at 0', async () => {
            // Index 0 is usable here, unlike the pairwise counter: this sequence
            // depends only on the sender's own spending key, so a restored
            // wallet rebuilds the counter from chain data instead of having to
            // guess whether it ever paid this person before.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            expect(buildArgs()['ephSkOverride']).toEqual(deriveOutgoingEphSk(OVK, 0));
        });

        it('advances the index on every payment', async () => {
            // Reusing one republishes its ephPk, which publicly links the two
            // notes as sharing a creator.
            for (const value of [10n, 20n, 30n]) {
                await buildZkNote(
                    { value, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                    { keys: KEYS, storage }
                );
            }

            const published = mocks.build.mock.calls.map(
                (c) => (c[0] as { ephSkOverride?: Uint8Array }).ephSkOverride
            );
            expect(published).toEqual([0, 1, 2].map((i) => deriveOutgoingEphSk(OVK, i)));
        });

        it('the sequence does NOT restart per recipient', async () => {
            // One counter for the whole wallet: paying a second person must not
            // hand out an index the first already published.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );
            mocks.build.mockClear();

            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: THIRD_IVK },
                { keys: KEYS, storage }
            );

            expect(buildArgs()['ephSkOverride']).toEqual(deriveOutgoingEphSk(OVK, 1));
        });

        it('a reconstructed counter resumes past the highest published index', async () => {
            // After a restore the chain is the only source, and it is served by
            // someone who could omit the top index. Resuming past a gap means
            // omitting one is not enough to force a collision.
            await buildZkNote(
                {
                    value: 10n,
                    circuitVersion: 1,
                    viewingPublicKey: OTHER_IVK,
                    outgoingIndexFromChain: 5,
                },
                { keys: KEYS, storage }
            );

            const used = buildArgs()['ephSkOverride'] as Uint8Array;
            const collides = [0, 1, 2, 3, 4].some(
                (i) => toHex(deriveOutgoingEphSk(OVK, i)) === toHex(used)
            );
            expect(collides).toBe(false);
        });

        it('a reconstruction never moves the counter BACKWARDS', async () => {
            // The defence against a feed that hides published outputs: a stored
            // counter always wins, so a lying feed cannot force a reuse.
            for (const value of [1n, 2n, 3n]) {
                await buildZkNote(
                    { value, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                    { keys: KEYS, storage }
                );
            }
            mocks.build.mockClear();

            await buildZkNote(
                {
                    value: 4n,
                    circuitVersion: 1,
                    viewingPublicKey: OTHER_IVK,
                    outgoingIndexFromChain: 0,
                },
                { keys: KEYS, storage }
            );

            const used = buildArgs()['ephSkOverride'] as Uint8Array;
            const collides = [0, 1, 2].some(
                (i) => toHex(deriveOutgoingEphSk(OVK, i)) === toHex(used)
            );
            expect(collides).toBe(false);
        });

        it('falls back to random without a reachable vault', async () => {
            // A wrong index is far worse than a missing one: the recipient still
            // finds the note by trial decryption, only the sender's own history
            // is lost.
            await buildZkNote(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS }
            );

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('un storage que LANZA tampoco rompe el pago', async () => {
            // El caso anterior omite el storage entero; éste es el que pasa de
            // verdad — vault presente pero ilegible. El pago tiene que salir
            // igual: negarse a pagar por no poder guardar historial sería
            // cambiar una pérdida de comodidad por una de función.
            const broken = {
                getConfig: () => Promise.reject(new Error('vault unreachable')),
                putConfig: () => Promise.reject(new Error('vault unreachable')),
            } as unknown as MemoryVaultStorage;

            await expect(
                buildZkNote(
                    { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                    { keys: KEYS, storage: broken }
                )
            ).resolves.toBeDefined();

            expect(buildArgs()['ephSkOverride']).toBeUndefined();
        });

        it('y deja `outgoingIndex` SIN definir, que es lo que apaga la libreta', async () => {
            // La consecuencia que importa y que nadie fijaba. `transfer.ts` lee
            // este campo como bandera: ausente, la nota de cambio no lleva
            // entrada de libreta y ese pago queda irrecuperable para siempre —
            // nada en cadena lo porta de otra forma.
            const broken = {
                getConfig: () => Promise.reject(new Error('vault unreachable')),
                putConfig: () => Promise.reject(new Error('vault unreachable')),
            } as unknown as MemoryVaultStorage;

            const built = await buildZkNoteWithIndex(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage: broken }
            );

            expect(built.outgoingIndex).toBeUndefined();
        });

        it('con el vault sano SÍ devuelve el índice', async () => {
            // El contraste que da sentido al anterior: mismo camino, misma
            // llamada, y el vault es lo único que cambia el resultado.
            const built = await buildZkNoteWithIndex(
                { value: 10n, circuitVersion: 1, viewingPublicKey: OTHER_IVK },
                { keys: KEYS, storage }
            );

            expect(built.outgoingIndex).toBe(0);
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
