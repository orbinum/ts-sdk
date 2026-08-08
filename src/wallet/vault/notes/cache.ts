/**
 * The decrypted notes a wallet holds while unlocked.
 *
 * Separate from `WalletSession` — which holds keys — because this is the piece
 * a host wires to its own reactivity: an application re-renders off these, and
 * the SDK must not know how. The interface stays at get/set/subscribe so an
 * adapter over any state container is a few lines.
 *
 * ## The read-modify-write rule
 *
 * A caller that mutates the list must re-read it AFTER any await and stay
 * synchronous from there to `set`. Merging onto a snapshot taken before the
 * await drops whatever a concurrent write (a rescan finishing, say) stored in
 * the meantime, and the note it drops is simply gone from the wallet's view
 * until the next full scan. Every mutation in `VaultStore` follows this.
 */
import type { ZkNote } from '../../../protocol/types';

export interface NotesCache {
    get(): ZkNote[];
    set(notes: ZkNote[]): void;
}

/** A cache that also publishes changes, for a host mirroring into its own store. */
export interface ObservableNotesCache extends NotesCache {
    /** Returns an unsubscribe function. */
    subscribe(listener: (notes: ZkNote[]) => void): () => void;
}

/**
 * A plain in-memory cache with subscription support.
 *
 * Enough for a consumer with no UI framework. An application with reactive
 * state implements `NotesCache` over its own store instead.
 */
export function createNotesCache(initial: ZkNote[] = []): ObservableNotesCache {
    let notes = initial;
    const listeners = new Set<(notes: ZkNote[]) => void>();

    return {
        get: () => notes,
        set(next) {
            notes = next;
            for (const listener of listeners) listener(next);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
