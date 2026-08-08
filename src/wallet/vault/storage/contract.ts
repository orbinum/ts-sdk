/**
 * The persistence contract a wallet's vault runs on.
 *
 * Split by responsibility rather than exposed as one interface: a consumer that
 * only decrypts notes never has to supply a nullifier cache, and an
 * implementation can grow one concern at a time. `VaultStorage` composes the
 * three for the common case.
 *
 * Every method is async because the reference backend is IndexedDB. Records
 * cross this boundary already encrypted and with identifiers blinded (see
 * `EncryptedNoteRecord`), so a backend never sees a commitment, a nullifier, or
 * an amount — which is what makes an untrusted or remote backend viable.
 */
import type { EncryptedNoteRecord } from './records';

/** Wallet-level state that is not a note: cursors and ephemeral-key counters. */
export interface VaultConfigRecord {
    id: 'main';
    /** Schema version of this record's shape. */
    v: number;
    /** Genesis hash the vault was last reconciled against. */
    chainFingerprint?: string;
    /** Highest leafIndex a completed scan processed; the next one resumes after it. */
    lastScannedLeafIndex?: number;
    /**
     * Next self-note ephemeral index.
     *
     * Monotonic, and that is a protocol requirement rather than bookkeeping:
     * reusing an index republishes the same ephPk and publicly links the two
     * notes as sharing a creator.
     */
    selfEphCounter?: number;
    /**
     * Counterparties whose payments can be recognised without a trial ECDH,
     * keyed by their packed viewing public key (lowercase hex). Each carries its
     * own counter, monotonic for the same reason as `selfEphCounter`.
     */
    pairwiseCounterparties?: Record<string, { nextIndex: number; addedAt: number }>;
    createdAt: number;
    updatedAt: number;
}

/** An encrypted entry in the local transaction history. */
export interface EncryptedTxRecord {
    /** Primary key — the transaction hash, the one field left in plaintext. */
    id: string;
    /** AES-GCM IV, base64. */
    iv: string;
    /** AES-GCM ciphertext of the record body, base64. */
    ciphertext: string;
    updatedAt: number;
}

/**
 * What is known locally about a spend, once a nullifier turns up in the set.
 *
 * Both fields are public chain data recovered from a set that always transfers
 * whole — neither implies a per-nullifier query.
 */
export interface SpendDetails {
    /** Spend block timestamp (ms); null when the source carried none. */
    spentAt: number | null;
    /** Hash of the spending transaction; null when the extrinsic was unresolvable. */
    txHash: string | null;
}

/**
 * One entry of the spent-nullifier set, stored as it arrives.
 *
 * Field names are terse because there is one record per spent note on the
 * chain: at millions of notes the key strings are a material share of the
 * cache's size on disk.
 */
export interface CachedNullifier {
    /** The nullifier hex, as the source publishes it. Primary key. */
    h: string;
    /** Spend block timestamp (ms); null when the source carried none. */
    ts: number | null;
    /** Hash of the spending transaction; null when unresolvable. */
    tx?: string | null;
}

/** Progress of the nullifier-set download, so a sync resumes instead of restarting. */
export interface NullifierSyncMeta {
    id: 'main';
    /** Sealed chunks already stored. */
    chunksDone: number;
    /** Generation of the set the stored chunks belong to; a change invalidates them. */
    generation: string;
    totalStored: number;
    updatedAt: number;
}

/** Config and note persistence — the minimum a wallet needs to hold funds. */
export interface NoteStorage {
    getConfig(): Promise<VaultConfigRecord | null>;
    putConfig(config: VaultConfigRecord): Promise<void>;
    /**
     * Applies `mutate` to the stored config as ONE atomic read-modify-write.
     *
     * Part of the contract, not sugar over get + put. Two concurrent callers
     * doing that separately both read the same `selfEphCounter`, so both derive
     * the same ephemeral index and publish the same ephPk — a privacy leak, not
     * a lost update. A backend that cannot make this atomic cannot host a vault.
     *
     * Resolves to null when no config exists; `mutate` is not called.
     */
    updateConfig(
        mutate: (config: VaultConfigRecord) => VaultConfigRecord
    ): Promise<VaultConfigRecord | null>;

    getAllNoteRecords(): Promise<EncryptedNoteRecord[]>;
    putNote(record: EncryptedNoteRecord): Promise<void>;
    putNotes(records: EncryptedNoteRecord[]): Promise<void>;
    deleteNote(commitmentTag: string): Promise<void>;
    deleteNotes(commitmentTags: string[]): Promise<void>;
    clearNotes(): Promise<void>;
}

/**
 * Local mirror of the spent-nullifier set.
 *
 * The whole set is downloaded and intersected locally, deliberately: asking a
 * server whether one specific nullifier is spent would tell it which notes the
 * wallet holds. That is why this is a cache to fill, not a lookup to call.
 */
export interface NullifierCache {
    /**
     * Stores one sealed chunk together with the sync progress it produced.
     *
     * Both must land in the same transaction: progress ahead of the data would
     * make the next sync resume past chunks the cache never stored, leaving
     * spent notes looking unspent.
     */
    putNullifierChunk(entries: CachedNullifier[], meta: NullifierSyncMeta): Promise<void>;
    getNullifierSyncMeta(): Promise<NullifierSyncMeta | null>;
    /**
     * Which of `hexes` the cache holds. Absent keys are unspent as far as it
     * knows.
     *
     * Matching is EXACT: a backend must not lowercase, trim or otherwise repair
     * a key. Normalising happens once at ingestion, where the feed's rows are
     * lowercased on the way into `putNullifierChunk` — so everything stored is
     * already in one form, and a backend that "helpfully" normalised again
     * would only hide a caller passing the wrong case.
     *
     * Both sides must agree, and the cost of disagreeing is not a missing row:
     * a lookup that misses reports a SPENT note as unspent, the wallet offers
     * it, and the spend dies on a duplicate nullifier.
     */
    getSpentNullifiers(hexes: string[]): Promise<Map<string, SpendDetails>>;
    countNullifiers(): Promise<number>;
    clearNullifierCache(): Promise<void>;
}

/** Encrypted local transaction history — outgoing sends the chain cannot reveal. */
export interface TxHistoryStore {
    addTxRecord(record: EncryptedTxRecord): Promise<void>;
    getAllTxRecords(): Promise<EncryptedTxRecord[]>;
}

/** Everything a full wallet needs from persistence. */
export interface VaultStorage extends NoteStorage, NullifierCache, TxHistoryStore {
    /** Whether a vault already exists for this identity. */
    hasVault(): Promise<boolean>;
}
