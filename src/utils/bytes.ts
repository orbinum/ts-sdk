/**
 * Serialises a bigint as a 32-byte little-endian Uint8Array.
 */
export function bigintTo32Le(n: bigint): Uint8Array {
    const buf = new Uint8Array(32);
    let v = n;
    for (let i = 0; i < 32; i++) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf;
}

/**
 * Deserialises a Uint8Array as a little-endian unsigned bigint.
 */
export function bytesToBigintLE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        result = (result << 8n) | BigInt(bytes[i] ?? 0);
    }
    return result;
}

/**
 * Serialises a bigint as a 32-byte big-endian Uint8Array.
 */
export function bigintTo32Be(n: bigint): Uint8Array {
    const buf = new Uint8Array(32);
    let v = n;
    for (let i = 31; i >= 0 && v > 0n; i--) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf;
}

/**
 * Serialises a bigint as a 32-element little-endian number[].
 * Useful when building SCALE-encoded arguments via polkadot-api.
 */
export function bigintTo32LeArr(n: bigint): number[] {
    const out: number[] = new Array(32).fill(0);
    let v = n;
    for (let i = 0; i < 32; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/**
 * Computes the Merkle path direction bits for a leaf at `leafIndex`
 * in a binary Merkle tree of `depth` levels.
 * bit 0 = bottom level (leaf), bit depth-1 = top level (root sibling).
 */
export function computePathIndices(leafIndex: number, depth: number): number[] {
    const indices: number[] = [];
    let idx = leafIndex;
    for (let i = 0; i < depth; i++) {
        indices.push(idx & 1);
        idx >>= 1;
    }
    return indices;
}

/**
 * Decodes a little-endian hex string (0x-prefixed or bare) to a bigint.
 * Equivalent to `bytesToBigintLE(fromHex(hex))`.
 */
export function leHexToBigint(hex: string): bigint {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return bytesToBigintLE(bytes);
}
