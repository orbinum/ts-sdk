/**
 * The unlock helpers — when a stored vault is discarded, and what survives.
 *
 * Every branch here decides between "reset" and "keep", and both directions
 * cost something real: a wrong reset drops notes the user has to rescan for, a
 * wrong keep shows a wallet whose contents do not match the chain. The
 * inconclusive cases (a validator that throws, an empty vault) are the ones
 * worth pinning down, because the safe answer there is to do nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    resetVaultToEmpty,
    detectCommitmentMismatch,
    decryptStoredNotes,
} from '../../../../src/wallet/vault/store/unlock';
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { VaultStore } from '../../../../src/wallet/vault/store/VaultStore';
import { createNotesCache } from '../../../../src/wallet/vault/notes/cache';
import { createWalletSession } from '../../../../src/wallet/vault/session/WalletSession';
import { buildConfig } from '../../../../src/wallet/vault/storage/config';
import {
    reserveSelfEphIndex,
    reserveOutgoingIndex,
} from '../../../../src/wallet/vault/storage/ephemeralIndex';
import { encryptNote } from '../../../../src/wallet/vault/notes/record';
import { deriveVaultKey, deriveVaultBlindKey } from '../../../../src/wallet/vault/crypto/keys';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../../src/protocol/types';

const MASTER = new Uint8Array(32).fill(7);
const OTHER_MASTER = new Uint8Array(32).fill(9);
const SPENDING_KEY = 12345678901234567890n;

const note = (over: Partial<ZkNote> = {}): ZkNote =>
    ({
        value: 100n,
        assetId: 0n,
        blinding: 42n,
        spendingKey: SPENDING_KEY,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        sourcePk: 0n,
        commitmentHex: '0xc1',
        nullifierHex: '0xn1',
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        ...over,
    }) as ZkNote;

describe('resetVaultToEmpty', () => {
    let storage: MemoryVaultStorage;

    beforeEach(() => {
        storage = new MemoryVaultStorage();
    });

    it('writes a fresh config on a first run, with nothing to clear', async () => {
        const clearNotes = vi.spyOn(storage, 'clearNotes');

        await resetVaultToEmpty(storage, null, '0xchain');

        expect(clearNotes).not.toHaveBeenCalled();
        expect(await storage.getConfig()).toMatchObject({ chainFingerprint: '0xchain', v: 5 });
    });

    it('clears the stored notes when a config already existed', async () => {
        await storage.putConfig(buildConfig(null));
        const key = await deriveVaultKey(MASTER);
        const blindKey = await deriveVaultBlindKey(MASTER);
        await storage.putNote(await encryptNote(key, blindKey, note()));

        await resetVaultToEmpty(storage, await storage.getConfig(), '0xchain');

        expect(await storage.getAllNoteRecords()).toEqual([]);
    });

    it('carries the ephemeral counters through the reset', async () => {
        // The notes are recoverable by rescanning; the counters are not. Losing
        // them would re-issue an ephemeral index and link two notes on chain.
        const existing = {
            ...buildConfig(null),
            selfEphCounter: 5,
            pairwiseCounterparties: { '0xaa': { nextIndex: 3, addedAt: 111 } },
        };
        await storage.putConfig(existing);

        await resetVaultToEmpty(storage, existing, '0xchain');

        const config = await storage.getConfig();
        expect(config?.selfEphCounter).toBe(5);
        expect(config?.pairwiseCounterparties?.['0xaa']?.nextIndex).toBe(3);
    });

    it('keeps the original createdAt', async () => {
        const existing = { ...buildConfig(null), createdAt: 1000 };
        await storage.putConfig(existing);

        await resetVaultToEmpty(storage, existing);

        expect((await storage.getConfig())?.createdAt).toBe(1000);
    });

    it('omits the fingerprint when none is given', async () => {
        await resetVaultToEmpty(storage, null);

        expect(await storage.getConfig()).not.toHaveProperty('chainFingerprint');
    });
});

describe('detectCommitmentMismatch', () => {
    it('reports a mismatch when the sampled commitment is gone from the chain', async () => {
        expect(await detectCommitmentMismatch([note()], async () => false)).toBe(true);
    });

    it('reports no mismatch when the commitment is still there', async () => {
        expect(await detectCommitmentMismatch([note()], async () => true)).toBe(false);
    });

    it('samples exactly ONE note, however many are stored', async () => {
        // Checking all of them would hand the node the wallet's entire
        // commitment set on every unlock — the linkage the scan design avoids.
        const validate = vi.fn().mockResolvedValue(true);
        const notes = Array.from({ length: 50 }, (_, i) => note({ commitmentHex: `0xc${i}` }));

        await detectCommitmentMismatch(notes, validate);

        expect(validate).toHaveBeenCalledTimes(1);
    });

    it('treats a throwing validator as inconclusive, not as a mismatch', async () => {
        // An RPC hiccup must not wipe a good vault.
        const validate = vi.fn().mockRejectedValue(new Error('rpc down'));

        expect(await detectCommitmentMismatch([note()], validate)).toBe(false);
    });

    it('does nothing without a validator', async () => {
        expect(await detectCommitmentMismatch([note()])).toBe(false);
    });

    it('does nothing for an empty vault', async () => {
        const validate = vi.fn();

        expect(await detectCommitmentMismatch([], validate)).toBe(false);
        expect(validate).not.toHaveBeenCalled();
    });
});

describe('decryptStoredNotes', () => {
    let storage: MemoryVaultStorage;
    let key: CryptoKey;
    let blindKey: CryptoKey;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        key = await deriveVaultKey(MASTER);
        blindKey = await deriveVaultBlindKey(MASTER);
    });

    it('reads every stored record back', async () => {
        await storage.putNotes([
            await encryptNote(key, blindKey, note({ commitmentHex: '0xc1' })),
            await encryptNote(key, blindKey, note({ commitmentHex: '0xc2' })),
        ]);

        const notes = await decryptStoredNotes(storage, key);

        expect(notes.map((n) => n.commitmentHex).sort()).toEqual(['0xc1', '0xc2']);
    });

    it('restores bigint fields as bigints, not as wrapper objects', async () => {
        await storage.putNote(await encryptNote(key, blindKey, note({ value: 999n })));

        const [restored] = await decryptStoredNotes(storage, key);

        expect(restored?.value).toBe(999n);
    });

    it('applies the record-level spent flags onto the decrypted note', async () => {
        const record = await encryptNote(key, blindKey, note());
        await storage.putNote({ ...record, spent: true, spentAt: 555 });

        const [restored] = await decryptStoredNotes(storage, key);

        expect(restored).toMatchObject({ spent: true, spentAt: 555 });
    });

    it('throws under a foreign key, which the caller reads as "different wallet"', async () => {
        await storage.putNote(await encryptNote(key, blindKey, note()));

        await expect(
            decryptStoredNotes(storage, await deriveVaultKey(OTHER_MASTER))
        ).rejects.toThrow();
    });

    it('returns nothing for an empty vault', async () => {
        expect(await decryptStoredNotes(storage, key)).toEqual([]);
    });
});

describe('decryptStoredNotes — partial corruption', () => {
    // Records are individually sealed, so one that fails to open says nothing
    // about the others. Failing the whole read used to discard every healthy
    // note beside it, turning one bad byte on disk into a full wallet wipe.
    let storage: MemoryVaultStorage;
    let key: CryptoKey;
    let blindKey: CryptoKey;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        key = await deriveVaultKey(MASTER);
        blindKey = await deriveVaultBlindKey(MASTER);
    });

    const store = async (...commitments: string[]) => {
        for (const c of commitments) {
            await storage.putNote(await encryptNote(key, blindKey, note({ commitmentHex: c })));
        }
    };

    /** Overwrites one stored record's ciphertext, as a disk fault would. */
    const corrupt = async (index: number) => {
        const records = await storage.getAllNoteRecords();
        await storage.putNote({ ...records[index]!, ciphertext: 'AAAA' });
    };

    it('keeps the readable notes when one record is corrupt', async () => {
        await store('0xc1', '0xc2', '0xc3');
        await corrupt(1);

        const notes = await decryptStoredNotes(storage, key);

        expect(notes).toHaveLength(2);
    });

    it('reports how many it skipped, so a host can explain the gap', async () => {
        // A silently shorter note list reads as missing funds.
        await store('0xc1', '0xc2', '0xc3');
        await corrupt(0);
        const onSkipped = vi.fn();

        await decryptStoredNotes(storage, key, onSkipped);

        expect(onSkipped).toHaveBeenCalledWith(1, 3);
    });

    it('does not report anything when every record opens', async () => {
        await store('0xc1', '0xc2');
        const onSkipped = vi.fn();

        await decryptStoredNotes(storage, key, onSkipped);

        expect(onSkipped).not.toHaveBeenCalled();
    });

    it('leaves the corrupt record on disk rather than deleting it', async () => {
        // Nothing here owns the decision to discard a record the user may still
        // recover — that is the caller's call, after a rescan.
        await store('0xc1', '0xc2');
        await corrupt(0);

        await decryptStoredNotes(storage, key);

        expect(await storage.getAllNoteRecords()).toHaveLength(2);
    });

    it('still throws when NOTHING opens — that is a wrong key, not a bad disk', async () => {
        await store('0xc1', '0xc2');
        await corrupt(0);
        await corrupt(1);

        await expect(decryptStoredNotes(storage, key)).rejects.toThrow(
            /no stored note could be decrypted/
        );
    });
});

describe('VaultStore.unlock — ephemeral counters', () => {
    // End-to-end guard on the caller, not on writeConfig. `unlock` reads the
    // config, then decrypts every note and awaits `validateCommitment` before
    // writing it back; a shield reserving an index inside that window used to be
    // rolled back, and the next reservation re-issued the same index. One ephPk
    // published twice links both notes on chain, and nothing local undoes it.
    const openVault = async () => {
        const storage = new MemoryVaultStorage();
        const key = await deriveVaultKey(MASTER);
        const blindKey = await deriveVaultBlindKey(MASTER);
        const session = createWalletSession();
        session.open(key, blindKey);
        const store = new VaultStore({ storage, session, notes: createNotesCache() });
        await store.unlock(key);
        // Stored notes matter: `unlock` decrypts each one before writing the
        // config back, and that is what holds the window open long enough for a
        // reservation to land inside it.
        for (const c of ['0xc1', '0xc2', '0xc3']) await store.save(note({ commitmentHex: c }));
        return { storage, key, session };
    };

    it('does not roll back an index reserved while unlock was in flight', async () => {
        const { storage, key, session } = await openVault();
        for (let i = 0; i < 10; i++) await reserveSelfEphIndex(storage);

        const reopened = new VaultStore({ storage, session, notes: createNotesCache() });
        const slowUnlock = reopened.unlock(key, {
            validateCommitment: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return true;
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const reservedMidFlight = await reserveSelfEphIndex(storage);
        await slowUnlock;

        expect(await reserveSelfEphIndex(storage)).not.toBe(reservedMidFlight);
    });

    it('does not roll back an outgoing reservation made during unlock', async () => {
        // A rolled-back outgoing counter hands out an index already published,
        // which republishes its ephPk and links the two payments in public.
        const { storage, key, session } = await openVault();
        await reserveOutgoingIndex(storage);

        const reopened = new VaultStore({ storage, session, notes: createNotesCache() });
        const slowUnlock = reopened.unlock(key, {
            validateCommitment: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return true;
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const reservedMidFlight = await reserveOutgoingIndex(storage);
        await slowUnlock;

        expect(await reserveOutgoingIndex(storage)).not.toBe(reservedMidFlight);
    });
});

describe('VaultStore.unlock — partial corruption', () => {
    it('opens with the surviving notes instead of resetting the vault', async () => {
        const storage = new MemoryVaultStorage();
        const key = await deriveVaultKey(MASTER);
        const blindKey = await deriveVaultBlindKey(MASTER);
        const session = createWalletSession();
        session.open(key, blindKey);
        const store = new VaultStore({ storage, session, notes: createNotesCache() });

        await store.unlock(key);
        for (const c of ['0xc1', '0xc2', '0xc3']) await store.save(note({ commitmentHex: c }));
        const records = await storage.getAllNoteRecords();
        await storage.putNote({ ...records[1]!, ciphertext: 'AAAA' });

        const onRecordsSkipped = vi.fn();
        const reopened = new VaultStore({ storage, session, notes: createNotesCache() });
        const result = await reopened.unlock(key, { onRecordsSkipped });

        expect(result.wasReset).toBe(false);
        expect(result.notes).toHaveLength(2);
        expect(onRecordsSkipped).toHaveBeenCalledWith(1, 3);
    });
});
