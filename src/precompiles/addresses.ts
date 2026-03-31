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
    ACCOUNT_MAPPING: '0x0000000000000000000000000000000000000800',
    SHIELDED_POOL: '0x0000000000000000000000000000000000000801',
} as const;

// ─── AccountMappingPrecompile selectors (0x0800) ──────────────────────────────
// Sources: frame/evm/precompile/account-mapping/src/lib.rs

/** Function selectors for `AccountMappingPrecompile`. */
export const AM_SEL = {
    // ── Read-only ─────────────────────────────────────────────────────────────
    // resolveAlias(string)                            → 0xd03149ab
    RESOLVE_ALIAS: new Uint8Array([0xd0, 0x31, 0x49, 0xab]),
    // getAliasOf(address)                             → 0x7a0ed62c
    GET_ALIAS_OF: new Uint8Array([0x7a, 0x0e, 0xd6, 0x2c]),
    // hasPrivateLink(string,bytes32)                  → 0x47e05c6c
    HAS_PRIVATE_LINK: new Uint8Array([0x47, 0xe0, 0x5c, 0x6c]),
    // ── No-argument writes ────────────────────────────────────────────────────
    // mapAccount()                                    → 0xdca49d0e
    MAP_ACCOUNT: new Uint8Array([0xdc, 0xa4, 0x9d, 0x0e]),
    // unmapAccount()                                  → 0x08f57367
    UNMAP_ACCOUNT: new Uint8Array([0x08, 0xf5, 0x73, 0x67]),
    // releaseAlias()                                  → 0x7fac359e
    RELEASE_ALIAS: new Uint8Array([0x7f, 0xac, 0x35, 0x9e]),
    // cancelSale()                                    → 0x4d023ab9
    CANCEL_SALE: new Uint8Array([0x4d, 0x02, 0x3a, 0xb9]),
    // ── Writes with arguments ─────────────────────────────────────────────────
    // registerAlias(string)                           → 0x2f8839c3
    REGISTER_ALIAS: new Uint8Array([0x2f, 0x88, 0x39, 0xc3]),
    // transferAlias(address)                          → 0x5ac998e7
    TRANSFER_ALIAS: new Uint8Array([0x5a, 0xc9, 0x98, 0xe7]),
    // buyAlias(string)                                → 0x1625df3a
    BUY_ALIAS: new Uint8Array([0x16, 0x25, 0xdf, 0x3a]),
    // putAliasOnSale(uint256,address[])               → 0x32091192
    PUT_ALIAS_ON_SALE: new Uint8Array([0x32, 0x09, 0x11, 0x92]),
    // removeChainLink(uint32)                         → 0x6f579c0c
    REMOVE_CHAIN_LINK: new Uint8Array([0x6f, 0x57, 0x9c, 0x0c]),
    // addChainLink(uint32,bytes,bytes)                → 0x5f3e837c
    ADD_CHAIN_LINK: new Uint8Array([0x5f, 0x3e, 0x83, 0x7c]),
    // registerPrivateLink(uint32,bytes32)             → 0xc04e98f4
    REGISTER_PRIVATE_LINK: new Uint8Array([0xc0, 0x4e, 0x98, 0xf4]),
    // removePrivateLink(bytes32)                      → 0xdfd8b57e
    REMOVE_PRIVATE_LINK: new Uint8Array([0xdf, 0xd8, 0xb5, 0x7e]),
    // revealPrivateLink(bytes32,bytes,bytes32,bytes)  → 0x4df1f33d
    REVEAL_PRIVATE_LINK: new Uint8Array([0x4d, 0xf1, 0xf3, 0x3d]),
    // setAccountMetadata(bytes,bytes,bytes)           → 0x776cf9ff
    SET_ACCOUNT_METADATA: new Uint8Array([0x77, 0x6c, 0xf9, 0xff]),
} as const;

// ─── ShieldedPoolPrecompile selectors (0x0801) ────────────────────────────────
// Source: frame/evm/precompile/shielded-pool/src/lib.rs

/** Function selectors for `ShieldedPoolPrecompile`. */
export const SP_SEL = {
    // shield(uint32,uint256,bytes32,bytes)                                  → 0x781442b9
    SHIELD: new Uint8Array([0x78, 0x14, 0x42, 0xb9]),
    // privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[])            → 0xdcd5b898
    PRIVATE_TRANSFER: new Uint8Array([0xdc, 0xd5, 0xb8, 0x98]),
    // unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32)                → 0xdcf1bff2
    UNSHIELD: new Uint8Array([0xdc, 0xf1, 0xbf, 0xf2]),
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
    '0x0000000000000000000000000000000000000800': {
        name: 'AccountMapping',
        functions: {
            d03149ab: 'resolveAlias(string)',
            '7a0ed62c': 'getAliasOf(address)',
            '47e05c6c': 'hasPrivateLink(string,bytes32)',
            dca49d0e: 'mapAccount()',
            '08f57367': 'unmapAccount()',
            '7fac359e': 'releaseAlias()',
            '4d023ab9': 'cancelSale()',
            '2f8839c3': 'registerAlias(string)',
            '5ac998e7': 'transferAlias(address)',
            '1625df3a': 'buyAlias(string)',
            '32091192': 'putAliasOnSale(uint256,address[])',
            '6f579c0c': 'removeChainLink(uint32)',
            '5f3e837c': 'addChainLink(uint32,bytes,bytes)',
            c04e98f4: 'registerPrivateLink(uint32,bytes32)',
            dfd8b57e: 'removePrivateLink(bytes32)',
            '4df1f33d': 'revealPrivateLink(bytes32,bytes,bytes32,bytes)',
            '776cf9ff': 'setAccountMetadata(bytes,bytes,bytes)',
        },
    },
    '0x0000000000000000000000000000000000000801': {
        name: 'ShieldedPool',
        functions: {
            '781442b9': 'shield(uint32,uint256,bytes32,bytes)',
            dcd5b898: 'privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[])',
            dcf1bff2: 'unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32)',
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
