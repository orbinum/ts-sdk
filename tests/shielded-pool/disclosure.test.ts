import { describe, it, expect } from 'vitest';
import {
    buildDisclosurePublicSignals,
    deriveBabyJubjubKeypair,
    decryptDisclosureSignals,
} from '../../src/shielded-pool/protocol/disclosure';
import type { DisclosureProofOutput } from '../../src/shielded-pool/protocol/disclosure';
import { BN254_R } from '../../src/utils/crypto-constants';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COMMITMENT = '0x' + 'ab'.repeat(32);

/** Build a minimal DisclosureProofOutput mock with all-zero encrypted data. */
function mockProofOutput(overrides: Partial<DisclosureProofOutput['encryptedData']> = {}): DisclosureProofOutput {
    const zero = '0x' + '00'.repeat(32);
    return {
        proof: '0xproof',
        publicSignals: [],
        encryptedData: {
            epkX: zero,
            epkY: zero,
            encValue: zero,
            encAssetId: zero,
            encOwnerHash: zero,
            ...overrides,
        },
    } as unknown as DisclosureProofOutput;
}

// ─── buildDisclosurePublicSignals ────────────────────────────────────────────

describe('buildDisclosurePublicSignals', () => {
    it('returns exactly 256 bytes', () => {
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput());
        expect(buf).toHaveLength(256);
    });

    it('places commitment bytes at [0..32]', () => {
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput());
        for (let i = 0; i < 32; i++) {
            expect(buf[i]).toBe(0xab);
        }
    });

    it('accepts commitment without 0x prefix', () => {
        const raw = 'ab'.repeat(32);
        const buf = buildDisclosurePublicSignals(raw, 0n, 0n, mockProofOutput());
        expect(buf[0]).toBe(0xab);
    });

    it('places auditorPkX at [32..64] LE', () => {
        const buf = buildDisclosurePublicSignals(COMMITMENT, 1n, 0n, mockProofOutput());
        expect(buf[32]).toBe(1);
        for (let i = 33; i < 64; i++) expect(buf[i]).toBe(0);
    });

    it('places auditorPkY at [64..96] LE', () => {
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 2n, mockProofOutput());
        expect(buf[64]).toBe(2);
        for (let i = 65; i < 96; i++) expect(buf[i]).toBe(0);
    });

    it('places epkX from proofOutput at [96..128]', () => {
        const epkX = '0x' + 'cd'.repeat(32);
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput({ epkX }));
        for (let i = 96; i < 128; i++) expect(buf[i]).toBe(0xcd);
    });

    it('places epkY from proofOutput at [128..160]', () => {
        const epkY = '0x' + 'de'.repeat(32);
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput({ epkY }));
        for (let i = 128; i < 160; i++) expect(buf[i]).toBe(0xde);
    });

    it('places encValue at [160..192]', () => {
        const encValue = '0x' + 'ef'.repeat(32);
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput({ encValue }));
        for (let i = 160; i < 192; i++) expect(buf[i]).toBe(0xef);
    });

    it('places encAssetId at [192..224]', () => {
        const encAssetId = '0x' + 'f0'.repeat(32);
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput({ encAssetId }));
        for (let i = 192; i < 224; i++) expect(buf[i]).toBe(0xf0);
    });

    it('places encOwnerHash at [224..256]', () => {
        const encOwnerHash = '0x' + 'a1'.repeat(32);
        const buf = buildDisclosurePublicSignals(COMMITMENT, 0n, 0n, mockProofOutput({ encOwnerHash }));
        for (let i = 224; i < 256; i++) expect(buf[i]).toBe(0xa1);
    });

    it('all-zero buffer when all inputs are zero', () => {
        const zeroCommitment = '0x' + '00'.repeat(32);
        const buf = buildDisclosurePublicSignals(zeroCommitment, 0n, 0n, mockProofOutput());
        expect(buf.every((b) => b === 0)).toBe(true);
    });
});

// ─── deriveBabyJubjubKeypair ─────────────────────────────────────────────────

describe('deriveBabyJubjubKeypair', () => {
    const KEY_32 = new Uint8Array(32).fill(1);

    it('returns sk, pkX, pkY as bigints', () => {
        const { sk, pkX, pkY } = deriveBabyJubjubKeypair(KEY_32);
        expect(typeof sk).toBe('bigint');
        expect(typeof pkX).toBe('bigint');
        expect(typeof pkY).toBe('bigint');
    });

    it('is deterministic — same input gives same output', () => {
        const a = deriveBabyJubjubKeypair(KEY_32);
        const b = deriveBabyJubjubKeypair(KEY_32);
        expect(a.sk).toBe(b.sk);
        expect(a.pkX).toBe(b.pkX);
        expect(a.pkY).toBe(b.pkY);
    });

    it('different inputs give different keypairs', () => {
        const key1 = new Uint8Array(32).fill(1);
        const key2 = new Uint8Array(32).fill(2);
        const a = deriveBabyJubjubKeypair(key1);
        const b = deriveBabyJubjubKeypair(key2);
        expect(a.sk).not.toBe(b.sk);
    });

    it('returns pk on the Baby Jubjub curve (non-zero)', () => {
        const { pkX, pkY } = deriveBabyJubjubKeypair(KEY_32);
        expect(pkX).toBeGreaterThan(0n);
        expect(pkY).toBeGreaterThan(0n);
    });
});

// ─── decryptDisclosureSignals ─────────────────────────────────────────────────

describe('decryptDisclosureSignals', () => {
    it('decrypts value=0 and assetId=0 correctly (trivial case)', () => {
        const sk = deriveBabyJubjubKeypair(new Uint8Array(32).fill(7)).sk;

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Base8, mulPointEscalar } = require('@zk-kit/baby-jubjub');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { poseidon3 } = require('poseidon-lite');
        const epkX = Base8[0] as bigint;
        const epkY = Base8[1] as bigint;

        // shared = sk · Base8 (r=1 so epk = G)
        const shared = mulPointEscalar([epkX, epkY], sk);
        const k0: bigint = poseidon3([shared[0], shared[1], 0n]);
        const k1: bigint = poseidon3([shared[0], shared[1], 1n]);
        const k2: bigint = poseidon3([shared[0], shared[1], 2n]);

        // Encrypt plaintext=0 → enc_i = k_i
        const result = decryptDisclosureSignals(sk, {
            epkX, epkY,
            encValue: k0, encAssetId: k1, encOwnerHash: k2,
        });
        expect(result.value).toBe(0n);
        expect(result.assetId).toBe(0n);
        expect(result.ownerHash).toBe(0n);
    });

    it('decrypts non-zero values correctly', () => {
        const sk = deriveBabyJubjubKeypair(new Uint8Array(32).fill(3)).sk;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Base8, mulPointEscalar } = require('@zk-kit/baby-jubjub');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { poseidon3 } = require('poseidon-lite');
        const epkX = Base8[0] as bigint;
        const epkY = Base8[1] as bigint;

        const shared = mulPointEscalar([epkX, epkY], sk);
        const k0: bigint = poseidon3([shared[0], shared[1], 0n]);
        const k1: bigint = poseidon3([shared[0], shared[1], 1n]);
        const k2: bigint = poseidon3([shared[0], shared[1], 2n]);

        const value = 1_000_000n;
        const assetId = 42n;
        const ownerHash = 0xdeadbeefn;

        const encValue = (value + k0) % BN254_R;
        const encAssetId = (assetId + k1) % BN254_R;
        const encOwnerHash = (ownerHash + k2) % BN254_R;

        const result = decryptDisclosureSignals(sk, { epkX, epkY, encValue, encAssetId, encOwnerHash });
        expect(result.value).toBe(value);
        expect(result.assetId).toBe(assetId);
        expect(result.ownerHash).toBe(ownerHash);
    });
});
