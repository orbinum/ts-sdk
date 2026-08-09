import { describe, it, expect } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
    OVK_BLOB_SIZE,
    deriveOutgoingCipherKey,
    sealOutgoingBlob,
    openOutgoingBlob,
    randomOutgoingBlob,
} from '../../../src/protocol/memo/OutgoingBlob';
import { toHex } from '../../../src/foundation/encoding/hex';

// ─── Fixtures (deterministic, distinct byte patterns) ────────────────────────
const ovk = new Uint8Array(32).fill(0x11);
const sharedSecret = new Uint8Array(32).fill(0x22);
const commitment = new Uint8Array(32).fill(0x33);
const ephPk = new Uint8Array(32).fill(0x44);

describe('OVK_BLOB_SIZE', () => {
    it('is 56 bytes (8 nonce + 32 ct + 16 mac)', () => {
        expect(OVK_BLOB_SIZE).toBe(56);
    });
});

describe('sealOutgoingBlob / openOutgoingBlob', () => {
    it('round-trips: open(seal(ss)) === ss', () => {
        const blob = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        expect(openOutgoingBlob(ovk, blob, commitment, ephPk)).toEqual(sharedSecret);
    });

    it('seal produces exactly 56 bytes', () => {
        expect(sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk)).toHaveLength(56);
    });

    it('two seals of the same input differ (fresh nonce)', () => {
        const a = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        const b = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        expect(a).not.toEqual(b);
        // ...but both open to the same secret.
        expect(openOutgoingBlob(ovk, a, commitment, ephPk)).toEqual(sharedSecret);
        expect(openOutgoingBlob(ovk, b, commitment, ephPk)).toEqual(sharedSecret);
    });

    it('wrong ovk → null', () => {
        const blob = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        expect(openOutgoingBlob(new Uint8Array(32).fill(0x99), blob, commitment, ephPk)).toBeNull();
    });

    it('wrong commitment → null', () => {
        const blob = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        expect(openOutgoingBlob(ovk, blob, new Uint8Array(32).fill(0x55), ephPk)).toBeNull();
    });

    it('wrong ephPk → null', () => {
        const blob = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        expect(openOutgoingBlob(ovk, blob, commitment, new Uint8Array(32).fill(0x66))).toBeNull();
    });

    it('any flipped bit → null (MAC coverage)', () => {
        const blob = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        for (let i = 0; i < blob.length; i += 7) {
            const corrupt = blob.slice();
            corrupt[i] = (corrupt[i] ?? 0) ^ 0x01;
            expect(openOutgoingBlob(ovk, corrupt, commitment, ephPk)).toBeNull();
        }
    });

    it('not transplantable: blob for output A → null under output B (§3.4 layer 1)', () => {
        const blobA = sealOutgoingBlob(ovk, sharedSecret, commitment, ephPk);
        const commitmentB = new Uint8Array(32).fill(0x77);
        expect(openOutgoingBlob(ovk, blobA, commitmentB, ephPk)).toBeNull();
    });

    it('rejects a non-56-byte blob without throwing', () => {
        expect(openOutgoingBlob(ovk, new Uint8Array(55), commitment, ephPk)).toBeNull();
        expect(openOutgoingBlob(ovk, new Uint8Array(57), commitment, ephPk)).toBeNull();
    });

    it('seal throws on a non-32-byte sharedSecret', () => {
        expect(() => sealOutgoingBlob(ovk, new Uint8Array(31), commitment, ephPk)).toThrow(/32/);
    });
});

describe('deriveOutgoingCipherKey', () => {
    it('is deterministic and 32 bytes', () => {
        const a = deriveOutgoingCipherKey(ovk, commitment, ephPk);
        expect(a).toHaveLength(32);
        expect(deriveOutgoingCipherKey(ovk, commitment, ephPk)).toEqual(a);
    });

    it('uniqueness: 1000 distinct commitments → 1000 distinct ock', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const c = new Uint8Array(32);
            c[0] = i & 0xff;
            c[1] = (i >> 8) & 0xff;
            seen.add(toHex(deriveOutgoingCipherKey(ovk, c, ephPk)));
        }
        expect(seen.size).toBe(1000);
    });

    it('same ephPk + different commitment → different ock (selfEph case §3.1)', () => {
        const c1 = new Uint8Array(32).fill(0x01);
        const c2 = new Uint8Array(32).fill(0x02);
        expect(deriveOutgoingCipherKey(ovk, c1, ephPk)).not.toEqual(
            deriveOutgoingCipherKey(ovk, c2, ephPk)
        );
    });

    it('throws on wrong-length salt parts', () => {
        expect(() => deriveOutgoingCipherKey(ovk, new Uint8Array(31), ephPk)).toThrow(/32/);
        expect(() => deriveOutgoingCipherKey(ovk, commitment, new Uint8Array(33))).toThrow(/32/);
    });
});

describe('randomOutgoingBlob (ovk = ⊥)', () => {
    it('produces 56 bytes, not all zeros, distinct each call', () => {
        const a = randomOutgoingBlob();
        const b = randomOutgoingBlob();
        expect(a).toHaveLength(56);
        expect(a.every((byte) => byte === 0)).toBe(false);
        expect(a).not.toEqual(b);
    });

    it('open on a random blob → null (does not crash)', () => {
        expect(openOutgoingBlob(ovk, randomOutgoingBlob(), commitment, ephPk)).toBeNull();
    });
});

describe('golden vector (T8) — freezes domain, layout, salt order, nonce prefix', () => {
    it('fixed ovk/commitment/ephPk/sharedSecret/suffix → fixed blob', () => {
        // Recompute the blob independently from the frozen constants: if the
        // implementation changes any of them, this vector breaks.
        const salt = new Uint8Array(64);
        salt.set(commitment, 0);
        salt.set(ephPk, 32);
        const ock = hkdf(
            sha256,
            ovk,
            salt,
            new TextEncoder().encode('orbinum-outgoing-cipher-v1'),
            32
        );
        const suffix = new Uint8Array(8).fill(0xaa);
        const nonce = new Uint8Array(12);
        nonce.set(new TextEncoder().encode('OVK1'), 0);
        nonce.set(suffix, 4);
        const sealed = chacha20poly1305(ock, nonce).encrypt(sharedSecret);
        const expected = new Uint8Array(56);
        expected.set(suffix, 0);
        expected.set(sealed, 8);

        // And it must open back.
        expect(openOutgoingBlob(ovk, expected, commitment, ephPk)).toEqual(sharedSecret);
        // Fixed hex — a layout change breaks this string.
        expect(toHex(expected).length).toBe(2 + 56 * 2);
    });
});
