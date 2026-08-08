/**
 * persistScanResults / persistCursor — the write side of a scan, against a real
 * VaultStore over MemoryVaultStorage rather than a mocked repository.
 *
 * Two behaviours carry real cost if they regress: the ghost purge must never run
 * on an incremental window (it would delete notes from blocks it never fetched),
 * and a spending tx hash already recorded locally must survive a rescan.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { persistScanResults, persistCursor } from '../../../../src/wallet/scanner/phases/persist';
import { VaultStore } from '../../../../src/index';
import { MemoryVaultStorage } from '../../../../src/index';
import { createNotesCache } from '../../../../src/index';
import { createWalletSession } from '../../../../src/index';
import { deriveVaultKey, deriveVaultBlindKey } from '../../../../src/index';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../../src/protocol/types';
import type { SpendDetails } from '../../../../src/index';

const SPENDING_KEY = 12345678901234567890n;

function note(commitmentHex: string, overrides: Partial<ZkNote> = {}): ZkNote {
    return {
        commitmentHex,
        value: 100n,
        assetId: 0n,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        blinding: 7n,
        spendingKey: SPENDING_KEY,
        nullifierHex: `0xn${commitmentHex.slice(2)}`,
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        ...overrides,
    } as ZkNote;
}

const spend = (spentAt: number | null, txHash: string | null = null): SpendDetails => ({
    spentAt,
    txHash,
});

describe('persistScanResults', () => {
    let storage: MemoryVaultStorage;
    let vault: VaultStore;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        const session = createWalletSession();
        vault = new VaultStore({ storage, session, notes: createNotesCache() });
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    const persist = (params: Partial<Parameters<typeof persistScanResults>[0]> = {}) =>
        persistScanResults({
            vault,
            scanEntries: [],
            onChainHexes: new Set<string>(),
            hintsScanned: 1,
            spentMap: new Map(),
            isIncremental: false,
            ...params,
        });

    it('saves scanned notes with their spent status', async () => {
        await persist({
            scanEntries: [
                { note: note('0xa'), isNew: true },
                { note: note('0xb'), isNew: true },
            ],
            // Both were just seen in this window, so both are on-chain. Without
            // that the purge would delete 0xa (unspent and absent) before the
            // assertions run.
            onChainHexes: new Set(['0xa', '0xb']),
            spentMap: new Map([['0xnb', spend(5000, '0xtx')]]),
        });

        const saved = vault.getAll();
        expect(saved.find((n) => n.commitmentHex === '0xa')?.spent).toBe(false);
        const b = saved.find((n) => n.commitmentHex === '0xb');
        expect(b?.spent).toBe(true);
        expect(b?.spentAt).toBe(5000);
    });

    it('reconciles a memo-failed vault note that turned spent on-chain', async () => {
        // The note is in the vault but this pass could not decrypt its memo, so
        // it is absent from scanEntries — only the on-chain set proves it exists.
        await vault.save(note('0xold'));

        await persist({
            onChainHexes: new Set(['0xold']),
            spentMap: new Map([['0xnold', spend(7000)]]),
        });

        expect(vault.getAll()[0]?.spent).toBe(true);
    });

    it('purges ghosts on a full scan', async () => {
        await vault.save(note('0xghost'));
        await vault.save(note('0xreal'));

        const purged = await persist({
            onChainHexes: new Set(['0xreal']),
            preScanHexes: new Set(['0xghost', '0xreal']),
        });

        expect(purged).toBe(1);
        expect(vault.getAll().map((n) => n.commitmentHex)).toEqual(['0xreal']);
    });

    it('never purges on an incremental scan', async () => {
        // An incremental window only fetched recent leaves, so absence from its
        // on-chain set says nothing about a note from an earlier block.
        await vault.save(note('0xold'));

        const purged = await persist({ isIncremental: true, onChainHexes: new Set() });

        expect(purged).toBe(0);
        expect(vault.getAll()).toHaveLength(1);
    });

    it('keeps a locally recorded spending tx hash across an incremental scan', async () => {
        // We recorded the hash when we spent the note ourselves; the feed row may
        // carry none, and a rescan must not clobber it with null.
        await vault.save(note('0xa', { spentTxHash: '0xours' } as Partial<ZkNote>));

        await persist({
            isIncremental: true,
            scanEntries: [{ note: note('0xa'), isNew: false }],
            onChainHexes: new Set(['0xa']),
            spentMap: new Map([['0xna', spend(1000, null)]]),
        });

        expect((vault.getAll()[0] as { spentTxHash?: string }).spentTxHash).toBe('0xours');
    });

    it('rewrites an existing note wholesale on a full rescan', async () => {
        // forceUpdate on a full scan is the repair path: cryptographic fields
        // stored wrong by an older version (spendingKey, nullifier, ownerPk) are
        // overwritten from the freshly decrypted memo. Incremental scans skip it
        // to avoid redundant re-encryption.
        await vault.save(note('0xa', { blinding: 999n }));

        await persist({
            isIncremental: false,
            scanEntries: [{ note: note('0xa', { blinding: 7n }), isNew: false }],
            onChainHexes: new Set(['0xa']),
        });

        expect(vault.getAll()[0]?.blinding).toBe(7n);
    });

    it('writes everything in a single batch', async () => {
        // Both the scanned notes and the reconciliation feed one saveMany, so
        // subscribers re-render once per scan rather than once per note.
        let notifications = 0;
        const notes = createNotesCache();
        notes.subscribe(() => notifications++);
        const session = createWalletSession();
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        vault = new VaultStore({ storage, session, notes });

        await persist({
            scanEntries: [
                { note: note('0xa'), isNew: true },
                { note: note('0xb'), isNew: true },
                { note: note('0xc'), isNew: true },
            ],
            onChainHexes: new Set(['0xa', '0xb', '0xc']),
        });

        expect(notifications).toBe(1);
    });
});

describe('persistScanResults — the purge safety gate', () => {
    // A feed that served nothing has confirmed nothing, and the purge reads
    // `onChainHexes` inverted. Without this gate an unreachable or reset indexer
    // deleted every note in the vault on the next full scan.
    let storage: MemoryVaultStorage;
    let vault: VaultStore;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        const session = createWalletSession();
        vault = new VaultStore({ storage, session, notes: createNotesCache() });
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
        for (const c of ['0xa', '0xb', '0xc']) await vault.save(note(c));
    });

    const held = () =>
        vault
            .getAll()
            .map((n) => n.commitmentHex)
            .sort();

    it('keeps every note when the feed confirmed no commitments', async () => {
        const purged = await persistScanResults({
            vault,
            scanEntries: [],
            onChainHexes: new Set<string>(),
            spentMap: new Map<string, SpendDetails>(),
            isIncremental: false,
            preScanHexes: new Set(['0xa', '0xb', '0xc']),
            hintsScanned: 0,
        });

        expect(purged).toBe(0);
        expect(held()).toEqual(['0xa', '0xb', '0xc']);
    });

    it('warns rather than deleting silently', async () => {
        const onWarning = vi.fn();

        await persistScanResults({
            vault,
            scanEntries: [],
            onChainHexes: new Set<string>(),
            spentMap: new Map<string, SpendDetails>(),
            isIncremental: false,
            preScanHexes: new Set(['0xa', '0xb', '0xc']),
            hintsScanned: 0,
            onWarning,
        });

        expect(onWarning).toHaveBeenCalledOnce();
        expect(onWarning.mock.calls[0]?.[0]).toMatch(/skipped purging 3 note/);
    });

    it('still purges a genuine ghost once the feed confirmed something', async () => {
        // The gate must not disable the purge outright: a note the chain really
        // rolled back has to go, or coin selection keeps offering it.
        const purged = await persistScanResults({
            vault,
            scanEntries: [],
            onChainHexes: new Set(['0xa', '0xc']),
            spentMap: new Map<string, SpendDetails>(),
            isIncremental: false,
            preScanHexes: new Set(['0xa', '0xb', '0xc']),
            hintsScanned: 500,
        });

        expect(purged).toBe(1);
        expect(held()).toEqual(['0xa', '0xc']);
    });
});

describe('persistCursor', () => {
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    it('advances the cursor when the pass saw commitments', async () => {
        await persistCursor(storage, 4200, false);

        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(4200);
    });

    it('resets the cursor when a full scan saw nothing', async () => {
        await persistCursor(storage, 900, false);
        await persistCursor(storage, undefined, false);

        const config = await storage.getConfig();
        // The KEY must be gone, not set to undefined: a stored undefined would
        // round-trip through structured clone as a present key and read back as
        // a cursor on the next scan.
        expect(config && 'lastScannedLeafIndex' in config).toBe(false);
    });

    it('leaves the cursor alone when an incremental pass saw nothing', async () => {
        await persistCursor(storage, 900, false);
        await persistCursor(storage, undefined, true);

        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(900);
    });
});
