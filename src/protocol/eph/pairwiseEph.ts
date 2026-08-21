/**
 * Pairwise ephemeral keys — a deterministic ephSk for notes sent BETWEEN two
 * parties who already know each other.
 *
 * `selfEph` removed the ECDH for a wallet's own notes, but a note from someone
 * else still costs one EC multiplication per pool hint: the sender picked a
 * random ephemeral the receiver cannot predict. That is ~99.6% of the pool and
 * what makes a rescan O(pool).
 *
 * Two parties who share a secret can predict it:
 *
 *   sharedSecret = ECDH(myViewingSk, theirViewingPk)          (symmetric)
 *   ephSk_i      = SHA256("orbinum-pairwise-eph-v1" || ss || u32le(i))
 *
 * The receiver precomputes a window of ephPk values per known sender and
 * matches hints by hash lookup — the same zero-EC path as selfEph, and no wire
 * change: the ephPk still travels as the memo's last 32 bytes.
 *
 * FIRST CONTACT IS UNCHANGED. The memo's `sourcePk` names the counterparty, so
 * a stranger's first payment is found by ordinary trial decryption and every
 * one after it is a hash lookup.
 *
 * ## Privacy
 *
 * The published ephPk is a PRF-derived curve point, uniformly distributed and
 * indistinguishable from random without the pair secret — the same argument
 * that makes selfEph and BIP-32 public keys safe.
 *
 * REUSING A COUNTER republishes an ephPk and publicly links the two notes as
 * one sender-receiver pair. This module is a pure function of (secret, range)
 * so the caller owns that state, exactly as with selfEph.
 *
 * VIEWING KEYS, NOT SPENDING KEYS. The pair secret lives on two devices and in
 * whatever backup either party keeps; deriving it from spending keys would let
 * one party's compromised storage bear on the other's authority to spend. The
 * worst case here is disclosure of which notes those two exchanged — visibility
 * a viewing key already confers.
 *
 * Matching is CLIENT-SIDE. Asking a server about a specific ephPk would tell it
 * which notes are yours, which the download-everything design exists to avoid.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_EPH_WINDOW } from './windowBounds';
import { assertSecretKeyBytes } from '../../foundation/crypto/keyGuards';
import { unpackUsableViewingKey } from '../../foundation/crypto/bjj';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { toHex } from '../../foundation/encoding/hex';
import { bytesToBjjScalar } from '../memo/EncryptedMemo';

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
    // Both sides checked, not just theirs. `unpackUsableViewingKey` also
    // rejects the cofactor-8 subgroup, where the shared secret collapses to at
    // most 8 values — plain `unpackPoint` accepts those.
    const theirPoint = unpackUsableViewingKey(bytesToBigintLE(theirIvkPacked));
    if (!theirPoint) throw new Error('derivePairwiseSharedSecret: invalid viewing public key');
    assertSecretKeyBytes(myViewingSk, 'derivePairwiseSharedSecret: myViewingSk');
    const shared = fastMulPoint(theirPoint, bytesToBjjScalar(myViewingSk));
    return bigintTo32Le(shared[0]);
}

/**
 * The ephemeral secret for the `index`-th note between this pair. Feed it to
 * `EncryptedMemo.encrypt` / `NoteBuilder.build` as `ephSkOverride`.
 */
export function derivePairwiseEphSk(pairSecret: Uint8Array, index: number): Uint8Array {
    // Rejected rather than coerced, exactly as in `deriveSelfEphSk` and
    // `deriveOutgoingEphSk`. `>>> 0` maps -1 onto 0xffffffff and 2^32 onto 0,
    // so an overflowing or negative counter lands on an index ALREADY
    // published — and republishing an ephPk publicly links the two payments
    // that carry it.
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
        throw new Error(`derivePairwiseEphSk: index must be a u32, got ${index}`);
    }
    assertSecretKeyBytes(pairSecret, 'derivePairwiseEphSk: pairSecret');
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
    // Bounded, because `count` decides how many elliptic-curve multiplications
    // run and it usually comes from stored config — a corrupt or hostile value
    // is an unbounded loop, not a wrong answer. The cap is far above any real
    // window; `windowSizeForCounter` never approaches it.
    if (!Number.isInteger(from) || from < 0) {
        throw new Error(`pairwiseEphWindow: from must be a non-negative integer, got ${from}`);
    }
    if (!Number.isInteger(count) || count > MAX_EPH_WINDOW) {
        throw new Error(
            `pairwiseEphWindow: count must be an integer <= ${MAX_EPH_WINDOW}, got ${count}`
        );
    }
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
