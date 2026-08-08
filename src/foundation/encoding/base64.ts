/**
 * Standard base64 over raw bytes.
 *
 * Hand-rolled rather than `btoa`/`atob` or Node's Buffer, for the same reason
 * as [base64url]: neither exists everywhere this package runs. React Native has
 * no `btoa`, and Buffer is Node-only.
 *
 * This one is not cosmetic. The vault's envelope stores its IV and ciphertext
 * as base64 (`encryptJson`/`decryptJson`) and blinded note tags are derived
 * through it, so a missing `btoa` is not a formatting problem — it is a
 * `ReferenceError` on the first note a mobile wallet tries to save, and a vault
 * that never opens.
 *
 * Padded, unlike the URL-safe variant: these strings live inside JSON records,
 * never inside a URI, and the padding keeps them decodable by any other base64
 * implementation that later reads the same vault.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!;
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        out += ALPHABET[a >> 2];
        out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
        out += b === undefined ? '=' : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
        out += c === undefined ? '=' : ALPHABET[c & 0x3f];
    }
    return out;
}

export function fromBase64(b64: string): Uint8Array {
    const lookup = new Map([...ALPHABET].map((ch, i) => [ch, i] as const));
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of b64) {
        if (ch === '=') break;
        const value = lookup.get(ch);
        // Whitespace is tolerated because base64 in transit is often wrapped;
        // anything else means the record is not what it claims to be, and
        // decoding it into silent garbage would surface far from the cause.
        if (value === undefined) {
            if (/\s/.test(ch)) continue;
            throw new Error(`Invalid base64 character: ${ch}`);
        }
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(bytes);
}
