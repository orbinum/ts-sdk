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

    // The mutator above already replaced an unusable counter with a fresh
    // sequence, so this reads back a valid one. Restarting is the right repair
    // here: a corrupt counter means the published history is unknown, and index
    // 0 of a fresh sequence is no more likely to collide than any other guess.
    // Unlike the pairwise path there is no "no history" answer to return, since
    // the caller needs an index or an exception.
    return (usableCounter(updated.selfEphCounter) ?? 1) - 1;
}

/**
 * Reserves the next pairwise index for a counterparty, keyed by their packed
 * viewing public key. Registering the counterparty is a side effect worth
 * having: it makes the REVERSE direction cheap too, since their future payments
 * to this wallet become hash lookups instead of one trial ECDH per note.
 *
 * Returns `null` when this vault holds no history for that counterparty, and
 * the caller must then use a random ephemeral. The reason is that "no history"
 * has two causes this function cannot tell apart:
 *
 *   - a genuine first payment, where index 0 is correct;
 *   - a counter that was LOST — a restored seed, a cleared IndexedDB, a wipe
 *     and rescan — where index 0 was already published and re-deriving it
 *     republishes that ephPk, linking the two notes in public.
 *
 * Unlike `selfEphCounter`, this one cannot be recovered: the index was
 * published on a note encrypted toward someone else, so it never appears in
 * this wallet's own scan, and asking a server whether a given ephPk exists
 * would reveal which notes are ours. So the ambiguity is resolved the safe way
 * — the caller degrades to random, costing the recipient one trial scan, and
 * every later payment to the same counterparty takes the fast path again.
 *
 * The entry is still created: the NEXT payment has a counter, and registering
 * the counterparty is what makes the reverse direction cheap.
 */
export async function reservePairwiseIndex(
    storage: NoteStorage,
    ivkHex: string
): Promise<number | null> {
    const key = ivkHex.toLowerCase();
    const updated = await storage.updateConfig((config) => {
        const stored = usableCounter(config.pairwiseCounterparties?.[key]?.nextIndex);
        const addedAt = config.pairwiseCounterparties?.[key]?.addedAt;
        return {
            ...config,
            pairwiseCounterparties: {
                ...config.pairwiseCounterparties,
                [key]: {
                    nextIndex: (stored ?? 0) + 1,
                    addedAt: typeof addedAt === 'number' ? addedAt : Date.now(),
                },
            },
            updatedAt: Date.now(),
        };
    });
    if (!updated) throw new Error('vault not initialized');

    // Read the verdict off the RESULT, never off a flag set inside the mutator.
    // The contract requires `updateConfig` to be atomic but does not promise it
    // calls `mutate` exactly once — a backend retrying on contention would leave
    // such a flag holding the value of an attempt that lost. A committed
    // `nextIndex` of 1 means this call created the entry, whichever attempt won.
    const nextIndex = usableCounter(updated.pairwiseCounterparties?.[key]?.nextIndex);
    if (nextIndex === null || nextIndex <= 1) return null;
    return nextIndex - 1;
}
