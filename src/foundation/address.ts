/**
 * Address forms, and the conversions between them.
 *
 * Orbinum accounts appear in three shapes — a 20-byte EVM address, a 32-byte
 * AccountId32, and its SS58 rendering — and a wallet meets all three: the user
 * pastes one, the chain reports another, the circuit takes a third.
 *
 * ONE mapping is structural and the one the runtime applies:
 *
 *   AccountId32 = H160 ++ [0x00; 12]      (EeSuffixAddressMapping)
 *
 * Suffix, not prefix. Ethereum's own convention pads the other way, and a
 * function that follows it produces a well-formed account that this chain has
 * never heard of — see `evmAddressToAccountId`.
 *
 * Every decode returns null rather than throwing: an address arrives from a
 * paste, a QR or an RPC, so a malformed one is ordinary input and the caller
 * decides what to say about it.
 */
import { bytesToBigintLE } from './encoding/bytes';
import { isHexOfLength, fromHex } from './encoding/hex';
import { BN254_R } from './crypto/constants';

/**
 * Normalises an EVM address to lowercase with 0x prefix.
 */
export function normalizeEvmAddress(addr: string): string {
    const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
    return '0x' + hex.toLowerCase();
}

/**
 * Normalises an EVM address, or null when it is not one.
 *
 * The checking form of `normalizeEvmAddress`, which reformats whatever it is
 * given — `'hello'` comes back as `'0xhello'`. That is fine when the caller
 * already knows the input is an address and wrong everywhere else, which is why
 * a host validating user input ends up writing this wrapper. It belongs here.
 *
 * Null rather than a throw: a bad address in a form field is an ordinary state
 * a UI renders, not an exception.
 */
export function parseEvmAddress(addr: string): string | null {
    if (!addr) return null;
    const withPrefix = addr.startsWith('0x') ? addr : `0x${addr}`;
    return isEvmAddress(withPrefix) ? withPrefix.toLowerCase() : null;
}

/**
 * Returns true if the string looks like a 20-byte EVM address.
 */
export function isEvmAddress(addr: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Pads a 20-byte EVM address to 32 bytes by PREPENDING 12 zero bytes.
 *
 * The Ethereum convention, NOT Orbinum's. This chain maps an H160 to an account
 * by appending — `evmToImplicitSubstrate` is the one that matches the runtime,
 * and the two produce different accounts for the same address.
 *
 * Kept for callers that need the Ethereum-shaped padding (an H256 topic, an ABI
 * word). Anything that has to name an Orbinum account wants the other one.
 */
export function evmAddressToAccountId(evmAddr: string): Uint8Array {
    const clean = cleanEvmAddress(evmAddr);
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
 * This is the only mapping the runtime applies — it is structural, not a
 * lookup, so every EVM address has exactly one Substrate account. Returns
 * 0x-prefixed 64-char hex.
 *
 * @param evmAddr  0x-prefixed 20-byte EVM address.
 */
export function evmToImplicitSubstrate(evmAddr: string): string {
    const clean = cleanEvmAddress(evmAddr);
    return '0x' + clean.toLowerCase() + '0'.repeat(24);
}

/**
 * Converts an EVM H160 address to the 32-byte AccountId32 hex the runtime
 * derives from it (EeSuffixAddressMapping: H160 ++ [0x00; 12]).
 * Returns null for invalid or non-EVM input.
 *
 * @param address  0x-prefixed EVM H160 address (or bare 40-char hex).
 */
export function evmToMappedAccountHex(address: string): string | null {
    if (!isEvmAddress(address)) return null;
    return evmToImplicitSubstrate(address);
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
const EVM_HEX_RE = /^[0-9a-fA-F]{40}$/;

function cleanEvmAddress(addr: string): string {
    const clean = addr.startsWith('0x') ? addr.slice(2) : addr;
    if (!EVM_HEX_RE.test(clean)) {
        throw new Error(`Expected 20-byte EVM address, got: ${addr}`);
    }
    return clean;
}

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
    const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
    if (!EVM_HEX_RE.test(hex)) return null;
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
        const hex = cleanEvmAddress(addr);
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

/**
 * Any address — SS58, EVM H160, or 0x-prefixed AccountId32 hex — as the BN254
 * scalar the circuits take for their `recipient` public signal.
 *
 * The mapping is circuit-defined, not a convention this library chose: EVM
 * addresses become `H160 ++ [0x00; 12]`, the 32 bytes are read little-endian,
 * and the value is reduced mod BN254_R. Getting any of those three wrong makes
 * the proof verify against a DIFFERENT recipient — the funds go to whoever that
 * scalar happens to name.
 */
export function addressToFieldElement(address: string): bigint {
    const accountIdHex = addressToAccountIdHex(address);
    if (!accountIdHex) throw new Error(`Cannot resolve address to AccountId32: ${address}`);
    // Shape-checked before the decode, even though every branch of
    // `addressToAccountIdHex` already produces or validates 32-byte hex today.
    // The decode below is `parseInt`, which yields NaN for non-hex and stores
    // it as byte 0 — so a future branch that forgot to validate would not fail
    // here, it would silently name a DIFFERENT recipient, which is the exact
    // failure this function's contract calls out.
    if (!isHexOfLength(accountIdHex, 32)) {
        throw new Error(`AccountId32 must be 32 bytes of hex: ${accountIdHex}`);
    }
    const bytes = fromHex(accountIdHex);
    return bytesToBigintLE(bytes) % BN254_R;
}
