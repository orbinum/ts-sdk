/**
 * Contract addresses and function selectors for all Orbinum EVM precompiles.
 *
 * Selectors are verified against the Rust source in frame/evm/precompile and
 * computed as `bytes4(keccak256("<functionName>(<argTypes>)"))`.
 */

import type { KnownPrecompileInfo } from './types';

// ─── Contract Addresses ───────────────────────────────────────────────────────

/** All precompile contract addresses. */
export const PRECOMPILE_ADDR = {
    // ── Ethereum standard (EIP) ─────────────────────────────────────────────
    EC_RECOVER: '0x0000000000000000000000000000000000000001',
    SHA256: '0x0000000000000000000000000000000000000002',
    RIPEMD160: '0x0000000000000000000000000000000000000003',
    IDENTITY: '0x0000000000000000000000000000000000000004',
    MODEXP: '0x0000000000000000000000000000000000000005',
    // ── Frontier / non-standard ─────────────────────────────────────────────
    SHA3_FIPS256: '0x0000000000000000000000000000000000000400',
    EC_RECOVER_PUBKEY: '0x0000000000000000000000000000000000000401',
    CURVE25519_ADD: '0x0000000000000000000000000000000000000402',
    CURVE25519_SCALAR_MUL: '0x0000000000000000000000000000000000000403',
    // ── Orbinum custom ───────────────────────────────────────────────────────
    SHIELDED_POOL: '0x0000000000000000000000000000000000000801',
} as const;

// ─── ShieldedPoolPrecompile selectors (0x0801) ────────────────────────────────
// Source: frame/evm/precompile/shielded-pool/src/lib.rs

/** Function selectors for `ShieldedPoolPrecompile`. */
export const SP_SEL = {
    // shield(uint32,bytes32,bytes)                                               → 0x9feb22ea  (payable, amount = msg.value)
    SHIELD: new Uint8Array([0x9f, 0xeb, 0x22, 0xea]),
    // privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256,uint32)  → 0x66ed2cd4
    PRIVATE_TRANSFER: new Uint8Array([0x66, 0xed, 0x2c, 0xd4]),
    // unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32,bytes,uint32)  → 0x4e505348
    UNSHIELD: new Uint8Array([0x4e, 0x50, 0x53, 0x48]),
    // claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes,uint32)         → 0x88d9deba
    CLAIM_SHIELDED_FEES: new Uint8Array([0x88, 0xd9, 0xde, 0xba]),
} as const;

// ─── Known Precompiles registry ───────────────────────────────────────────────

/**
 * Registry of all known Orbinum EVM precompiles, keyed by lowercase address.
 * Covers Ethereum standard (EIP), Frontier non-standard, and Orbinum custom precompiles.
 */
export const KNOWN_PRECOMPILES: Record<string, KnownPrecompileInfo> = {
    // ── Ethereum standard (EIP) ─────────────────────────────────────────────
    '0x0000000000000000000000000000000000000001': {
        name: 'ECRecover',
        functions: { '00000000': 'ecrecover(bytes32,uint8,bytes32,bytes32)' },
    },
    '0x0000000000000000000000000000000000000002': { name: 'SHA256', functions: {} },
    '0x0000000000000000000000000000000000000003': { name: 'RIPEMD160', functions: {} },
    '0x0000000000000000000000000000000000000004': { name: 'Identity', functions: {} },
    '0x0000000000000000000000000000000000000005': { name: 'ModExp', functions: {} },
    // ── Frontier / non-standard ─────────────────────────────────────────────
    '0x0000000000000000000000000000000000000400': { name: 'SHA3FIPS256', functions: {} },
    '0x0000000000000000000000000000000000000401': { name: 'ECRecoverPublicKey', functions: {} },
    '0x0000000000000000000000000000000000000402': { name: 'Curve25519Add', functions: {} },
    '0x0000000000000000000000000000000000000403': { name: 'Curve25519ScalarMul', functions: {} },
    // ── Orbinum custom ───────────────────────────────────────────────────────
    '0x0000000000000000000000000000000000000801': {
        name: 'ShieldedPool',
        functions: {
            '9feb22ea': 'shield(uint32,bytes32,bytes)',
            '66ed2cd4':
                'privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256,uint32)',
            '4e505348':
                'unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32,bytes,uint32)',
            '88d9deba': 'claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes,uint32)',
        },
    },
};

/**
 * Returns the human-readable name for a known precompile address,
 * or null if the address is not a known precompile.
 */
export function getPrecompileLabel(address: string | null | undefined): string | null {
    if (!address) return null;
    return KNOWN_PRECOMPILES[address.toLowerCase()]?.name ?? null;
}
