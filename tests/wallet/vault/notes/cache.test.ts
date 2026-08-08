/**
 * The notes cache — the seam a host wires to its own reactive state.
 *
 * Small enough that the interesting part is the subscription contract, since a
 * host builds its rendering on it: every `set` notifies, unsubscribing actually
 * stops delivery, and a listener re-reading the cache sees the new value rather
 * than the one it is replacing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNotesCache } from '../../../../src/wallet/vault/notes/cache';
import type { ZkNote } from '../../../../src/protocol/types';

const note = (commitmentHex: string): ZkNote => ({ commitmentHex }) as ZkNote;

describe('createNotesCache', () => {
    it('starts empty', () => {
        expect(createNotesCache().get()).toEqual([]);
    });

    it('accepts an initial list', () => {
        expect(createNotesCache([note('0xa')]).get()).toEqual([note('0xa')]);
    });

    it('returns what was last set', () => {
        const cache = createNotesCache();

        cache.set([note('0xa'), note('0xb')]);

        expect(cache.get()).toHaveLength(2);
    });

    it("replaces rather than merges — merging is the caller's job", () => {
        const cache = createNotesCache([note('0xa')]);

        cache.set([note('0xb')]);

        expect(cache.get()).toEqual([note('0xb')]);
    });
});

describe('subscription', () => {
    it('delivers the new list on every set', () => {
        const cache = createNotesCache();
        const listener = vi.fn();
        cache.subscribe(listener);

        cache.set([note('0xa')]);
        cache.set([note('0xb')]);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith([note('0xb')]);
    });

    it('does not fire on subscribe — a host reads the current value itself', () => {
        const cache = createNotesCache([note('0xa')]);
        const listener = vi.fn();

        cache.subscribe(listener);

        expect(listener).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', () => {
        const cache = createNotesCache();
        const listener = vi.fn();

        const unsubscribe = cache.subscribe(listener);
        unsubscribe();
        cache.set([note('0xa')]);

        expect(listener).not.toHaveBeenCalled();
    });

    it('notifies every listener', () => {
        const cache = createNotesCache();
        const first = vi.fn();
        const second = vi.fn();
        cache.subscribe(first);
        cache.subscribe(second);

        cache.set([note('0xa')]);

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
    });

    it('unsubscribing one leaves the others subscribed', () => {
        const cache = createNotesCache();
        const kept = vi.fn();
        const dropped = vi.fn();
        cache.subscribe(kept);
        cache.subscribe(dropped)();

        cache.set([note('0xa')]);

        expect(kept).toHaveBeenCalledOnce();
        expect(dropped).not.toHaveBeenCalled();
    });

    it('a get inside a listener already sees the new value', () => {
        // A host that re-reads the cache while reacting must not see the old
        // list — that would render one update behind, permanently.
        const cache = createNotesCache();
        let seen: ZkNote[] = [];
        cache.subscribe(() => {
            seen = cache.get();
        });

        cache.set([note('0xa')]);

        expect(seen).toEqual([note('0xa')]);
    });
});
