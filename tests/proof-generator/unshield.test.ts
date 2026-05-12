import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactProvider, ProofResult } from '../../src/proof-generator/unshield';

// ─── Mock @orbinum/proof-generator ────────────────────────────────────────────

vi.mock('@orbinum/proof-generator', () => ({
    CircuitType: { Unshield: 'unshield', Transfer: 'transfer' },
    generateProof: vi.fn(),
    WebArtifactProvider: vi.fn().mockImplementation(function (this: object) { return this; }),
}));

// Mock @noble/ciphers/utils.js — deterministic randomBytes for testing
vi.mock('@noble/ciphers/utils.js', () => ({
    randomBytes: vi.fn(() => new Uint8Array(32).fill(0xab)),
}));

// Mock @zk-kit/baby-jubjub — deterministic ownerPk derivation
vi.mock('@zk-kit/baby-jubjub', () => ({
    Base8: [0n, 0n],
    mulPointEscalar: vi.fn((_base: unknown, sk: bigint) => [sk * 2n, 0n]),
}));

import { generateUnshieldProof, CircuitType, WebArtifactProvider } from '../../src/proof-generator/unshield';
import { generateProof } from '@orbinum/proof-generator';

const mockProofResult: ProofResult = {
    proof: '0x' + 'ab'.repeat(64),
    publicSignals: ['1', '2'],
    circuitType: CircuitType.Unshield,
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// 32-byte LE hex where byte[0]=0x01
const HEX_ROOT = '0x' + '01' + '00'.repeat(31);
// 20 siblings for a depth-20 tree
const PATH_SIBLINGS = new Array(20).fill('0x' + '02' + '00'.repeat(31));

const BASE_INPUTS = {
    merkleRoot: HEX_ROOT,
    nullifier: 100n,
    amount: 500n,
    assetId: 0n,
    recipient: 999n,
    blinding: 42n,
    spendingKey: 7n,
    pathSiblings: PATH_SIBLINGS,
    leafIndex: 3,
};

// Helper — avoids repeated non-null assertions on mock.calls[0]
const call0 = () => vi.mocked(generateProof).mock.calls[0]!;

describe('generateUnshieldProof', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(generateProof).mockResolvedValue(mockProofResult);
    });

    it('returns proof fields from generateProof', async () => {
        const result = await generateUnshieldProof(BASE_INPUTS);
        expect(result).toMatchObject(mockProofResult);
    });

    it('exposes changeCommitment and changeValue on the result', async () => {
        const result = await generateUnshieldProof(BASE_INPUTS);
        expect(result).toHaveProperty('changeCommitment');
        expect(result).toHaveProperty('changeValue');
        expect(result.changeValue).toBe(0n);
        expect(result.changeCommitment).toBe(0n);
    });

    it('calls generateProof with CircuitType.Unshield', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        expect(generateProof).toHaveBeenCalledWith(
            CircuitType.Unshield,
            expect.any(Object),
            expect.any(Object)
        );
    });

    it('passes merkle_root as decimal string of LE bigint', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        expect((circuitInputs as Record<string, unknown>)['merkle_root']).toBe('1');
    });

    it('passes nullifier as string', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        expect((circuitInputs as Record<string, unknown>)['nullifier']).toBe('100');
    });

    it('passes amount and note_value as the same string when fee and changeValue are 0', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['amount']).toBe('500');
        expect(ci['note_value']).toBe('500');
    });

    it('passes path_elements with length equal to pathSiblings', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect((ci['path_elements'] as string[]).length).toBe(20);
    });

    it('passes path_indices as ["0","1"] bits for leafIndex=3', async () => {
        // leafIndex 3 = binary ...011 → first two bits: [1, 1, 0, ...]
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        const indices = ci['path_indices'] as string[];
        expect(indices[0]).toBe('1');
        expect(indices[1]).toBe('1');
        expect(indices[2]).toBe('0');
    });

    it('uses WebArtifactProvider by default', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        expect(WebArtifactProvider).toHaveBeenCalledTimes(1);
    });

    it('forwards a custom provider if supplied', async () => {
        const customProvider = {} as ArtifactProvider;
        await generateUnshieldProof(BASE_INPUTS, { provider: customProvider });
        const [, , opts] = call0();
        expect((opts as Record<string, unknown>)['provider']).toBe(customProvider);
        expect(WebArtifactProvider).not.toHaveBeenCalled();
    });

    it('does not include verbose key when not specified', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, , opts] = call0();
        expect(opts).not.toHaveProperty('verbose');
    });

    it('forwards verbose when specified', async () => {
        await generateUnshieldProof(BASE_INPUTS, { verbose: true });
        const [, , opts] = call0();
        expect((opts as Record<string, unknown>)['verbose']).toBe(true);
    });

    // ── fee signal ──────────────────────────────────────────────────────────────

    it('passes fee as "0" by default', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['fee']).toBe('0');
    });

    it('passes explicit fee as string', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, fee: 100n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['fee']).toBe('100');
    });

    it('computes note_value = amount + fee', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, fee: 100n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['amount']).toBe('500');
        expect(ci['fee']).toBe('100');
        expect(ci['note_value']).toBe('600');
    });

    it('note_value equals amount when fee is 0n', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, fee: 0n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['note_value']).toBe(ci['amount']);
    });

    it('passes large fee correctly', async () => {
        const bigFee = 1_000_000_000_000_000n;
        await generateUnshieldProof({ ...BASE_INPUTS, fee: bigFee });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['fee']).toBe(bigFee.toString());
        expect(ci['note_value']).toBe((BASE_INPUTS.amount + bigFee).toString());
    });

    // ── change note signals ────────────────────────────────────────────────────

    it('passes change_value as "0" by default', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_value']).toBe('0');
    });

    it('passes change_commitment as "0" for total unshield', async () => {
        await generateUnshieldProof(BASE_INPUTS);
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_commitment']).toBe('0');
    });

    it('includes note_value = amount + fee + changeValue', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, fee: 10n, changeValue: 50n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['note_value']).toBe((500n + 10n + 50n).toString());
    });

    it('passes explicit changeValue as change_value string', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, changeValue: 200n, changeBlinding: 99n, changeOwnerPubkey: 11n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_value']).toBe('200');
    });

    it('passes explicit changeBlinding as change_blinding string', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, changeValue: 1n, changeBlinding: 77n, changeOwnerPubkey: 5n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_blinding']).toBe('77');
    });

    it('passes explicit changeOwnerPubkey as change_owner_pubkey string', async () => {
        await generateUnshieldProof({ ...BASE_INPUTS, changeValue: 1n, changeBlinding: 1n, changeOwnerPubkey: 42n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_owner_pubkey']).toBe('42');
    });

    it('derives changeOwnerPubkey from spendingKey when not provided', async () => {
        // Mock: mulPointEscalar(Base8, sk) => [sk * 2n, 0n]
        // spendingKey = 7n → changeOwnerPubkey = 14n
        await generateUnshieldProof({ ...BASE_INPUTS, changeValue: 1n, changeBlinding: 1n });
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_owner_pubkey']).toBe((BASE_INPUTS.spendingKey * 2n).toString());
    });

    it('uses randomBytes for changeBlinding when changeValue > 0 and no blinding given', async () => {
        // randomBytes mock returns 0xab * 32 bytes
        const { randomBytes } = await import('@noble/ciphers/utils.js');
        await generateUnshieldProof({ ...BASE_INPUTS, changeValue: 1n, changeOwnerPubkey: 5n });
        expect(randomBytes).toHaveBeenCalledWith(32);
    });

    it('uses zero changeBlinding when changeValue is 0 and no blinding given', async () => {
        await generateUnshieldProof(BASE_INPUTS); // changeValue defaults to 0n
        const [, circuitInputs] = call0();
        const ci = circuitInputs as Record<string, unknown>;
        expect(ci['change_blinding']).toBe('0');
    });

    it('exposes non-zero changeCommitment on result for partial unshield', async () => {
        const result = await generateUnshieldProof({
            ...BASE_INPUTS,
            changeValue: 100n,
            changeBlinding: 1n,
            changeOwnerPubkey: 2n,
        });
        expect(result.changeValue).toBe(100n);
        expect(result.changeCommitment).not.toBe(0n);
    });

    it('exposes zero changeCommitment on result for total unshield', async () => {
        const result = await generateUnshieldProof(BASE_INPUTS);
        expect(result.changeCommitment).toBe(0n);
    });
});

