/**
 * `VaultStore` — write semantics and the concurrency rule.
 *
 * The interesting assertions are the ones about a write landing *while* another
 * is encrypting. Encryption is the slow step, and a rescan finishing in that
 * window is routine rather than exotic; merging onto a stale snapshot there
 * drops notes with no error to notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VaultStore } from '../../../../src/wallet/vault/store/VaultStore';
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { createNotesCache } from '../../../../src/wallet/vault/notes/cache';
import { createWalletSession } from '../../../../src/wallet/vault/session/WalletSession';
import { deriveVaultKey, deriveVaultBlindKey } from '../../../../src/wallet/vault/crypto/keys';
import { VaultLockedError } from '../../../../src/wallet/vault/session/errors';
import { VAULT_SCHEMA_VERSION } from '../../../../src/wallet/vault/storage/config';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../../src/protocol/types';
import type { ObservableNotesCache } from '../../../../src/wallet/vault/notes/cache';

const SPENDING_KEY = 12345678901234567890n;

/** A self-consistent note: its spending key derives its own ownerPk. */
function note(commitmentHex: string, overrides: Partial<ZkNote> = {}): ZkNote {
    return {
        commitmentHex,
        value: 100n,
        assetId: 0n,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        blinding: 7n,
        spendingKey: SPENDING_KEY,
        nullifierHex: `0xn${commitmentHex.slice(2)}`,
        // Required by decryptNoteRecord: a record without it is treated as
        // corrupt, which would make every unlock look like a key mismatch.
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        ...overrides,
    } as ZkNote;
}

describe('VaultStore', () => {
    let storage: MemoryVaultStorage;
    let notes: ObservableNotesCache;
    let session: ReturnType<typeof createWalletSession>;
    let store: VaultStore;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        notes = createNotesCache();
        session = createWalletSession();
        store = new VaultStore({ storage, session, notes });

        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    describe('locked vault', () => {
        it('refuses every write', async () => {
            session.lock();

            await expect(store.save(note('0xa'))).rejects.toThrow(VaultLockedError);
            await expect(store.saveMany([{ note: note('0xa') }])).rejects.toThrow(VaultLockedError);
            await expect(store.remove('0xa')).rejects.toThrow(VaultLockedError);
            await expect(store.getTxRecords()).rejects.toThrow(VaultLockedError);
        });
    });

    describe('save', () => {
        it('stores a new note and exposes it', async () => {
            await store.save(note('0xa'));

            expect(store.getAll().map((n) => n.commitmentHex)).toEqual(['0xa']);
            expect(await storage.getAllNoteRecords()).toHaveLength(1);
        });

        it('skips a rewrite when nothing changed', async () => {
            await store.save(note('0xa'));
            const spy = vi.spyOn(storage, 'putNote');

            await store.save(note('0xa'));

            expect(spy).not.toHaveBeenCalled();
        });

        it('updates spend status on an existing note', async () => {
            await store.save(note('0xa'));

            await store.save(note('0xa'), { spent: true, spentAt: 500 });

            expect(store.getAll()[0]).toMatchObject({ spent: true, spentAt: 500 });
        });

        // Without this a pre-forest note keeps returning early and never gains
        // its position, leaving same-tree coin selection unable to see it.
        it('backfills a missing leaf index even when spend status is unchanged', async () => {
            await store.save(note('0xa'));

            await store.save(note('0xa', { leafIndex: 42 }));

            expect(store.getAll()[0]?.leafIndex).toBe(42);
        });

        it('ignores a leaf index that is not a valid u32', async () => {
            await store.save(note('0xa'));

            await store.save(note('0xa', { leafIndex: Number.NaN }));

            expect(store.getAll()[0]?.leafIndex).toBeUndefined();
        });

        // A note whose keys disagree cannot be spent, but it is recoverable
        // from its on-chain memo — so it is stored with a warning, not refused.
        it('stores an inconsistent note rather than losing it', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            await store.save(note('0xa', { ownerPk: 999n }));

            expect(store.getAll()).toHaveLength(1);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        // The rule this whole module is built around.
        it('keeps a note saved while another was encrypting', async () => {
            const slow = store.save(note('0xa'));
            notes.set([...notes.get(), note('0xconcurrent')]);

            await slow;

            expect(
                store
                    .getAll()
                    .map((n) => n.commitmentHex)
                    .sort()
            ).toEqual(['0xa', '0xconcurrent']);
        });
    });

    describe('saveMany', () => {
        it('writes a batch in one storage call', async () => {
            const spy = vi.spyOn(storage, 'putNotes');

            const written = await store.saveMany([
                { note: note('0xa') },
                { note: note('0xb') },
                { note: note('0xc') },
            ]);

            expect(written).toBe(3);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(store.getAll()).toHaveLength(3);
        });

        it('collapses repeated updates to one note within a batch', async () => {
            await store.saveMany([
                { note: note('0xa') },
                { note: note('0xa'), noteStatus: { spent: true, spentAt: 1 } },
            ]);

            expect(store.getAll()).toHaveLength(1);
            expect(store.getAll()[0]?.spent).toBe(true);
        });

        it('writes nothing when no entry changes anything', async () => {
            await store.save(note('0xa'));

            expect(await store.saveMany([{ note: note('0xa') }])).toBe(0);
        });

        it('treats an empty batch as a no-op', async () => {
            expect(await store.saveMany([])).toBe(0);
        });

        it('fills in a transaction hash the stored note lacks', async () => {
            await store.save(note('0xa'));

            await store.saveMany([
                { note: note('0xa', { createdTxHash: '0xtx' } as Partial<ZkNote>) },
            ]);

            expect(store.getAll()[0]).toMatchObject({ createdTxHash: '0xtx' });
        });

        it('never overwrites a hash already stored', async () => {
            await store.save(note('0xa', { createdTxHash: '0xmine' } as Partial<ZkNote>));

            await store.saveMany([
                { note: note('0xa', { createdTxHash: '0xtheirs' } as Partial<ZkNote>) },
            ]);

            expect(store.getAll()[0]).toMatchObject({ createdTxHash: '0xmine' });
        });

        // The window is widest here: a full rescan re-encrypts every note.
        it('keeps a note saved while the batch was encrypting', async () => {
            const slow = store.saveMany([{ note: note('0xa') }, { note: note('0xb') }]);
            notes.set([...notes.get(), note('0xconcurrent')]);

            await slow;

            expect(
                store
                    .getAll()
                    .map((n) => n.commitmentHex)
                    .sort()
            ).toEqual(['0xa', '0xb', '0xconcurrent']);
        });
    });

    describe('markSpent', () => {
        it('flags a note and records the spending transaction', async () => {
            await store.save(note('0xa'));

            await store.markSpent('0xa', 500, { txHash: '0xtx' });

            expect(store.getAll()[0]).toMatchObject({
                spent: true,
                spentAt: 500,
                spentTxHash: '0xtx',
            });
        });

        it('omits the hash when the spending transaction is unknown', async () => {
            await store.save(note('0xa'));

            await store.markSpent('0xa', 500);

            expect(store.getAll()[0]).not.toHaveProperty('spentTxHash');
        });

        it('does nothing for an unknown or already-spent note', async () => {
            await store.save(note('0xa'), { spent: true, spentAt: 1 });
            const spy = vi.spyOn(storage, 'putNote');

            await store.markSpent('0xa');
            await store.markSpent('0xmissing');

            expect(spy).not.toHaveBeenCalled();
        });

        // The purge acted on the chain saying the note never existed, which
        // outranks a local spend flag.
        it('does not resurrect a note purged while it was encrypting', async () => {
            await store.save(note('0xa'));

            const slow = store.markSpent('0xa');
            notes.set([]);
            await slow;

            expect(store.getAll()).toEqual([]);
        });
    });

    describe('remove', () => {
        it('deletes from the cache and the store', async () => {
            await store.save(note('0xa'));

            await store.remove('0xa');

            expect(store.getAll()).toEqual([]);
            expect(await storage.getAllNoteRecords()).toEqual([]);
        });

        it('removes many and reports how many were present', async () => {
            await store.saveMany([{ note: note('0xa') }, { note: note('0xb') }]);

            expect(await store.removeMany(['0xa', '0xunknown'])).toBe(1);
            expect(store.getAll().map((n) => n.commitmentHex)).toEqual(['0xb']);
        });

        it('treats an empty removal as a no-op', async () => {
            expect(await store.removeMany([])).toBe(0);
        });

        it('keeps a note saved while tags were being derived', async () => {
            await store.save(note('0xa'));

            const slow = store.removeMany(['0xa']);
            notes.set([...notes.get(), note('0xconcurrent')]);
            await slow;

            expect(store.getAll().map((n) => n.commitmentHex)).toEqual(['0xconcurrent']);
        });
    });

    describe('tx history', () => {
        it('round-trips an encrypted record', async () => {
            await store.saveTxRecord({ id: '0xtx', amount: '100' });

            expect(await store.getTxRecords()).toEqual([{ id: '0xtx', amount: '100' }]);
        });

        it('stores only the hash in plaintext', async () => {
            await store.saveTxRecord({ id: '0xtx', amount: '100' });

            const [stored] = await storage.getAllTxRecords();
            expect(stored?.id).toBe('0xtx');
            expect(JSON.stringify(stored)).not.toContain('100');
        });

        // One leftover row from a previous key must not make the whole history
        // unreadable.
        it('skips rows encrypted under a different key', async () => {
            await store.saveTxRecord({ id: '0xgood', amount: '1' });
            await storage.addTxRecord({
                id: '0xforeign',
                iv: 'AAAAAAAAAAAAAAAA',
                ciphertext: 'bm90LXJlYWxseS1jaXBoZXJ0ZXh0',
                updatedAt: 1,
            });

            expect(await store.getTxRecords()).toEqual([{ id: '0xgood', amount: '1' }]);
        });
    });

    describe('unlock — schema version', () => {
        /**
         * A record written by an older build has a shape this one misreads.
         * Resetting is safe because notes are recoverable by rescanning, and it
         * beats loading a vault whose fields mean something else.
         */
        it('resets when the stored version is older than expected', async () => {
            await store.save(note('0xa'));
            await storage.putConfig({ id: 'main', v: 3, createdAt: 1, updatedAt: 1 });

            const result = await store.unlock(session.cryptoKey!, { expectedSchemaVersion: 4 });

            expect(result.wasReset).toBe(true);
            expect(store.getAll()).toEqual([]);
            expect(await storage.getAllNoteRecords()).toEqual([]);
        });

        it('writes a config at the current version after resetting', async () => {
            await storage.putConfig({ id: 'main', v: 3, createdAt: 1, updatedAt: 1 });

            await store.unlock(session.cryptoKey!, { expectedSchemaVersion: 4 });

            expect((await storage.getConfig())?.v).toBe(5);
        });

        it('resets on a NEWER stored version too', async () => {
            // A downgrade — the user opened a build older than the one that wrote
            // the vault. Just as unreadable as the other direction.
            await store.save(note('0xa'));
            await storage.putConfig({ id: 'main', v: 5, createdAt: 1, updatedAt: 1 });

            expect(
                (await store.unlock(session.cryptoKey!, { expectedSchemaVersion: 4 })).wasReset
            ).toBe(true);
        });

        it('keeps the vault when the version matches', async () => {
            await store.save(note('0xa'));

            const result = await store.unlock(session.cryptoKey!, { expectedSchemaVersion: 4 });

            expect(result.wasReset).toBe(false);
            expect(store.getAll().map((n) => n.commitmentHex)).toEqual(['0xa']);
        });

        it('resets a v4 vault under the current schema', async () => {
            // The transition this bump exists for. A v4 record stores the note
            // key as `counterpartyPk`, and reading it back does NOT throw:
            // `sourcePk` is in ABSENT_MEANS_ZERO, so the missing key reads as a
            // legitimate zero and the note loads and spends while having
            // silently dropped the payee. Resetting is what stops that.
            await store.save(note('0xa'));
            await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });

            const result = await store.unlock(session.cryptoKey!, {
                expectedSchemaVersion: VAULT_SCHEMA_VERSION,
            });

            expect(result.wasReset).toBe(true);
            expect(store.getAll()).toEqual([]);
        });

        it('skips the check when no version is expected', async () => {
            // Opting out has to stay possible for a schema that never changed.
            await store.save(note('0xa'));
            await storage.putConfig({ id: 'main', v: 99, createdAt: 1, updatedAt: 1 });

            expect((await store.unlock(session.cryptoKey!)).wasReset).toBe(false);
        });
    });

    describe('unlock', () => {
        it('reads stored notes back into the cache', async () => {
            await store.save(note('0xa'));
            notes.set([]);

            const result = await store.unlock(session.cryptoKey!);

            expect(result.wasReset).toBe(false);
            expect(store.getAll().map((n) => n.commitmentHex)).toEqual(['0xa']);
        });

        it('resets when the vault belongs to another chain', async () => {
            await storage.putConfig({
                id: 'main',
                v: 4,
                chainFingerprint: '0xchain-a',
                createdAt: 1,
                updatedAt: 1,
            });
            await store.save(note('0xa'));

            const result = await store.unlock(session.cryptoKey!, {
                chainFingerprint: '0xchain-b',
            });

            expect(result.wasReset).toBe(true);
            expect(store.getAll()).toEqual([]);
        });

        it('resets when the chain no longer knows a stored note', async () => {
            await store.save(note('0xa'));
            notes.set([]);

            const result = await store.unlock(session.cryptoKey!, {
                validateCommitment: async () => false,
            });

            expect(result.wasReset).toBe(true);
        });

        // An RPC hiccup must not wipe a good vault.
        it('keeps the vault when the validator throws', async () => {
            await store.save(note('0xa'));
            notes.set([]);

            const result = await store.unlock(session.cryptoKey!, {
                validateCommitment: async () => {
                    throw new Error('rpc down');
                },
            });

            expect(result.wasReset).toBe(false);
            expect(store.getAll()).toHaveLength(1);
        });

        it('resets when the records were written under a different key', async () => {
            await store.save(note('0xa'));
            const otherKey = await deriveVaultKey(new Uint8Array(32).fill(1));

            const result = await store.unlock(otherKey);

            expect(result.wasReset).toBe(true);
            expect(await storage.getAllNoteRecords()).toEqual([]);
        });
    });

    it('publishes note changes to a subscriber', async () => {
        const seen: number[] = [];
        notes.subscribe((n) => seen.push(n.length));

        await store.save(note('0xa'));
        await store.save(note('0xb'));

        expect(seen).toEqual([1, 2]);
    });
});

/**
 * A note whose spending key does not derive its `ownerPk` is unspendable, and
 * it is stored anyway so a rescan can repair it — but it must be REPORTED, or
 * the balance silently includes money that cannot move.
 *
 * `save` warned and `saveMany` did not, which is backwards: the batch path is
 * the one a scan writes hundreds of notes through.
 */
describe('unspendable notes are reported on every write path', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let store: VaultStore;

    beforeEach(async () => {
        const storage = new MemoryVaultStorage();
        const session = createWalletSession();
        store = new VaultStore({ storage, session, notes: createNotesCache() });
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
        warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warn.mockRestore();
    });

    /** Owner derived from a DIFFERENT key, so the pairing cannot be spent. */
    const unspendable = (commitmentHex: string): ZkNote =>
        note(commitmentHex, { ownerPk: deriveOwnerPk(SPENDING_KEY + 1n) });

    it('warns from save', async () => {
        await store.save(unspendable('0xbad1'));

        expect(warn).toHaveBeenCalledOnce();
    });

    it('SECURITY: warns from saveMany — the path a scan uses', async () => {
        await store.saveMany([{ note: unspendable('0xbad2') }]);

        expect(warn).toHaveBeenCalledOnce();
    });

    it('reports a count rather than one line per note', async () => {
        // A rescan that repaired a batch wrongly would otherwise emit hundreds
        // of identical lines.
        await store.saveMany([
            { note: unspendable('0xbad3') },
            { note: unspendable('0xbad4') },
            { note: unspendable('0xbad5') },
        ]);

        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/storing 3 note\(s\)/);
    });

    it('never logs a note identifier', async () => {
        // Console output reaches extensions, shared screens and bug reports.
        await store.saveMany([{ note: unspendable('0xdeadbeef') }]);

        expect(String(warn.mock.calls[0]?.[0])).not.toContain('0xdeadbeef');
    });

    it('stays quiet for notes the wallet genuinely owns', async () => {
        await store.saveMany([{ note: note('0xgood') }]);

        expect(warn).not.toHaveBeenCalled();
    });
});
