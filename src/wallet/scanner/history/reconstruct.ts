/**
 * Outgoing-history reconstruction — rebuilds the records for OUTGOING private
 * transfers that are missing after a scan.
 *
 * A clean device gets its notes back from the scan, but the outgoing history
 * (amount, recipient, fee) is never on chain: it was only saved locally at
 * submission time. What IS recoverable is each transfer's shape — which notes
 * it spent, which it produced — so the record is derived from that:
 * `amount = Σ(inputs) − change kept − fee`. Every field that cannot be derived
 * is left absent rather than guessed.
 */
import { fetchExtrinsicFacts } from './extrinsicFacts';
import { scalarToHex } from '../../../foundation/encoding/hex';
import { hasSourcePk, selectDescribingNoteByCommitment } from '../../provenance/index';
import {
    recoverSentNote,
    collectOutgoingFacts,
    type SentNoteFacts,
} from '../../../protocol/note/index';
import { regeneratePaymentSlip } from '../../provenance/index';
import type { NoteFacts } from '../../../protocol/types';
import type { TransferFactsRow, TransferFactsSource, TxFactsSource } from '../feed/sources';
import type { VaultStore } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';

/** An unknown recipient: the protocol identity is a pk, so absence is all-zero. */
const ZERO_PK = '0x' + '00'.repeat(32);

/**
 * The record this reconstruction writes. A host's own history type may carry
 * more fields; anything extra on an EXISTING record survives the backfill,
 * which only ever adds the recipient.
 */
export interface ReconstructedTxRecord {
    /** Tx hash, or "{block}-{index}" when the extrinsic was not decoded. */
    id: string;
    type: 'private_transfer';
    blockNumber: number;
    hash: string;
    assetId: string;
    amount: string;
    recipientPkHex: string;
    status: 'success' | 'failed';
    feePlanck?: string;
    /** Set when the fee was unreadable — the amount overstates by exactly it. */
    amountApproximate?: true;
    timestampMs: number;
    /**
     * A freshly sealed `orbslip1:` slip for the recipient, when this row was
     * recovered from the memo.
     *
     * Re-issued rather than remembered: a slip is sealed toward the recipient,
     * so the sender never held a copy they could read back. It carries only
     * public facts, and the sweep that recovered the amount also identified
     * which counterparty to seal it toward.
     */
    paymentSlip?: string;
}

export interface ReconstructDeps {
    vault: Pick<VaultStore, 'getAll' | 'getTxRecords' | 'saveTxRecord'>;
    transfers: TransferFactsSource;
    txFacts: TxFactsSource;
    /** Injectable clock — reconstruction stamps rows whose block time is unknown. */
    now?: () => number;
    /**
     * What the sender needs to read back their own outgoing memos. Omit to keep
     * the arithmetic-only behaviour.
     *
     * `counterpartyIvks` are the packed viewing keys of counterparties this
     * vault knows — the keys of `pairwiseCounterparties`, which survive a
     * wipe-and-rescan by design.
     */
    keys?: {
        viewingSecretKey: Uint8Array;
        counterpartyIvks: Uint8Array[];
    };
}

/** Groups the feed's per-extrinsic rows: "{blockNumber}:{extrinsicIndex}". */
function extrinsicKey(row: Pick<TransferFactsRow, 'blockNumber' | 'extrinsicIndex'>) {
    return `${row.blockNumber}:${row.extrinsicIndex ?? 'null'}`;
}

/**
 * A 0x-prefixed 64-char pk, or ZERO_PK when the note carries no counterparty.
 *
 * Shares `hasSourcePk` with the selection rule rather than repeating its check:
 * both ask the same question, and a note whose scalars skipped normalisation
 * carries a string, where `'0' != null && '0' !== 0n` reads a zero as a real
 * key.
 */
function toPkHex(sourcePk: bigint | null | undefined): string {
    return typeof sourcePk === 'bigint' && hasSourcePk({ sourcePk })
        ? scalarToHex(sourcePk)
        : ZERO_PK;
}

/** Local records keyed by tx hash; an unavailable history reads as empty. */
async function loadExistingRecords(
    vault: ReconstructDeps['vault']
): Promise<Map<string, ReconstructedTxRecord>> {
    try {
        const records = await vault.getTxRecords<ReconstructedTxRecord>();
        return new Map(records.map((r) => [r.id, r]));
    } catch {
        // History not yet available — treat every record as missing.
        return new Map();
    }
}

/**
 * The key a record is stored under — the same one `saveTxRecord` writes.
 *
 * An extrinsic without a decoded hash still gets a row, keyed by position.
 * Looking it up by `hash` instead would miss it (that field is left empty), so
 * the next reconstruction would treat the row as absent and write it again,
 * discarding whatever the previous pass had already resolved.
 *
 * The `{block}-{index}` spelling is NOT `extrinsicKey`: that one groups rows
 * in memory and may change freely, while this one is a storage key already
 * written into vaults, so its shape is fixed.
 */
function recordKey(transfer: Pick<TransferFactsRow, 'hash' | 'blockNumber' | 'extrinsicIndex'>) {
    return transfer.hash ?? `${transfer.blockNumber}-${transfer.extrinsicIndex ?? 0}`;
}

/**
 * The exact facts of a sent note, when the sender can still re-derive them.
 *
 * Only possible for a payment to a counterparty this vault knows: the pair
 * secret is symmetric, so the ephemeral used back then is derivable now, and
 * with it the memo the sender sealed. Returns null for everything else — a
 * first payment (random ephemeral), a counterparty no longer in the vault, or
 * a feed that does not serve outputs.
 *
 * Sweeping every known counterparty per output is what makes this work without
 * storing which one each payment went to. The cost is bounded by the vault's
 * counterparty count, and only the extrinsics this wallet signed are looked up.
 */
type RecoveredSend = {
    facts: SentNoteFacts;
    /** The counterparty whose key opened it — what a re-issued slip is sealed toward. */
    theirIvk: Uint8Array;
    /** The output's public facts, verbatim, ready to seal into a fresh slip. */
    publicFacts: NoteFacts;
};

async function recoverSentFacts(
    deps: ReconstructDeps,
    transfer: TransferFactsRow
): Promise<RecoveredSend | null> {
    const { keys } = deps;
    if (!keys || !deps.transfers.outputsByExtrinsics) return null;
    if (transfer.extrinsicIndex === null) return null;

    try {
        const outputs = await deps.transfers.outputsByExtrinsics([
            { blockNumber: transfer.blockNumber, extrinsicIndex: transfer.extrinsicIndex },
        ]);

        for (const output of outputs) {
            const hint = {
                commitmentHex: output.commitmentHex,
                leafIndex: output.leafIndex ?? -1,
                encryptedMemo: output.encryptedMemo,
            };
            for (const theirIvk of keys.counterpartyIvks) {
                const facts = recoverSentNote({
                    hint,
                    myViewingSecretKey: keys.viewingSecretKey,
                    theirViewingPublicKey: theirIvk,
                });
                if (!facts) continue;
                // Which key opened it is the missing half of a re-issued slip:
                // a slip is sealed TOWARD the recipient, so the sender needs
                // their viewing key, and the sweep just identified it.
                const publicFacts = collectOutgoingFacts(hint);
                if (publicFacts) return { facts, theirIvk, publicFacts };
            }
        }
    } catch {
        // A feed that errors costs the exact amount, not the record — the
        // arithmetic path below still produces a usable row.
    }
    return null;
}

/** A re-issued slip for a recovered send, or nothing when it cannot be sealed. */
function reissuedSlip(sent: RecoveredSend, hash: string | null): { paymentSlip?: string } {
    try {
        return {
            paymentSlip: regeneratePaymentSlip(sent.publicFacts, sent.theirIvk, hash ?? undefined),
        };
    } catch {
        return {};
    }
}

export async function reconstructOutgoingTxRecords(deps: ReconstructDeps): Promise<void> {
    const { vault, transfers } = deps;
    const now = deps.now ?? Date.now;

    const allNotes = vault.getAll();
    const spentNotes = allNotes.filter((n) => n.spent);
    if (spentNotes.length === 0) return; // nothing spent → no outgoing history

    // In parallel — the feed filters server-side. by-nullifiers finds the
    // extrinsics that spent our notes; by-commitments locates their change notes.
    const [outgoingTransfers, commitmentTransfers] = await Promise.all([
        transfers.byNullifiers(spentNotes.map((n) => n.nullifierHex)),
        transfers.byCommitments(allNotes.map((n) => n.commitmentHex)),
    ]);
    if (outgoingTransfers.length === 0) return;

    const noteByNullifier = new Map(spentNotes.map((n) => [n.nullifierHex, n]));
    const noteByCommitment = new Map(allNotes.map((n) => [n.commitmentHex, n]));
    const commitmentsByExtrinsic = new Map(
        commitmentTransfers.map((ct) => [extrinsicKey(ct), ct.matchedCommitments ?? []])
    );

    const existingByKey = await loadExistingRecords(vault);

    for (const transfer of outgoingTransfers) {
        // Already recorded WITH a known recipient → idempotent skip. A zero pk
        // falls through so the recipient can be backfilled once known.
        const existing = existingByKey.get(recordKey(transfer));
        if (existing?.recipientPkHex && existing.recipientPkHex !== ZERO_PK) continue;

        // The input notes this extrinsic spent — ours only.
        const inputNotes = (transfer.matchedNullifiers ?? [])
            .map((h) => noteByNullifier.get(h))
            .filter((n): n is ZkNote => n !== undefined);
        if (inputNotes.length === 0) continue; // spent by someone else

        // Recipient = the change note's counterparty pk; per protocol the
        // stealth address is the identity. The note may itself be spent by now
        // (chained transfers), so unspent is not required.
        const changeNote = selectDescribingNoteByCommitment(
            commitmentsByExtrinsic.get(extrinsicKey(transfer)) ?? [],
            noteByCommitment
        );
        const recipientPkHex = toPkHex(changeNote?.sourcePk);

        // Backfill: the record exists but its recipient was unknown — update in
        // place, keeping every other field.
        if (existing) {
            if (recipientPkHex === ZERO_PK) continue; // still unknown
            await vault.saveTxRecord({ ...existing, recipientPkHex });
            continue;
        }

        // One lookup yields both the fee the sender chose and the on-chain
        // outcome, so a failed transfer is recorded as failed instead of
        // silently joining the history as a success.
        const { fee, success } = await fetchExtrinsicFacts(deps.txFacts, transfer.hash);

        // The exact amount, when the sender can still re-derive the memo they
        // sealed. Everything below falls back to arithmetic.
        const sent = await recoverSentFacts(deps, transfer);

        // With no fee to subtract the amount overstates by exactly that fee, so
        // it ships MARKED: a visibly approximate amount beats a precise-looking
        // wrong one. A recovered amount needs no such caveat — it is the figure
        // the sender wrote, not a subtraction.
        const totalInputValue = inputNotes.reduce((sum, n) => sum + n.value, 0n);
        const derivedAmount = totalInputValue - (changeNote?.value ?? 0n) - (fee ?? 0n);
        const transferAmount = sent?.facts.value ?? derivedAmount;
        if (transferAmount <= 0n) continue;

        const record: ReconstructedTxRecord = {
            id: recordKey(transfer),
            type: 'private_transfer',
            blockNumber: transfer.blockNumber,
            hash: transfer.hash ?? '',
            assetId: (sent?.facts.assetId ?? inputNotes[0]!.assetId).toString(),
            amount: transferAmount.toString(),
            // The recovered stealth pk comes from the memo the sender sealed,
            // which beats reading it off a change note that may not exist.
            recipientPkHex: sent ? toPkHex(sent.facts.recipientStealthPk) : recipientPkHex,
            status: success ? 'success' : 'failed',
            ...(fee !== null ? { feePlanck: fee.toString() } : {}),
            ...(fee === null && !sent ? { amountApproximate: true as const } : {}),
            timestampMs: transfer.timestampMs ?? now(),
            // Best-effort: a slip that cannot be sealed costs the convenience of
            // handing it over again, never the history row.
            ...(sent ? reissuedSlip(sent, transfer.hash) : {}),
        };
        await vault.saveTxRecord(record);
    }
}
