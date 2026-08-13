/**
 * Is `value` a 0x-prefixed hex string of exactly `byteLen` bytes?
 *
 * A total predicate on `unknown`, for validating values that crossed a trust
 * boundary — a decoded payment slip, an indexer response, a pasted string.
 * Those arrive as `unknown` or as a `string` the type system already believes,
 * and a bare `typeof === 'string'` check admits script tags, URLs and megabyte
 * payloads into fields the wallet later stores and renders.
 *
 * Returns a boolean rather than throwing: callers at a boundary usually want to
 * drop the value or reject the message, not unwind. Use `fromHex` when a throw
 * is the right answer.
 */
export function isHexOfLength(value: unknown, byteLen: number): value is string {
    return typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${byteLen * 2}}$`).test(value);
}

/**
 * Converts a Uint8Array or number[] to a 0x-prefixed lowercase hex string.
 */
export function toHex(bytes: Uint8Array | number[]): string {
    return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decodes a hex string (with or without 0x prefix) to Uint8Array.
 */
export function fromHex(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) {
        throw new Error(`Invalid hex string — odd length: "${hex}"`);
    }
    // Reject non-hex up front. `parseInt(_, 16)` accepts a valid prefix and
    // drops the rest ("1z" → 1, "-1" → -1), so a per-pair NaN check lets
    // near-hex from an untrusted source (indexer memo/commitment/blob) decode
    // into attacker-chosen bytes instead of throwing.
    if (!/^[0-9a-fA-F]*$/.test(clean)) {
        throw new Error('Invalid hex string — non-hex characters');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Ensures a hex string has the 0x prefix.
 */
export function ensureHexPrefix(hex: string): string {
    return hex.startsWith('0x') ? hex : `0x${hex}`;
}

/**
 * Converts a 0x-prefixed hex string (as returned by JSON-RPC) to a number.
 */
export function hexToNumber(hex: string): number {
    return parseInt(hex, 16);
}

/**
 * Converts a 0x-prefixed hex string (as returned by JSON-RPC) to a bigint.
 */
export function hexToBigint(hex: string): bigint {
    return BigInt(hex);
}

/**
 * A field scalar as canonical 32-byte hex: `0x` + 64 zero-padded chars.
 *
 * Big-endian and fixed-width on purpose. These strings are compared as strings
 * — a wallet finds its own note by matching an `ownerPk`, and the note-transfer
 * format is a cross-client contract — so one scalar must produce exactly one
 * spelling. Letting `toString(16)` emit its natural width would make `0x1` and
 * `0x0…01` two different keys for one value.
 *
 * Not for commitments or nullifiers: those travel LITTLE-endian and go through
 * `toHex(bigintTo32Le(...))`.
 */
export function scalarToHex(value: bigint): string {
    return '0x' + value.toString(16).padStart(64, '0');
}
