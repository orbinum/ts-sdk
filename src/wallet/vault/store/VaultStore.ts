/**
 * The wallet's notes: encrypted at rest, decrypted in memory, kept in step.
 *
 * Sits between the note crypto and a backend, owning the part neither can:
 * what a write means when the same note is already stored, and what happens
 * when a concurrent write lands mid-flight.
 *
 * ## The rule every mutation here follows
 *
 * Re-read the cache AFTER any await, then stay synchronous through to `set`.
 * Encrypting takes time; a rescan finishing in that window replaces the list,
 * and merging onto the snapshot taken before the await silently drops whatever
 * it stored. The dropped note is gone from the wallet's view until the next
 * full scan — no error, no warning.
 */
import { applyNoteStatus, encryptNote, noteBlindTag } from '../notes/record';
import { decryptJson, encryptJson } from '../crypto/keys';
import { applyBatch, isNoteSelfConsistent, removeByCommitment, upsertNote } from '../notes/merge';
import { writeConfig, normalizeChainFingerprint } from '../storage/config';
import { ensureCreatedAt, type NoteWithMeta, type TxKind } from '../notes/meta';
import { requireSessionKeys, type WalletSession } from '../session/WalletSession';
import { decryptStoredNotes, detectCommitmentMismatch, resetVaultToEmpty } from './unlock';
import type { NotesCache } from '../notes/cache';
import type {
    EncryptedTxRecord,
    NoteStorage,
    TxHistoryStore,
    VaultConfigRecord,
} from '../storage/contract';
import type { NoteStatusUpdate } from '../storage/records';
import type { ZkNote } from '../../../protocol/types';
import { isValidLeafIndex } from '../../../protocol/spend/index';

export interface VaultUnlockOptions {
    /** Genesis hash of the current chain. Detects notes carried over from another. */
    chainFingerprint?: string | null;
    /** Verifies a commitment still exists on-chain; false resets the vault. */
    validateCommitment?: (commitmentHex: string) => Promise<boolean>;
    /**
     * Record schema this build understands. A stored config at any other version
     * resets the vault.
     *
     * Worth checking explicitly rather than trusting decryption to fail: an old
     * record whose fields happen to decrypt would load with a shape this build
     * misreads, and the notes are recoverable by rescanning either way. Omit to
     * skip the check — correct only when the schema has never changed.
     */
    expectedSchemaVersion?: number;
    /**
     * Called when individual records could not be decrypted but others could.
     * The vault opens with what survived; a rescan recovers the rest. Worth
     * surfacing — a silently shorter note list looks like missing funds.
     */
    onRecordsSkipped?: (skipped: number, total: number) => void;
}

export interface VaultStoreDeps {
    storage: NoteStorage & TxHistoryStore;
    /** Supplies the keys. The store never derives or holds them itself. */
    session: WalletSession;
    /** The decrypted notes. A host wires this to its own reactive state. */
    notes: NotesCache;
    /** Called after the store opens a session, with the notes it decrypted. */
    onUnlocked?: (notes: ZkNote[]) => void;
}

/**
 * Fields an incoming note can fill in on a stored one, or null when it adds
 * nothing. Only ever fills a gap: a hash already stored wins, so a local stamp
 * from this wallet's own operation is never overwritten by a scan's guess.
 */
function txHashPatch(existing: ZkNote, incoming: ZkNote): Partial<NoteWithMeta> | null {
    const patch: Partial<NoteWithMeta> = {};
    const prev = existing as NoteWithMeta;
    const next = incoming as NoteWithMeta;

    if (!prev.createdTxHash && next.createdTxHash) patch.createdTxHash = next.createdTxHash;
    if (!prev.spentTxHash && next.spentTxHash) patch.spentTxHash = next.spentTxHash;
    if (Object.keys(patch).length === 0) return null;
    patch.txKind = prev.txKind ?? next.txKind ?? 'substrate';
    return patch;
}

/**
 * Warns about notes that are stored but can never be spent.
 *
 * A note whose spending key does not derive its own `ownerPk` is unspendable:
 * every spend path recomputes the commitment from `BabyPbk(spendingKey).Ax` and
 * rejects the mismatch. It is stored anyway rather than thrown on, because a
 * rescan can repair it from the on-chain memo — discarding it would lose the
 * only local record that the note exists.
 *
 * Reported once per write with a COUNT, not once per note: a rescan that
 * repaired a batch wrongly would otherwise emit hundreds of identical lines.
 * No commitment or nullifier is logged — printing a note identifier leaks it to
 * the console, which extensions, shared screens and bug reports all read.
 */
function warnIfUnspendable(notes: ZkNote[]): void {
    const broken = notes.filter((note) => !isNoteSelfConsistent(note)).length;
    if (broken === 0) return;
    // eslint-disable-next-line no-console
    console.warn(
        `[vault] storing ${broken} note(s) whose spending key does not match their ownerPk — ` +
            'they cannot be spent until a rescan repairs them'
    );
}

export class VaultStore {
    constructor(private readonly deps: VaultStoreDeps) {}

    private keys() {
        return requireSessionKeys(this.deps.session);
    }

    /**
     * Reads the stored vault back into memory under `aesKey`.
     *
     * Resets to empty — rather than failing — when what is stored cannot be
     * trusted: a different chain, a different key, or notes the chain no longer
     * recognises. Notes are recoverable by rescanning, so discarding beats
     * presenting a wallet whose contents are wrong.
     *
     * The caller opens the session; this reports whether a reset happened so a
     * host can prompt for a rescan.
     */
    async unlock(
        aesKey: CryptoKey,
        options: VaultUnlockOptions = {}
    ): Promise<{ wasReset: boolean; notes: ZkNote[] }> {
        const { storage } = this.deps;
        const chainFingerprint = normalizeChainFingerprint(options.chainFingerprint);
        const config = await storage.getConfig();
        const storedFingerprint = normalizeChainFingerprint(config?.chainFingerprint);

        // Checked before anything reads the record's fields: past this point the
        // code assumes the shape it was written against.
        if (
            options.expectedSchemaVersion !== undefined &&
            config !== null &&
            config.v !== options.expectedSchemaVersion
        ) {
            await resetVaultToEmpty(storage, config, chainFingerprint ?? storedFingerprint);
            return this.opened([], true);
        }

        if (storedFingerprint && chainFingerprint && storedFingerprint !== chainFingerprint) {
            await resetVaultToEmpty(storage, config, chainFingerprint);
            return this.opened([], true);
        }

        try {
            const notes = await decryptStoredNotes(storage, aesKey, options.onRecordsSkipped);

            if (await detectCommitmentMismatch(notes, options.validateCommitment)) {
                await resetVaultToEmpty(storage, config, chainFingerprint ?? storedFingerprint);
                return this.opened([], true);
            }

            // Merged atomically, not written from `config` — that snapshot was
            // taken before decrypting every note and before `validateCommitment`
            // awaited an RPC, and a shield reserving an ephemeral index in that
            // window would be rolled back into reuse.
            await writeConfig(storage, config, chainFingerprint ?? storedFingerprint);
            return this.opened(notes, false);
        } catch {
            // Authentication failure: the records were written under a
            // different spending key. A rescan recovers them.
            await resetVaultToEmpty(storage, config, chainFingerprint ?? undefined);
            return this.opened([], true);
        }
    }

    private opened(notes: ZkNote[], wasReset: boolean): { wasReset: boolean; notes: ZkNote[] } {
        this.deps.notes.set(notes);
        this.deps.onUnlocked?.(notes);
        return { wasReset, notes };
    }

    /** The decrypted notes. Empty while locked. */
    getAll(): ZkNote[] {
        return this.deps.notes.get();
    }

    /**
     * Writes one note.
     *
     * A note already stored is only rewritten when something actually changed —
     * its spend status, or a forest position it was missing. Without that last
     * case a pre-forest note would keep returning early and never gain its leaf
     * index, leaving same-tree coin selection blind to it.
     */
    async save(note: ZkNote, noteStatus?: NoteStatusUpdate, forceUpdate = false): Promise<void> {
        const { cryptoKey, blindKey } = this.keys();
        const vaultNote = applyNoteStatus(note, noteStatus);
        const existing = this.deps.notes.get().find((n) => n.commitmentHex === note.commitmentHex);

        if (
            existing &&
            !forceUpdate &&
            existing.spent === vaultNote.spent &&
            existing.spentAt === vaultNote.spentAt &&
            (existing.leafIndex !== undefined || vaultNote.leafIndex === undefined)
        ) {
            return;
        }

        const merged = !existing
            ? ensureCreatedAt(vaultNote)
            : forceUpdate
              ? vaultNote
              : {
                    ...existing,
                    spent: vaultNote.spent,
                    spentAt: vaultNote.spentAt,
                    ...(isValidLeafIndex(vaultNote.leafIndex)
                        ? { leafIndex: vaultNote.leafIndex }
                        : {}),
                };

        if (!existing) warnIfUnspendable([merged]);

        await this.deps.storage.putNote(await encryptNote(cryptoKey, blindKey, merged));
        this.deps.notes.set(upsertNote(this.deps.notes.get(), merged));
    }

    /**
     * Writes many notes with one bulk store write and one cache update, so a
     * host re-renders once per scan page rather than once per note.
     */
    async saveMany(
        entries: Array<{ note: ZkNote; noteStatus?: NoteStatusUpdate; forceUpdate?: boolean }>
    ): Promise<number> {
        const { cryptoKey, blindKey } = this.keys();
        if (entries.length === 0) return 0;

        // Keyed by commitment so repeated updates to the same note within one
        // batch collapse into a single record.
        const byCommitment = new Map(this.deps.notes.get().map((n) => [n.commitmentHex, n]));
        const toWrite = new Map<string, ZkNote>();

        for (const { note, noteStatus, forceUpdate = false } of entries) {
            const vaultNote = applyNoteStatus(note, noteStatus);
            const existing = byCommitment.get(note.commitmentHex);

            if (existing && !forceUpdate) {
                const hashPatch = txHashPatch(existing, vaultNote);
                if (
                    existing.spent === vaultNote.spent &&
                    existing.spentAt === vaultNote.spentAt &&
                    hashPatch === null
                ) {
                    continue;
                }
                const merged = {
                    ...existing,
                    spent: vaultNote.spent,
                    spentAt: vaultNote.spentAt,
                    ...hashPatch,
                };
                byCommitment.set(note.commitmentHex, merged);
                toWrite.set(note.commitmentHex, merged);
            } else {
                const stamped = existing ? vaultNote : ensureCreatedAt(vaultNote);
                byCommitment.set(note.commitmentHex, stamped);
                toWrite.set(note.commitmentHex, stamped);
            }
        }

        if (toWrite.size === 0) return 0;
        // Same guard `save` applies. This is the path a scan uses, so without it
        // an unspendable note enters the vault in silence and inflates the
        // balance with funds that can never move.
        warnIfUnspendable([...toWrite.values()]);

        const records = await Promise.all(
            [...toWrite.values()].map((n) => encryptNote(cryptoKey, blindKey, n))
        );
        await this.deps.storage.putNotes(records);
        // Apply only what this batch wrote, onto the current list. Replacing it
        // with `byCommitment` would erase anything saved while this batch was
        // encrypting — a wide window on a full rescan, which re-encrypts
        // every note.
        this.deps.notes.set(applyBatch(this.deps.notes.get(), toWrite));
        return records.length;
    }

    /**
     * Flags a note spent.
     *
     * `spend.txHash` is recorded only when the spending transaction is known —
     * this wallet spent it, or a scan resolved it from the nullifier set. A
     * note flipped by reconciliation omits it rather than storing a hash that
     * would render a dead explorer link.
     */
    async markSpent(
        commitmentHex: string,
        spentAt: number | null = Date.now(),
        spend: { txHash?: string | null; txKind?: TxKind } = {}
    ): Promise<void> {
        const { cryptoKey, blindKey } = this.keys();
        const target = this.deps.notes.get().find((n) => n.commitmentHex === commitmentHex);
        if (!target || target.spent) return;

        const updated = {
            ...target,
            spent: true,
            spentAt,
            ...(spend.txHash
                ? { spentTxHash: spend.txHash, txKind: spend.txKind ?? ('substrate' as TxKind) }
                : {}),
        };
        await this.deps.storage.putNote(await encryptNote(cryptoKey, blindKey, updated));

        // A note purged while this was encrypting is NOT resurrected: the purge
        // acted on the chain saying the note never existed, which outranks a
        // local spend flag.
        const current = this.deps.notes.get();
        if (!current.some((n) => n.commitmentHex === commitmentHex)) return;
        this.deps.notes.set(upsertNote(current, updated));
    }

    /** Deletes one note. */
    async remove(commitmentHex: string): Promise<void> {
        const { blindKey } = this.keys();
        // The stored key is the blinded tag, not the raw hex.
        await this.deps.storage.deleteNote(await noteBlindTag(blindKey, commitmentHex));
        this.deps.notes.set(removeByCommitment(this.deps.notes.get(), new Set([commitmentHex])));
    }

    /** Deletes many notes in one write. Unknown commitments are ignored. */
    async removeMany(commitmentHexes: string[]): Promise<number> {
        const { blindKey } = this.keys();
        if (commitmentHexes.length === 0) return 0;

        const toRemove = new Set(commitmentHexes);
        const present = this.deps.notes.get().filter((n) => toRemove.has(n.commitmentHex));
        if (present.length === 0) return 0;

        const tags = await Promise.all(present.map((n) => noteBlindTag(blindKey, n.commitmentHex)));
        await this.deps.storage.deleteNotes(tags);
        // Filter the current list: a note saved while the tags were being
        // derived must survive a removal that never targeted it.
        this.deps.notes.set(removeByCommitment(this.deps.notes.get(), toRemove));
        return present.length;
    }

    /**
     * Stores an outgoing transaction, encrypted.
     *
     * The chain cannot reveal what this wallet sent — that is the point of a
     * shielded transfer — so the record is the only account of it. The body is
     * encrypted; only the transaction hash stays plaintext, as the storage key.
     */
    async saveTxRecord<T extends { id: string }>(record: T): Promise<void> {
        const { cryptoKey } = this.keys();
        const { iv, ciphertext } = await encryptJson(cryptoKey, record);
        const stored: EncryptedTxRecord = {
            id: record.id,
            iv,
            ciphertext,
            updatedAt: Date.now(),
        };
        await this.deps.storage.addTxRecord(stored);
    }

    /**
     * Reads back the transaction history.
     *
     * Rows encrypted under a foreign key are skipped rather than thrown on:
     * they are leftovers from a previous key, and one of them must not make the
     * whole history unreadable.
     */
    async getTxRecords<T>(): Promise<T[]> {
        const { cryptoKey } = this.keys();
        const stored = await this.deps.storage.getAllTxRecords();
        const records: T[] = [];
        for (const row of stored) {
            try {
                records.push((await decryptJson(cryptoKey, row.iv, row.ciphertext)) as T);
            } catch {
                // Foreign key — unusable here; a rescan rebuilds it.
            }
        }
        return records;
    }

    /** The stored config, or null before a vault exists. */
    getConfig(): Promise<VaultConfigRecord | null> {
        return this.deps.storage.getConfig();
    }
}
