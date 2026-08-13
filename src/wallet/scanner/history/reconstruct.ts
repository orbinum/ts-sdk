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
}

export interface ReconstructDeps {
    vault: Pick<VaultStore, 'getAll' | 'getTxRecords' | 'saveTxRecord'>;
    transfers: TransferFactsSource;
    txFacts: TxFactsSource;
    /** Injectable clock — reconstruction stamps rows whose block time is unknown. */
    now?: () => number;
}

/** Groups the feed's per-extrinsic rows: "{blockNumber}:{extrinsicIndex}". */
function extrinsicKey(row: Pick<TransferFactsRow, 'blockNumber' | 'extrinsicIndex'>) {
    return `${row.blockNumber}:${row.extrinsicIndex ?? 'null'}`;
}

/** A 0x-prefixed 64-char pk, or ZERO_PK when the note carries no counterparty. */
function toPkHex(sourcePk: bigint | null | undefined): string {
    return sourcePk != null && sourcePk !== 0n ? scalarToHex(sourcePk) : ZERO_PK;
}

/**
 * The change note of a transfer: a note WE own produced by the same extrinsic.
 *
 * It may itself be spent by now (chained transfers), so unspent is not
 * required. A candidate with a stamped counterparty pk wins — that is the
 * change note, and in a self-transfer the recipient note qualifies too since
 * either identifies us.
 */
function findChangeNote(
    commitments: string[],
    noteByCommitment: Map<string, ZkNote>
): ZkNote | undefined {
    const candidates = commitments
        .map((h) => noteByCommitment.get(h))
        .filter((n): n is ZkNote => n !== undefined);
    return candidates.find((n) => n.sourcePk != null && n.sourcePk !== 0n) ?? candidates[0];
}

/** Local records keyed by tx hash; an unavailable history reads as empty. */
async function loadExistingRecords(
    vault: ReconstructDeps['vault']
): Promise<Map<string, ReconstructedTxRecord>> {
    try {
        const records = await vault.getTxRecords<ReconstructedTxRecord>();
        return new Map(records.map((r) => [r.hash, r]));
    } catch {
        // History not yet available — treat every record as missing.
        return new Map();
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

    const existingByHash = await loadExistingRecords(vault);

    for (const transfer of outgoingTransfers) {
        // Already recorded WITH a known recipient → idempotent skip. A zero pk
        // falls through so the recipient can be backfilled once known.
        const existing = transfer.hash ? existingByHash.get(transfer.hash) : undefined;
        if (existing?.recipientPkHex && existing.recipientPkHex !== ZERO_PK) continue;

        // The input notes this extrinsic spent — ours only.
        const inputNotes = (transfer.matchedNullifiers ?? [])
            .map((h) => noteByNullifier.get(h))
            .filter((n): n is ZkNote => n !== undefined);
        if (inputNotes.length === 0) continue; // spent by someone else

        // Recipient = the change note's counterparty pk; per protocol the
        // stealth address is the identity.
        const changeNote = findChangeNote(
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

        // With no fee to subtract the amount overstates by exactly that fee, so
        // it ships MARKED: a visibly approximate amount beats a precise-looking
        // wrong one.
        const totalInputValue = inputNotes.reduce((sum, n) => sum + n.value, 0n);
        const transferAmount = totalInputValue - (changeNote?.value ?? 0n) - (fee ?? 0n);
        if (transferAmount <= 0n) continue;

        const record: ReconstructedTxRecord = {
            id: transfer.hash ?? `${transfer.blockNumber}-${transfer.extrinsicIndex ?? 0}`,
            type: 'private_transfer',
            blockNumber: transfer.blockNumber,
            hash: transfer.hash ?? '',
            assetId: inputNotes[0]!.assetId.toString(),
            amount: transferAmount.toString(),
            recipientPkHex,
            status: success ? 'success' : 'failed',
            ...(fee !== null
                ? { feePlanck: fee.toString() }
                : { amountApproximate: true as const }),
            timestampMs: transfer.timestampMs ?? now(),
        };
        await vault.saveTxRecord(record);
    }
}
