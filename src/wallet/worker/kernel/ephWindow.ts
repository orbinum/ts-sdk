/**
 * The precomputed discovery window: every ephPk this wallet can recognize
 * WITHOUT doing an elliptic-curve multiplication.
 *
 * Three mechanisms feed it, each publishing a PRF-derived ephemeral somebody can
 * predict, so all three collapse to a hash lookup:
 *
 *   - **self** — notes this wallet created for itself (shields, change)
 *   - **pairwise** — notes from a counterparty it has already been paid by
 *   - **outgoing** — notes this wallet SENT, which it can recognise because it
 *     chose their ephemeral
 *
 * The first two share one map and carry the secret that opens the memo. The
 * third cannot: an outgoing memo is sealed toward the recipient, so the secret
 * is not derivable until a candidate viewing key is in hand.
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
    outgoingEphWindow,
} from '../../../protocol/eph/index';
import { deriveViewingPublicKey } from '../../../protocol/keys/PrivacyKeys';
import { isUsableSecretKey } from '../../../foundation/crypto/keyGuards';
import { toHex } from '../../../foundation/encoding/hex';
import { SELF_EPH_WINDOW, PAIRWISE_EPH_WINDOW, OUTGOING_EPH_WINDOW, type ScanKeys } from './types';

/** Which precomputed window recognized a hint — the two differ in what they prove. */
type MatchSource = 'self' | 'pairwise';

export interface KnownEphEntry {
    sharedSecret: Uint8Array;
    index: number;
    source: MatchSource;
}

export interface KnownEphWindow {
    /** ephPkHex (lowercase) → entry. */
    byEphPk: Map<string, KnownEphEntry>;
    /**
     * ephPkHex (lowercase) → outgoing index, for the notes this wallet SENT.
     *
     * Separate from `byEphPk` because it holds no shared secret: an outgoing
     * memo is sealed toward the RECIPIENT, whose key is not known until a
     * candidate opens it. The index is all the precompute can supply, and it is
     * what recovery needs to derive the secret per candidate.
     */
    outgoingByEphPk: Map<string, number>;
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
    const outSize = keys.outgoingEphWindowSize ?? OUTGOING_EPH_WINDOW;
    const counterparties = keys.pairwiseCounterparties ?? [];
    // Presence is not enough — the KEY has to be USABLE. An all-zero ovk (a
    // missing field, an uninitialised buffer) derives a sequence anyone can
    // recompute, matching this wallet's payments against a public window and
    // opening its recipient book in the clear.
    //
    // Refused here, not below: `deriveOutgoingEphSk` throws on it, and that
    // throw lands inside the window build whose catch would turn off the SELF
    // sequence too. This way a bad ovk costs only the outgoing route.
    const canScanOutgoing = keys.outgoingEph === true && isUsableSecretKey(keys.outgoingViewingKey);
    if (!keys.selfEph && !canScanOutgoing && counterparties.length === 0) return null;

    // Counterparties are part of the identity: learning a new sender must rebuild
    // the window, or their notes would keep taking the slow path forever.
    const cacheKey =
        `${keys.spendingKey.toString(16)}:${keys.selfEph ? selfSize : 0}:${pairSize}:` +
        `${canScanOutgoing ? outSize : 0}:` +
        counterparties.map((c) => toHex(c)).join(',');
    if (cachedWindow?.cacheKey === cacheKey) return cachedWindow.window;

    try {
        const ivkPacked = deriveViewingPublicKey(keys.viewingKey);
        const byEphPk = new Map<string, KnownEphEntry>();
        const outgoingByEphPk = new Map<string, number>();

        if (keys.selfEph) {
            for (const e of selfEphWindow(keys.viewingKey, ivkPacked, 0, selfSize)) {
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

        if (canScanOutgoing) {
            // Kept out of `byEphPk`: these carry no shared secret, and a hint
            // that matches here is NOT a note this wallet can spend.
            for (const e of outgoingEphWindow(keys.outgoingViewingKey!, 0, outSize)) {
                // Normalised HERE, like the two maps above, rather than trusting
                // the producer to do it. `deriveOutgoingEphPk` happens to
                // lowercase today, so this looked redundant — but the lookup
                // side lowercases unconditionally, and a mismatch costs no error
                // at all: every own payment silently stops being recognised.
                outgoingByEphPk.set(e.ephPkHex.toLowerCase(), e.index);
            }
        }

        cachedWindow = { cacheKey, window: { byEphPk, outgoingByEphPk } };
        return cachedWindow.window;
    } catch {
        // SDK without these primitives or bad keys — discovery off, scan intact.
        return null;
    }
}
