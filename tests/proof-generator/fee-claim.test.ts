import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactProvider, ProofResult } from '../../src/proof-generator/unshield';

// ─── Mock @orbinum/proof-generator ────────────────────────────────────────────

vi.mock('@orbinum/proof-generator', () => ({
    CircuitType: {
        Unshield: 'unshield',
        Transfer: 'transfer',
        ValueProof: 'value_proof',
        PrivateLink: 'private_link',
    },
    generateProof: vi.fn(),
    WebArtifactProvider: vi.fn().mockImplementation(function (this: object) { return this; }),
}));

import { generateFeeClaimProof, WebArtifactProvider } from '../../src/proof-generator/fee-claim';
import { generateProof } from '@orbinum/proof-generator';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COMMITMENT  = 42n;
const AMOUNT      = 1_000n;      // → circuit field "value"
const ASSET_ID    = 2n;
const OWNER_PK    = 99_999n;
const BLINDING    = 77n;

// Concrete public signals the mock circuit returns.
// Order: [commitment, value, asset_id, owner_hash]
const SIG_COMMITMENT  = COMMITMENT;   //  42n
const SIG_VALUE       = AMOUNT;       // 1000n
const SIG_ASSET_ID    = ASSET_ID;     //   2n
const SIG_OWNER_HASH  = 255n;

const MOCK_PROOF_RESULT: ProofResult = {
    proof: '0x' + 'cd'.repeat(64), // 128-byte hex
    publicSignals: [
        SIG_COMMITMENT.toString(),
        SIG_VALUE.toString(),
        SIG_ASSET_ID.toString(),
        SIG_OWNER_HASH.toString(),
    ],
    circuitType: 'value_proof' as ProofResult['circuitType'],
};

const BASE_INPUTS = {
    commitment: COMMITMENT,
    amount: AMOUNT,
    assetId: ASSET_ID,
    ownerPubkey: OWNER_PK,
    blinding: BLINDING,
};

// Helper — read the first mock call to generateProof
const call0 = () => vi.mocked(generateProof).mock.calls[0]!;

// ─── Helpers for byte-level assertions ────────────────────────────────────────

/**
 * Reads a little-endian bigint from `bytes[offset..offset+length]`.
 */
function readLeUint(bytes: number[], offset: number, length: number): bigint {
    let result = 0n;
    for (let i = length - 1; i >= 0; i--) {
        result = (result << 8n) | BigInt(bytes[offset + i]!);
    }
    return result;
}

// ─── generateFeeClaimProof ────────────────────────────────────────────────────

describe('generateFeeClaimProof', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(generateProof).mockResolvedValue(MOCK_PROOF_RESULT);
    });

    // ── Circuit type ──────────────────────────────────────────────────────────

    it('calls generateProof with CircuitType.ValueProof', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [circuitType] = call0();
        expect(circuitType).toBe('value_proof');
    });

    // ── Circuit inputs ────────────────────────────────────────────────────────

    it('maps inputs.commitment to circuit field "commitment" as decimal string', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        expect((ci as Record<string, unknown>)['commitment']).toBe(COMMITMENT.toString());
    });

    it('maps inputs.amount to circuit field "value" (not "amount")', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        const inputs = ci as Record<string, unknown>;
        expect(inputs['value']).toBe(AMOUNT.toString());
        expect(inputs['amount']).toBeUndefined();
    });

    it('maps inputs.assetId to circuit field "asset_id" as decimal string', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        expect((ci as Record<string, unknown>)['asset_id']).toBe(ASSET_ID.toString());
    });

    it('maps inputs.ownerPubkey to circuit field "owner_pubkey" as decimal string', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        expect((ci as Record<string, unknown>)['owner_pubkey']).toBe(OWNER_PK.toString());
    });

    it('maps inputs.blinding to circuit field "blinding" as decimal string', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        expect((ci as Record<string, unknown>)['blinding']).toBe(BLINDING.toString());
    });

    it('circuit inputs contain exactly the 5 expected fields', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, ci] = call0();
        expect(Object.keys(ci as object).sort()).toEqual(
            ['asset_id', 'blinding', 'commitment', 'owner_pubkey', 'value'].sort()
        );
    });

    // ── Proof field pass-through ──────────────────────────────────────────────

    it('returns the proof string from the circuit result', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        expect(result.proof).toBe(MOCK_PROOF_RESULT.proof);
    });

    // ── publicSignals buffer ──────────────────────────────────────────────────

    it('publicSignals is a number[] of length 76', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        expect(Array.isArray(result.publicSignals)).toBe(true);
        expect(result.publicSignals).toHaveLength(76);
    });

    it('publicSignals[0..32] encodes commitment as 32-byte LE', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const got = readLeUint(result.publicSignals, 0, 32);
        expect(got).toBe(SIG_COMMITMENT);
    });

    it('publicSignals[32..40] encodes value as u64 LE (8 bytes)', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const got = readLeUint(result.publicSignals, 32, 8);
        expect(got).toBe(SIG_VALUE);
    });

    it('publicSignals[40..44] encodes asset_id as u32 LE (4 bytes)', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const got = readLeUint(result.publicSignals, 40, 4);
        expect(got).toBe(SIG_ASSET_ID);
    });

    it('publicSignals[44..76] encodes owner_hash as 32-byte LE', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const got = readLeUint(result.publicSignals, 44, 32);
        expect(got).toBe(SIG_OWNER_HASH);
    });

    it('publicSignals bytes outside the four slots are zero', async () => {
        // With our fixtures: commitment=42n → byte[0]=42, [1..31]=0
        //                    value=1000n  → [32]=232,[33]=3,[34..39]=0
        //                    asset_id=2n  → [40]=2,[41..43]=0
        //                    owner_hash=255n → [44]=255,[45..75]=0
        const result = await generateFeeClaimProof(BASE_INPUTS);
        expect(result.publicSignals[1]).toBe(0);   // commitment high bytes
        expect(result.publicSignals[34]).toBe(0);  // value high bytes
        expect(result.publicSignals[41]).toBe(0);  // asset_id high bytes
        expect(result.publicSignals[45]).toBe(0);  // owner_hash high bytes
    });

    it('all publicSignals values are 0–255 (valid byte range)', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        for (const byte of result.publicSignals) {
            expect(byte).toBeGreaterThanOrEqual(0);
            expect(byte).toBeLessThanOrEqual(255);
        }
    });

    // ── Input validation ──────────────────────────────────────────────────────

    it('throws when amount is 0n', async () => {
        await expect(
            generateFeeClaimProof({ ...BASE_INPUTS, amount: 0n })
        ).rejects.toThrow(/amount must be greater than zero/);
    });

    it('throws when amount is negative', async () => {
        await expect(
            generateFeeClaimProof({ ...BASE_INPUTS, amount: -1n })
        ).rejects.toThrow(/amount must be greater than zero/);
    });

    it('does NOT call generateProof when validation fails', async () => {
        await generateFeeClaimProof({ ...BASE_INPUTS, amount: 0n }).catch(() => {});
        expect(generateProof).not.toHaveBeenCalled();
    });

    // ── Provider handling ─────────────────────────────────────────────────────

    it('uses WebArtifactProvider by default', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, , opts] = call0();
        expect((opts as { provider: unknown }).provider).toBeInstanceOf(WebArtifactProvider);
    });

    it('passes a custom provider through to generateProof', async () => {
        const customProvider = {} as ArtifactProvider;
        await generateFeeClaimProof(BASE_INPUTS, { provider: customProvider });
        const [, , opts] = call0();
        expect((opts as { provider: unknown }).provider).toBe(customProvider);
    });

    it('omits verbose from options when not specified', async () => {
        await generateFeeClaimProof(BASE_INPUTS);
        const [, , opts] = call0();
        expect(opts).not.toHaveProperty('verbose');
    });

    it('passes verbose: true when specified', async () => {
        await generateFeeClaimProof(BASE_INPUTS, { verbose: true });
        const [, , opts] = call0();
        expect((opts as { verbose?: boolean }).verbose).toBe(true);
    });

    // ── Determinism ───────────────────────────────────────────────────────────

    it('produces the same publicSignals for repeated calls with same inputs', async () => {
        const a = await generateFeeClaimProof(BASE_INPUTS);
        const b = await generateFeeClaimProof(BASE_INPUTS);
        expect(a.publicSignals).toEqual(b.publicSignals);
    });

    it('different amounts produce different publicSignals (value slot changes)', async () => {
        vi.mocked(generateProof)
            .mockResolvedValueOnce({
                ...MOCK_PROOF_RESULT,
                publicSignals: ['42', '500', '2', '255'],
            })
            .mockResolvedValueOnce({
                ...MOCK_PROOF_RESULT,
                publicSignals: ['42', '1500', '2', '255'],
            });

        const a = await generateFeeClaimProof({ ...BASE_INPUTS, amount: 500n });
        const b = await generateFeeClaimProof({ ...BASE_INPUTS, amount: 1500n });

        const valueA = readLeUint(a.publicSignals, 32, 8);
        const valueB = readLeUint(b.publicSignals, 32, 8);
        expect(valueA).not.toBe(valueB);
    });
});
