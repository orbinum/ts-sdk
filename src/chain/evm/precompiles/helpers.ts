import { bigintTo32Be } from '../../../foundation/encoding/bytes';
import { fromHex } from '../../../foundation/encoding/hex';
import type { AbiParam } from './abi';

export const STATIC_TYPES = new Set<string>(['uint', 'bytes32', 'address', 'bool']);

export function concat(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, array) => sum + array.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const array of arrays) {
        out.set(array, offset);
        offset += array.length;
    }
    return out;
}

export function padTo32Multiple(data: Uint8Array): Uint8Array {
    const rem = data.length % 32;
    if (rem === 0) return data;
    const padded = new Uint8Array(data.length + (32 - rem));
    padded.set(data);
    return padded;
}

/**
 * A `bytes32` slot from exactly 32 bytes.
 *
 * Never reshaped to fit: truncating a longer value or zero-padding a shorter
 * one both yield a well-formed slot holding a DIFFERENT value. These bytes
 * become commitments and nullifiers, where a changed value is not an error the
 * chain reports but a note nobody can find or spend.
 *
 * Shared with the array encoder so the two cannot drift — a check that exists
 * on the scalar and not on `bytes32[]` is the same bug with one caller.
 */
function bytes32Slot(value: Uint8Array): Uint8Array {
    if (value.length !== 32) {
        throw new Error(`encodeAbi: bytes32 needs 32 bytes, got ${value.length}`);
    }
    const slot = new Uint8Array(32);
    slot.set(value);
    return slot;
}

/**
 * An `address` slot: 20 bytes right-aligned in 32.
 *
 * `padStart` only ever lengthens, so without the bound an over-long address
 * reached `set(_, 12)` and failed with a `RangeError` from inside the encoder
 * rather than a message naming the offending value.
 */
function addressSlot(address: string): Uint8Array {
    const clean = address.startsWith('0x') ? address.slice(2) : address;
    if (clean.length > 40) {
        throw new Error(`encodeAbi: address needs at most 20 bytes, got ${clean.length / 2}`);
    }
    const slot = new Uint8Array(32);
    slot.set(fromHex('0x' + clean.padStart(40, '0')), 12);
    return slot;
}

export function encodeStaticParam(param: AbiParam): Uint8Array {
    const buf = new Uint8Array(32);
    switch (param.type) {
        case 'uint': {
            return bigintTo32Be(param.value);
        }
        case 'bytes32': {
            return bytes32Slot(param.value);
        }
        case 'address': {
            return addressSlot(param.value);
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

export function encodeDynamicParam(param: AbiParam): Uint8Array {
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
            const parts: Uint8Array[] = [bigintTo32Be(BigInt(param.value.length))];
            for (const b32 of param.value) parts.push(bytes32Slot(b32));
            return concat(parts);
        }
        case 'address[]': {
            const parts: Uint8Array[] = [bigintTo32Be(BigInt(param.value.length))];
            for (const addr of param.value) parts.push(addressSlot(addr));
            return concat(parts);
        }
        case 'bytes[]': {
            const n = param.value.length;
            const offsets: Uint8Array[] = [];
            const datas: Uint8Array[] = [];
            let offset = n * 32;
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
