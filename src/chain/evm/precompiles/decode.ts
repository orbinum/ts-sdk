/**
 * Decodes calldata for known Orbinum EVM precompiles.
 *
 * Returns raw decoded values (bigint amounts, hex strings for bytes32).
 * Callers are responsible for display formatting.
 */

import { toHex } from '../../../foundation/encoding/hex';
import { KNOWN_PRECOMPILES } from './addresses';
import { fromHex } from '../../../foundation/encoding/hex';
import { decodeUint } from './abi';

/**
 * Which shielded-pool operation a precompile call performs.
 *
 * Named rather than left to the caller to derive from `fnSig`, because the
 * obvious derivation is substring matching and `shield` is a substring of
 * `unshield` — a classifier that checks in the wrong order reports every
 * unshield as a shield, silently, and a new pallet method breaks it again.
 */
export type PrecompileMethod =
    | 'shield'
    | 'unshield'
    | 'privateTransfer'
    | 'shieldBatch'
    | 'claimShieldedFees';

export type DecodedPrecompile = {
    fnSig: string;
    /**
     * The operation, from the selector. Null only when the args below could not
     * be decoded either — every signature this file decodes maps to a name.
     */
    method: PrecompileMethod | null;
    args: Record<string, unknown>;
};

/**
 * The operation a function signature names.
 *
 * Anchored at the start and matched longest-first, so `unshield(` can never be
 * read as `shield(`.
 */
function methodOf(fnSig: string): PrecompileMethod | null {
    if (fnSig.startsWith('unshield(')) return 'unshield';
    if (fnSig.startsWith('privateTransfer(')) return 'privateTransfer';
    if (fnSig.startsWith('shieldBatch(')) return 'shieldBatch';
    if (fnSig.startsWith('claimShieldedFees(')) return 'claimShieldedFees';
    if (fnSig.startsWith('shield(')) return 'shield';
    return null;
}

/**
 * Is the ABI head long enough to hold `slots` complete 32-byte words?
 *
 * `decodeUint` reads a fixed 32-byte window and substitutes `?? 0` for bytes
 * past the end, so a field that is half present decodes to a value nobody
 * encoded — 16 bytes of `0xff` followed by 16 substituted zeros reads as
 * ~1.15e77. This input comes from the CHAIN, so a truncated or hand-crafted
 * call is ordinary, and consumers render `args.amount` to the user as what a
 * transaction moved. An absent field is honest; a fabricated one is not.
 */
function hasFullHead(data: Uint8Array, slots: number): boolean {
    return data.length >= slots * 32;
}

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

    // shield(uint32,bytes32,bytes)  — payable, amount = msg.value (NOT in calldata)
    // ABI head after selector:
    // [0-31] assetId | [32-63] commitment (bytes32) | [64-95] offset→memo
    if (fnSig.startsWith('shield(')) {
        try {
            const data = fromHex(input.slice(10));
            if (!hasFullHead(data, 3)) return { fnSig, method: methodOf(fnSig), args: {} };
            const assetId = decodeUint(data, 0);
            const commitment = toHex(data.slice(32, 64));
            // amount is msg.value — not present in calldata
            return { fnSig, method: methodOf(fnSig), args: { assetId, commitment } };
        } catch {
            return { fnSig, method: methodOf(fnSig), args: {} };
        }
    }

    // unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32,bytes,uint32)
    // ABI head after selector:
    // [0-31] offset→proof | [32-63] root | [64-95] nullifier
    // [96-127] assetId    | [128-159] amount | [160-191] recipient | [192-223] fee
    // [224-255] change_commitment | [256-287] offset→change_encrypted_memo | [288-319] circuit_version
    if (fnSig.startsWith('unshield(')) {
        try {
            const data = fromHex(input.slice(10));
            if (!hasFullHead(data, 10)) return { fnSig, method: methodOf(fnSig), args: {} };
            const root = toHex(data.slice(32, 64));
            const nullifier = toHex(data.slice(64, 96));
            const assetId = decodeUint(data, 96);
            const amount = decodeUint(data, 128);
            const recipient = toHex(data.slice(160, 192));
            const fee = decodeUint(data, 192);
            const changeCommitment = toHex(data.slice(224, 256));
            const circuitVersion = decodeUint(data, 288);
            return {
                fnSig,
                method: methodOf(fnSig),
                args: {
                    root,
                    nullifier,
                    assetId,
                    amount,
                    recipient,
                    fee,
                    changeCommitment,
                    circuitVersion,
                },
            };
        } catch {
            return { fnSig, method: methodOf(fnSig), args: {} };
        }
    }

    // privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256,uint32[,bytes])
    // ABI head after selector (both the legacy 8-slot and current 9-slot layout —
    // every field read below sits at the same offset in both):
    // [0-31] offset→proof | [32-63] root | [64-95] offset→nullifiers
    // [96-127] offset→commitments | [128-159] offset→memos
    // [160-191] assetId (uint32) | [192-223] fee (uint256) | [224-255] circuit_version (uint32)
    if (fnSig.startsWith('privateTransfer(')) {
        try {
            const data = fromHex(input.slice(10));
            if (!hasFullHead(data, 8)) return { fnSig, method: methodOf(fnSig), args: {} };
            const root = toHex(data.slice(32, 64));
            const assetId = decodeUint(data, 160);
            const fee = decodeUint(data, 192);
            const circuitVersion = decodeUint(data, 224);

            // The array lengths sit at offsets read FROM the calldata, so they
            // are attacker-chosen: an offset past the end would read a length
            // of zero out of substituted bytes, and `Number()` on a 32-byte
            // word silently loses precision well before that. Reported only
            // when the offset actually lands on a complete length word.
            const counts: Record<string, number> = {};
            for (const [name, slot] of [
                ['nullifiers', 64],
                ['commitments', 96],
            ] as const) {
                const offset = decodeUint(data, slot);
                if (offset <= BigInt(data.length - 32)) {
                    counts[name] = Number(decodeUint(data, Number(offset)));
                }
            }

            return {
                fnSig,
                method: methodOf(fnSig),
                args: { root, ...counts, assetId, fee, circuitVersion },
            };
        } catch {
            return { fnSig, method: methodOf(fnSig), args: {} };
        }
    }

    // claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes,uint32)
    // ABI head after selector (7 slots × 32 = 224 bytes):
    // [0-31]   commitment (bytes32)
    // [32-63]  amount (uint256)
    // [64-95]  asset_id (uint32, right-aligned)
    // [96-127] offset → memo
    // [128-159] offset → proof
    // [160-191] offset → publicSignals
    // [192-223] circuit_version (uint32, right-aligned)
    if (fnSig.startsWith('claimShieldedFees(')) {
        try {
            const data = fromHex(input.slice(10));
            if (!hasFullHead(data, 7)) return { fnSig, method: methodOf(fnSig), args: {} };
            const commitment = toHex(data.slice(0, 32));
            const amount = decodeUint(data, 32);
            const assetId = decodeUint(data, 64);
            const circuitVersion = decodeUint(data, 192);
            return {
                fnSig,
                method: methodOf(fnSig),
                args: { commitment, amount, assetId, circuitVersion },
            };
        } catch {
            return { fnSig, method: methodOf(fnSig), args: {} };
        }
    }

    return { fnSig, method: methodOf(fnSig), args: {} };
}
