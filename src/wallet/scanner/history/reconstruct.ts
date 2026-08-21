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
import { fromHex, scalarToHex } from '../../../foundation/encoding/hex';
import { hasSourcePk, selectDescribingNoteByCommitment } from '../../provenance/index';
import { regeneratePaymentSlip } from '../../provenance/index';
import type { SentNoteMatch } from '../../worker/index';
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
     * A freshly sealed `orbslip1:` slip, when this row was recovered from the
     * memo. RE-ISSUED, not remembered: a slip is sealed toward the recipient,
     * so the sender never held a readable copy. It carries only public facts.
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
     * Notes this wallet sent, as the scan recovered them.
     *
     * Comes from `ScanOutcome.sentNotes` — the sweep already recognises them by
     * their outgoing ephPk. Omit to keep the arithmetic-only behaviour.
     */
    sentNotes?: SentNoteMatch[];
}

/** Groups the feed's per-extrinsic rows: "{blockNumber}:{extrinsicIndex}". */
function extrinsicKey(row: Pick<TransferFactsRow, 'blockNumber' | 'extrinsicIndex'>) {
    return `${row.blockNumber}:${row.extrinsicIndex ?? 'null'}`;
}

/**
 * A 0x-prefixed 64-char pk, or ZERO_PK when there is no counterparty.
 *
 * Shares `hasSourcePk` with the selection rule rather than repeating the check:
 * a note whose scalars skipped normalisation carries a STRING, and
 * `'0' != null && '0' !== 0n` reads that zero as a real key.
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
 * An extrinsic with no decoded hash still gets a row, keyed by position. Looking
 * it up by `hash` would miss it and rewrite the row on every pass, discarding
 * whatever the previous one resolved.
 *
 * The `{block}-{index}` spelling is NOT `extrinsicKey`: that one groups rows in
 * memory and may change freely; this is a storage key already written into
 * vaults, so its shape is fixed.
 */
function recordKey(transfer: Pick<TransferFactsRow, 'hash' | 'blockNumber' | 'extrinsicIndex'>) {
    return transfer.hash ?? `${transfer.blockNumber}-${transfer.extrinsicIndex ?? 0}`;
}

/**
 * The sent notes of one extrinsic, indexed by the commitments it produced.
 *
 * The scan recovers sent notes without knowing which extrinsic each belongs to,
 * and `byCommitments` already tells us which commitments an extrinsic inserted.
 * Joining them locally needs no further request.
 */
function sentByCommitment(sentNotes: SentNoteMatch[]): Map<string, SentNoteMatch> {
    return new Map(sentNotes.map((s) => [s.commitmentHex.toLowerCase(), s]));
}

/**
 * A re-issued slip for a recovered send, or nothing when it cannot be sealed.
 *
 * Best-effort by design: a slip is a convenience the recipient can also live
 * without, so a failure here must never cost the history row.
 */
function reissuedSlip(sent: SentNoteMatch, hash: string | null) {
    try {
        const facts: NoteFacts = {
            commitmentHex: sent.commitmentHex,
            encryptedMemo: sent.encryptedMemo,
            ...(sent.leafIndex !== undefined ? { leafIndex: sent.leafIndex } : {}),
        };
        return {
            paymentSlip: regeneratePaymentSlip(
                facts,
                fromHex(sent.counterpartyIvkHex),
                hash ?? undefined
            ),
        };
    } catch {
        return {};
    }
}

export async function reconstructOutgoingTxRecords(deps: ReconstructDeps): Promise<void> {
    const { vault, transfers } = deps;
    const now = deps.now ?? Date.now;

    // ── 1. Nothing spent → no outgoing history ────────────────────────────────
    const allNotes = vault.getAll();
    const spentNotes = allNotes.filter((n) => n.spent);
    if (spentNotes.length === 0) return;

    // ── 2. Ask the feed which extrinsics these notes belong to ────────────────
    // In parallel, filtered server-side: by-nullifiers finds the extrinsics that
    // spent our notes, by-commitments the outputs those extrinsics produced.
    //
    // The recovered SENT commitments MUST be in that second list. They are not
    // in the vault — a sender does not own the note they paid — so asking about
    // vault notes alone leaves every payment unmatched: no recipient on the row,
    // no slip to re-issue. Same request, more items; the client chunks at 50.
    const sentCommitments = (deps.sentNotes ?? []).map((s) => s.commitmentHex);
    const [outgoingTransfers, commitmentTransfers] = await Promise.all([
        transfers.byNullifiers(spentNotes.map((n) => n.nullifierHex)),
        transfers.byCommitments([...allNotes.map((n) => n.commitmentHex), ...sentCommitments]),
    ]);
    if (outgoingTransfers.length === 0) return;

    // ── 3. Index everything the loop below looks up ───────────────────────────
    const noteByNullifier = new Map(spentNotes.map((n) => [n.nullifierHex, n]));
    const noteByCommitment = new Map(allNotes.map((n) => [n.commitmentHex, n]));
    const commitmentsByExtrinsic = new Map(
        commitmentTransfers.map((ct) => [extrinsicKey(ct), ct.matchedCommitments ?? []])
    );

    const existingByKey = await loadExistingRecords(vault);
    const sentIndex = sentByCommitment(deps.sentNotes ?? []);
    // Whether this caller runs sent-note recovery at all. It decides what an
    // unrecovered change note's `sourcePk` may be taken to mean — see below.
    const recoveryEnabled = deps.sentNotes !== undefined;

    /** The sent note this extrinsic produced, if the scan recovered one. */
    const sentFor = (row: TransferFactsRow) =>
        (commitmentsByExtrinsic.get(extrinsicKey(row)) ?? [])
            .map((hex) => sentIndex.get(hex.toLowerCase()))
            .find((s): s is SentNoteMatch => s !== undefined);

    // ── 4. One record per outgoing extrinsic ──────────────────────────────────
    for (const transfer of outgoingTransfers) {
        // Idempotent skip, but only when the row is COMPLETE: a zero pk or a
        // missing slip falls through, since this scan may have just recovered
        // what fills it in.
        const existing = existingByKey.get(recordKey(transfer));
        const known = existing?.recipientPkHex && existing.recipientPkHex !== ZERO_PK;
        if (known && existing?.paymentSlip) continue;

        // The input notes this extrinsic spent — ours only.
        const inputNotes = (transfer.matchedNullifiers ?? [])
            .map((h) => noteByNullifier.get(h))
            .filter((n): n is ZkNote => n !== undefined);
        if (inputNotes.length === 0) continue; // spent by someone else

        const changeNote = selectDescribingNoteByCommitment(
            commitmentsByExtrinsic.get(extrinsicKey(transfer)) ?? [],
            noteByCommitment
        );

        // A recovered note names the recipient exactly — the stealth pk comes
        // out of the memo the sender sealed.
        //
        // `sourcePk` is a fallback ONLY without sent-note recovery, where that
        // field still holds the recipient's stealth key. With recovery on it may
        // instead hold a sealed book entry: ciphertext that is indistinguishable
        // from a pk — a third of random values even unpack as valid curve
        // points. Showing one as the address paid is worse than showing nothing,
        // and a later scan backfills the real value.
        const sentForRow = sentFor(transfer);
        const recipientPkHex = sentForRow
            ? toPkHex(sentForRow.recipientStealthPk)
            : recoveryEnabled
              ? ZERO_PK
              : toPkHex(changeNote?.sourcePk);

        // 4a. Backfill in place — the row exists but the scan can now supply
        // the recipient, a slip, or both. Every other field survives.
        if (existing) {
            const patch = {
                // Only when it ADDS something: this runs over the whole
                // outgoing history on every scan, and rewriting what is already
                // there would make each one a write.
                ...(!known && recipientPkHex !== ZERO_PK ? { recipientPkHex } : {}),
                ...(sentForRow && !existing.paymentSlip
                    ? reissuedSlip(sentForRow, transfer.hash)
                    : {}),
            };
            if (Object.keys(patch).length > 0) {
                await vault.saveTxRecord({ ...existing, ...patch });
            }
            continue;
        }

        // 4b. New row. One lookup yields the fee AND the on-chain outcome, so a
        // failed transfer is recorded as failed instead of joining the history
        // as a success.
        const { fee, success } = await fetchExtrinsicFacts(deps.txFacts, transfer.hash);

        // Without a fee to subtract the amount overstates by exactly that fee,
        // so it ships MARKED — a visibly approximate figure beats a
        // precise-looking wrong one. A RECOVERED amount needs no caveat: it is
        // what the sender wrote, not a subtraction.
        const totalInputValue = inputNotes.reduce((sum, n) => sum + n.value, 0n);
        const derivedAmount = totalInputValue - (changeNote?.value ?? 0n) - (fee ?? 0n);
        const transferAmount = sentForRow?.value ?? derivedAmount;
        if (transferAmount <= 0n) continue;

        const record: ReconstructedTxRecord = {
            id: recordKey(transfer),
            type: 'private_transfer',
            blockNumber: transfer.blockNumber,
            hash: transfer.hash ?? '',
            assetId: (sentForRow?.assetId ?? inputNotes[0]!.assetId).toString(),
            amount: transferAmount.toString(),
            recipientPkHex,
            status: success ? 'success' : 'failed',
            ...(fee !== null ? { feePlanck: fee.toString() } : {}),
            ...(fee === null && !sentForRow ? { amountApproximate: true as const } : {}),
            timestampMs: transfer.timestampMs ?? now(),
            // Best-effort: a slip that cannot be sealed costs the convenience of
            // handing it over again, never the history row.
            ...(sentForRow ? reissuedSlip(sentForRow, transfer.hash) : {}),
        };
        await vault.saveTxRecord(record);
    }
}
