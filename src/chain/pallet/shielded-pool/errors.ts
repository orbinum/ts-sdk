/**
 * Classification of shielded-pool failures out of raw chain errors.
 *
 * Pallet vocabulary, not app policy. The strings are the runtime's error
 * variants, and what each MEANS for a wallet — resync, purge a note, retry — is
 * protocol knowledge: without it a ghost note reads as a generic failure and
 * the unspendable note stays in the vault.
 *
 * This module answers "what kind of failure, and what should a wallet DO"; the
 * words a person reads belong to the host. Two wallets should agree that
 * `UnknownMerkleRoot` means "rescan and retry" while phrasing it differently.
 */

/**
 * The pallet error name inside a raw chain error, or null.
 *
 * Accepts both quote forms — plain from Substrate, backslash-escaped from the
 * EVM path's nested eth_call message.
 */
export function extractPalletError(raw: string): string | null {
    return raw.match(/message: Some\(\\?"([^"\\]+)\\?"\)/)?.[1] ?? null;
}

/**
 * What a wallet should do about a failure, independent of how it words it.
 *
 * - `already-spent` — the vault is behind the chain; resync, then let the user
 *   pick again. Retrying the same inputs fails identically.
 * - `ghost-note` — an input is not in the on-chain tree. The note is
 *   unspendable and stays that way; purging it is the only progress.
 * - `stale-proof` — proved against a tree that has moved. A rescan and a fresh
 *   proof succeed, so this one IS worth retrying.
 * - `amount` / `asset` / `shape` — the request was malformed or unaffordable.
 *   Nothing to retry until the user changes it.
 * - `proof` — verification failed. Not user-correctable; it means a bug or a
 *   circuit-version mismatch.
 * - `capacity` — the pool cannot accept more commitments at all.
 * - `balance` — a plain balances-pallet failure, not a shielded-pool one.
 * - `unknown` — a name this SDK version does not classify. Treat as terminal
 *   and show the raw name: a wrong reaction is worse than none.
 */
export type PalletErrorKind =
    | 'already-spent'
    | 'ghost-note'
    | 'stale-proof'
    | 'amount'
    | 'asset'
    | 'shape'
    | 'proof'
    | 'capacity'
    | 'balance'
    | 'unknown';

/**
 * Every `pallet-shielded-pool` error name this SDK classifies, plus the few it
 * meets through the same path. An unlisted name degrades to `unknown`, so a
 * runtime newer than this SDK loses the hint and nothing else.
 *
 * Three entries are not shielded-pool variants:
 *   - `NullifierAlreadySpent` — raised by the SDK's own pre-flight check in
 *     `ops/spend/lifecycle`, worded to match the pallet so one situation
 *     produces one reaction however it was found;
 *   - `InsufficientBalance` / `ExistentialDeposit` — the balances pallet,
 *     reached through the same submit.
 */
const ERROR_KINDS: Readonly<Record<string, PalletErrorKind>> = {
    // Notes and nullifiers
    NullifierAlreadyUsed: 'already-spent',
    NullifierAlreadySpent: 'already-spent',
    CommitmentNotFound: 'ghost-note',
    CommitmentAlreadyExists: 'shape',
    UnknownMerkleRoot: 'stale-proof',

    // Amounts and fees
    InvalidAmount: 'amount',
    InsufficientPoolBalance: 'amount',
    FeeTooLow: 'amount',
    InsufficientPendingFees: 'amount',

    // Proofs
    InvalidProof: 'proof',
    ProofVerificationFailed: 'proof',
    InvalidPublicSignals: 'proof',

    // Assets
    InvalidAssetId: 'asset',
    AssetNotVerified: 'asset',
    AssetIdMismatch: 'asset',
    AssetIdAlreadyExists: 'asset',

    // Request shape
    InvalidMemoSize: 'shape',
    MemoCommitmentMismatch: 'shape',
    TooManyInputsOrOutputs: 'shape',
    InvalidRecipient: 'shape',
    EmptyBatch: 'shape',
    FeeRecipientUnavailable: 'shape',

    // Capacity
    MerkleTreeFull: 'capacity',

    // Balances pallet, reached through the same path
    InsufficientBalance: 'balance',
    ExistentialDeposit: 'balance',
};

/** Every error name this SDK classifies. Useful to a host building a copy table. */
export const KNOWN_PALLET_ERRORS: readonly string[] = Object.freeze(Object.keys(ERROR_KINDS));

/**
 * Classifies a pallet error NAME. Returns `unknown` for anything unrecognised,
 * including a runtime newer than this SDK.
 */
export function palletErrorKind(name: string): PalletErrorKind {
    return ERROR_KINDS[name] ?? 'unknown';
}

/**
 * Classifies a RAW chain error, extracting the name first.
 *
 * The RPC fallback matters: a ghost note surfaces as the merkle-proof call
 * failing rather than as a pallet rejection, because the spend never reaches
 * the chain. Same condition, different messenger.
 */
export function classifyChainError(rawMessage: string): PalletErrorKind {
    const name = extractPalletError(rawMessage);
    if (name !== null) {
        const kind = palletErrorKind(name);
        if (kind !== 'unknown') return kind;
    }
    return isMissingMerkleProof(rawMessage) ? 'ghost-note' : 'unknown';
}

/** The merkle-proof RPC reporting no leaf for a commitment. */
function isMissingMerkleProof(rawMessage: string): boolean {
    return /getMerkleProofByCommitment|commitment not found|no merkle/i.test(rawMessage);
}

/**
 * True when a spend was rejected because an input was already spent on-chain.
 *
 * Covers both the pallet's post-submit rejection and the pre-flight check's
 * wording. Either way the local vault is behind the chain, and the right
 * reaction is a resync — the chain is the authority on spent status.
 */
export function isAlreadySpentError(rawMessage: string): boolean {
    return classifyChainError(rawMessage) === 'already-spent';
}

/**
 * True when a spend failed because an input commitment is not in the on-chain
 * tree — a "ghost" note that never landed (or was pruned). Surfaces either as
 * the merkle-proof RPC failing (no leaf for that commitment) or as the pallet
 * rejecting the proof against a tree that never held it.
 *
 * `UnknownMerkleRoot` is deliberately NOT a ghost note here even though both
 * are proof-versus-tree failures: a stale root means the note exists and a
 * rescan fixes it, while a ghost note is gone for good. Conflating them would
 * either purge a live note or retry forever on a dead one.
 */
export function isGhostNoteError(rawMessage: string): boolean {
    return classifyChainError(rawMessage) === 'ghost-note';
}
