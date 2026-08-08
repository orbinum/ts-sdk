/**
 * `toBase64` / `fromBase64` — the encoding the vault envelope is stored in.
 *
 * Two properties matter, and they pull in opposite directions.
 *
 * PORTABILITY: no `btoa`/`atob`, no Buffer. The vault's IV and ciphertext go
 * through here on every save, so a missing global is not a formatting problem
 * but a `ReferenceError` on the first note a React Native wallet writes.
 *
 * COMPATIBILITY: the output must be byte-identical to what `btoa` produced,
 * because vaults written by earlier versions are already on disk. A "portable"
 * encoder that disagreed with the old one would leave every existing wallet
 * unopenable — which is why the round-trip against the native implementation is
 * asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { toBase64, fromBase64 } from '../../../src/foundation/encoding/base64';

const bytes = (...n: number[]) => new Uint8Array(n);

/** What the previous `btoa`-based implementation produced, for comparison. */
function nativeToBase64(buf: Uint8Array): string {
    let str = '';
    for (const b of buf) str += String.fromCharCode(b);
    return btoa(str);
}

describe('agreement with the native implementation', () => {
    it('matches btoa on every input length modulo 3', () => {
        // The tail is where padding is decided and where a hand-rolled encoder
        // goes wrong: 1 leftover byte takes '==', 2 take '='.
        for (let len = 0; len <= 32; len++) {
            const input = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
            expect(toBase64(input)).toBe(nativeToBase64(input));
        }
    });

    it('matches btoa across the full byte range', () => {
        const all = new Uint8Array(256).map((_, i) => i);
        expect(toBase64(all)).toBe(nativeToBase64(all));
    });

    it('decodes what btoa encoded — old vaults must still open', () => {
        const stored = new Uint8Array(48).map((_, i) => (i * 11) & 0xff);
        expect(fromBase64(nativeToBase64(stored))).toEqual(stored);
    });
});

describe('known vectors', () => {
    it.each([
        [[], ''],
        [[0x66], 'Zg=='],
        [[0x66, 0x6f], 'Zm8='],
        [[0x66, 0x6f, 0x6f], 'Zm9v'],
        [[0x66, 0x6f, 0x6f, 0x62], 'Zm9vYg=='],
    ])('encodes %j', (input, expected) => {
        expect(toBase64(bytes(...input))).toBe(expected);
    });

    it('uses the standard alphabet, not the URL-safe one', () => {
        // 0xfb 0xff produces the two characters that differ between alphabets.
        // Emitting '-' or '_' here would write vaults no standard decoder reads.
        expect(toBase64(bytes(0xfb, 0xff))).toBe('+/8=');
    });
});

describe('round trip', () => {
    it('survives every length modulo 3', () => {
        for (let len = 0; len <= 16; len++) {
            const input = new Uint8Array(len).map((_, i) => (i * 53) & 0xff);
            expect(fromBase64(toBase64(input))).toEqual(input);
        }
    });

    it('preserves all 256 byte values', () => {
        const all = new Uint8Array(256).map((_, i) => i);
        expect(fromBase64(toBase64(all))).toEqual(all);
    });

    it('accepts an ArrayBuffer as well as a view', () => {
        // `crypto.subtle.encrypt` resolves to an ArrayBuffer, which is what
        // `encryptJson` passes straight in.
        const view = bytes(1, 2, 3, 4, 5);
        expect(toBase64(view.buffer as ArrayBuffer)).toBe(toBase64(view));
    });
});

describe('portability', () => {
    it('does not call btoa or atob', async () => {
        // The guarantee is structural: shadowing both globals must change
        // nothing. A future refactor that reaches for them fails here rather
        // than on a phone.
        const globals = globalThis as Record<string, unknown>;
        const realBtoa = globals['btoa'];
        const realAtob = globals['atob'];
        globals['btoa'] = () => {
            throw new Error('btoa is not available in React Native');
        };
        globals['atob'] = () => {
            throw new Error('atob is not available in React Native');
        };
        try {
            const input = bytes(0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f);
            expect(fromBase64(toBase64(input))).toEqual(input);
        } finally {
            globals['btoa'] = realBtoa;
            globals['atob'] = realAtob;
        }
    });
});

describe('malformed input', () => {
    it('rejects a character outside the alphabet', () => {
        // Silent garbage would surface as an AES-GCM authentication failure far
        // from the record that was actually corrupt.
        expect(() => fromBase64('Zm9v!')).toThrow(/Invalid base64 character/);
    });

    it('tolerates whitespace, which transit sometimes inserts', () => {
        expect(fromBase64('Zm9v\nYg==')).toEqual(bytes(0x66, 0x6f, 0x6f, 0x62));
    });

    it('stops at padding rather than decoding it', () => {
        expect(fromBase64('Zg==')).toEqual(bytes(0x66));
    });
});
