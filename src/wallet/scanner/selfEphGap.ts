/**
 * Self-eph gap-limit sweep — fixes the counter after a restore that found self
 * notes near the top of the discovery window.
 *
 * A wallet with more self notes than the window still FINDS the excess via
 * trial-decrypt, but the scan only learns the indexes of window matches. If the
 * counter were bumped from that partial maximum, the next note would reuse an
 * already-published ephemeral index — the same ephPk twice on chain, linking
 * both notes as same-creator.
 *
 * The fix needs no pool re-scan: every self note is already in the vault and
 * carries its published ephPk in the memo tail. Derive extension windows and
 * match them against that small set, with BIP-44 gap-limit semantics — stop at
 * the first window with zero matches.
 */
import { selfEphWindow } from '../../protocol/eph/index';
import { deriveViewingPublicKey } from '../../protocol/keys/PrivacyKeys';
// Straight from the module that declares it, never the `../worker` barrel: that
// barrel re-exports the pool, so importing one number through it would pull the
// whole worker implementation into the root entry's graph.
import { SELF_EPH_WINDOW } from '../worker/kernel/types';
import { toHex } from '../../foundation/encoding/hex';
import type { ZkNote } from '../../protocol/types';

/** Published ephPk of a note: the memo's last 32 bytes, 0x-prefixed lowercase. */
function noteEphPkHex(note: ZkNote): string | null {
    if (!Array.isArray(note.memo) || note.memo.length < 32) return null;
    return toHex(note.memo.slice(-32)).toLowerCase();
}

/** Sweep trigger margin: matches this close to the window top may hide more above. */
export function gapMargin(windowSize: number): number {
    return Math.max(1, Math.floor(windowSize / 16));
}

/**
 * Returns the highest self-eph index actually in use, extending past the scan
 * window when the scan's maximum landed near its top. `null` in, `null` out (no
 * self notes seen). Cost: two EC muls per extension index, only when the sweep
 * triggers — the common wallet never enters the loop.
 */
export function resolveSelfEphCeiling(params: {
    /** The wallet's notes AFTER persist — self notes carry their ephPk in the memo. */
    notes: ZkNote[];
    spendingKey: bigint;
    viewingKey: Uint8Array;
    /** Highest window-matched index reported by the scan. */
    scanMaxIndex: number | null;
    windowSize?: number;
}): number | null {
    const { notes, spendingKey, viewingKey, scanMaxIndex } = params;
    const windowSize = params.windowSize ?? SELF_EPH_WINDOW;
    if (scanMaxIndex === null) return null;
    if (scanMaxIndex < windowSize - gapMargin(windowSize)) return scanMaxIndex;

    const ownEphPks = new Set<string>();
    for (const note of notes) {
        const hex = noteEphPkHex(note);
        if (hex) ownEphPks.add(hex);
    }

    const ivkPacked = deriveViewingPublicKey(viewingKey);
    let max = scanMaxIndex;
    let from = windowSize;
    for (;;) {
        const slice = selfEphWindow(spendingKey, ivkPacked, from, windowSize);
        let matched = false;
        for (const entry of slice) {
            if (ownEphPks.has(entry.ephPkHex.toLowerCase())) {
                matched = true;
                if (entry.index > max) max = entry.index;
            }
        }
        if (!matched) break;
        from += windowSize;
    }
    return max;
}

/**
 * Discovery window size for the next scan, given the persisted counter: at least
 * the default, rounded up so every index the wallet may already have used (plus
 * the gap margin) falls inside the fast path.
 */
export function windowSizeForCounter(counter: number): number {
    const needed = counter + gapMargin(SELF_EPH_WINDOW);
    return Math.max(SELF_EPH_WINDOW, Math.ceil(needed / SELF_EPH_WINDOW) * SELF_EPH_WINDOW);
}
