/**
 * Self-note ephemeral keys — deterministic ephSk derivation for notes the
 * wallet creates for ITSELF (shields, change, self-transfers).
 *
 * A random ephSk is thrown away after sealing the memo, forcing a cold
 * restore to rediscover the wallet's own notes with one trial ECDH per pool
 * hint. Deriving it from the seed instead makes those notes recognizable by
 * a plain hash-set lookup on the published ephPk — zero EC work per hint:
 *
 *   ephSk_i = SHA256("orbinum-self-eph-v1" || spendingKey_LE32 || u32le(i))
 *
 * The published ephPk is a PRF-derived curve point — uniformly distributed
 * and indistinguishable from the random ephemerals used today (same argument
 * as BIP-32 HD public keys). The index `i` is a monotonic per-wallet counter;
 * reusing an index publishes the same ephPk twice, which links the two notes
 * as same-creator — callers must persist the counter and never reuse it.
 *
 * Received notes (a third party chose the ephSk) are untouched — they keep
 * the trial-decrypt path.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { toHex } from '../../foundation/encoding/hex';
import { bytesToBjjScalar } from '../memo/EncryptedMemo';

const SELF_EPH_DOMAIN = new TextEncoder().encode('orbinum-self-eph-v1');

/**
 * Derive the deterministic 32-byte ephemeral secret for self-note `index`.
 * Feed it to EncryptedMemo.encrypt / NoteBuilder.build as `ephSkOverride`.
 */
export function deriveSelfEphSk(spendingKey: bigint, index: number): Uint8Array {
    const h = sha256.create();
    h.update(SELF_EPH_DOMAIN);
    h.update(bigintTo32Le(spendingKey));
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
 * @param spendingKey Wallet spending key (the seed of the derivation).
 * @param ivkPacked   The wallet's OWN 32-byte LE packed viewing public key —
 *                    self memos are encrypted to it.
 */
export function selfEphWindow(
    spendingKey: bigint,
    ivkPacked: Uint8Array,
    from: number,
    count: number
): SelfEphWindowEntry[] {
    const ivkPoint = unpackPoint(bytesToBigintLE(ivkPacked));
    if (!ivkPoint) throw new Error('selfEphWindow: invalid viewing public key');

    const entries: SelfEphWindowEntry[] = [];
    for (let i = from; i < from + count; i++) {
        // Same bytes→scalar clamp EncryptedMemo.encrypt applies to ephSkOverride,
        // so the published point matches byte-for-byte.
        const scalar = bytesToBjjScalar(deriveSelfEphSk(spendingKey, i));
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
