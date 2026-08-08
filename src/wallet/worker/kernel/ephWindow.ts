/**
 * The precomputed discovery window: every ephPk this wallet can recognize
 * WITHOUT doing an elliptic-curve multiplication.
 *
 * Two mechanisms feed it and both publish a PRF-derived ephemeral the receiver
 * can predict, so both collapse to the same hash lookup and share one map:
 *
 *   - **self** — notes this wallet created for itself (shields, change)
 *   - **pairwise** — notes from a counterparty it has already been paid by
 *
 * ## Why it is cached
 *
 * Building it costs two EC muls per index, and a scan runs it against every
 * page of the feed. One build per identity amortises across the whole scan;
 * rebuilding per page would cost more than the ECDH it saves.
 *
 * ## What it holds
 *
 * SECRETS. Each entry carries an ECDH shared secret derived from the wallet's
 * viewing key — roughly 100 KB for a default window. The cache is keyed by
 * spending key so it can never answer for a different identity, but that is
 * "cannot be misused", not "is gone": see `clearKnownEphWindow`.
 */
import {
    selfEphWindow,
    derivePairwiseSharedSecret,
    pairwiseEphWindow,
} from '../../../protocol/eph/index';
import { deriveViewingPublicKey } from '../../../protocol/keys/PrivacyKeys';
import { SELF_EPH_WINDOW, PAIRWISE_EPH_WINDOW, type ScanKeys } from './types';

/** Which precomputed window recognized a hint — the two differ in what they prove. */
export type MatchSource = 'self' | 'pairwise';

export interface KnownEphEntry {
    sharedSecret: Uint8Array;
    index: number;
    source: MatchSource;
}

export interface KnownEphWindow {
    /** ephPkHex (lowercase) → entry. */
    byEphPk: Map<string, KnownEphEntry>;
}

// One window per worker lifetime — the EC precompute runs once on the first
// batch and is reused across every page of the scan.
//
// This holds SECRET material: every entry carries an ECDH shared secret derived
// from the wallet's viewing key. It outlives any single scan by design, which
// means it also outlives a vault lock unless someone clears it — see
// `clearKnownEphWindow`.
let cachedWindow: { cacheKey: string; window: KnownEphWindow } | null = null;

/**
 * Drops the precomputed discovery window and the shared secrets in it.
 *
 * Call when the wallet locks. The cache is keyed by spending key, so it can
 * never serve a different identity — but "cannot be misused" is not "is gone":
 * after `lock()` the session keys are dropped while ~100 KB of ECDH secrets
 * derived from the viewing key stay reachable in module memory, and on a
 * main-thread pool that is the page's own heap.
 *
 * Terminating a worker achieves the same thing by discarding the whole realm.
 * This exists for the main-thread pool, which has no realm to discard, and for
 * hosts that keep their workers warm across a lock.
 */
export function clearKnownEphWindow(): void {
    cachedWindow = null;
}

/** Stable map key for a packed key, so the window cache can compare sender sets. */
function bytesKey(bytes: Uint8Array): string {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
}

/**
 * The window for these keys, built on first use and cached after.
 *
 * Returns null when discovery is off entirely (no self-eph, no counterparties)
 * or when the primitives are unavailable — the scan then takes the trial-decrypt
 * path for everything, which is slower but correct.
 */
export function getKnownEphWindow(keys: ScanKeys): KnownEphWindow | null {
    const selfSize = keys.selfEphWindowSize ?? SELF_EPH_WINDOW;
    const pairSize = keys.pairwiseWindowSize ?? PAIRWISE_EPH_WINDOW;
    const counterparties = keys.pairwiseCounterparties ?? [];
    if (!keys.selfEph && counterparties.length === 0) return null;

    // Counterparties are part of the identity: learning a new sender must rebuild
    // the window, or their notes would keep taking the slow path forever.
    const cacheKey =
        `${keys.spendingKey.toString(16)}:${keys.selfEph ? selfSize : 0}:${pairSize}:` +
        counterparties.map((c) => bytesKey(c)).join(',');
    if (cachedWindow?.cacheKey === cacheKey) return cachedWindow.window;

    try {
        const ivkPacked = deriveViewingPublicKey(keys.viewingKey);
        const byEphPk = new Map<string, KnownEphEntry>();

        if (keys.selfEph) {
            for (const e of selfEphWindow(keys.spendingKey, ivkPacked, 0, selfSize)) {
                byEphPk.set(e.ephPkHex.toLowerCase(), {
                    sharedSecret: e.sharedSecret,
                    index: e.index,
                    source: 'self',
                });
            }
        }

        for (const theirIvk of counterparties) {
            const pairSecret = derivePairwiseSharedSecret(keys.viewingKey, theirIvk);
            for (const e of pairwiseEphWindow(pairSecret, ivkPacked, 0, pairSize)) {
                // Self entries win a collision: the wallet's own notes are the ones it
                // can always spend, and a clash here is a point collision anyway.
                const hex = e.ephPkHex.toLowerCase();
                if (!byEphPk.has(hex)) {
                    byEphPk.set(hex, {
                        sharedSecret: e.sharedSecret,
                        index: e.index,
                        source: 'pairwise',
                    });
                }
            }
        }

        cachedWindow = { cacheKey, window: { byEphPk } };
        return cachedWindow.window;
    } catch {
        // SDK without these primitives or bad keys — discovery off, scan intact.
        return null;
    }
}
