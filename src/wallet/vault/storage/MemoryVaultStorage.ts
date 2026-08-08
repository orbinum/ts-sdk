/**
 * In-memory `VaultStorage`.
 *
 * Two roles, both real: the backend a Node consumer uses when persistence is
 * someone else's problem (a server that rebuilds state per request, a test
 * harness), and the second implementation the conformance suite runs against.
 * A contract verified by exactly one implementation only describes that one.
 *
 * Not durable — everything is lost when the process exits.
 */
import type { EncryptedNoteRecord } from './records';
import type {
    CachedNullifier,
    EncryptedTxRecord,
    NullifierSyncMeta,
    SpendDetails,
    VaultConfigRecord,
    VaultStorage,
} from './contract';

export class MemoryVaultStorage implements VaultStorage {
    private config: VaultConfigRecord | null = null;
    private readonly notes = new Map<string, EncryptedNoteRecord>();
    private readonly txRecords = new Map<string, EncryptedTxRecord>();
    private readonly nullifiers = new Map<string, SpendDetails>();
    private nullifierMeta: NullifierSyncMeta | null = null;

    /**
     * Serialises `updateConfig` calls. JavaScript is single-threaded, but an
     * async mutator could otherwise interleave with the next call's read and
     * lose an increment — the exact failure the contract forbids.
     */
    private configLock: Promise<unknown> = Promise.resolve();

    async getConfig(): Promise<VaultConfigRecord | null> {
        return this.config ? { ...this.config } : null;
    }

    async putConfig(config: VaultConfigRecord): Promise<void> {
        this.config = { ...config };
    }

    async updateConfig(
        mutate: (config: VaultConfigRecord) => VaultConfigRecord
    ): Promise<VaultConfigRecord | null> {
        const run = this.configLock.then(() => {
            if (!this.config) return null;
            this.config = { ...mutate({ ...this.config }) };
            return { ...this.config };
        });
        this.configLock = run.catch(() => undefined);
        return run;
    }

    async hasVault(): Promise<boolean> {
        return this.config !== null;
    }

    async getAllNoteRecords(): Promise<EncryptedNoteRecord[]> {
        return [...this.notes.values()];
    }

    async putNote(record: EncryptedNoteRecord): Promise<void> {
        this.notes.set(record.commitmentTag, { ...record });
    }

    async putNotes(records: EncryptedNoteRecord[]): Promise<void> {
        for (const record of records) this.notes.set(record.commitmentTag, { ...record });
    }

    async deleteNote(commitmentTag: string): Promise<void> {
        this.notes.delete(commitmentTag);
    }

    async deleteNotes(commitmentTags: string[]): Promise<void> {
        for (const tag of commitmentTags) this.notes.delete(tag);
    }

    async clearNotes(): Promise<void> {
        this.notes.clear();
    }

    async putNullifierChunk(entries: CachedNullifier[], meta: NullifierSyncMeta): Promise<void> {
        for (const e of entries) {
            this.nullifiers.set(e.h, { spentAt: e.ts ?? null, txHash: e.tx ?? null });
        }
        this.nullifierMeta = { ...meta };
    }

    async getNullifierSyncMeta(): Promise<NullifierSyncMeta | null> {
        return this.nullifierMeta ? { ...this.nullifierMeta } : null;
    }

    async getSpentNullifiers(hexes: string[]): Promise<Map<string, SpendDetails>> {
        const found = new Map<string, SpendDetails>();
        for (const hex of hexes) {
            const details = this.nullifiers.get(hex);
            if (details) found.set(hex, { ...details });
        }
        return found;
    }

    async countNullifiers(): Promise<number> {
        return this.nullifiers.size;
    }

    async clearNullifierCache(): Promise<void> {
        this.nullifiers.clear();
        this.nullifierMeta = null;
    }

    async addTxRecord(record: EncryptedTxRecord): Promise<void> {
        this.txRecords.set(record.id, { ...record });
    }

    async getAllTxRecords(): Promise<EncryptedTxRecord[]> {
        return [...this.txRecords.values()];
    }
}
