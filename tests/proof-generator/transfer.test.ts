import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactProvider, ProofResult } from '../../src/proof-generator/transfer';

// ─── Mock @orbinum/proof-generator ────────────────────────────────────────────

vi.mock('@orbinum/proof-generator', () => ({
    CircuitType: { Unshield: 'unshield', Transfer: 'transfer' },
    generateProof: vi.fn(),
    WebArtifactProvider: vi.fn().mockImplementation(function (this: object) { return this; }),
}));

import { generateTransferProof, WebArtifactProvider } from '../../src/proof-generator/transfer';
import { generateProof, CircuitType } from '@orbinum/proof-generator';

const mockProofResult: ProofResult = {
    proof: '0x' + 'cd'.repeat(64),
    publicSignals: ['1', '10', '20', '77', '88'],
    circuitType: CircuitType.Transfer,
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HEX_ROOT = '0x' + '01' + '00'.repeat(31);
const SIBLINGS = new Array(20).fill('0x' + '03' + '00'.repeat(31));

const SPENDING_KEY_0 = 9n;
const SPENDING_KEY_1 = 17n;

const INPUT_NOTE_0 = {
    nullifier: 10n,
    value: 150n,
    assetId: 0n,
    ownerPk: 1n,
    blinding: 5n,
    spendingKey: SPENDING_KEY_0,
    pathSiblings: SIBLINGS,
    leafIndex: 2,
};

const INPUT_NOTE_1 = {
    nullifier: 20n,
    value: 100n,
    assetId: 0n,
    ownerPk: 1n,
    blinding: 7n,
    spendingKey: SPENDING_KEY_1,
    pathSiblings: SIBLINGS,
    leafIndex: 5,
};

const OUTPUT_NOTE_0 = {
    commitment: 77n,
    value: 180n,
    assetId: 0n,
    ownerPk: 2n,
    blinding: 3n,
};

const OUTPUT_NOTE_1 = {
    commitment: 88n,
    value: 70n,
    assetId: 0n,
    ownerPk: 3n,
    blinding: 6n,
};

const BASE_PARAMS = {
    merkleRoot: HEX_ROOT,
    inputs: [INPUT_NOTE_0, INPUT_NOTE_1] as [typeof INPUT_NOTE_0, typeof INPUT_NOTE_1],
    outputs: [OUTPUT_NOTE_0, OUTPUT_NOTE_1] as [typeof OUTPUT_NOTE_0, typeof OUTPUT_NOTE_1],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ci(): Record<string, unknown> {
    return vi.mocked(generateProof).mock.calls[0]![1] as Record<string, unknown>;
}

function opts(): Record<string, unknown> {
    return vi.mocked(generateProof).mock.calls[0]![2] as Record<string, unknown>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateTransferProof', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(generateProof).mockResolvedValue(mockProofResult);
    });

    // ── Return value ────────────────────────────────────────────────────────────

    it('returns the ProofResult from generateProof', async () => {
        const result = await generateTransferProof(BASE_PARAMS);
        expect(result).toEqual(mockProofResult);
    });

    it('calls generateProof with CircuitType.Transfer', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(generateProof).toHaveBeenCalledWith(
            CircuitType.Transfer,
            expect.any(Object),
            expect.any(Object)
        );
    });

    // ── Public signals ──────────────────────────────────────────────────────────

    it('passes merkle_root as decimal LE bigint string', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['merkle_root']).toBe('1');
    });

    it('passes nullifiers as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['nullifiers']).toEqual(['10', '20']);
    });

    it('passes commitments (output) as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['commitments']).toEqual(['77', '88']);
    });

    // ── Input note private signals ──────────────────────────────────────────────

    it('passes input_values as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['input_values']).toEqual(['150', '100']);
    });

    it('passes input_asset_ids as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['input_asset_ids']).toEqual(['0', '0']);
    });

    it('passes input_blindings as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['input_blindings']).toEqual(['5', '7']);
    });

    it('passes spending_keys as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['spending_keys']).toEqual(['9', '17']);
    });

    // ── Merkle path signals ─────────────────────────────────────────────────────

    it('passes input_path_elements as 2×20 array', async () => {
        await generateTransferProof(BASE_PARAMS);
        const elements = ci()['input_path_elements'] as string[][];
        expect(elements).toHaveLength(2);
        expect(elements[0]).toHaveLength(20);
        expect(elements[1]).toHaveLength(20);
    });

    it('passes input_path_indices with correct bits for leafIndex 2 (binary 010)', async () => {
        await generateTransferProof(BASE_PARAMS);
        const indices = ci()['input_path_indices'] as string[][];
        expect(indices[0]![0]).toBe('0');
        expect(indices[0]![1]).toBe('1');
        expect(indices[0]![2]).toBe('0');
    });

    it('passes input_path_indices with correct bits for leafIndex 5 (binary 101)', async () => {
        await generateTransferProof(BASE_PARAMS);
        const indices = ci()['input_path_indices'] as string[][];
        expect(indices[1]![0]).toBe('1');
        expect(indices[1]![1]).toBe('0');
        expect(indices[1]![2]).toBe('1');
    });

    // ── Output note signals ─────────────────────────────────────────────────────

    it('passes output_values as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['output_values']).toEqual(['180', '70']);
    });

    it('passes output_asset_ids as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['output_asset_ids']).toEqual(['0', '0']);
    });

    it('passes output_owner_pubkeys as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['output_owner_pubkeys']).toEqual(['2', '3']);
    });

    it('passes output_blindings as array of two strings', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['output_blindings']).toEqual(['3', '6']);
    });

    it('generates deterministic signatures (same inputs → same output)', async () => {
        await generateTransferProof(BASE_PARAMS);
        const firstSpendingKeys = ci()['spending_keys'];

        vi.clearAllMocks();
        vi.mocked(generateProof).mockResolvedValue(mockProofResult);

        await generateTransferProof(BASE_PARAMS);
        expect(ci()['spending_keys']).toEqual(firstSpendingKeys);
    });

    // ── Old signal names must NOT appear ────────────────────────────────────────

    it('does not use old signal names', async () => {
        await generateTransferProof(BASE_PARAMS);
        const inputs = ci();
        expect(inputs).not.toHaveProperty('in_nullifier');
        expect(inputs).not.toHaveProperty('in_value');
        expect(inputs).not.toHaveProperty('in_asset_id');
        expect(inputs).not.toHaveProperty('in_owner_pk');
        expect(inputs).not.toHaveProperty('in_blinding');
        expect(inputs).not.toHaveProperty('in_spending_key');
        expect(inputs).not.toHaveProperty('in_path_elements');
        expect(inputs).not.toHaveProperty('in_path_indices');
        expect(inputs).not.toHaveProperty('out_commitment');
        expect(inputs).not.toHaveProperty('out_value');
        expect(inputs).not.toHaveProperty('out_owner_pk');
        expect(inputs).not.toHaveProperty('out_blinding');
        // Ownership is proven via BabyPbk(spending_key) internally — no EdDSA signals
        expect(inputs).not.toHaveProperty('input_owner_Ax');
        expect(inputs).not.toHaveProperty('input_owner_Ay');
        expect(inputs).not.toHaveProperty('input_sig_R8x');
        expect(inputs).not.toHaveProperty('input_sig_R8y');
        expect(inputs).not.toHaveProperty('input_sig_S');
    });

    // ── Provider & options ──────────────────────────────────────────────────────

    it('uses WebArtifactProvider by default', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(WebArtifactProvider).toHaveBeenCalledTimes(1);
    });

    it('forwards a custom provider if supplied', async () => {
        const customProvider = {} as ArtifactProvider;
        await generateTransferProof(BASE_PARAMS, { provider: customProvider });
        expect(opts()['provider']).toBe(customProvider);
        expect(WebArtifactProvider).not.toHaveBeenCalled();
    });

    it('does not include verbose key when not specified', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(opts()).not.toHaveProperty('verbose');
    });

    it('forwards verbose when specified', async () => {
        await generateTransferProof(BASE_PARAMS, { verbose: false });
        expect(opts()['verbose']).toBe(false);
    });

    // ── fee signal ──────────────────────────────────────────────────────────────

    it('passes fee as "0" by default', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['fee']).toBe('0');
    });

    it('passes explicit fee as string', async () => {
        await generateTransferProof({ ...BASE_PARAMS, fee: 500n });
        expect(ci()['fee']).toBe('500');
    });

    it('enforces conservation: input_sum == output_sum + fee', async () => {
        // input_sum = 150 + 100 = 250, output_sum = 180 + 70 = 250 → fee 0n valid
        await generateTransferProof(BASE_PARAMS);
        const inputs = ci();
        const i = (inputs['input_values'] as string[]).reduce((a, v) => a + BigInt(v), 0n);
        const o = (inputs['output_values'] as string[]).reduce((a, v) => a + BigInt(v), 0n);
        const fee = BigInt(inputs['fee'] as string);
        expect(i).toBe(o + fee);
    });

    it('passes large fee as a bigint string', async () => {
        const bigFee = 1_000_000_000_000_000n;
        await generateTransferProof({ ...BASE_PARAMS, fee: bigFee });
        expect(ci()['fee']).toBe(bigFee.toString());
    });

    // ── asset_id signal ─────────────────────────────────────────────────────────

    it('passes asset_id derived from input notes', async () => {
        await generateTransferProof(BASE_PARAMS);
        expect(ci()['asset_id']).toBe('0');
    });

    it('passes asset_id=1 when input notes use assetId 1', async () => {
        const params = {
            ...BASE_PARAMS,
            inputs: [
                { ...INPUT_NOTE_0, assetId: 1n },
                { ...INPUT_NOTE_1, assetId: 1n },
            ] as [typeof INPUT_NOTE_0, typeof INPUT_NOTE_1],
        };
        await generateTransferProof(params);
        expect(ci()['asset_id']).toBe('1');
    });
});
