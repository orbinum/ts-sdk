/**
 * Normalises an EVM address to lowercase with 0x prefix.
 */
export function normalizeEvmAddress(addr: string): string {
    const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
    return '0x' + hex.toLowerCase();
}

/**
 * Returns true if the string looks like an SS58 encoded address
 * (not a 0x-prefixed hex).
 */
export function isSs58(addr: string): boolean {
    return !addr.startsWith('0x') && addr.length >= 46 && addr.length <= 50;
}

/**
 * Returns true if the string looks like a 20-byte EVM address.
 */
export function isEvmAddress(addr: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Pads a 20-byte EVM address to a 32-byte account ID (H256)
 * by prepending 12 zero bytes (Ethereum-compatible mapping).
 */
export function evmAddressToAccountId(evmAddr: string): Uint8Array {
    const clean = evmAddr.startsWith('0x') ? evmAddr.slice(2) : evmAddr;
    if (clean.length !== 40) {
        throw new Error(`Expected 20-byte EVM address, got: ${evmAddr}`);
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 20; i++) {
        bytes[i + 12] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Derives the implicit Substrate AccountId32 for an EVM address using the
 * EeSuffixAddressMapping rule: AccountId32 = H160 ++ [0x00; 12].
 *
 * This is the same rule applied by pallet-account-mapping's fallback when
 * there is no explicit `map_account` entry. Returns 0x-prefixed 64-char hex.
 *
 * @param evmAddr  0x-prefixed 20-byte EVM address.
 */
export function evmToImplicitSubstrate(evmAddr: string): string {
    const clean = evmAddr.startsWith('0x') ? evmAddr.slice(2) : evmAddr;
    if (clean.length !== 40) {
        throw new Error(`Expected 20-byte EVM address, got: ${evmAddr}`);
    }
    return '0x' + clean.toLowerCase() + '0'.repeat(24);
}

/**
 * Returns true if the given AccountId32 hex was derived from an EVM address
 * via the EeSuffixAddressMapping (last 12 bytes are zero).
 *
 * @param accountHex  0x-prefixed 64-char AccountId32 hex.
 */
export function isImplicitEvmAccount(accountHex: string): boolean {
    const clean = accountHex.startsWith('0x') ? accountHex.slice(2) : accountHex;
    if (clean.length !== 64) return false;
    return clean.slice(40).toLowerCase() === '0'.repeat(24);
}

/**
 * Extracts the EVM address (H160) from an implicit Substrate AccountId32
 * created by EeSuffixAddressMapping.  Throws if the account is not EVM-derived.
 *
 * @param accountHex  0x-prefixed 64-char AccountId32 hex.
 */
export function implicitSubstrateToEvm(accountHex: string): string {
    if (!isImplicitEvmAccount(accountHex)) {
        throw new Error(`AccountId32 is not an implicit EVM-derived account: ${accountHex}`);
    }
    const clean = accountHex.startsWith('0x') ? accountHex.slice(2) : accountHex;
    return '0x' + clean.slice(0, 40).toLowerCase();
}

// ─── SS58 / AccountId utilities (require @polkadot/util-crypto) ──────────────

import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

const ACCOUNT_ID_BYTES = 32;
const EVM_BYTES = 20;

/**
 * Returns true if `addr` is a valid SS58 substrate address (not EVM).
 */
export function isSubstrateAddress(addr: string): boolean {
    if (!addr || typeof addr !== 'string' || isEvmAddress(addr)) return false;
    if (addr.length < 40 || addr.length > 60) return false;
    try {
        const bytes = decodeAddress(addr);
        return bytes.length === ACCOUNT_ID_BYTES;
    } catch {
        return false;
    }
}

/**
 * Returns true if `addr` is a Substrate SS58 address derived from an EVM H160
 * via the EeSuffixAddressMapping rule (last 12 bytes of AccountId are zero).
 */
export function isUnifiedAddress(addr: string): boolean {
    if (!addr || isEvmAddress(addr)) return false;
    try {
        const bytes = decodeAddress(addr);
        if (bytes.length !== ACCOUNT_ID_BYTES) return false;
        return bytes.slice(EVM_BYTES, ACCOUNT_ID_BYTES).every((b) => b === 0x00);
    } catch {
        return false;
    }
}

/**
 * Converts a unified (EVM-derived) Substrate SS58 address to its EVM H160.
 * Returns null for native Substrate accounts or invalid input.
 */
export function substrateToEvm(addr: string): string | null {
    if (!addr) return null;
    if (isEvmAddress(addr)) return normalizeEvmAddress(addr);
    try {
        const bytes = decodeAddress(addr);
        if (bytes.length !== ACCOUNT_ID_BYTES) return null;
        const isUnified = bytes.slice(EVM_BYTES, ACCOUNT_ID_BYTES).every((b) => b === 0x00);
        if (!isUnified) return null;
        return (
            '0x' +
            Array.from(bytes.slice(0, EVM_BYTES))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
        );
    } catch {
        return null;
    }
}

/**
 * Converts an EVM H160 address to its Substrate SS58 equivalent
 * using the EeSuffixAddressMapping rule: AccountId32 = H160 ++ [0x00; 12].
 * Returns null on invalid input.
 */
export function evmToSubstrate(addr: string): string | null {
    const normalized = normalizeEvmAddress(addr);
    if (!normalized) return null;
    const hex = normalized.slice(2);
    if (hex.length !== 40) return null;
    const mapped = new Uint8Array(ACCOUNT_ID_BYTES);
    for (let i = 0; i < EVM_BYTES; i++) {
        mapped[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    // last 12 bytes remain 0x00 (default)
    try {
        return encodeAddress(mapped);
    } catch {
        return null;
    }
}

/**
 * Converts a 32-byte AccountId hex (0x-prefixed or bare) to its SS58 string.
 * Returns null on invalid input.
 */
export function accountIdHexToSs58(hex: string): string | null {
    if (!hex) return null;
    try {
        const h = hex.startsWith('0x') ? hex.slice(2) : hex;
        if (h.length !== 64) return null;
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
        }
        return encodeAddress(bytes);
    } catch {
        return null;
    }
}

/**
 * Converts a Substrate SS58 address to its AccountId32 as a 0x-prefixed 64-char hex.
 * Returns null on invalid input.
 */
export function substrateSs58ToAccountIdHex(addr: string): string | null {
    if (!addr) return null;
    try {
        const bytes = decodeAddress(addr);
        if (bytes.length !== ACCOUNT_ID_BYTES) return null;
        return (
            '0x' +
            Array.from(bytes)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
        );
    } catch {
        return null;
    }
}

/**
 * Universal converter: given any raw address string (SS58, 0x-prefixed 64-char
 * AccountId hex, or EVM H160), returns the AccountId32 hex (0x-prefixed).
 * Returns null on unrecognised input.
 */
export function addressToAccountIdHex(addr: string): string | null {
    if (!addr) return null;
    // EVM H160 → mapped AccountId32
    if (isEvmAddress(addr)) {
        const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
        const mapped = new Uint8Array(ACCOUNT_ID_BYTES);
        for (let i = 0; i < EVM_BYTES; i++) {
            mapped[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return (
            '0x' +
            Array.from(mapped)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
        );
    }
    // 0x-prefixed 64-char hex → return as-is (normalised)
    if (/^0x[0-9a-fA-F]{64}$/.test(addr)) {
        return addr.toLowerCase();
    }
    // SS58 → AccountId hex
    return substrateSs58ToAccountIdHex(addr);
}
