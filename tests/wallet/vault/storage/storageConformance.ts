/**
 * The `VaultStorage` conformance suite.
 *
 * Exported rather than run here: every implementation must pass the same
 * assertions, and a contract verified against a single backend only describes
 * that backend. The app's IndexedDB adapter runs this too.
 *
 * The atomicity block is the one that matters most. A backend that loses a
 * concurrent `updateConfig` increment makes two notes derive the same ephemeral
 * index and publish the same ephPk — a privacy leak, and one that no unit test
 * of the backend's own methods would surface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { EncryptedNoteRecord } from '../../../../src/wallet/vault/storage/records';
import type {
    NullifierSyncMeta,
    VaultConfigRecord,
    VaultStorage,
} from '../../../../src/wallet/vault/storage/contract';

export const emptyConfig = (): VaultConfigRecord => ({
    id: 'main',
    v: 5,
    createdAt: 1000,
    updatedAt: 1000,
});

export const syncMeta = (chunksDone: number, totalStored: number): NullifierSyncMeta => ({
    id: 'main',
    chunksDone,
    generation: '3',
    totalStored,
    updatedAt: 1,
});

export const noteRecord = (tag: string): EncryptedNoteRecord => ({
    commitmentTag: tag,
    iv: 'aXY=',
    ciphertext: 'Y2lwaGVy',
    nullifierTag: `n-${tag}`,
    assetTag: 'a-0',
    updatedAt: 1,
});

/**
 * @param name    Implementation name, for the describe block.
 * @param create  Fresh, empty storage per test.
 */
export function testVaultStorageConformance(name: string, create: () => VaultStorage): void {
    describe(`VaultStorage conformance — ${name}`, () => {
        let storage: VaultStorage;
        beforeEach(() => {
            storage = create();
        });

        describe('config', () => {
            it('starts empty', async () => {
                expect(await storage.getConfig()).toBeNull();
                expect(await storage.hasVault()).toBe(false);
            });

            it('round-trips a stored config', async () => {
                await storage.putConfig({ ...emptyConfig(), selfEphCounter: 7 });

                expect(await storage.getConfig()).toMatchObject({ id: 'main', selfEphCounter: 7 });
                expect(await storage.hasVault()).toBe(true);
            });

            it('returns null from updateConfig when there is nothing to update', async () => {
                const mutate = (c: VaultConfigRecord) => c;

                expect(await storage.updateConfig(mutate)).toBeNull();
            });

            it('applies the mutation and returns the stored result', async () => {
                await storage.putConfig(emptyConfig());

                const updated = await storage.updateConfig((c) => ({ ...c, selfEphCounter: 3 }));

                expect(updated?.selfEphCounter).toBe(3);
                expect((await storage.getConfig())?.selfEphCounter).toBe(3);
            });

            // The contract's load-bearing guarantee: a lost increment here means
            // two notes publish the same ephemeral public key.
            it('loses no increment under concurrent updates', async () => {
                await storage.putConfig(emptyConfig());

                const reserved = await Promise.all(
                    Array.from({ length: 8 }, () =>
                        storage
                            .updateConfig((c) => ({
                                ...c,
                                selfEphCounter: (c.selfEphCounter ?? 0) + 1,
                            }))
                            .then((c) => (c?.selfEphCounter ?? 1) - 1)
                    )
                );

                expect(new Set(reserved).size).toBe(8);
                expect([...reserved].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
                expect((await storage.getConfig())?.selfEphCounter).toBe(8);
            });
        });

        describe('notes', () => {
            it('stores and reads back records', async () => {
                await storage.putNote(noteRecord('a'));
                await storage.putNotes([noteRecord('b'), noteRecord('c')]);

                const tags = (await storage.getAllNoteRecords()).map((n) => n.commitmentTag);
                expect(tags.sort()).toEqual(['a', 'b', 'c']);
            });

            it('replaces a record with the same tag rather than duplicating it', async () => {
                await storage.putNote(noteRecord('a'));
                await storage.putNote({ ...noteRecord('a'), spent: true });

                const all = await storage.getAllNoteRecords();
                expect(all).toHaveLength(1);
                expect(all[0]?.spent).toBe(true);
            });

            it('deletes by tag, singly and in bulk', async () => {
                await storage.putNotes([noteRecord('a'), noteRecord('b'), noteRecord('c')]);

                await storage.deleteNote('a');
                await storage.deleteNotes(['b', 'missing']);

                expect((await storage.getAllNoteRecords()).map((n) => n.commitmentTag)).toEqual([
                    'c',
                ]);
            });

            it('clears every record', async () => {
                await storage.putNotes([noteRecord('a'), noteRecord('b')]);

                await storage.clearNotes();

                expect(await storage.getAllNoteRecords()).toEqual([]);
            });

            it('treats an empty bulk write as a no-op', async () => {
                await storage.putNotes([]);
                await storage.deleteNotes([]);

                expect(await storage.getAllNoteRecords()).toEqual([]);
            });
        });

        describe('nullifier cache', () => {
            it('starts empty', async () => {
                expect(await storage.countNullifiers()).toBe(0);
                expect(await storage.getNullifierSyncMeta()).toBeNull();
            });

            it('stores a chunk with its sync progress', async () => {
                await storage.putNullifierChunk(
                    [
                        { h: '0xaa', ts: 5, tx: '0xtx' },
                        { h: '0xbb', ts: null },
                    ],
                    syncMeta(1, 2)
                );

                expect(await storage.countNullifiers()).toBe(2);
                expect(await storage.getNullifierSyncMeta()).toMatchObject({
                    chunksDone: 1,
                    generation: '3',
                });
            });

            it('returns spend details for the hexes it holds, and nothing else', async () => {
                await storage.putNullifierChunk([{ h: '0xaa', ts: 5, tx: '0xtx' }], syncMeta(1, 1));

                const spent = await storage.getSpentNullifiers(['0xaa', '0xunspent']);

                expect(spent.get('0xaa')).toEqual({ spentAt: 5, txHash: '0xtx' });
                expect(spent.has('0xunspent')).toBe(false);
            });

            it('reports null details rather than dropping an entry that has none', async () => {
                // A row cached before the field existed, or one whose extrinsic
                // the indexer could not resolve. It is still spent.
                await storage.putNullifierChunk([{ h: '0xaa', ts: null }], syncMeta(1, 1));

                expect((await storage.getSpentNullifiers(['0xaa'])).get('0xaa')).toEqual({
                    spentAt: null,
                    txHash: null,
                });
            });

            it('clears the cache and its progress together', async () => {
                await storage.putNullifierChunk([{ h: '0xaa', ts: null }], syncMeta(1, 1));

                await storage.clearNullifierCache();

                expect(await storage.countNullifiers()).toBe(0);
                // Leaving the meta behind would make the next sync resume from a
                // chunk count the cache no longer holds.
                expect(await storage.getNullifierSyncMeta()).toBeNull();
            });
        });

        describe('tx history', () => {
            it('stores and reads back records', async () => {
                await storage.addTxRecord({
                    id: '0xtx',
                    iv: 'aXY=',
                    ciphertext: 'Y2lwaGVy',
                    updatedAt: 1,
                });

                expect(await storage.getAllTxRecords()).toHaveLength(1);
            });

            it('replaces a record with the same hash', async () => {
                const base = { id: '0xtx', iv: 'aXY=', ciphertext: 'Y2lwaGVy', updatedAt: 1 };
                await storage.addTxRecord(base);
                await storage.addTxRecord({ ...base, updatedAt: 2 });

                const all = await storage.getAllTxRecords();
                expect(all).toHaveLength(1);
                expect(all[0]?.updatedAt).toBe(2);
            });
        });
    });
}
