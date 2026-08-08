/**
 * bjj-fast — the noble-backed BabyJubJub multiplication MUST be byte-identical
 * to @zk-kit/baby-jubjub's, on which every on-chain memo depends. A mismatch
 * here silently breaks memo decryption — this suite is the contract.
 */
import { describe, it, expect } from 'vitest';
import { mulPointEscalar, Base8, packPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../../src/foundation/crypto/bjj-fast';
import { BABYJUB_SUBORDER } from '../../../src/foundation/crypto/constants';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';

describe('bjj-fast ≡ zk-kit', () => {
    it('base multiplication matches over a scalar sweep', () => {
        for (let i = 1; i <= 40; i++) {
            const k = (1234567890123456789n * BigInt(i) * 987654321n) % BABYJUB_SUBORDER || 1n;
            expect(fastMulBase(k)).toEqual(mulPointEscalar(Base8, k));
        }
    });

    it('variable-point multiplication matches (the scan ECDH shape)', () => {
        const P = mulPointEscalar(Base8, 424242n);
        for (let i = 1; i <= 40; i++) {
            const k = (998877665544332211n * BigInt(i)) % BABYJUB_SUBORDER || 1n;
            expect(fastMulPoint(P, k)).toEqual(mulPointEscalar(P, k));
        }
    });

    it('edge scalars: 1, suborder-1, multiples of suborder', () => {
        expect(fastMulBase(1n)).toEqual(mulPointEscalar(Base8, 1n));
        expect(fastMulBase(BABYJUB_SUBORDER - 1n)).toEqual(
            mulPointEscalar(Base8, BABYJUB_SUBORDER - 1n)
        );
        // k ≡ 0 (mod n) → identity [0, 1] (zk-kit agrees on the reduced scalar).
        expect(fastMulBase(BABYJUB_SUBORDER)).toEqual([0n, 1n]);
    });

    it('over-suborder scalars reduce identically (Base8 has order n)', () => {
        const k = 2n * BABYJUB_SUBORDER + 12345n;
        expect(fastMulBase(k)).toEqual(mulPointEscalar(Base8, k));
        const P = mulPointEscalar(Base8, 777n);
        expect(fastMulPoint(P, k)).toEqual(mulPointEscalar(P, k));
    });

    it('identity point input: [0,1] × k = [0,1]', () => {
        expect(fastMulPoint([0n, 1n], 12345n)).toEqual([0n, 1n]);
    });
});

// PrivacyKeys derives ivk and ownerPk through fastMulBase. Both are on-chain
// formats — the packed ivk is what a sender encrypts to, and ownerPk is what
// the commitment binds — so a drift here would not throw, it would silently
// produce keys that decrypt nothing and notes that can never be spent. The
// equivalence is pinned at the derived-value level, not just the primitive.
describe('PrivacyKeys derivations ≡ zk-kit', () => {
    const oldIvk = (ivsk: Uint8Array): Uint8Array => {
        const s = BigInt(toHex(ivsk)) % BABYJUB_SUBORDER || 1n;
        return bigintTo32Le(packPoint(mulPointEscalar(Base8, s)) as bigint);
    };

    it('deriveViewingPublicKey matches over a spending-key sweep', () => {
        for (let i = 1; i <= 25; i++) {
            const sk = (7654321098765432109n * BigInt(i)) % BABYJUB_SUBORDER || 1n;
            const ivsk = deriveViewingSecretKey(sk);

            expect(deriveViewingPublicKey(ivsk)).toEqual(oldIvk(ivsk));
        }
    });

    it('deriveOwnerPk matches, including edge scalars', () => {
        const scalars = [1n, 424242n, BABYJUB_SUBORDER - 1n, BABYJUB_SUBORDER + 5n];
        for (let i = 1; i <= 25; i++) {
            scalars.push((1357924680135792468n * BigInt(i)) % BABYJUB_SUBORDER || 1n);
        }

        for (const sk of scalars) {
            expect(deriveOwnerPk(sk)).toBe(mulPointEscalar(Base8, sk)[0]);
        }
    });
});
