/**
 * `OrbinumWallet` — the assembled wallet: keys, vault, scanner, note building.
 *
 * A convenience layer, not a new capability. Everything it does is available
 * from the pieces it wires (`VaultStore`, `runScan`, `buildZkNote`), and a host
 * that needs a different shape should use those directly rather than work around
 * this. What the facade buys is that the pieces are wired the way they must be
 * wired — the same session driving the vault and the scan, the same storage
 * holding the notes and the ephemeral counters.
 *
 * Deliberately NOT here: SUBMITTING transactions. A spend needs a chain client,
 * a signer and a proving backend, all of which differ per host, so the transport
 * stays the host's. Everything up to it does not: `spendKeys`, `recoverStealth`
 * and `buildOutputNote` produce exactly the dependencies `transferNotes` and
 * `unshieldNote` take, so a consumer wires those two ops without reaching around
 * the facade for key material.
 */
import { VaultStore } from './vault/index';
import { createNotesCache } from './vault/index';
import { createWalletSession } from './vault/index';
import { deriveVaultKey, deriveVaultBlindKey } from './vault/index';
import { assertSecretKeyBytes } from '../foundation/crypto/keyGuards';
import { deriveIdentity } from './identity/walletIdentity';
import type { WalletIdentity } from './identity/walletIdentity';
import type { IdentityVersion } from './identity/vaultName';
import { runScan } from './scanner/index';
import { buildZkNote, buildZkNoteWithIndex, recoverSelfStealthNote } from './ops/index';
import { chainActiveCircuitVersion } from './ops/index';
import type { BuildNoteParams } from './ops/index';
import type { VaultStorage, MutableWalletSession } from './vault/index';
import type { ObservableNotesCache, VaultUnlockOptions } from './vault/index';
import type { DecryptPool } from './worker/index';
import type { NullifierSource, ScanHintSource } from './scanner/index';
import type { ScanProgress, ScanResult } from './scanner/index';
import type { ZkNote } from '../protocol/types';
import type { ZkVerifierModule } from '../chain/pallet/zk-verifier/ZkVerifierModule';

export interface OrbinumWalletConfig {
    /** Where the vault lives. `MemoryVaultStorage` for Node, IndexedDB in a browser. */
    storage: VaultStorage;
    /** The commitment feed the scanner walks. */
    hints: ScanHintSource;
    /** The spent-nullifier feed. Never queried per nullifier — see `NullifierSource`. */
    nullifiers: NullifierSource;
    /**
     * Where trial decryption runs. Pass a worker-backed pool in a browser; a
     * main-thread pool (`createDecryptPool({ factory: null })`) is fine on a
     * server, where blocking the loop costs nothing visible.
     */
    pool: DecryptPool;
    /**
     * Leaf at which the chain began emitting view tags. Hints below it carry
     * none, so the fast filter must not apply to them. Null disables it.
     */
    viewTagActivationLeaf?: number | null | undefined;
    /** Non-fatal diagnostics from a scan. */
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
    /**
     * Reads the chain's active circuit version for newly built notes. Required
     * to build spend outputs unless `circuitVersion` is pinned.
     */
    zkVerifier?: Pick<ZkVerifierModule, 'getCircuitVersionInfo'> | undefined;
    /**
     * Pins the circuit version instead of reading it. For tests and for a host
     * that already resolved it — a wrong value yields unspendable notes.
     */
    circuitVersion?: number | undefined;
    /**
     * Which derivation scheme this wallet's keys come from.
     *
     * Only `v3` exists, so this is here for the NEXT scheme rather than for a
     * choice available today — passing it changes nothing. v2 was removed, not
     * deprecated: it chained the viewing key off the spending key, which made a
     * watch-only wallet impossible and left no branch to hang the outgoing
     * viewing key on.
     */
    identityVersion?: IdentityVersion | undefined;
}

export interface ScanOptions {
    /**
     * Resume from this leaf. Omit for a full scan, which is also the only mode
     * that purges notes the chain no longer has — an incremental window cannot
     * tell "gone" from "not fetched".
     */
    sinceLeafIndex?: number | undefined;
    onProgress?: ((p: ScanProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
}

export class OrbinumWallet {
    private readonly session: MutableWalletSession;
    private readonly notes: ObservableNotesCache;
    private readonly vaultStore: VaultStore;
    /**
     * The identity this wallet is unlocked as, or null.
     *
     * Held as a bundle rather than a single scalar because v3 keys are SIBLINGS:
     * the spending key no longer produces the viewing key, so there is nothing
     * left to derive the others from once unlock returns. Keeping the root out
     * of this object is deliberate — the branches are what the wallet needs, and
     * the root is the thing worth not retaining.
     */
    private identity: WalletIdentity | null = null;

    constructor(private readonly config: OrbinumWalletConfig) {
        this.session = createWalletSession();
        this.notes = createNotesCache();
        this.vaultStore = new VaultStore({
            storage: config.storage,
            session: this.session,
            notes: this.notes,
        });
    }

    /** The underlying store, for operations the facade does not cover. */
    get vault(): VaultStore {
        return this.vaultStore;
    }

    get unlocked(): boolean {
        return this.session.unlocked && this.identity !== null;
    }

    /**
     * Opens the wallet from the master key bytes a `SpendingKeyRequest`
     * signature produces — the same value `PrivacyKeyManager.getMasterBytes()`
     * returns.
     *
     * Master bytes rather than the spending-key scalar, deliberately: the master
     * is the root EVERY branch hangs off — spending key, viewing key, outgoing
     * viewing key and vault key are each their own HKDF of it, none derived
     * from another. Only `ownerPk` comes from the spending scalar, because the
     * circuit defines it that way.
     *
     * It is also what keeps a stored vault readable across a modulus change:
     * the vault key is derived pre-reduction.
     *
     * Reports whether the stored vault was RESET: a different chain, a different
     * key, or notes the chain no longer recognises. When it was, the wallet
     * holds nothing until a full scan runs.
     *
     * All or nothing: if reading the vault fails, the wallet locks itself again
     * before the error propagates. A half-open wallet is worse than a closed
     * one — it reports `unlocked` with live keys and an EMPTY note list, so a
     * host renders a wallet with no funds and still lets the user spend, while
     * every operation that reserves an ephemeral index consumes real state
     * against a vault that was never read.
     */
    async unlock(
        masterBytes: Uint8Array,
        options: VaultUnlockOptions = {}
    ): Promise<{ wasReset: boolean; notes: ZkNote[] }> {
        // Length AND usability: an all-zero master is 32 bytes, so a
        // length-only check let it through to derive an identity every other
        // wallet also derives. `deriveIdentity` rejects it, but a level deeper —
        // after the session is already open.
        assertSecretKeyBytes(masterBytes, 'Master key');

        this.session.open(
            await deriveVaultKey(masterBytes),
            await deriveVaultBlindKey(masterBytes)
        );
        this.identity = deriveIdentity(masterBytes, this.config.identityVersion ?? 'v3');

        try {
            return await this.vaultStore.unlock(this.session.cryptoKey!, options);
        } catch (err) {
            this.lock();
            throw err;
        }
    }

    /** Drops the in-memory keys. The stored vault is untouched. */
    lock(): void {
        this.session.lock();
        this.identity = null;
        this.notes.set([]);
        // The pool caches a discovery window holding one ECDH shared secret per
        // index, all derived from the viewing key. It outlives a scan by design
        // and so outlived a lock too: the session keys were dropped while tens
        // of KB of secret material stayed reachable in module memory — on a
        // main-thread pool, the page's own heap.
        //
        // `terminate` is what drops it, and it is safe to call here: a
        // worker-backed pool respawns on the next scan, and the main-thread
        // pool only clears the cache. Failures are swallowed because locking
        // must always succeed — a lock that throws leaves the wallet unlocked.
        try {
            this.config.pool.terminate();
        } catch {
            // Nothing actionable: the keys and notes above are already gone.
        }
    }

    /** The notes currently held. Empty while locked. */
    getNotes(): ZkNote[] {
        return this.notes.get();
    }

    /** Subscribes to note changes. Returns an unsubscribe function. */
    onNotesChanged(listener: (notes: ZkNote[]) => void): () => void {
        return this.notes.subscribe(listener);
    }

    /** This wallet's privacy identity: the keys a payer needs to address it. */
    privacyKeys(): { ownerPk: bigint; viewingPublicKey: Uint8Array } {
        const { ownerPk, viewingPublicKey } = this.requireIdentity();
        return { ownerPk, viewingPublicKey };
    }

    /**
     * Walks the feed, recovers this wallet's notes, and persists them with their
     * spent status.
     *
     * Resume from the stored cursor for an incremental pass; omit
     * `sinceLeafIndex` for a full scan, which is what a restore needs.
     */
    async scan(options: ScanOptions = {}): Promise<ScanResult> {
        const identity = this.requireIdentity();

        return runScan({
            vault: this.vaultStore,
            storage: this.config.storage,
            hints: this.config.hints,
            nullifiers: this.config.nullifiers,
            pool: this.config.pool,
            keys: {
                viewingKey: identity.viewingSecretKey,
                spendingKey: identity.spendingKey,
                ownerPk: identity.ownerPk,
                // Absent on a watch-only identity: the scan then finds every
                // note the wallet owns and reconstructs no payment history.
                ...(identity.outgoingViewingKey
                    ? { outgoingViewingKey: identity.outgoingViewingKey }
                    : {}),
            },
            sinceLeafIndex: options.sinceLeafIndex,
            viewTagActivationLeaf: this.config.viewTagActivationLeaf,
            onProgress: options.onProgress,
            signal: options.signal,
            onWarning: this.config.onWarning,
        });
    }

    /** The leaf a next incremental scan should resume from, or undefined. */
    async scanCursor(): Promise<number | undefined> {
        return (await this.config.storage.getConfig())?.lastScannedLeafIndex;
    }

    /**
     * Builds a note payable to `viewingPublicKey`'s owner, or to this wallet
     * when none is given.
     *
     * The result is NOT persisted and carries no proof — it is an output to feed
     * a transfer or shield extrinsic. Its ephemeral index IS reserved, so a note
     * that is built and then discarded burns one; that is deliberate, since
     * reusing an index would republish an ephPk and link the two notes.
     */
    async buildNote(params: Omit<BuildNoteParams, 'circuitVersion'> & { circuitVersion: number }) {
        const identity = this.requireIdentity();
        return buildZkNote(params, {
            keys: {
                ownerPk: identity.ownerPk,
                spendingKey: identity.spendingKey,
                viewingPublicKey: identity.viewingPublicKey,
                viewingSecretKey: identity.viewingSecretKey,
                ...(identity.outgoingViewingKey
                    ? { outgoingViewingKey: identity.outgoingViewingKey }
                    : {}),
            },
            storage: this.config.storage,
        });
    }

    /**
     * The key material the spend ops need as dependencies.
     *
     * Exposed deliberately: `transferNotes` and `unshieldNote` require the
     * wallet's GLOBAL spending key (stealth derivation hangs off it) and its
     * viewing secret (to reopen a memo this wallet authored). Without an
     * accessor a consumer would have to abandon the facade to spend, which is
     * the opposite of what a facade is for.
     *
     * Treat the result as secret: it can spend every note this wallet holds.
     */
    spendKeys(): {
        spendingKey: bigint;
        viewingSecretKey: Uint8Array;
        ownerPk: bigint;
        outgoingViewingKey?: Uint8Array;
    } {
        const identity = this.requireIdentity();
        return {
            spendingKey: identity.spendingKey,
            viewingSecretKey: identity.viewingSecretKey,
            ownerPk: identity.ownerPk,
            ...(identity.outgoingViewingKey
                ? { outgoingViewingKey: identity.outgoingViewingKey }
                : {}),
        };
    }

    /**
     * `recoverStealth` for the spend ops, bound to this wallet's keys.
     *
     * Returns null when the memo does not open — which the ops read as "do NOT
     * persist this note", since the built form is unspendable.
     */
    recoverStealth = (note: ZkNote): ZkNote | null => {
        const { spendingKey, viewingSecretKey, ownerPk } = this.spendKeys();
        return recoverSelfStealthNote(note, { viewingSecretKey, spendingKey, ownerPk });
    };

    /**
     * A `buildNote` bound to this wallet, shaped for the spend ops.
     *
     * The ops call it WITHOUT a circuit version, so the version is resolved
     * here — from the chain when a zkVerifier is configured, fail-closed. A
     * guessed version produces a note the chain refuses to spend after a
     * verifying-key rotation, and the failure surfaces much later.
     */
    buildOutputNote = async (
        params: Omit<BuildNoteParams, 'circuitVersion'>
    ): Promise<{ note: ZkNote; outgoingIndex?: number }> => {
        const identity = this.requireIdentity();
        // `buildZkNoteWithIndex` rather than `buildNote`: a transfer needs to
        // know which outgoing index the payment published, so the change note
        // can be given a recipient book entry.
        return buildZkNoteWithIndex(
            { ...params, circuitVersion: await this.circuitVersion() },
            {
                keys: {
                    ownerPk: identity.ownerPk,
                    spendingKey: identity.spendingKey,
                    viewingPublicKey: identity.viewingPublicKey,
                    viewingSecretKey: identity.viewingSecretKey,
                    ...(identity.outgoingViewingKey
                        ? { outgoingViewingKey: identity.outgoingViewingKey }
                        : {}),
                },
                storage: this.config.storage,
            }
        );
    };

    /** The circuit version a new note should carry. */
    async circuitVersion(): Promise<number> {
        if (this.config.circuitVersion !== undefined) return this.config.circuitVersion;
        if (!this.config.zkVerifier) {
            throw new Error(
                'Cannot determine the circuit version: pass `zkVerifier` (or a fixed ' +
                    '`circuitVersion`) to OrbinumWallet.'
            );
        }
        return chainActiveCircuitVersion(this.config.zkVerifier);
    }

    private requireIdentity(): WalletIdentity {
        if (this.identity === null) {
            throw new Error('Wallet is locked. Call unlock() before using it.');
        }
        return this.identity;
    }
}
