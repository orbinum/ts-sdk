/**
 * base64url for wire formats that travel through URIs.
 *
 * Hand-rolled rather than `btoa`/`atob` or Node's Buffer: neither exists
 * everywhere this package runs. React Native has no `btoa`, and Buffer is
 * Node-only — a wire format that a mobile client cannot decode is not a wire
 * format.
 *
 * URL-safe alphabet with padding stripped, so the result survives a URI without
 * escaping.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!;
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        out += ALPHABET[a >> 2];
        out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
        if (b === undefined) break;
        out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
        if (c === undefined) break;
        out += ALPHABET[c & 0x3f];
    }
    return out;
}

export function base64UrlDecode(input: string): string {
    const lookup = new Map([...ALPHABET].map((ch, i) => [ch, i]));
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of input) {
        const value = lookup.get(ch);
        if (value === undefined) throw new Error(`Invalid base64url character: ${ch}`);
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}
