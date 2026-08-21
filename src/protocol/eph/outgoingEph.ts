/**
 * Outgoing ephemeral keys — a deterministic ephSk for notes this wallet SENDS.
 *
 * `selfEph` made a wallet's own notes recoverable from the seed and
 * `pairwiseEph` made a known counterparty's payments cheap to spot. Neither
 * helps the sender read back what they PAID: that memo is sealed toward someone
 * else, and the ephemeral that opened it was random.
 *
 *   ephSk_i = SHA256("orbinum-outgoing-eph-v3" || ovk || u32le(i))
 *
 * The published ephPk travels in the memo's last 32 bytes and depends on
 * NEITHER the amount nor the blinding — which is what makes recovery possible
 * at all: a restored sender recognises their own payments without knowing what
 * they are looking for. Recomputing the commitment cannot work, since that
 * needs the value, the very thing being recovered.
 *
 * A SEPARATE DOMAIN, not an index offset into `selfEph`. Sharing a domain and
 * reserving a high range looks equivalent: it is not, because a wallet that
 * publishes more self notes than the offset walks into the outgoing range and
 * republishes an ephPk. Distinct domains are disjoint at every index.
 *
 * ## Privacy
 *
 * PRF-derived, uniformly distributed, indistinguishable from a random ephemeral
 * without the ovk — the argument that carries `selfEph` and BIP-32.
 *
 * It hangs off the OUTGOING viewing key by design: predicting these points IS
 * the capability "see what I sent", so it belongs to the branch that names it.
 * The ovk holder is meant to enumerate the wallet's payments; the incoming
 * viewing key holder is not, and the spending key would have bundled the
 * payment graph with the authority to move funds.
 *
 * Reusing an index republishes an ephPk and links the two notes in public.
 * Unlike the pairwise counter this one is RECOVERABLE — see
 * `reconstructOutgoingIndex` — so a restore need not fall back to random.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_EPH_WINDOW } from './windowBounds';
import { assertSecretKeyBytes } from '../../foundation/crypto/keyGuards';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { toHex } from '../../foundation/encoding/hex';
import { bytesToBjjScalar } from '../memo/EncryptedMemo';

const OUTGOING_EPH_DOMAIN = new TextEncoder().encode('orbinum-outgoing-eph-v3');

/**
 * The ephemeral secret for the `index`-th note this wallet sends. Feed it to
 * `NoteBuilder.build` as `ephSkOverride`.
 */
export function deriveOutgoingEphSk(outgoingViewingKey: Uint8Array, index: number): Uint8Array {
    // Rejected rather than coerced. `>>> 0` maps -1 onto 0xffffffff and 2^32
    // onto 0, so a counter that overflows or goes negative would silently land
    // on an index already published — and republishing an ephPk is the public
    // same-creator link this whole sequence exists to avoid.
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
        throw new Error(`deriveOutgoingEphSk: index must be a u32, got ${index}`);
    }
    // A degenerate key is a PUBLIC sequence, not a weak one. SHA256 answers for
    // any input, so an ovk that is empty or all zeros — the shape a missing
    // field or an uninitialised buffer takes — yields ephemerals anyone can
    // recompute. That makes every payment recognisable as this wallet's and
    // opens its recipient book, since the book's keystream hangs off the same
    // key. Same failure the all-zero ivk had in a privacy address, reached from
    // the other side, so it is refused the same way: loudly, at the boundary.
    assertSecretKeyBytes(outgoingViewingKey, 'deriveOutgoingEphSk: outgoingViewingKey');
    const h = sha256.create();
    h.update(OUTGOING_EPH_DOMAIN);
    h.update(outgoingViewingKey);
    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, index >>> 0, true);
    h.update(idx);
    return h.digest();
}

/** The ephPk this wallet publishes at `index` — the memo's last 32 bytes. */
export function deriveOutgoingEphPk(outgoingViewingKey: Uint8Array, index: number): string {
    const scalar = bytesToBjjScalar(deriveOutgoingEphSk(outgoingViewingKey, index));
    return toHex(bigintTo32Le(packPoint(fastMulBase(scalar)) as bigint)).toLowerCase();
}

/** One precomputed outgoing window entry. */
export interface OutgoingEphWindowEntry {
    index: number;
    /** 0x-prefixed LE-packed ephPk — byte-identical to the memo's last 32 bytes. */
    ephPkHex: string;
}

/**
 * Precompute [from, from+count) of the outgoing sequence.
 *
 * Only the ephPk, never a shared secret: unlike the self and pairwise windows,
 * the secret that opens an outgoing memo depends on the RECIPIENT's viewing
 * key, which is not known until the note is matched. Recovery derives it then,
 * per candidate, with `deriveOutgoingSharedSecret`.
 */
export function outgoingEphWindow(
    outgoingViewingKey: Uint8Array,
    from: number,
    count: number
): OutgoingEphWindowEntry[] {
    const entries: OutgoingEphWindowEntry[] = [];
    // Bounded, because `count` decides how many elliptic-curve multiplications
    // run and it usually comes from stored config — a corrupt or hostile value
    // is an unbounded loop, not a wrong answer. The cap is far above any real
    // window; `windowSizeForCounter` never approaches it.
    if (!Number.isInteger(from) || from < 0) {
        throw new Error(`outgoingEphWindow: from must be a non-negative integer, got ${from}`);
    }
    if (!Number.isInteger(count) || count > MAX_EPH_WINDOW) {
        throw new Error(
            `outgoingEphWindow: count must be an integer <= ${MAX_EPH_WINDOW}, got ${count}`
        );
    }
    for (let i = from; i < from + count; i++) {
        entries.push({ index: i, ephPkHex: deriveOutgoingEphPk(outgoingViewingKey, i) });
    }
    return entries;
}

/**
 * The secret that opens the memo of the payment this wallet sent at `index`.
 *
 * The same value the recipient computes from their viewing secret key and the
 * published ephPk — reached from the other side, which is what lets the sender
 * read back a memo sealed toward someone else.
 *
 * Throws on a viewing key that is not a curve point; callers sweeping
 * candidates should treat that as "not this one".
 */
export function deriveOutgoingSharedSecret(
    outgoingViewingKey: Uint8Array,
    index: number,
    recipientIvkPacked: Uint8Array
): Uint8Array {
    const ivkPoint = unpackPoint(bytesToBigintLE(recipientIvkPacked));
    if (!ivkPoint) throw new Error('deriveOutgoingSharedSecret: invalid viewing public key');
    const scalar = bytesToBjjScalar(deriveOutgoingEphSk(outgoingViewingKey, index));
    return bigintTo32Le(fastMulPoint(ivkPoint, scalar)[0]);
}

/**
 * The next unused outgoing index, read off the chain.
 *
 * The sender can predict every ephPk they would publish, so the highest one
 * that actually appears on chain names the last index used. This is what the
 * pairwise counter cannot do — its ephemerals depend on a counterparty the
 * restored wallet no longer knows — and it is why an outgoing sequence may
 * start at 0 instead of degrading to a random ephemeral.
 *
 * ## This result must never be trusted on its own
 *
 * Omission is a WRITE attack: a feed that hides the highest index makes this
 * return a value already published, and using it republishes that ephPk. Two
 * rules follow, both enforced by the caller in `reserveOutgoingIndex`:
 *
 *   - never move a counter BACKWARDS — a local counter always wins;
 *   - after a restore, where there is no local counter to compare against,
 *     leave a gap so a feed would have to hide a whole run of consecutive
 *     top indexes rather than a single one.
 *
 * @param window How many indexes to consider — must cover the highest ever
 *               used, or a high index stays invisible and gets handed out
 *               again. Grow it with the counter, as `selfEphGap` does.
 */
export function reconstructOutgoingIndex(
    outgoingViewingKey: Uint8Array,
    publishedEphPks: Iterable<string>,
    window: number
): number {
    // Normalised rather than probed as given: hex case is a serving decision, and
    // a set of UPPERCASE ephPks would match nothing, reconstruct as 0, and hand
    // back indexes already on chain — the reuse this whole function exists to
    // prevent, reached by a cosmetic difference.
    const published = new Set<string>();
    for (const hex of publishedEphPks) published.add(hex.toLowerCase());

    let highest = -1;
    for (let i = 0; i < window; i++) {
        if (published.has(deriveOutgoingEphPk(outgoingViewingKey, i))) highest = i;
    }
    return highest + 1;
}
