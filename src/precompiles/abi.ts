import { fromHex, toHex } from '../utils/hex';
import { bigintTo32Be } from '../utils/bytes';
import { concat, encodeDynamicParam, encodeStaticParam, STATIC_TYPES } from './helpers';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated-union of every ABI type used by Orbinum precompiles.
 *
 * Static types occupy exactly one 32-byte head slot.
 * Dynamic types place an offset in the head and their content in the tail.
 */
export type AbiParam =
    | { type: 'uint'; value: bigint } // uint32 / uint256 — right-aligned
    | { type: 'bytes32'; value: Uint8Array } // exactly 32 bytes — left-aligned
    | { type: 'address'; value: string } // 0x-prefixed 20-byte hex — right-aligned
    | { type: 'bool'; value: boolean } // right-aligned uint8
    | { type: 'bytes'; value: Uint8Array } // dynamic
    | { type: 'string'; value: string } // dynamic (UTF-8)
    | { type: 'bytes32[]'; value: Uint8Array[] } // dynamic array of static elements
    | { type: 'address[]'; value: string[] } // dynamic array of addresses
    | { type: 'bytes[]'; value: Uint8Array[] }; // dynamic array of dynamic elements

// ─── Main encoder ─────────────────────────────────────────────────────────────

/**
 * ABI-encodes a function call (selector + parameters).
 *
 * Implements the standard Ethereum ABI encoding (static head + dynamic tail).
 *
 * @param selector  4-byte function selector (NOT keccak — use the hardcoded constants).
 * @param params    ABI parameters in declaration order.
 */
export function encode(selector: Uint8Array, ...params: AbiParam[]): Uint8Array {
    const n = params.length;
    const headSize = n * 32;
    const heads: Uint8Array[] = [];
    const tails: Uint8Array[] = [];
    let tailOffset = headSize;

    for (const param of params) {
        if (STATIC_TYPES.has(param.type)) {
            heads.push(encodeStaticParam(param));
        } else {
            heads.push(bigintTo32Be(BigInt(tailOffset)));
            const tail = encodeDynamicParam(param);
            tails.push(tail);
            tailOffset += tail.length;
        }
    }

    return concat([selector, ...heads, ...tails]);
}

/** Returns the 0x-prefixed hex of an encoded call. */
export function encodeHex(selector: Uint8Array, ...params: AbiParam[]): string {
    return toHex(encode(selector, ...params));
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

/** Reads a big-endian uint256 from 32 bytes at `offset`. */
export function decodeUint(data: Uint8Array, offset = 0): bigint {
    let result = 0n;
    for (let i = 0; i < 32; i++) {
        result = (result << 8n) | BigInt(data[offset + i] ?? 0);
    }
    return result;
}

/**
 * Reads a right-aligned 20-byte address from a 32-byte ABI slot.
 * Returns a 0x-prefixed lowercase hex string.
 */
export function decodeAddress(data: Uint8Array, offset = 0): string {
    return '0x' + toHex(data.slice(offset + 12, offset + 32)).slice(2);
}

/** Reads a bool from the last byte of a 32-byte ABI slot. */
export function decodeBool(data: Uint8Array, offset = 0): boolean {
    return data[offset + 31] !== 0;
}

/**
 * Reads a dynamic `bytes` value.
 *
 * `data` is the full return payload from `eth_call` (not including the selector).
 * `offset` is the byte position of the head slot containing the data offset.
 */
export function decodeBytes(data: Uint8Array, slotOffset = 0): Uint8Array {
    const dataOffset = Number(decodeUint(data, slotOffset));
    const length = Number(decodeUint(data, dataOffset));
    return data.slice(dataOffset + 32, dataOffset + 32 + length);
}

/** Reads a dynamic `string` value (UTF-8 decoded). */
export function decodeString(data: Uint8Array, slotOffset = 0): string {
    return new TextDecoder().decode(decodeBytes(data, slotOffset));
}

/** Converts a 0x-prefixed hex string returned by `eth_call` to bytes. */
export function hexToBytes(hex: string): Uint8Array {
    if (hex === '0x' || hex === '') return new Uint8Array(0);
    return fromHex(hex.startsWith('0x') ? hex : '0x' + hex);
}
