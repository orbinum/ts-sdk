/**
 * Self-note ephemeral keys — deterministic ephSk derivation for notes the
 * wallet creates for ITSELF (shields, change, self-transfers).
 *
 * A random ephSk is thrown away after sealing the memo, forcing a cold
 * restore to rediscover the wallet's own notes with one trial ECDH per pool
 * hint. Deriving it from the seed instead makes those notes recognizable by
 * a plain hash-set lookup on the published ephPk — zero EC work per hint:
 *
 *   ephSk_i = SHA256("orbinum-self-eph-v3" || ivsk || u32le(i))
 *
 * The published ephPk is a PRF-derived curve point — uniformly distributed
 * and indistinguishable from the random ephemerals used today (same argument
 * as BIP-32 HD public keys). The index `i` is a monotonic per-wallet counter;
 * reusing an index publishes the same ephPk twice, which links the two notes
 * as same-creator — callers must persist the counter and never reuse it.
 *
 * It hangs off the INCOMING viewing key, and it has to: a self note's memo is
 * sealed toward the wallet's own ivk, so the secret that opens it is
 * ECDH(ephSk, own ivk). An ovk holder could predict the point and still not
 * read the note. Finding one's own notes is part of "read what arrives", so it
 * lives on that branch — which is also what lets a watch-only wallet locate the
 * change notes carrying the recipient book.
 *
 * The cost, stated rather than discovered: a delegated ivsk can ENUMERATE every
 * self note. That is inherent — whoever can see everything can necessarily
 * enumerate everything — but under the old spending-key derivation it took the
 * spending key to do it.
 *
 * Received notes (a third party chose the ephSk) are untouched — they keep
 * the trial-decrypt path.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_EPH_WINDOW } from './windowBounds';
import { assertSecretKeyBytes } from '../../foundation/crypto/keyGuards';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { toHex } from '../../foundation/encoding/hex';
import { bytesToBjjScalar } from '../memo/EncryptedMemo';

const SELF_EPH_DOMAIN = new TextEncoder().encode('orbinum-self-eph-v3');

/**
 * Derive the deterministic 32-byte ephemeral secret for self-note `index`.
 * Feed it to EncryptedMemo.encrypt / NoteBuilder.build as `ephSkOverride`.
 */
export function deriveSelfEphSk(viewingSecretKey: Uint8Array, index: number): Uint8Array {
    // Rejected rather than coerced. `>>> 0` maps -1 onto 0xffffffff and 2^32
    // onto 0, so a counter that overflows or goes negative would silently land
    // on an index already published — and republishing an ephPk is the public
    // same-creator link this whole sequence exists to avoid.
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
        throw new Error(`deriveSelfEphSk: index must be a u32, got ${index}`);
    }
    // The KEY matters as much as the index. SHA256 answers for any input, so a
    // short or all-zero viewing key yields a sequence anyone can recompute —
    // and this sequence is what makes a wallet's own notes findable, so a
    // public one hands every shield and change note to whoever guesses it.
    // `deriveOutgoingEphSk` refuses the same shapes; this is the same check.
    assertSecretKeyBytes(viewingSecretKey, 'deriveSelfEphSk: viewingSecretKey');
    const h = sha256.create();
    h.update(SELF_EPH_DOMAIN);
    h.update(viewingSecretKey);
    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, index >>> 0, true);
    h.update(idx);
    return h.digest();
}

/** One precomputed self-note window entry. */
export interface SelfEphWindowEntry {
    index: number;
    /** 0x-prefixed LE-packed ephPk — byte-identical to the memo's last 32 bytes. */
    ephPkHex: string;
    /** ECDH shared secret vs the wallet's own ivk — feeds decryptWithSharedSecret. */
    sharedSecret: Uint8Array;
}

/**
 * Precompute the self-note discovery window [from, from+count): for each
 * index, the ephPk the wallet would have published and the shared secret
 * needed to decrypt the memo. One EC pass up front; scanning then matches
 * hints by ephPk hex equality with no per-hint EC work.
 *
 * @param viewingSecretKey Wallet incoming viewing key (the seed of the derivation).
 * @param ivkPacked   The wallet's OWN 32-byte LE packed viewing public key —
 *                    self memos are encrypted to it.
 */
export function selfEphWindow(
    viewingSecretKey: Uint8Array,
    ivkPacked: Uint8Array,
    from: number,
    count: number
): SelfEphWindowEntry[] {
    const ivkPoint = unpackPoint(bytesToBigintLE(ivkPacked));
    if (!ivkPoint) throw new Error('selfEphWindow: invalid viewing public key');

    const entries: SelfEphWindowEntry[] = [];
    // Bounded, because `count` decides how many elliptic-curve multiplications
    // run and it usually comes from stored config — a corrupt or hostile value
    // is an unbounded loop, not a wrong answer. The cap is far above any real
    // window; `windowSizeForCounter` never approaches it.
    if (!Number.isInteger(from) || from < 0) {
        throw new Error(`selfEphWindow: from must be a non-negative integer, got ${from}`);
    }
    if (!Number.isInteger(count) || count > MAX_EPH_WINDOW) {
        throw new Error(
            `selfEphWindow: count must be an integer <= ${MAX_EPH_WINDOW}, got ${count}`
        );
    }
    for (let i = from; i < from + count; i++) {
        // Same bytes→scalar clamp EncryptedMemo.encrypt applies to ephSkOverride,
        // so the published point matches byte-for-byte.
        const scalar = bytesToBjjScalar(deriveSelfEphSk(viewingSecretKey, i));
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
