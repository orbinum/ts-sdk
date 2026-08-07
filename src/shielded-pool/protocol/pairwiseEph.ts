/**
 * Pairwise ephemeral keys — deterministic ephSk for notes sent BETWEEN two
 * parties who already know each other.
 *
 * `selfEph` removed the ECDH for a wallet's own notes, but a note from someone
 * else still costs one elliptic-curve multiplication per pool hint, because
 * the sender picked a random ephemeral the receiver cannot predict. That is
 * the ~99.6% case and it is what makes a rescan O(pool).
 *
 * A sender and receiver who share a secret can predict it. Derive the
 * ephemeral from that shared secret and a counter:
 *
 *   sharedSecret = ECDH(myViewingSk, theirViewingPk)          (symmetric)
 *   ephSk_i      = SHA256("orbinum-pairwise-eph-v1" || ss || u32le(i))
 *
 * The receiver precomputes a window of ephPk values per known sender and
 * matches published hints by hash lookup — the same zero-EC path selfEph
 * already uses. Nothing about the wire format changes: the ephPk still travels
 * as the memo's last 32 bytes and is already indexed. No pallet change, no new
 * field, no migration.
 *
 * Where the counterparty comes from: the memo's plaintext carries
 * `counterpartyPk`, so the FIRST payment from a stranger is discovered by
 * ordinary trial decryption, and every payment after it is a hash lookup.
 * This makes recurring relationships — the common case for a wallet in daily
 * use — nearly free, while leaving first contact exactly as it is today.
 *
 * ## Privacy
 *
 * The published ephPk is a PRF-derived curve point, uniformly distributed and
 * indistinguishable from a random ephemeral to anyone without the pair secret
 * — the same argument that makes selfEph and BIP-32 public keys safe.
 *
 * Reusing a counter republishes the same ephPk, which publicly links the two
 * notes as sharing a sender-receiver pair. The counter must be persisted and
 * never reused; `pairwiseEphWindow` is deliberately a pure function of
 * (secret, range) so the caller owns that state, exactly as with selfEph.
 *
 * Viewing keys are used rather than spending keys on purpose. The pair secret
 * is held by both sides, so it will exist on two devices and inside whatever
 * backup either party keeps; deriving it from spending keys would make a
 * compromise of one party's stored secrets bear on the other's ability to
 * spend. With viewing keys the worst case is disclosure of which notes were
 * exchanged between those two parties — the visibility a viewing key already
 * confers — and nothing about authority to spend.
 *
 * Matching is CLIENT-SIDE only. Asking a server for a specific ephPk would
 * tell it which notes are yours, which is precisely what the scan's
 * download-everything design exists to avoid.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../utils/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../utils/bytes';
import { toHex } from '../../utils/hex';
import { bytesToBjjScalar } from './EncryptedMemo';

const PAIRWISE_EPH_DOMAIN = new TextEncoder().encode('orbinum-pairwise-eph-v1');

/**
 * The secret shared by a sender/receiver pair: ECDH between one side's viewing
 * SECRET key and the other side's viewing PUBLIC key. Symmetric — both parties
 * compute the same 32 bytes from opposite inputs, which is what lets the
 * sender choose an ephemeral the receiver can predict.
 *
 * @param myViewingSk  32-byte viewing secret key (from `deriveViewingSecretKey`).
 * @param theirIvkPacked 32-byte LE packed viewing public key of the other party.
 */
export function derivePairwiseSharedSecret(
    myViewingSk: Uint8Array,
    theirIvkPacked: Uint8Array
): Uint8Array {
    const theirPoint = unpackPoint(bytesToBigintLE(theirIvkPacked));
    if (!theirPoint) throw new Error('derivePairwiseSharedSecret: invalid viewing public key');
    const shared = fastMulPoint(theirPoint, bytesToBjjScalar(myViewingSk));
    return bigintTo32Le(shared[0]);
}

/**
 * The ephemeral secret for the `index`-th note between this pair. Feed it to
 * `EncryptedMemo.encrypt` / `NoteBuilder.build` as `ephSkOverride`.
 */
export function derivePairwiseEphSk(pairSecret: Uint8Array, index: number): Uint8Array {
    const h = sha256.create();
    h.update(PAIRWISE_EPH_DOMAIN);
    h.update(pairSecret);
    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, index >>> 0, true);
    h.update(idx);
    return h.digest();
}

/** One precomputed pairwise window entry — same shape as `SelfEphWindowEntry`. */
export interface PairwiseEphWindowEntry {
    index: number;
    /** 0x-prefixed LE-packed ephPk — byte-identical to the memo's last 32 bytes. */
    ephPkHex: string;
    /** ECDH shared secret vs the RECEIVER's ivk — feeds decryptWithSharedSecret. */
    sharedSecret: Uint8Array;
}

/**
 * Precomputes the discovery window [from, from+count) for one counterparty:
 * for each index, the ephPk that party would publish and the secret needed to
 * open the memo. One EC pass per sender up front; the scan then matches by hex
 * equality with no per-hint EC work.
 *
 * The cost is paid once per sender and reused across every page of the scan,
 * which is what makes it worth building — unlike a per-hint precompute, which
 * measured 26× SLOWER than just doing the multiplication.
 *
 * @param pairSecret       From `derivePairwiseSharedSecret`.
 * @param receiverIvkPacked The RECEIVER's packed viewing public key — the memo
 *                          is encrypted to it, so the shared secret is against
 *                          that key regardless of which side is precomputing.
 */
export function pairwiseEphWindow(
    pairSecret: Uint8Array,
    receiverIvkPacked: Uint8Array,
    from: number,
    count: number
): PairwiseEphWindowEntry[] {
    const ivkPoint = unpackPoint(bytesToBigintLE(receiverIvkPacked));
    if (!ivkPoint) throw new Error('pairwiseEphWindow: invalid viewing public key');

    const entries: PairwiseEphWindowEntry[] = [];
    for (let i = from; i < from + count; i++) {
        // Same bytes→scalar clamp EncryptedMemo.encrypt applies to ephSkOverride,
        // so the published point matches the memo byte-for-byte.
        const scalar = bytesToBjjScalar(derivePairwiseEphSk(pairSecret, i));
        const ephPk = fastMulBase(scalar);
        const sharedPoint = fastMulPoint(ivkPoint, scalar);
        entries.push({
            index: i,
            ephPkHex: toHex(bigintTo32Le(packPoint(ephPk) as bigint)),
            sharedSecret: bigintTo32Le(sharedPoint[0]),
        });
    }
    return entries;
}
