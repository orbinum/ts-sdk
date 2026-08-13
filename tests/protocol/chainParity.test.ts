/**
 * Cross-implementation parity: the SDK vs the chain.
 *
 * The node and this SDK are two independent implementations of one protocol.
 * Every constant, every layout and every acceptance rule below exists in BOTH,
 * and a disagreement is a bug no single-repo suite can see: the SDK builds a
 * note the chain rejects (funds stuck), or encodes a value the chain reads as a
 * DIFFERENT one (funds lost).
 *
 * The Rust side of each pairing is named in the comment so a change to either
 * repo lands here. Values are pinned literally rather than imported, because a
 * test that derives a constant from the code under test cannot detect that the
 * constant moved.
 */
import { describe, it, expect } from 'vitest';
import { poseidon4 } from 'poseidon-lite';
import {
    bigintTo32Le,
    bigintTo32Be,
    bigintTo32LeArr,
    bytesToBigintLE,
} from '../../src/foundation/encoding/bytes';
import { ENCRYPTED_MEMO_SIZE } from '../../src/protocol/memo/EncryptedMemo';
import { BN254_R } from '../../src/foundation/crypto/constants';

/**
 * `is_canonical_le` from primitives/zk-core/src/types.rs: a 32-byte LE string is
 * canonical iff re-encoding the reduced element gives back the same bytes —
 * i.e. iff the value is < p. The pallet rejects every non-canonical commitment
 * and nullifier (`Error::InvalidPublicSignals`), so anything the SDK sends must
 * satisfy this.
 */
function isCanonicalLe(bytes: Uint8Array): boolean {
    return bytesToBigintLE(bytes) < BN254_R;
}

describe('frozen sizes match the pallet', () => {
    // frame/shielded-pool/src/types/memo.rs — MAX_ENCRYPTED_MEMO_SIZE
    it('memo is 180 bytes on both sides', () => {
        expect(ENCRYPTED_MEMO_SIZE).toBe(180);
    });

});

describe('canonicity: what the SDK sends, the pallet must accept', () => {
    /**
     * Commitments come out of Poseidon, which reduces mod p — so they are
     * canonical by construction. This pins that, since it is the property the
     * chain relies on and a hash swap could break it silently.
     */
    it('Poseidon commitments are always canonical', () => {
        for (let i = 0n; i < 200n; i++) {
            const c = poseidon4([i * 7919n, 0n, i * 104729n + 1n, i * 15485863n + 3n]);
            expect(isCanonicalLe(bigintTo32Le(c))).toBe(true);
        }
    });

    /**
     * The exact boundary. `p - 1` is the largest canonical value; `p` itself and
     * `p + 1` are not, and the pallet rejects them with InvalidPublicSignals.
     */
    it('the canonical boundary sits exactly at p', () => {
        expect(isCanonicalLe(bigintTo32Le(BN254_R - 1n))).toBe(true);
        expect(isCanonicalLe(bigintTo32Le(BN254_R))).toBe(false);
        expect(isCanonicalLe(bigintTo32Le(BN254_R + 1n))).toBe(false);
    });

    /**
     * Zero is canonical as a field element, but the pallet separately rejects a
     * zero COMMITMENT (`is_valid`) because it is the empty-leaf sentinel, and
     * treats a zero NULLIFIER as the dummy input. Both are shapes the SDK must
     * never emit for a real note.
     */
    it('zero is canonical yet reserved — the SDK must not build a real note on it', () => {
        expect(isCanonicalLe(bigintTo32Le(0n))).toBe(true);
        // A real note always has a non-zero value and blinding, so its
        // commitment is a Poseidon output — never the reserved zero.
        const real = poseidon4([1n, 0n, 12345n, 67890n]);
        expect(real).not.toBe(0n);
    });
});

describe('32-byte encoders refuse what they cannot represent', () => {
    /**
     * REGRESSION. `v >>= 8n` on a negative bigint is an arithmetic shift: it
     * converges to -1n and never reaches zero, so `-1n` used to encode as 32
     * bytes of 0xFF — which reads back as 2^256-1, a NON-CANONICAL value the
     * chain rejects. Silent corruption of an on-chain commitment.
     */
    it('a negative value throws instead of encoding as 0xFF…FF', () => {
        for (const enc of [bigintTo32Le, bigintTo32Be, bigintTo32LeArr]) {
            expect(() => enc(-1n)).toThrow(/does not fit in 32 bytes/);
            expect(() => enc(-5n)).toThrow(/does not fit in 32 bytes/);
        }
    });

    /**
     * REGRESSION, and the worse half: a value ≥ 2^256 had its high bits dropped,
     * so `2^256 + 7` encoded as `7` — a DIFFERENT number, canonical, which the
     * chain accepts happily. The note would be committed under a value the
     * wallet does not have.
     */
    it('a value ≥ 2^256 throws instead of silently truncating to a different number', () => {
        for (const enc of [bigintTo32Le, bigintTo32Be, bigintTo32LeArr]) {
            expect(() => enc(1n << 256n)).toThrow(/does not fit in 32 bytes/);
            expect(() => enc((1n << 256n) + 7n)).toThrow(/does not fit in 32 bytes/);
        }
    });

    it('the full in-range domain still encodes, boundaries included', () => {
        const max = (1n << 256n) - 1n;
        for (const v of [0n, 1n, BN254_R - 1n, BN254_R, max]) {
            expect(bigintTo32Le(v)).toHaveLength(32);
            expect(bytesToBigintLE(bigintTo32Le(v))).toBe(v);
        }
    });

    it('LE and the number[] form agree byte for byte', () => {
        for (const v of [0n, 1n, 255n, 256n, BN254_R - 1n, (1n << 256n) - 1n]) {
            expect(Array.from(bigintTo32Le(v))).toEqual(bigintTo32LeArr(v));
        }
    });

    /**
     * Endianness is the failure mode `shieldParams.ts` warns about in prose:
     * commitments travel LITTLE-endian, and a big-endian spelling produces a
     * commitment the chain stores and NOBODY can ever find. Pin that they differ
     * so a future refactor cannot quietly swap one for the other.
     */
    it('LE and BE are genuinely different spellings', () => {
        const v = 0x1234n;
        expect(bigintTo32Le(v)[0]).toBe(0x34);
        expect(bigintTo32Be(v)[31]).toBe(0x34);
        expect(Array.from(bigintTo32Le(v))).not.toEqual(Array.from(bigintTo32Be(v)));
    });
});

describe('round-trip stability over the whole encoding domain', () => {
    /**
     * Deterministic sweep: every value the SDK can legally encode must come back
     * identical. A round-trip that loses information is a note that cannot be
     * recomputed from its own record.
     */
    it('encode → decode is the identity for 2000 pseudo-random scalars', () => {
        let seed = 0x243f6a8885a308d3n;
        const mask = (1n << 256n) - 1n;
        for (let i = 0; i < 2000; i++) {
            seed = (seed * 6364136223846793005n + 1442695040888963407n) & mask;
            const v = seed & mask;
            expect(bytesToBigintLE(bigintTo32Le(v))).toBe(v);
        }
    });
});
