import { describe, it, expect } from 'vitest';
import {
    formatBalance,
    formatORB,
    parseAmount,
    formatAmountPlain,
} from '../../../src/foundation/text/format';

// ─── formatBalance ────────────────────────────────────────────────────────────

describe('formatBalance — null / zero inputs', () => {
    it('returns "0 ORB" for null', () => {
        expect(formatBalance(null)).toBe('0 ORB');
    });

    it('returns "0 ORB" for undefined', () => {
        expect(formatBalance(undefined)).toBe('0 ORB');
    });

    it('returns "0 ORB" for string "0"', () => {
        expect(formatBalance('0')).toBe('0 ORB');
    });

    it('returns "0 ORB" for bigint 0n', () => {
        expect(formatBalance(0n)).toBe('0 ORB');
    });

    it('returns "0 ORB" for string "0x0"', () => {
        expect(formatBalance('0x0')).toBe('0 ORB');
    });

    it('returns "0" when showSymbol is false and value is zero', () => {
        expect(formatBalance(null, { showSymbol: false })).toBe('0');
    });
});

describe('formatBalance — integer amounts (string)', () => {
    it('formats 1 ORB (10^18 planck) as "1 ORB"', () => {
        expect(formatBalance('1000000000000000000')).toBe('1 ORB');
    });

    it('formats 10 ORB as "10 ORB"', () => {
        expect(formatBalance('10000000000000000000')).toBe('10 ORB');
    });

    it('formats 1000 ORB with thousands separator', () => {
        // toLocaleString uses locale separator; in test environment (en) it should be "1,000"
        const result = formatBalance('1000000000000000000000');
        expect(result).toMatch(/^1[,.]?000 ORB$/);
    });

    it('formats 0.5 ORB as "0.5 ORB"', () => {
        expect(formatBalance('500000000000000000')).toBe('0.5 ORB');
    });

    it('formats 0.000001 ORB (6 decimals precision)', () => {
        expect(formatBalance('1000000000000')).toBe('0.000001 ORB');
    });

    it('trims trailing zeros (e.g. 1.5 not 1.500000)', () => {
        const result = formatBalance('1500000000000000000');
        expect(result).toBe('1.5 ORB');
    });
});

describe('formatBalance — bigint input', () => {
    it('accepts bigint for 1 ORB', () => {
        expect(formatBalance(1_000_000_000_000_000_000n)).toBe('1 ORB');
    });

    it('accepts bigint for 0.5 ORB', () => {
        expect(formatBalance(500_000_000_000_000_000n)).toBe('0.5 ORB');
    });

    it('accepts bigint 0n as zero', () => {
        expect(formatBalance(0n)).toBe('0 ORB');
    });
});

describe('formatBalance — number input', () => {
    it('accepts number 0 as zero', () => {
        expect(formatBalance(0)).toBe('0 ORB');
    });

    it('accepts number 1e18 (1 ORB)', () => {
        // Number(1e18) = 1000000000000000000 — safe as integer string
        expect(formatBalance(1e18)).toBe('1 ORB');
    });
});

describe('formatBalance — hex string input', () => {
    it('parses 0x0de0b6b3a7640000 as 1 ORB', () => {
        // 0x0de0b6b3a7640000 = 10^18
        expect(formatBalance('0x0de0b6b3a7640000')).toBe('1 ORB');
    });

    it('accepts uppercase 0X-prefixed hex', () => {
        expect(formatBalance('0X0DE0B6B3A7640000')).toBe('1 ORB');
    });

    it('parses 0x6f05b59d3b20000 as 0.5 ORB', () => {
        // 0x6f05b59d3b20000 = 5 * 10^17
        expect(formatBalance('0x6f05b59d3b20000')).toBe('0.5 ORB');
    });
});

describe('formatBalance — already-decimal string input', () => {
    it('accepts "1.5" as 1.5 ORB (already formatted)', () => {
        expect(formatBalance('1.5')).toBe('1.5 ORB');
    });

    it('accepts "0.000001" as 0.000001 ORB', () => {
        expect(formatBalance('0.000001')).toBe('0.000001 ORB');
    });

    it('trims trailing zeros from decimal string "1.500000"', () => {
        expect(formatBalance('1.500000')).toBe('1.5 ORB');
    });

    it('returns zero for "0.0000000" (all zeros after decimal)', () => {
        expect(formatBalance('0.0000000')).toBe('0 ORB');
    });
});

describe('formatBalance — options: custom decimals', () => {
    it('formats with 6 decimals (USDT-like)', () => {
        expect(formatBalance('1000000', { decimals: 6, symbol: 'USDT' })).toBe('1 USDT');
    });

    it('formats with 0 decimals', () => {
        expect(formatBalance('42', { decimals: 0, symbol: 'UNITS' })).toBe('42 UNITS');
    });

    it('supports legacy numeric second argument as decimals', () => {
        expect(formatBalance('1000000', 6)).toBe('1 ORB');
    });
});

describe('formatBalance — options: showSymbol', () => {
    it('omits symbol when showSymbol is false', () => {
        expect(formatBalance('1000000000000000000', { showSymbol: false })).toBe('1');
    });

    it('includes symbol by default', () => {
        expect(formatBalance('1000000000000000000')).toContain('ORB');
    });
});

describe('formatBalance — options: custom symbol', () => {
    it('uses custom symbol', () => {
        expect(formatBalance('1000000000000000000', { symbol: 'ETH' })).toBe('1 ETH');
    });
});

describe('formatBalance — options: precision', () => {
    it('limits to 2 decimal places', () => {
        // 1.23456789 ORB at precision=2 → "1.23 ORB"
        expect(formatBalance('1234567890000000000', { precision: 2 })).toBe('1.23 ORB');
    });

    it('`precision` es un TOPE: no rellena con ceros', () => {
        // El JSDoc prometía '0.50 ORB' para este caso. `precision` limita los
        // decimales y `normalizeDecimalForDisplay` recorta los ceros finales,
        // así que rellenar nunca ocurre — el test de arriba no lo veía porque
        // su valor llena los dos decimales de todas formas.
        expect(formatBalance(500000000000000000n, { precision: 2 })).toBe('0.5 ORB');
    });

    it('limits to 0 decimal places (integer only)', () => {
        expect(formatBalance('1500000000000000000', { precision: 0 })).toBe('1 ORB');
    });

    it('precision=18 shows full value without truncation', () => {
        const result = formatBalance('1230000000000000000', { precision: 18 });
        expect(result).toBe('1.23 ORB');
    });

    it('sub-precision amounts round down to 0', () => {
        // 0.0000001 ORB with precision=6 → below visible threshold → '0 ORB'
        expect(formatBalance('100000000000', { precision: 6 })).toBe('0 ORB');
    });
});

describe('formatBalance — negative values', () => {
    it('formats negative bigint', () => {
        expect(formatBalance(-1_000_000_000_000_000_000n)).toBe('-1 ORB');
    });

    it('formats negative decimal string', () => {
        expect(formatBalance('-1.5')).toBe('-1.5 ORB');
    });
});

describe('formatBalance — invalid / unparseable input', () => {
    it('returns zero for empty string', () => {
        expect(formatBalance('')).toBe('0 ORB');
    });

    it('returns zero for non-numeric string', () => {
        expect(formatBalance('not-a-number')).toBe('0 ORB');
    });

    it('returns zero for grouped strings with commas', () => {
        expect(formatBalance('1,000')).toBe('0 ORB');
    });

    it('returns zero for scientific notation', () => {
        expect(formatBalance('1e18')).toBe('0 ORB');
    });

    it('returns zero for explicit plus sign', () => {
        expect(formatBalance('+1')).toBe('0 ORB');
    });

    it('returns zero for underscored numeric strings', () => {
        expect(formatBalance('1_000')).toBe('0 ORB');
    });

    it('returns zero for malformed hex', () => {
        expect(formatBalance('0xZZ')).toBe('0 ORB');
    });
});

// ─── formatORB ────────────────────────────────────────────────────────────────

describe('formatORB', () => {
    it('formats 1 ORB', () => {
        expect(formatORB('1000000000000000000')).toBe('1 ORB');
    });

    it('formats 0.5 ORB from bigint', () => {
        expect(formatORB(500_000_000_000_000_000n)).toBe('0.5 ORB');
    });

    it('formats null as "0 ORB"', () => {
        expect(formatORB(null)).toBe('0 ORB');
    });

    it('respects custom precision argument', () => {
        expect(formatORB('1234567890000000000', 2)).toBe('1.23 ORB');
    });

    it('always uses ORB symbol (ignores any external symbol config)', () => {
        expect(formatORB('1000000000000000000')).toContain('ORB');
    });

    it('defaults to 6 decimal precision', () => {
        // 1.123456789 → truncated to 6 → 1.123456
        expect(formatORB('1123456789000000000')).toBe('1.123456 ORB');
    });
});

/**
 * `parseAmount` / `formatAmountPlain` — display ↔ planck.
 *
 * This pair decides how much money a spend moves, which is why it is protocol
 * rather than presentation: a wallet collects a string and the chain takes a
 * bigint, and every host would otherwise write this conversion itself.
 *
 * Validation is by shape, not by `Number()`. Both reach the same value for an
 * ordinary amount — the arithmetic was always BigInt — but a float check also
 * ACCEPTS forms the BigInt path then mangles: `1e18` parses as a number and
 * reaches `BigInt('1e18')`, which throws, and a grouped `1,5` reads as 1.
 */
describe('parseAmount', () => {
    it('converts whole and fractional amounts', () => {
        expect(parseAmount('1', 18)).toBe(10n ** 18n);
        expect(parseAmount('0.5', 18)).toBe(5n * 10n ** 17n);
        expect(parseAmount('1.5', 18)).toBe(15n * 10n ** 17n);
    });

    it('keeps full precision beyond what a float can hold', () => {
        // 23 significant digits. The digits survive because the arithmetic never
        // goes through a float, only the string does.
        expect(parseAmount('12345.678901234567891', 18)).toBe(12345678901234567891000n);
    });

    it('truncates excess fractional digits rather than rounding', () => {
        // Rounding up would build a spend for more than the user typed.
        expect(parseAmount('1.999', 2)).toBe(199n);
        // Digits past the asset's precision do not exist on-chain, so an amount
        // made only of them truncates to zero — which is not a usable amount.
        expect(parseAmount('0.00000000000000000099', 18)).toBeNull();
    });

    it.each([
        ['', 'empty'],
        ['   ', 'blank'],
        ['.', 'a bare dot'],
        ['0', 'zero'],
        ['0.0', 'zero with a fraction'],
        ['abc', 'letters'],
        ['1e18', 'scientific notation'],
        ['-1', 'a negative'],
        ['1,5', 'a grouped value'],
    ])('rejects %s (%s)', (input) => {
        expect(parseAmount(input, 18)).toBeNull();
    });

    it('tolerates surrounding whitespace', () => {
        expect(parseAmount('  1.5  ', 18)).toBe(15n * 10n ** 17n);
    });

    it('accepts a leading or trailing dot with digits on one side', () => {
        expect(parseAmount('.5', 18)).toBe(5n * 10n ** 17n);
        expect(parseAmount('5.', 18)).toBe(5n * 10n ** 18n);
    });
});

describe('formatAmountPlain', () => {
    it('does not group thousands — the value must round-trip', () => {
        // `formatBalance` would render "1,199"; a numeric input rejects that.
        expect(formatAmountPlain(1199n * 10n ** 18n, 18)).toBe('1199');
    });

    it('trims trailing zeros in the fraction', () => {
        expect(formatAmountPlain(15n * 10n ** 17n, 18)).toBe('1.5');
        expect(formatAmountPlain(10n ** 18n, 18)).toBe('1');
    });

    it('round-trips through parseAmount', () => {
        for (const planck of [1n, 10n ** 18n, 12345678901234567891000n, 999n * 10n ** 15n]) {
            expect(parseAmount(formatAmountPlain(planck, 18), 18)).toBe(planck);
        }
    });
});
