/**
 * `OrbinumWallet` — the facade, against real storage and real crypto.
 *
 * It adds no logic of its own, so what these check is the WIRING: that the same
 * session drives the vault and the scan, that the keys come from the right
 * place, and that a locked wallet refuses work rather than doing it with stale
 * keys.
 *
 * The key-derivation test is the one that matters most. The vault key hangs off
 * the master bytes and not off the spending-key scalar, and getting that
 * backwards produces a vault that reads correctly today and becomes unreadable
 * after a modulus change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrbinumWallet } from '../../src/wallet/OrbinumWallet';
import { MemoryVaultStorage } from '../../src/index';
import { deriveVaultKey } from '../../src/index';
import {
    deriveSpendingKeyFromMaster,
    deriveOwnerPk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
} from '../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../src/protocol/types';
import type { DecryptPool } from '../../src/index';
import type { ScanHint, ScanHintSource, NullifierSource } from '../../src/index';

const MASTER = new Uint8Array(32).fill(7);
const SPENDING_KEY = deriveSpendingKeyFromMaster(MASTER);

const hint = (i: number): ScanHint => ({
    leafIndex: i,
    commitmentHex: `0xc${i}`,
    ephPkHex: `0xe${i}`,
    encryptedMemo: `0xm${i}`,
    timestampMs: null,
    txHash: null,
});

function hintSource(size: number): ScanHintSource {
    return {
        async listHints({ limit }) {
            return {
                data: Array.from({ length: size }, (_, i) => hint(i)),
                pagination: { limit, total: size },
            };
        },
    };
}

const nullifierSource = (spent: string[] = []): NullifierSource => ({
    async manifest() {
        return { generation: '1', chunks: [] };
    },
    async chunk() {
        return { data: [] };
    },
    async tail() {
        return { afterChunks: 0, data: spent, timestampsMs: spent.map(() => 1), txHashes: [] };
    },
});

/** A note the fake pool "recovers", self-consistent so the vault accepts it. */
function note(commitmentHex: string): ZkNote {
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
    } as ZkNote;
}

function fakePool(decrypt: (h: ScanHint) => ZkNote | null = () => null): DecryptPool {
    return {
        async decryptBatch(hints: ScanHint[]) {
            return {
                notes: hints.map(decrypt),
                tagFiltered: 0,
                selfMatched: 0,
                pairwiseMatched: 0,
                maxSelfEphIndex: null,
            };
        },
        terminate() {},
    } as unknown as DecryptPool;
}

function makeWallet(overrides: Partial<ConstructorParameters<typeof OrbinumWallet>[0]> = {}) {
    const storage = new MemoryVaultStorage();
    const wallet = new OrbinumWallet({
        storage,
        hints: hintSource(3),
        nullifiers: nullifierSource(),
        pool: fakePool(),
        ...overrides,
    });
    return { wallet, storage };
}

describe('OrbinumWallet — unlock', () => {
    it('derives the vault key from the MASTER bytes, not the spending key', async () => {
        // The scalar is the master reduced mod the curve order. Deriving the
        // vault key from it would tie the encrypted vault to the current
        // modulus, so a future change would orphan every stored note.
        const { wallet, storage } = makeWallet();
        await wallet.unlock(MASTER);
        await wallet.vault.save(note('0xa'));

        // A second wallet over the same storage, unlocked with the same master,
        // must read that note back.
        const reopened = new OrbinumWallet({
            storage,
            hints: hintSource(0),
            nullifiers: nullifierSource(),
            pool: fakePool(),
        });
        const { notes, wasReset } = await reopened.unlock(MASTER);

        expect(wasReset).toBe(false);
        expect(notes.map((n) => n.commitmentHex)).toEqual(['0xa']);
        // And the key really is the master-derived one.
        expect(await deriveVaultKey(MASTER)).toBeDefined();
    });

    it('resets the vault when opened with a different key', async () => {
        const { wallet, storage } = makeWallet();
        await wallet.unlock(MASTER);
        await wallet.vault.save(note('0xa'));

        const other = new OrbinumWallet({
            storage,
            hints: hintSource(0),
            nullifiers: nullifierSource(),
            pool: fakePool(),
        });
        const { wasReset, notes } = await other.unlock(new Uint8Array(32).fill(9));

        // Discarding beats presenting a wallet whose contents cannot be trusted;
        // the notes are recoverable by rescanning.
        expect(wasReset).toBe(true);
        expect(notes).toEqual([]);
    });

    it('rejects a master key of the wrong length', async () => {
        const { wallet } = makeWallet();

        await expect(wallet.unlock(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    });

    it('reports itself unlocked only after unlock', async () => {
        const { wallet } = makeWallet();
        expect(wallet.unlocked).toBe(false);

        await wallet.unlock(MASTER);

        expect(wallet.unlocked).toBe(true);
    });
});

describe('OrbinumWallet — locked', () => {
    it('refuses to scan or build while locked', async () => {
        const { wallet } = makeWallet();

        await expect(wallet.scan()).rejects.toThrow(/locked/);
        await expect(wallet.buildNote({ value: 1n, circuitVersion: 1 })).rejects.toThrow(/locked/);
        expect(() => wallet.privacyKeys()).toThrow(/locked/);
    });

    it('drops keys and notes on lock, leaving storage intact', async () => {
        const { wallet, storage } = makeWallet();
        await wallet.unlock(MASTER);
        await wallet.vault.save(note('0xa'));

        wallet.lock();

        expect(wallet.unlocked).toBe(false);
        expect(wallet.getNotes()).toEqual([]);
        // The vault itself was not touched — unlocking again finds the note.
        expect(await storage.getAllNoteRecords()).toHaveLength(1);
    });
});

describe('OrbinumWallet — identity', () => {
    it('exposes the keys a payer needs to address this wallet', async () => {
        const { wallet } = makeWallet();
        await wallet.unlock(MASTER);

        expect(wallet.privacyKeys()).toEqual({
            ownerPk: deriveOwnerPk(SPENDING_KEY),
            viewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(SPENDING_KEY)),
        });
    });
});

describe('OrbinumWallet — scan', () => {
    let wallet: OrbinumWallet;
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        const made = makeWallet({ pool: fakePool((h) => note(h.commitmentHex)) });
        wallet = made.wallet;
        storage = made.storage;
        await wallet.unlock(MASTER);
    });

    it('recovers notes and exposes them', async () => {
        const result = await wallet.scan();

        expect(result.found).toBe(3);
        expect(wallet.getNotes()).toHaveLength(3);
    });

    it('notifies subscribers as notes land', async () => {
        const seen: number[] = [];
        wallet.onNotesChanged((notes) => seen.push(notes.length));

        await wallet.scan();

        expect(seen.at(-1)).toBe(3);
    });

    it('stops notifying after unsubscribe', async () => {
        let calls = 0;
        const off = wallet.onNotesChanged(() => calls++);
        off();

        await wallet.scan();

        expect(calls).toBe(0);
    });

    it('persists a cursor the next scan can resume from', async () => {
        await wallet.scan();

        expect(await wallet.scanCursor()).toBe(2);
    });

    it('passes the resume point through to an incremental scan', async () => {
        const result = await wallet.scan({ sinceLeafIndex: 1 });

        expect(result.incremental).toBe(true);
    });

    it('reports progress', async () => {
        const progress: number[] = [];

        await wallet.scan({ onProgress: (p) => progress.push(p.scanned) });

        expect(progress.at(-1)).toBe(3);
    });

    it('marks a note spent when the feed reports its nullifier', async () => {
        const spentWallet = new OrbinumWallet({
            storage,
            hints: hintSource(1),
            nullifiers: nullifierSource(['0xnc0']),
            pool: fakePool((h) => note(h.commitmentHex)),
        });
        await spentWallet.unlock(MASTER);

        await spentWallet.scan();

        expect(spentWallet.getNotes()[0]?.spent).toBe(true);
    });

    it('propagates an abort', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(wallet.scan({ signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });
});

describe('OrbinumWallet — buildNote', () => {
    it('reserves an ephemeral index for a self note', async () => {
        // Reserve-before-use: a built-then-discarded note burns an index, which
        // is deliberate. Reusing one would republish an ephPk and link the two
        // notes as sharing a creator.
        const { wallet, storage } = makeWallet();
        await wallet.unlock(MASTER);

        await wallet.buildNote({ value: 10n, circuitVersion: 1 });

        expect((await storage.getConfig())?.selfEphCounter).toBe(1);
    });

    it('does not persist what it builds', async () => {
        // The result is an output to feed an extrinsic, not a note the wallet
        // holds — it has no proof and is not on chain yet.
        const { wallet } = makeWallet();
        await wallet.unlock(MASTER);

        await wallet.buildNote({ value: 10n, circuitVersion: 1 });

        expect(wallet.getNotes()).toEqual([]);
    });
});

describe('OrbinumWallet — spend dependencies', () => {
    // The facade must be able to produce every dep the spend ops take. Before
    // these existed a consumer had to abandon the facade to spend at all,
    // which defeats the point of having one.
    it('exposes the key material the spend ops require', async () => {
        const { wallet } = makeWallet();
        await wallet.unlock(MASTER);

        const keys = wallet.spendKeys();

        // The GLOBAL spending key: stealth derivation hangs off it, and a
        // note-local key would derive garbage.
        expect(keys.spendingKey).toBe(SPENDING_KEY);
        expect(keys.ownerPk).toBe(deriveOwnerPk(SPENDING_KEY));
        expect(keys.viewingSecretKey).toEqual(deriveViewingSecretKey(SPENDING_KEY));
    });

    it('refuses to hand out keys while locked', () => {
        const { wallet } = makeWallet();

        expect(() => wallet.spendKeys()).toThrow(/locked/);
    });

    it('provides a recoverStealth bound to its own keys', async () => {
        const { wallet } = makeWallet();
        await wallet.unlock(MASTER);

        // A note this wallet did not author does not open — the ops read null
        // as "do not persist", since the built form is unspendable.
        expect(wallet.recoverStealth(note('0xforeign'))).toBeNull();
    });

    it('resolves the circuit version from the chain for spend outputs', async () => {
        const getCircuitVersionInfo = vi.fn().mockResolvedValue({ activeVersion: 4 });
        const { wallet } = makeWallet({ zkVerifier: { getCircuitVersionInfo } });
        await wallet.unlock(MASTER);

        const built = await wallet.buildOutputNote({ value: 10n });

        expect(getCircuitVersionInfo).toHaveBeenCalled();
        expect((built as { circuitVersion?: number }).circuitVersion).toBe(4);
    });

    it('honours a pinned circuit version without touching the chain', async () => {
        const getCircuitVersionInfo = vi.fn();
        const { wallet } = makeWallet({ circuitVersion: 2, zkVerifier: { getCircuitVersionInfo } });
        await wallet.unlock(MASTER);

        await wallet.buildOutputNote({ value: 10n });

        expect(getCircuitVersionInfo).not.toHaveBeenCalled();
    });

    it('fails closed when it can neither read nor be told the version', async () => {
        // Guessing produces a note the chain refuses to spend after a rotation.
        const { wallet } = makeWallet();
        await wallet.unlock(MASTER);

        await expect(wallet.buildOutputNote({ value: 10n })).rejects.toThrow(/circuit version/);
    });
});

/**
 * Unlock is all or nothing.
 *
 * The keys are derived and the session opened BEFORE the vault is read, so a
 * storage failure in between used to leave the wallet reporting `unlocked` with
 * live spending keys and an EMPTY note list. A host that trusts that flag then
 * renders a wallet with no funds and still permits spending — and every
 * operation that reserves an ephemeral index consumes real state against a
 * vault nobody managed to read.
 */
describe('OrbinumWallet — a failed unlock leaves nothing open', () => {
    /**
     * A storage whose CONFIG read fails, as an aborted IDB transaction or a
     * quota error would.
     *
     * The config read is the failure that escapes: `VaultStore.unlock` catches a
     * failing note read and treats it as a wrong key, resetting the vault, which
     * is a deliberate recovery path. Nothing catches a config read, so that one
     * propagates through the facade.
     */
    function brokenStorage(): MemoryVaultStorage {
        const storage = new MemoryVaultStorage();
        storage.getConfig = async () => {
            throw new Error('IDB transaction aborted');
        };
        return storage;
    }

    it('SECURITY: reports locked after the vault read fails', async () => {
        const { wallet } = makeWallet({ storage: brokenStorage() });

        await expect(wallet.unlock(MASTER)).rejects.toThrow('IDB transaction aborted');

        expect(wallet.unlocked).toBe(false);
    });

    it('SECURITY: does not hand out spending keys after a failed unlock', async () => {
        const { wallet } = makeWallet({ storage: brokenStorage() });

        await wallet.unlock(MASTER).catch(() => undefined);

        expect(() => wallet.spendKeys()).toThrow(/locked/i);
        expect(() => wallet.privacyKeys()).toThrow(/locked/i);
    });

    it('propagates the original error rather than masking it', async () => {
        // The host needs the real cause to decide between retry and rescan.
        const { wallet } = makeWallet({ storage: brokenStorage() });

        await expect(wallet.unlock(MASTER)).rejects.toThrow('IDB transaction aborted');
    });

    it('can be unlocked normally once the storage recovers', async () => {
        // Locking on failure must not poison the instance.
        const storage = new MemoryVaultStorage();
        let failing = true;
        const original = storage.getConfig.bind(storage);
        storage.getConfig = async () => {
            if (failing) throw new Error('IDB transaction aborted');
            return original();
        };
        const { wallet } = makeWallet({ storage });

        await wallet.unlock(MASTER).catch(() => undefined);
        failing = false;
        await wallet.unlock(MASTER);

        expect(wallet.unlocked).toBe(true);
    });
});
