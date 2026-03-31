import { describe, it, expect } from 'vitest';
import { decodePrecompileCalldata } from '../../src/precompiles/decode';
import { ShieldedPoolPrecompile } from '../../src/precompiles/ShieldedPoolPrecompile';
import { AccountMappingPrecompile } from '../../src/precompiles/AccountMappingPrecompile';
import { PRECOMPILE_ADDR } from '../../src/precompiles/addresses';
import type { EvmClient } from '../../src/evm/EvmClient';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SP_ADDR = PRECOMPILE_ADDR.SHIELDED_POOL;
const AM_ADDR = PRECOMPILE_ADDR.ACCOUNT_MAPPING;

const COMMITMENT = '0x' + 'aa'.repeat(32);
const NULLIFIER = '0x' + 'bb'.repeat(32);
const ROOT = '0x' + 'cc'.repeat(32);
const PROOF = new Uint8Array([0x01, 0x02, 0x03]);
const RECIPIENT = '0x' + 'dd'.repeat(32);

function mockEvm(): EvmClient {
    return { call: async () => '0x', estimateGas: async () => 0n } as unknown as EvmClient;
}

// ─── Null / edge cases ────────────────────────────────────────────────────────

describe('decodePrecompileCalldata — null cases', () => {
    it('returns null for an unknown address', () => {
        expect(decodePrecompileCalldata('0xdeadbeef', '0x12345678')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(decodePrecompileCalldata(SP_ADDR, '')).toBeNull();
    });

    it('returns null for input shorter than 10 chars', () => {
        expect(decodePrecompileCalldata(SP_ADDR, '0x1234')).toBeNull();
    });

    it('returns null when selector is not registered', () => {
        expect(decodePrecompileCalldata(SP_ADDR, '0x' + 'ff'.repeat(4) + '00'.repeat(32))).toBeNull();
    });

    it('is case-insensitive on address', () => {
        const calldata = new ShieldedPoolPrecompile(mockEvm()).buildShieldCalldata({
            assetId: 0,
            amount: 1n,
            commitment: COMMITMENT,
        });
        const upper = SP_ADDR.toUpperCase();
        const result = decodePrecompileCalldata(upper, calldata);
        expect(result).not.toBeNull();
        expect(result?.fnSig).toMatch(/^shield\(/);
    });
});

// ─── shield(uint32,uint256,bytes32,bytes) — round-trip ────────────────────────

describe('decodePrecompileCalldata — shield', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildShieldCalldata({ assetId: 0, amount: 1_000n, commitment: COMMITMENT });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe('shield(uint32,uint256,bytes32,bytes)');
    });

    it('round-trips assetId', () => {
        const calldata = sp.buildShieldCalldata({ assetId: 7, amount: 1n, commitment: COMMITMENT });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['assetId']).toBe(7n);
    });

    it('round-trips amount', () => {
        const amount = 1_000_000_000_000_000_000n; // 1 ORB in planck
        const calldata = sp.buildShieldCalldata({ assetId: 0, amount, commitment: COMMITMENT });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['amount']).toBe(amount);
    });

    it('round-trips commitment as 0x-prefixed hex', () => {
        const calldata = sp.buildShieldCalldata({ assetId: 0, amount: 1n, commitment: COMMITMENT });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(typeof result?.args['commitment']).toBe('string');
        expect((result?.args['commitment'] as string).toLowerCase()).toBe(COMMITMENT.toLowerCase());
    });
});

// ─── unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32) — round-trip ──────

describe('decodePrecompileCalldata — unshield', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    const params = {
        proof: PROOF,
        merkleRoot: ROOT,
        nullifier: NULLIFIER,
        assetId: 1,
        amount: 500_000n,
        recipientAddress: RECIPIENT,
    };

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe('unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32)');
    });

    it('round-trips root', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['root'] as string).toLowerCase()).toBe(ROOT.toLowerCase());
    });

    it('round-trips nullifier', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['nullifier'] as string).toLowerCase()).toBe(NULLIFIER.toLowerCase());
    });

    it('round-trips assetId', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['assetId']).toBe(1n);
    });

    it('round-trips amount', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['amount']).toBe(500_000n);
    });

    it('round-trips recipient', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['recipient'] as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
    });
});

// ─── privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[]) — round-trip ──

describe('decodePrecompileCalldata — privateTransfer', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            inputs: [{ nullifier: NULLIFIER, commitment: COMMITMENT }],
            outputs: [{ commitment: COMMITMENT }],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe('privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[])');
    });

    it('round-trips root', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            inputs: [{ nullifier: NULLIFIER, commitment: COMMITMENT }],
            outputs: [{ commitment: COMMITMENT }],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['root'] as string).toLowerCase()).toBe(ROOT.toLowerCase());
    });

    it('counts nullifiers correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            inputs: [
                { nullifier: NULLIFIER, commitment: COMMITMENT },
                { nullifier: NULLIFIER, commitment: COMMITMENT },
            ],
            outputs: [{ commitment: COMMITMENT }],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['nullifiers']).toBe(2);
    });

    it('counts commitments correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            inputs: [{ nullifier: NULLIFIER, commitment: COMMITMENT }],
            outputs: [
                { commitment: COMMITMENT },
                { commitment: COMMITMENT },
            ],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['commitments']).toBe(2);
    });
});

// ─── registerAlias(string) — round-trip ──────────────────────────────────────

describe('decodePrecompileCalldata — registerAlias', () => {
    const am = new AccountMappingPrecompile(mockEvm());

    it('decodes fnSig correctly', () => {
        const calldata = am.buildRegisterAliasCalldata('alice');
        const result = decodePrecompileCalldata(AM_ADDR, calldata);
        expect(result?.fnSig).toBe('registerAlias(string)');
    });

    it('round-trips ASCII alias', () => {
        const calldata = am.buildRegisterAliasCalldata('alice');
        const result = decodePrecompileCalldata(AM_ADDR, calldata);
        expect(result?.args['alias']).toBe('alice');
    });

    it('round-trips alias with hyphens', () => {
        const calldata = am.buildRegisterAliasCalldata('my-cool-alias');
        const result = decodePrecompileCalldata(AM_ADDR, calldata);
        expect(result?.args['alias']).toBe('my-cool-alias');
    });

    it('returns empty string alias when data has only the selector (zero-length ABI body)', () => {
        // Input is exactly the 4-byte selector with no ABI body — all-zeros decode → length 0 → ""
        const calldata = '0x2f8839c3'; // REGISTER_ALIAS selector, no args
        const result = decodePrecompileCalldata(AM_ADDR, calldata);
        expect(result).not.toBeNull();
        expect(result?.fnSig).toBe('registerAlias(string)');
        // decodeString with empty data returns '' without throwing
        expect(result?.args['alias']).toBe('');
    });
});
