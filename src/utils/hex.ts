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
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        if (isNaN(byte)) throw new Error(`Invalid hex character at position ${i * 2}`);
        bytes[i] = byte;
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
