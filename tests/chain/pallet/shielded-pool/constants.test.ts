/**
 * Runtime parameters the chain enforces.
 *
 * These are values a wallet cannot derive and must not choose. `MIN_GASLESS_FEE`
 * in particular is what `planTransfer`/`planUnshield` need for their required
 * `fee` argument — without it a host recovers the number from a rejected
 * extrinsic, which is a poor way to learn a consensus rule.
 */
import { describe, it, expect } from 'vitest';
import {
    MIN_GASLESS_FEE,
    TRANSFER_INPUTS,
    TRANSFER_OUTPUTS,
    NATIVE_ASSET_ID,
    isNativeAsset,
} from '../../../../src/chain/pallet/shielded-pool/constants';

describe('MIN_GASLESS_FEE', () => {
    it('is 0.001 ORB in planck, matching the runtime MinGaslessFee', () => {
        expect(MIN_GASLESS_FEE).toBe(1_000_000_000_000_000n);
        expect(MIN_GASLESS_FEE).toBe(10n ** 18n / 1000n);
    });

    it('is a bigint — planck exceeds what a number holds exactly', () => {
        expect(typeof MIN_GASLESS_FEE).toBe('bigint');
    });
});

describe('transfer arity', () => {
    it('is 2-in/2-out, as the circuit fixes it', () => {
        // A spend with one real input pads with a dummy; change is always the
        // second output even when zero.
        expect(TRANSFER_INPUTS).toBe(2);
        expect(TRANSFER_OUTPUTS).toBe(2);
    });
});

describe('isNativeAsset', () => {
    it('recognises the native id in every form a record carries it', () => {
        expect(isNativeAsset(0n)).toBe(true);
        expect(isNativeAsset(0)).toBe(true);
        expect(isNativeAsset('0')).toBe(true);
        expect(isNativeAsset(NATIVE_ASSET_ID)).toBe(true);
    });

    it('treats a missing id as native', () => {
        // Records written before the pool carried multiple assets have no asset
        // id, and every one of those was ORB.
        expect(isNativeAsset(null)).toBe(true);
        expect(isNativeAsset(undefined)).toBe(true);
        expect(isNativeAsset('')).toBe(true);
    });

    it('rejects any other asset', () => {
        expect(isNativeAsset(1n)).toBe(false);
        expect(isNativeAsset('2')).toBe(false);
        expect(isNativeAsset(999)).toBe(false);
    });

    it('does not fold an unparseable id into the native total', () => {
        // Summing an unknown token as ORB produces a balance that means nothing.
        expect(isNativeAsset('not-a-number')).toBe(false);
        expect(isNativeAsset('0x')).toBe(false);
    });

    it('accepts hex, which some records store', () => {
        expect(isNativeAsset('0x0')).toBe(true);
        expect(isNativeAsset('0x1')).toBe(false);
    });
});
