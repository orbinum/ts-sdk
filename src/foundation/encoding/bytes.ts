import { fromHex } from './hex';

/**
 * Rejects a value that cannot be spelled in 32 bytes.
 *
 * Both failure modes are SILENT without this check, and both produce bytes that
 * are wrong rather than absent:
 *
 *  - a NEGATIVE bigint: `>>` on a negative is an arithmetic shift, so it
 *    converges to `-1n` and never reaches zero — `-1n` encodes as 32×`0xFF`,
 *    which reads back as `2^256 - 1`;
 *  - a value ≥ 2^256: the high bits are dropped, so `2^256 + 7` encodes as `7`
 *    — a DIFFERENT number the chain will happily accept.
 *
 * These bytes become on-chain commitments and nullifiers. A corrupted
 * commitment is a note nobody can ever find or spend, which is why this throws
 * instead of clamping: an encoder that silently changes the value is worse than
 * one that refuses.
 */
function assert32ByteRange(n: bigint, fn: string): void {
    if (n < 0n || n >= 1n << 256n) {
        throw new Error(`${fn}: value does not fit in 32 bytes: ${n}`);
    }
}

/**
 * Serialises a bigint as a 32-byte little-endian Uint8Array.
 *
 * Throws on a negative value or one ≥ 2^256 — see `assert32ByteRange`.
 */
export function bigintTo32Le(n: bigint): Uint8Array {
    assert32ByteRange(n, 'bigintTo32Le');
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
 *
 * Throws on a negative value or one ≥ 2^256 — see `assert32ByteRange`.
 */
export function bigintTo32Be(n: bigint): Uint8Array {
    assert32ByteRange(n, 'bigintTo32Be');
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
 *
 * Throws on a negative value or one ≥ 2^256 — see `assert32ByteRange`. This is
 * the encoder that feeds commitments straight into extrinsic arguments, so a
 * silently-wrong value here lands on chain.
 */
export function bigintTo32LeArr(n: bigint): number[] {
    assert32ByteRange(n, 'bigintTo32LeArr');
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
    return bytesToBigintLE(fromHex(hex));
}
