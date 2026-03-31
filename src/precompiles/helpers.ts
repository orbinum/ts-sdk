import { bigintTo32Be } from '../utils/bytes';
import { fromHex } from '../utils/hex';
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

export function encodeStaticParam(param: AbiParam): Uint8Array {
    const buf = new Uint8Array(32);
    switch (param.type) {
        case 'uint': {
            return bigintTo32Be(param.value);
        }
        case 'bytes32': {
            buf.set(param.value.slice(0, 32));
            return buf;
        }
        case 'address': {
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
