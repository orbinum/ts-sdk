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
import { collectOutgoingFacts } from '../../../protocol/note/index';
import { selectDescribingNoteByCommitment, mergeProvenance } from '../../provenance/index';
import type { NoteProvenanceRecord, ProvenancePeer } from '../../provenance/index';
import type {
    TransferFactsRow,
    TransferFactsSource,
    TransferOutputRow,
    TxFactsSource,
} from '../feed/sources';
import type { VaultStore } from '../../vault/index';
import type { NoteFacts, ZkNote } from '../../../protocol/types';

/**
 * The record this reconstruction writes.
 *
 * It is the shared `NoteProvenanceRecord` — the same shape a host writes at
 * submit time — so a backfill and a witnessed record can be merged by rule
 * (`mergeProvenance`) instead of by a spread expression and good intentions.
 */
export type ReconstructedTxRecord = NoteProvenanceRecord;

export interface ReconstructDeps {
    vault: Pick<VaultStore, 'getAll' | 'getTxRecords' | 'saveTxRecord'>;
    transfers: TransferFactsSource;
    txFacts: TxFactsSource;
    /** View-tag activation leaf, mirroring the recipient scan's gating. */
    viewTagActivationLeaf?: number | null;
    /** Injectable clock — reconstruction stamps rows whose block time is unknown. */
    now?: () => number;
}

/** Groups the feed's per-extrinsic rows: "{blockNumber}:{extrinsicIndex}". */
function extrinsicKey(row: Pick<TransferFactsRow, 'blockNumber' | 'extrinsicIndex'>) {
    return `${row.blockNumber}:${row.extrinsicIndex ?? 'null'}`;
}

/**
 * The change note of a transfer: a note WE own produced by the same extrinsic.
 *
 * It may itself be spent by now (chained transfers), so unspent is not
 * required. The selection rule lives in `provenance/selectDescribingNote` —
 * shared with the app's incoming-transfer path, which used to carry its own
 * copy of it.
 */
const findChangeNote = selectDescribingNoteByCommitment<ZkNote>;

/**
 * Targeted lookup — random access over our own extrinsics, never a blind sweep.
 *
 * The sender already knows its outgoing extrinsics (they spent its own
 * nullifiers), so the lookup is restricted to THEIR outputs. A commitment
 * planted by someone else is never reached, and no key leaves the wallet.
 *
 * Returns the outputs of each outgoing extrinsic, keyed by extrinsicKey.
 * Empty map when the source capability is absent (inference path).
 */
async function fetchOutgoingOutputs(
    deps: ReconstructDeps,
    outgoing: TransferFactsRow[]
): Promise<Map<string, TransferOutputRow[]>> {
    const byKey = new Map<string, TransferOutputRow[]>();
    if (!deps.transfers.outputsByExtrinsics) return byKey;

    const keys = outgoing
        .filter((t): t is TransferFactsRow & { extrinsicIndex: number } => t.extrinsicIndex != null)
        .map((t) => ({ blockNumber: t.blockNumber, extrinsicIndex: t.extrinsicIndex }));
    if (keys.length === 0) return byKey;

    try {
        const rows = await deps.transfers.outputsByExtrinsics(keys);
        for (const row of rows) {
            const key = extrinsicKey(row);
            const list = byKey.get(key);
            if (list) list.push(row);
            else byKey.set(key, [row]);
        }
    } catch {
        // Recovery is best-effort; the inference path still runs.
    }
    return byKey;
}

/**
 * Collect the public facts of one extrinsic's recipient output.
 *
 * The recipient's output is the one that is NOT among our own notes — our
 * change note we can already open, theirs we never can. Nothing is decrypted
 * here; the memo is carried verbatim so a payment slip can be re-issued from it.
 */
function collectFactsFor(
    outputs: TransferOutputRow[],
    noteByCommitment: Map<string, ZkNote>
): NoteFacts | null {
    for (const output of outputs) {
        if (noteByCommitment.has(output.commitmentHex)) continue;
        const facts = collectOutgoingFacts({
            commitmentHex: output.commitmentHex,
            leafIndex: output.leafIndex,
            encryptedMemo: output.encryptedMemo,
        });
        if (facts) return facts;
    }
    return null;
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
    const outputsByExtrinsic = await fetchOutgoingOutputs(deps, outgoingTransfers);

    for (const transfer of outgoingTransfers) {
        // Settled: peer known AND amount exact — no recovery path can improve
        // it, so skip before doing any work. A record missing either falls
        // through, since the peer can still be backfilled from the change note.
        const existing = transfer.hash ? existingByHash.get(transfer.hash) : undefined;
        if (existing?.peer && existing.amount?.exact === true) continue;

        // The input notes this extrinsic spent — ours only.
        const inputNotes = (transfer.matchedNullifiers ?? [])
            .map((h) => noteByNullifier.get(h))
            .filter((n): n is ZkNote => n !== undefined);
        if (inputNotes.length === 0) continue; // spent by someone else

        // Public facts about the recipient output: commitment, memo, leaf index.
        // Nothing is decrypted — the memo is sealed toward the recipient — so
        // this yields no amount and no recipient. It is what re-issuing a
        // payment slip needs, and nothing more.
        const facts = collectFactsFor(
            outputsByExtrinsic.get(extrinsicKey(transfer)) ?? [],
            noteByCommitment
        );

        // Inference fallback: the peer is the change note's stamped sourcePk.
        const changeNote = findChangeNote(
            commitmentsByExtrinsic.get(extrinsicKey(transfer)) ?? [],
            noteByCommitment
        );
        // A ONE-TIME stealth key, never a stable identity: read back off our own
        // change note, the only copy a sender can still open.
        const peerPk = changeNote?.sourcePk;
        const peer: ProvenancePeer | null =
            peerPk != null && peerPk !== 0n ? { pk: peerPk, scope: 'stealth' } : null;

        // An existing record is only rewritten when this run actually learned
        // something: a slip-bearing memo, or a peer it was missing. Otherwise a
        // transfer would be re-saved on every scan to arrive at the same record.
        if (existing && !facts && (!peer || existing.peer)) continue;

        // One lookup yields both the fee the sender chose and the on-chain
        // outcome, so a failed transfer is recorded as failed instead of
        // silently joining the history as a success.
        const { fee, success } = await fetchExtrinsicFacts(deps.txFacts, transfer.hash);

        // The amount is always derived: it lives in a memo the sender cannot
        // reopen. With no fee to subtract it overstates by exactly that fee,
        // which is what `exact: false` tells the UI to mark.
        const totalInputValue = inputNotes.reduce((sum, n) => sum + n.value, 0n);
        const value = totalInputValue - (changeNote?.value ?? 0n) - (fee ?? 0n);
        if (value <= 0n) continue;

        const record: ReconstructedTxRecord = {
            id: transfer.hash ?? `${transfer.blockNumber}-${transfer.extrinsicIndex ?? 0}`,
            hash: transfer.hash ?? '',
            blockNumber: transfer.blockNumber,
            timestampMs: transfer.timestampMs ?? now(),
            direction: 'out',
            kind: 'private_transfer',
            origin: 'transfer-change',
            source: facts ? 'chain' : 'inferred',
            peer,
            // Exactness is a property of the FIGURE, not of the source: an
            // inferred amount with a readable fee is exact too.
            amount: { value, exact: fee !== null },
            assetId: inputNotes[0]!.assetId,
            status: success ? 'success' : 'failed',
            ...(fee !== null ? { feePlanck: fee } : {}),
            ...(facts ? { note: facts } : {}),
        };
        // Merge by rule, never by spread: a weaker source cannot overwrite what
        // the wallet witnessed, so the amount and recipient it recorded at
        // submit time survive a later thin `chain` record.
        await vault.saveTxRecord(existing ? mergeProvenance(existing, record) : record);
    }
}
