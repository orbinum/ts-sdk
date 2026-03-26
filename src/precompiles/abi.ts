import { fromHex, toHex } from '../utils/hex';
import { bigintTo32Be } from '../utils/bytes';

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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function concat(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrays) {
        out.set(a, o);
        o += a.length;
    }
    return out;
}

/** Pads `data` to the next multiple of 32 bytes (right-padded with zeros). */
function padTo32Multiple(data: Uint8Array): Uint8Array {
    const rem = data.length % 32;
    if (rem === 0) return data;
    const padded = new Uint8Array(data.length + (32 - rem));
    padded.set(data);
    return padded;
}

const STATIC_TYPES = new Set<string>(['uint', 'bytes32', 'address', 'bool']);

// ─── Encode static param ──────────────────────────────────────────────────────

function encodeStaticParam(param: AbiParam): Uint8Array {
    const buf = new Uint8Array(32);
    switch (param.type) {
        case 'uint': {
            return bigintTo32Be(param.value);
        }
        case 'bytes32': {
            // left-aligned, exactly 32 bytes — no padding needed
            buf.set(param.value.slice(0, 32));
            return buf;
        }
        case 'address': {
            // right-aligned: 12 zero bytes + 20 address bytes
            const clean = param.value.startsWith('0x') ? param.value.slice(2) : param.value;
            const bytes = fromHex('0x' + clean.padStart(40, '0'));
            buf.set(bytes, 12);
            return buf;
        }
        case 'bool': {
            buf[31] = param.value ? 1 : 0;
            return buf;
        }
        default:
            throw new Error(
                `encodeStatic: not a static ABI type: ${(param as { type: string }).type}`
            );
    }
}

// ─── Encode dynamic param (returns the tail block) ────────────────────────────

function encodeDynamicParam(param: AbiParam): Uint8Array {
    switch (param.type) {
        case 'bytes': {
            const data = param.value;
            return concat([bigintTo32Be(BigInt(data.length)), padTo32Multiple(data)]);
        }
        case 'string': {
            const data = new TextEncoder().encode(param.value);
            return concat([bigintTo32Be(BigInt(data.length)), padTo32Multiple(data)]);
        }
        case 'bytes32[]': {
            const n = param.value.length;
            const parts: Uint8Array[] = [bigintTo32Be(BigInt(n))];
            for (const b32 of param.value) {
                const slot = new Uint8Array(32);
                slot.set(b32.slice(0, 32));
                parts.push(slot);
            }
            return concat(parts);
        }
        case 'address[]': {
            const n = param.value.length;
            const parts: Uint8Array[] = [bigintTo32Be(BigInt(n))];
            for (const addr of param.value) {
                const slot = new Uint8Array(32);
                const clean = addr.startsWith('0x') ? addr.slice(2) : addr;
                const bytes = fromHex('0x' + clean.padStart(40, '0'));
                slot.set(bytes, 12);
                parts.push(slot);
            }
            return concat(parts);
        }
        case 'bytes[]': {
            /*
             * `bytes[]` encoding — each element is dynamic:
             *
             * Layout (relative to start of THIS dynamic section's body, i.e., right after uint256(n)):
             *   [0 .. n*32-1]     n offsets, each uint256, relative to body start
             *   [n*32 ..]         element0: uint256(len0) + data0_padded
             *                     element1: uint256(len1) + data1_padded
             *                     ...
             */
            const n = param.value.length;
            const offsets: Uint8Array[] = [];
            const datas: Uint8Array[] = [];
            let offset = n * 32; // first data block starts after n offset slots
            for (const item of param.value) {
                offsets.push(bigintTo32Be(BigInt(offset)));
                const itemBlock = concat([
                    bigintTo32Be(BigInt(item.length)),
                    padTo32Multiple(item),
                ]);
                datas.push(itemBlock);
                offset += itemBlock.length;
            }
            return concat([bigintTo32Be(BigInt(n)), ...offsets, ...datas]);
        }
        default:
            throw new Error(
                `encodeDynamic: not a dynamic ABI type: ${(param as { type: string }).type}`
            );
    }
}

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
