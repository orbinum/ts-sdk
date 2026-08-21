import { describe, it, expect } from 'vitest';
import {
    toHex,
    fromHex,
    isHexOfLength,
    ensureHexPrefix,
    hexToNumber,
    hexToBigint,
    scalarToHex,
} from '../../../src/foundation/encoding/hex';
import * as publicIndex from '../../../src/index';

describe('toHex', () => {
    it('encodes empty array to "0x"', () => {
        expect(toHex(new Uint8Array())).toBe('0x');
    });

    it('encodes bytes to lowercase hex with 0x prefix', () => {
        expect(toHex(new Uint8Array([0, 1, 255]))).toBe('0x0001ff');
    });

    it('pads single-nibble bytes', () => {
        expect(toHex(new Uint8Array([10, 15]))).toBe('0x0a0f');
    });

    it('roundtrips with fromHex', () => {
        const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        expect(fromHex(toHex(original))).toEqual(original);
    });
});

describe('fromHex', () => {
    it('decodes 0x-prefixed string', () => {
        expect(fromHex('0x0001ff')).toEqual(new Uint8Array([0, 1, 255]));
    });

    it('decodes unprefixed string', () => {
        expect(fromHex('0001ff')).toEqual(new Uint8Array([0, 1, 255]));
    });

    it('decodes empty string to empty array', () => {
        expect(fromHex('')).toEqual(new Uint8Array());
    });

    it('decodes "0x" to empty array', () => {
        expect(fromHex('0x')).toEqual(new Uint8Array());
    });

    it('throws on odd-length hex string', () => {
        expect(() => fromHex('0x0')).toThrow(/odd length/);
    });

    it('throws on invalid hex character', () => {
        expect(() => fromHex('0xzz')).toThrow();
    });

    // Regression: parseInt(_, 16) accepts a valid prefix and drops the rest, so
    // these used to decode into attacker-chosen bytes instead of throwing.
    it('rejects near-hex that parseInt would silently truncate', () => {
        expect(() => fromHex('0x1z')).toThrow(/non-hex/);
        expect(() => fromHex('0x-1')).toThrow(/non-hex/);
        expect(() => fromHex('0x 1')).toThrow(/non-hex/);
        expect(() => fromHex('0xg0')).toThrow(/non-hex/);
    });

    it('decodes full byte range 0x00–0xff', () => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        expect(fromHex(toHex(bytes))).toEqual(bytes);
    });
});

describe('ensureHexPrefix', () => {
    it('adds 0x when missing', () => {
        expect(ensureHexPrefix('aabb')).toBe('0xaabb');
    });

    it('keeps 0x when already present', () => {
        expect(ensureHexPrefix('0xaabb')).toBe('0xaabb');
    });

    it('handles empty string', () => {
        expect(ensureHexPrefix('')).toBe('0x');
    });

    it('does not double-prefix', () => {
        expect(ensureHexPrefix('0x0x')).toBe('0x0x');
    });
});

describe('hexToNumber', () => {
    it('converts 0x-prefixed hex to number', () => {
        expect(hexToNumber('0x1')).toBe(1);
        expect(hexToNumber('0xff')).toBe(255);
        expect(hexToNumber('0x100')).toBe(256);
    });

    it('converts unprefixed hex to number', () => {
        expect(hexToNumber('ff')).toBe(255);
        expect(hexToNumber('10')).toBe(16);
    });

    it('converts 0x0 to 0', () => {
        expect(hexToNumber('0x0')).toBe(0);
    });

    it('rechaza casi-hex en vez de truncarlo', () => {
        // `parseInt` acepta un prefijo válido y tira el resto: `"0x12zz"` daba
        // `18`, un número de bloque plausible y equivocado. Y esto viene de un
        // servidor.
        expect(() => hexToNumber('0x12zz')).toThrow(/Invalid hex quantity/);
        // Pero `0X` en mayúsculas es una entrada que esta función SIEMPRE ha
        // aceptado — endurecerla no puede empezar a rechazarla.
        expect(hexToNumber('0XFF')).toBe(255);
        expect(() => hexToNumber('zz')).toThrow(/Invalid hex quantity/);
        expect(() => hexToNumber('')).toThrow(/Invalid hex quantity/);
        expect(() => hexToNumber('0x')).toThrow(/Invalid hex quantity/);
    });

    it('rechaza una cantidad que no cabe en un entero seguro', () => {
        // Más allá de 2^53 el número pierde precisión en silencio.
        expect(() => hexToNumber('0x' + 'f'.repeat(16))).toThrow(/safe integer/);
        expect(hexToNumber('0x1fffffffffffff')).toBe(2 ** 53 - 1);
    });

    it('handles typical JSON-RPC block number', () => {
        expect(hexToNumber('0x4b7')).toBe(1207);
    });

    it('handles large block numbers', () => {
        expect(hexToNumber('0xf4240')).toBe(1000000);
    });
});

describe('hexToBigint', () => {
    it('converts 0x-prefixed hex to bigint', () => {
        expect(hexToBigint('0x1')).toBe(1n);
        expect(hexToBigint('0xff')).toBe(255n);
    });

    it('converts 0x0 to 0n', () => {
        expect(hexToBigint('0x0')).toBe(0n);
    });

    it('handles typical wei balance', () => {
        // 1 ETH in wei = 1_000_000_000_000_000_000
        expect(hexToBigint('0xde0b6b3a7640000')).toBe(1_000_000_000_000_000_000n);
    });

    it('handles very large values without precision loss', () => {
        const large =
            21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        const asHex = '0x' + large.toString(16);
        expect(hexToBigint(asHex)).toBe(large);
    });
});

// ─── public re-exports (src/index.ts) ─────────────────────────────────────────

describe('public index re-exports', () => {
    it('exports hexToNumber', () => {
        expect(typeof publicIndex.hexToNumber).toBe('function');
        expect(publicIndex.hexToNumber('0x15')).toBe(21);
    });

    it('exports hexToBigint', () => {
        expect(typeof publicIndex.hexToBigint).toBe('function');
        expect(publicIndex.hexToBigint('0xde0b6b3a7640000')).toBe(1_000_000_000_000_000_000n);
    });
});

/**
 * `scalarToHex` — one spelling per scalar.
 *
 * These strings are compared as strings: a wallet finds its own note by
 * matching an `ownerPk`, and the note-transfer format is a cross-client
 * contract two separately-shipped programs must agree on. A natural-width
 * `toString(16)` would make `0x1` and `0x0…01` two keys for one value, so the
 * padding is the property, not a formatting preference.
 */
describe('scalarToHex', () => {
    it('always emits 32 bytes, whatever the magnitude', () => {
        for (const value of [0n, 1n, 255n, 2n ** 200n]) {
            expect(scalarToHex(value)).toHaveLength(66);
        }
    });

    it('zero-pads a small scalar rather than emitting its natural width', () => {
        expect(scalarToHex(1n)).toBe('0x' + '0'.repeat(63) + '1');
    });

    it('round-trips through hexToBigint', () => {
        for (const value of [0n, 42n, 2n ** 255n - 1n]) {
            expect(hexToBigint(scalarToHex(value))).toBe(value);
        }
    });

    it('is big-endian — the low byte lands last', () => {
        // Commitments and nullifiers travel LITTLE-endian and must NOT use this.
        expect(scalarToHex(0x1234n).endsWith('1234')).toBe(true);
    });

    it('rechaza lo que rompe la invariante de una grafía por escalar', () => {
        // Un negativo emitía un literal `0x-…` y un valor por encima de 2^256
        // desbordaba los 64 caracteres. Las dos cosas se comparan como cadena
        // contra una grafía correcta y simplemente no casan — en silencio.
        expect(() => scalarToHex(-1n)).toThrow(/32 unsigned bytes/);
        expect(() => scalarToHex(1n << 256n)).toThrow(/32 unsigned bytes/);
    });

    it('acepta el máximo que sí cabe', () => {
        expect(scalarToHex((1n << 256n) - 1n)).toHaveLength(66);
    });
});

describe('isHexOfLength', () => {
    // The guard every trust boundary leans on: a decoded slip, an indexer row,
    // a pasted string. What it must reject is exactly what a bare
    // `typeof === 'string'` lets through.

    it('accepts a 0x-prefixed hex string of the exact byte length', () => {
        expect(isHexOfLength('0x' + 'ab'.repeat(32), 32)).toBe(true);
        expect(isHexOfLength('0x' + 'AB'.repeat(32), 32)).toBe(true); // case-insensitive
        expect(isHexOfLength('0x', 0)).toBe(true);
    });

    it('rejects the wrong length, off by a single nibble', () => {
        expect(isHexOfLength('0x' + 'ab'.repeat(31), 32)).toBe(false);
        expect(isHexOfLength('0x' + 'ab'.repeat(33), 32)).toBe(false);
        expect(isHexOfLength('0x' + 'ab'.repeat(32) + 'c', 32)).toBe(false);
    });

    it('requires the 0x prefix', () => {
        expect(isHexOfLength('ab'.repeat(32), 32)).toBe(false);
        expect(isHexOfLength('0X' + 'ab'.repeat(32), 32)).toBe(false);
    });

    it('rejects non-hex characters that parseInt would silently accept', () => {
        // `parseInt('1z', 16)` is 1 — near-hex must never decode into
        // attacker-chosen bytes.
        expect(isHexOfLength('0x' + 'zz'.repeat(32), 32)).toBe(false);
        expect(isHexOfLength('0x' + 'ab'.repeat(31) + 'g0', 32)).toBe(false);
    });

    it('rejects anything that is not a string, without throwing', () => {
        for (const v of [null, undefined, 42, true, {}, [], new Uint8Array(32)]) {
            expect(() => isHexOfLength(v, 32)).not.toThrow();
            expect(isHexOfLength(v, 32)).toBe(false);
        }
    });

    it('rejects the injection shapes a rendered field would carry', () => {
        for (const v of [
            '<script>alert(1)</script>',
            'javascript:alert(1)',
            'https://evil.example',
            'x'.repeat(100_000),
            '',
        ]) {
            expect(isHexOfLength(v, 32)).toBe(false);
        }
    });

    it('anchors both ends — no prefix or suffix smuggling', () => {
        const valid = 'ab'.repeat(32);
        expect(isHexOfLength(`0x${valid}<script>`, 32)).toBe(false);
        expect(isHexOfLength(`prefix0x${valid}`, 32)).toBe(false);
        expect(isHexOfLength(`0x${valid}\n0x${valid}`, 32)).toBe(false);
    });
});
