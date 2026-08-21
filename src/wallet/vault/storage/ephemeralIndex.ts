/**
 * Reservation of the ephemeral indexes a wallet publishes.
 *
 * Both counters are monotonic, and that is a protocol requirement rather than
 * bookkeeping: deriving the same index twice republishes the same ephPk on
 * chain, which publicly links the two notes as sharing a creator. Reserving
 * BEFORE use is what makes a crash safe — a reservation nobody spends skips an
 * index, which costs nothing, while spending an index nobody reserved leaks.
 *
 * Every mutation goes through `updateConfig`, whose atomicity the storage
 * contract requires for exactly this reason: two concurrent readers of the same
 * counter would both derive the same index.
 */
import type { NoteStorage } from './contract';

/**
 * The largest counter that can still be advanced and derived from.
 *
 * `derivePairwiseEphSk` writes the index as a u32, so anything at or above 2^32
 * aliases onto an index already published. The safe-integer ceiling matters for
 * a different reason: at 2^53 the `+ 1` below is a no-op, so the counter would
 * freeze and hand the same index out forever.
 */
const MAX_EPH_INDEX = 0xffff_fffe;

/**
 * Indexes skipped when an outgoing counter is rebuilt from chain data.
 *
 * A feed that hides the highest published index makes the reconstruction return
 * one already in use. Resuming past a gap means hiding one index is not enough
 * — a feed would have to hide this many consecutive top indexes, each of which
 * is a note the wallet can see is missing when it scans.
 */
const RESTORE_SAFETY_GAP = 8;

/**
 * A stored counter, or `null` when it cannot be used to derive from.
 *
 * The config survives restores, migrations, backups and hand-editing, so it
 * comes back as whatever JSON was on disk — not necessarily what this code
 * wrote. Every rejected shape here corrupts an index rather than failing
 * loudly, which is the dangerous kind:
 *
 *   - a FRACTION truncates on the u32 write, so 2.5 and 2 publish the same
 *     ephPk;
 *   - a STRING concatenates (`'3' + 1 === '31'`) instead of incrementing;
 *   - `NaN`/`Infinity` derive from a meaningless index;
 *   - a NEGATIVE value wraps to a huge one, leaving the note outside the
 *     recipient's lookup window.
 *
 * All of them resolve the same way: treat it as no history and let the caller
 * use a random ephemeral, which is correct at the cost of one trial scan.
 */
function usableCounter(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    if (value < 0 || value > MAX_EPH_INDEX) return null;
    return value;
}

/**
 * Reserves the next self-note ephemeral index, returning the value BEFORE the
 * bump. Throws when no vault config exists — a caller with nowhere to record the
 * reservation must fall back to a random ephemeral rather than assume zero.
 */
export async function reserveSelfEphIndex(storage: NoteStorage): Promise<number> {
    const updated = await storage.updateConfig((config) => ({
        ...config,
        selfEphCounter: (usableCounter(config.selfEphCounter) ?? 0) + 1,
        updatedAt: Date.now(),
    }));
    if (!updated) throw new Error('vault not initialized');

    // The mutator already replaced an unusable counter with a fresh sequence,
    // so this reads back a valid one. Restarting is the right repair: a corrupt
    // counter means the published history is unknown, and 0 of a fresh sequence
    // is no likelier to collide than any other guess.
    return (usableCounter(updated.selfEphCounter) ?? 1) - 1;
}

/**
 * Reserves the next OUTGOING index — the ephemeral published on a note this
 * wallet sends.
 *
 * "No history" is unambiguous here, unlike the pairwise counter: a sender can
 * predict every ephPk they published, so a restored wallet recovers the counter
 * by sweeping the chain. That is why this may start at 0 instead of degrading
 * to a random ephemeral.
 *
 * THE COUNTER ONLY MOVES FORWARD. `fromChain` comes from a feed, and a feed
 * that HID the highest published index would report a counter already used —
 * handing it out again republishes that ephPk and links the two notes in
 * public. So it is a floor, never the truth: a stored counter always wins.
 *
 * The restore itself is the one exposure, having no stored counter to defend
 * with. `RESTORE_SAFETY_GAP` covers it by resuming past a run of unused
 * indexes, so hiding one top index is not enough — a feed would have to hide
 * the whole run. Skipped indexes are free and only widen a window.
 *
 * @param fromChain Next index per `reconstructOutgoingIndex`, or undefined on
 *                  the normal path where the stored counter stands alone.
 */
export async function reserveOutgoingIndex(
    storage: NoteStorage,
    fromChain?: number
): Promise<number> {
    const recovered = usableCounter(fromChain);

    // Detected INSIDE the mutator, where the read is atomic. Checking first
    // would be advisory: a concurrent reservation could exhaust the counter
    // between read and write, and a transient read failure would skip it.
    //
    // It matters because the repair below cannot tell CORRUPT from EXHAUSTED —
    // `usableCounter` rejects a fraction, a NaN and a past-the-ceiling value
    // alike, and `?? 0` reads them all as "start at 0". For a corrupt counter
    // that is right. For an exhausted one it is the leak: 0 is an index this
    // wallet certainly published, and so is every index after it.
    //
    // Shape separates them: a whole number above the ceiling is a sequence that
    // ran out, not a scrambled value. The flag goes in the RECORD, not a local,
    // since `updateConfig` may call `mutate` more than once and a local would
    // keep whichever attempt lost.
    let exhausted = false;
    const updated = await storage.updateConfig((config) => {
        const raw = config.outgoingEphCounter;
        if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > MAX_EPH_INDEX) {
            exhausted = true;
            return config; // untouched: a spent counter must not be repaired away
        }
        exhausted = false;

        const stored = usableCounter(raw) ?? 0;
        // A reconstruction only counts when it exceeds what is already known,
        // and lands past a gap: it is the branch that has no local counter to
        // fall back on, so it is also the one a hostile feed can aim at.
        const floor =
            recovered !== null && recovered > stored
                ? Math.min(recovered + RESTORE_SAFETY_GAP, MAX_EPH_INDEX)
                : stored;
        return {
            ...config,
            outgoingEphCounter: floor + 1,
            updatedAt: Date.now(),
        };
    });
    if (!updated) throw new Error('vault not initialized');
    // Re-derived from the committed record, not from the flag alone: the flag
    // only reports the last mutator call, while this is what actually landed.
    if (
        exhausted ||
        (typeof updated.outgoingEphCounter === 'number' &&
            Number.isSafeInteger(updated.outgoingEphCounter) &&
            updated.outgoingEphCounter > MAX_EPH_INDEX)
    ) {
        throw new Error('outgoing ephemeral sequence exhausted');
    }

    // Read the reservation off the committed result, never off a value computed
    // inside the mutator: `updateConfig` is atomic but is not promised to call
    // `mutate` exactly once, so a backend retrying on contention could leave a
    // local variable holding the attempt that lost.
    //
    // Refused rather than defaulted, and that is the whole point. Reading an
    // unusable counter as "start over" is what the SELF path does, because a
    // fresh sequence there is no likelier to collide than any other guess. Here
    // it is the opposite: index 0 is the first index this wallet ever published,
    // so restarting hands back a value guaranteed to be on chain already and
    // republishes its ephPk. The caller treats a throw as "no index" and falls
    // back to a random ephemeral — a slow scan, against a permanent public link.
    const committed = usableCounter(updated.outgoingEphCounter);
    if (committed === null || committed - 1 >= MAX_EPH_INDEX) {
        throw new Error('outgoing ephemeral sequence exhausted');
    }
    return committed - 1;
}

/**
 * Records a counterparty this wallet has paid, keyed by their packed viewing
 * public key.
 *
 * Purely an optimisation for the REVERSE direction: once they are known, their
 * future payments to this wallet are found by hash lookup against a precomputed
 * window instead of one trial ECDH per note in the pool. Nothing this wallet
 * publishes depends on it, so a failure here costs scan speed and nothing else.
 *
 * The stored `nextIndex` is legacy — outgoing ephemerals now come from the
 * wallet-wide sequence in `outgoingEphCounter`, which is recoverable where a
 * per-counterparty one was not. It is preserved rather than dropped so that a
 * vault written by an older version still reads back cleanly.
 */
export async function registerPairwiseCounterparty(
    storage: NoteStorage,
    ivkHex: string
): Promise<void> {
    const key = ivkHex.toLowerCase();
    const updated = await storage.updateConfig((config) => {
        const existing = config.pairwiseCounterparties?.[key];
        return {
            ...config,
            pairwiseCounterparties: {
                ...config.pairwiseCounterparties,
                [key]: {
                    nextIndex: usableCounter(existing?.nextIndex) ?? 0,
                    addedAt: typeof existing?.addedAt === 'number' ? existing.addedAt : Date.now(),
                },
            },
            updatedAt: Date.now(),
        };
    });
    if (!updated) throw new Error('vault not initialized');
}
