/**
 * bjj-fast — the noble-backed BabyJubJub multiplication MUST be byte-identical
 * to @zk-kit/baby-jubjub's, on which every on-chain memo depends. A mismatch
 * here silently breaks memo decryption — this suite is the contract.
 */
import { describe, it, expect } from 'vitest';
import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../src/utils/bjj-fast';
import { BABYJUB_SUBORDER } from '../../src/utils/crypto-constants';

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
      mulPointEscalar(Base8, BABYJUB_SUBORDER - 1n),
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
