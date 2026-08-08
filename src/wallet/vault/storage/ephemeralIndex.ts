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
 * Reserves the next self-note ephemeral index, returning the value BEFORE the
 * bump. Throws when no vault config exists — a caller with nowhere to record the
 * reservation must fall back to a random ephemeral rather than assume zero.
 */
export async function reserveSelfEphIndex(storage: NoteStorage): Promise<number> {
    const updated = await storage.updateConfig((config) => ({
        ...config,
        selfEphCounter: (config.selfEphCounter ?? 0) + 1,
        updatedAt: Date.now(),
    }));
    if (!updated) throw new Error('vault not initialized');
    return (updated.selfEphCounter ?? 1) - 1;
}

/**
 * Reserves the next pairwise index for a counterparty, keyed by their packed
 * viewing public key. Registering the counterparty is a side effect worth
 * having: it makes the REVERSE direction cheap too, since their future payments
 * to this wallet become hash lookups instead of one trial ECDH per note.
 */
export async function reservePairwiseIndex(storage: NoteStorage, ivkHex: string): Promise<number> {
    const key = ivkHex.toLowerCase();
    const updated = await storage.updateConfig((config) => {
        const current = config.pairwiseCounterparties?.[key];
        return {
            ...config,
            pairwiseCounterparties: {
                ...config.pairwiseCounterparties,
                [key]: {
                    nextIndex: (current?.nextIndex ?? 0) + 1,
                    addedAt: current?.addedAt ?? Date.now(),
                },
            },
            updatedAt: Date.now(),
        };
    });
    if (!updated) throw new Error('vault not initialized');
    return (updated.pairwiseCounterparties?.[key]?.nextIndex ?? 1) - 1;
}
