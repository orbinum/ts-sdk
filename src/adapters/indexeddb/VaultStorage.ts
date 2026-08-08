/// <reference lib="dom" />
/**
 * `VaultStorage` over IndexedDB — the browser's copy of a wallet's notes.
 *
 * The DOM lib reference above is scoped to this file: the package's tsconfig
 * ships `lib: ["esnext"]`, so nothing outside this entry point can reach for a
 * browser API by accident.
 *
 * Ships in its own subpath so a consumer on Node, React Native or a worker
 * implements their own backend and never loads this module — the interface it
 * satisfies lives in the root entry.
 *
 * ## Object stores
 *
 *   vault_config      one record, id "main": schema version, scan cursor, the
 *                     ephemeral-index counters
 *   vault_notes       one record per note, keyed by its BLINDED commitment tag.
 *                     The note itself is encrypted and its identifiers are
 *                     blinded, so a database dump reveals nothing linkable to
 *                     chain activity while equality lookups still work.
 *   vault_tx_history  encrypted outgoing-transfer records
 *   nullifier_set     the spent-nullifier mirror. Public chain data, stored in
 *                     the clear on purpose: it is the same set every wallet
 *                     downloads, so encrypting it would protect nothing and
 *                     make membership checks cost a decrypt each.
 *   nullifier_sync    sync progress for the above
 *
 * The database NAME is supplied by the caller rather than fixed here. One vault
 * per (chain, account) is what keeps a wallet from reading notes that belong to
 * a different chain or a different key, and only the host knows those.
 */
import type {
    VaultStorage,
    VaultConfigRecord,
    EncryptedTxRecord,
    NullifierSyncMeta,
    SpendDetails,
    CachedNullifier,
} from '../../wallet/vault/index';
import type { EncryptedNoteRecord } from '../../wallet/vault/index';
import { idbRequest } from './idb';

const DB_VERSION = 1;
const STORE_CONFIG = 'vault_config';
const STORE_NOTES = 'vault_notes';
const STORE_TX_HISTORY = 'vault_tx_history';
const STORE_NULLIFIERS = 'nullifier_set';
const STORE_NULLIFIER_SYNC = 'nullifier_sync';

export interface IndexedDbVaultStorageOptions {
    /**
     * Database name. Use one per (chain, account): a vault opened against the
     * wrong chain holds notes whose commitments no longer exist, and one opened
     * under another account cannot decrypt anything it finds.
     */
    name: string;
    /**
     * IndexedDB factory. Defaults to the global one; pass a fake to test without
     * a browser.
     */
    indexedDB?: IDBFactory | undefined;
}

/** Browser-backed `VaultStorage`. One instance per database. */
export class IndexedDbVaultStorage implements VaultStorage {
    private readonly name: string;
    private readonly idb: IDBFactory;
    private db: IDBDatabase | null = null;

    constructor(options: IndexedDbVaultStorageOptions) {
        this.name = options.name;
        const factory = options.indexedDB ?? globalThis.indexedDB;
        if (!factory) {
            throw new Error(
                'IndexedDB is unavailable. Pass `indexedDB`, or use a different VaultStorage.'
            );
        }
        this.idb = factory;
    }

    private openDB(): Promise<IDBDatabase> {
        if (this.db) return Promise.resolve(this.db);

        return new Promise<IDBDatabase>((resolve, reject) => {
            const req = this.idb.open(this.name, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                for (const [store, keyPath] of [
                    [STORE_CONFIG, 'id'],
                    [STORE_NOTES, 'commitmentTag'],
                    [STORE_TX_HISTORY, 'id'],
                    [STORE_NULLIFIERS, 'h'],
                    [STORE_NULLIFIER_SYNC, 'id'],
                ] as const) {
                    if (!db.objectStoreNames.contains(store)) {
                        db.createObjectStore(store, { keyPath });
                    }
                }
            };

            req.onsuccess = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                // A connection closed underneath us (another tab upgrading, the
                // browser reclaiming it) must not stay cached, or every later
                // call fails against a dead handle.
                db.onclose = () => {
                    if (this.db === db) this.db = null;
                };
                db.onversionchange = () => {
                    db.close();
                    if (this.db === db) this.db = null;
                };
                this.db = db;
                resolve(db);
            };

            req.onerror = () =>
                reject(new Error(`Failed to open IndexedDB: ${String(req.error?.message)}`));
        });
    }

    /**
     * Runs one transaction, reopening once if the cached connection was already
     * dead.
     *
     * `onclose` does not fire in every closing path — notably a connection
     * killed between `openDB()` and the transaction call — so this retry is what
     * actually makes the adapter self-healing. `InvalidStateError` means "this
     * handle is finished", and a fresh one is the only fix. Once is enough: a
     * second failure is a real problem, not a stale handle.
     *
     * `run` must build its requests synchronously (no await before the last
     * one), or the transaction auto-commits underneath it.
     */
    private async withDB<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
        try {
            return await run(await this.openDB());
        } catch (err) {
            if ((err as DOMException | null)?.name !== 'InvalidStateError') throw err;
            this.db = null;
            return run(await this.openDB());
        }
    }

    // ── Config ───────────────────────────────────────────────────────────────

    async getConfig(): Promise<VaultConfigRecord | null> {
        return this.withDB(async (db) => {
            const tx = db.transaction(STORE_CONFIG, 'readonly');
            const result = await idbRequest<VaultConfigRecord | undefined>(
                tx.objectStore(STORE_CONFIG).get('main')
            );
            return result ?? null;
        });
    }

    async putConfig(config: VaultConfigRecord): Promise<void> {
        await this.withDB(async (db) => {
            const tx = db.transaction(STORE_CONFIG, 'readwrite');
            await idbRequest(tx.objectStore(STORE_CONFIG).put(config));
        });
    }

    /**
     * Read-modify-write in ONE transaction.
     *
     * Doing this as getConfig() then putConfig() spans two transactions, so two
     * concurrent callers both read the old record and the second write wins. For
     * `selfEphCounter` that lost increment means two notes derive the SAME
     * ephemeral index and publish one ephPk twice, linking them as
     * same-creator — a privacy leak, not a lost UI update. A single readwrite
     * transaction serialises them, since IndexedDB scopes those per store.
     */
    async updateConfig(
        mutate: (config: VaultConfigRecord) => VaultConfigRecord
    ): Promise<VaultConfigRecord | null> {
        return this.withDB(async (db) => {
            const tx = db.transaction(STORE_CONFIG, 'readwrite');
            const store = tx.objectStore(STORE_CONFIG);
            const current = await idbRequest<VaultConfigRecord | undefined>(store.get('main'));
            if (!current) return null;
            const updated = mutate(current);
            await idbRequest(store.put(updated));
            return updated;
        });
    }

    async hasVault(): Promise<boolean> {
        return (await this.getConfig()) !== null;
    }

    // ── Notes ────────────────────────────────────────────────────────────────

    async getAllNoteRecords(): Promise<EncryptedNoteRecord[]> {
        return this.withDB((db) => {
            const tx = db.transaction(STORE_NOTES, 'readonly');
            return idbRequest<EncryptedNoteRecord[]>(tx.objectStore(STORE_NOTES).getAll());
        });
    }

    async putNote(record: EncryptedNoteRecord): Promise<void> {
        await this.putNotes([record]);
    }

    async putNotes(records: EncryptedNoteRecord[]): Promise<void> {
        if (records.length === 0) return;
        await this.withDB(async (db) => {
            const tx = db.transaction(STORE_NOTES, 'readwrite');
            const store = tx.objectStore(STORE_NOTES);
            await Promise.all(records.map((r) => idbRequest(store.put(r))));
        });
    }

    async deleteNote(commitmentTag: string): Promise<void> {
        await this.deleteNotes([commitmentTag]);
    }

    async deleteNotes(commitmentTags: string[]): Promise<void> {
        if (commitmentTags.length === 0) return;
        await this.withDB(async (db) => {
            const tx = db.transaction(STORE_NOTES, 'readwrite');
            const store = tx.objectStore(STORE_NOTES);
            await Promise.all(commitmentTags.map((tag) => idbRequest(store.delete(tag))));
        });
    }

    async clearNotes(): Promise<void> {
        await this.withDB(async (db) => {
            const tx = db.transaction(STORE_NOTES, 'readwrite');
            await idbRequest(tx.objectStore(STORE_NOTES).clear());
        });
    }

    // ── Transaction history ──────────────────────────────────────────────────
    // Storage-dumb: rows are written and read as-is. Encryption lives in
    // VaultStore, which is what a caller should use.

    async addTxRecord(record: EncryptedTxRecord): Promise<void> {
        await this.withDB(async (db) => {
            const tx = db.transaction(STORE_TX_HISTORY, 'readwrite');
            await idbRequest(tx.objectStore(STORE_TX_HISTORY).put(record));
        });
    }

    async getAllTxRecords(): Promise<EncryptedTxRecord[]> {
        return this.withDB((db) => {
            const tx = db.transaction(STORE_TX_HISTORY, 'readonly');
            return idbRequest<EncryptedTxRecord[]>(tx.objectStore(STORE_TX_HISTORY).getAll());
        });
    }

    // ── Nullifier cache ──────────────────────────────────────────────────────

    /**
     * Persists one sealed chunk AND the sync progress it produced in a single
     * transaction. Both must land together: progress ahead of the data would
     * make the next sync resume past chunks that were never stored, leaving
     * spent notes looking unspent.
     */
    async putNullifierChunk(entries: CachedNullifier[], meta: NullifierSyncMeta): Promise<void> {
        await this.withDB(async (db) => {
            const tx = db.transaction([STORE_NULLIFIERS, STORE_NULLIFIER_SYNC], 'readwrite');
            const store = tx.objectStore(STORE_NULLIFIERS);
            await Promise.all([
                ...entries.map((e) => idbRequest(store.put(e))),
                idbRequest(tx.objectStore(STORE_NULLIFIER_SYNC).put(meta)),
            ]);
        });
    }

    async getNullifierSyncMeta(): Promise<NullifierSyncMeta | null> {
        return this.withDB(async (db) => {
            const tx = db.transaction(STORE_NULLIFIER_SYNC, 'readonly');
            const result = await idbRequest<NullifierSyncMeta | undefined>(
                tx.objectStore(STORE_NULLIFIER_SYNC).get('main')
            );
            return result ?? null;
        });
    }

    /**
     * Which of `hexes` the cache holds, as batch point-gets.
     *
     * Local lookups are the whole point: asking a server whether one specific
     * nullifier is spent would tell it which notes this wallet owns.
     */
    async getSpentNullifiers(hexes: string[]): Promise<Map<string, SpendDetails>> {
        if (hexes.length === 0) return new Map();
        return this.withDB(async (db) => {
            const tx = db.transaction(STORE_NULLIFIERS, 'readonly');
            const store = tx.objectStore(STORE_NULLIFIERS);
            const results = await Promise.all(
                hexes.map((h) => idbRequest<CachedNullifier | undefined>(store.get(h)))
            );
            return new Map(
                results
                    .filter((r): r is CachedNullifier => r !== undefined)
                    .map((r) => [r.h, { spentAt: r.ts ?? null, txHash: r.tx ?? null }])
            );
        });
    }

    async countNullifiers(): Promise<number> {
        return this.withDB((db) => {
            const tx = db.transaction(STORE_NULLIFIERS, 'readonly');
            return idbRequest<number>(tx.objectStore(STORE_NULLIFIERS).count());
        });
    }

    async clearNullifierCache(): Promise<void> {
        await this.withDB(async (db) => {
            const tx = db.transaction([STORE_NULLIFIERS, STORE_NULLIFIER_SYNC], 'readwrite');
            await Promise.all([
                idbRequest(tx.objectStore(STORE_NULLIFIERS).clear()),
                idbRequest(tx.objectStore(STORE_NULLIFIER_SYNC).clear()),
            ]);
        });
    }

    /** Closes the cached connection. The next call reopens it. */
    close(): void {
        this.db?.close();
        this.db = null;
    }
}
