/**
 * Decodes calldata for known Orbinum EVM precompiles.
 *
 * Returns raw decoded values (bigint amounts, hex strings for bytes32).
 * Callers are responsible for display formatting.
 */

import { toHex } from '../utils/hex';
import { KNOWN_PRECOMPILES } from './addresses';
import { decodeUint, decodeString, hexToBytes } from './abi';

export type DecodedPrecompile = {
    fnSig: string;
    args: Record<string, unknown>;
};

/**
 * Decodes EVM calldata for a known Orbinum precompile.
 *
 * @param address - The precompile contract address (0x-prefixed).
 * @param input   - The transaction input data (0x-prefixed hex).
 * @returns Decoded `{ fnSig, args }` with raw values, or `null` if unknown.
 */
export function decodePrecompileCalldata(address: string, input: string): DecodedPrecompile | null {
    const info = KNOWN_PRECOMPILES[address.toLowerCase()];
    if (!info || !input || input.length < 10) return null;

    const selector = input.slice(2, 10).toLowerCase(); // strip 0x
    const fnSig = info.functions[selector];
    if (!fnSig) return null;

    // registerAlias(string)
    if (fnSig.startsWith('registerAlias')) {
        try {
            const data = hexToBytes(input.slice(10));
            // ABI: offset (32 bytes) + length (32 bytes) + utf-8 data
            const alias = decodeString(data, 0);
            return { fnSig, args: { alias } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // shield(uint32,uint256,bytes32,bytes)
    // ABI head after selector:
    // [0-31] assetId | [32-63] amount | [64-95] commitment (bytes32) | [96-127] offset→memo
    if (fnSig.startsWith('shield(')) {
        try {
            const data = hexToBytes(input.slice(10));
            const assetId = decodeUint(data, 0);
            const amount = decodeUint(data, 32);
            const commitment = toHex(data.slice(64, 96));
            return { fnSig, args: { assetId, amount, commitment } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32)
    // ABI head after selector:
    // [0-31] offset→proof | [32-63] root | [64-95] nullifier
    // [96-127] assetId    | [128-159] amount | [160-191] recipient
    if (fnSig.startsWith('unshield(')) {
        try {
            const data = hexToBytes(input.slice(10));
            const root = toHex(data.slice(32, 64));
            const nullifier = toHex(data.slice(64, 96));
            const assetId = decodeUint(data, 96);
            const amount = decodeUint(data, 128);
            const recipient = toHex(data.slice(160, 192));
            return { fnSig, args: { root, nullifier, assetId, amount, recipient } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[])
    // ABI head after selector:
    // [0-31] offset→proof | [32-63] root | [64-95] offset→nullifiers
    // [96-127] offset→commitments | [128-159] offset→memos
    if (fnSig.startsWith('privateTransfer(')) {
        try {
            const data = hexToBytes(input.slice(10));
            const root = toHex(data.slice(32, 64));
            const nullOffset = Number(decodeUint(data, 64)); // byte offset into data
            const commOffset = Number(decodeUint(data, 96)); // byte offset into data
            const nullifiers = Number(decodeUint(data, nullOffset));
            const commitments = Number(decodeUint(data, commOffset));
            return { fnSig, args: { root, nullifiers, commitments } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    return { fnSig, args: {} };
}
