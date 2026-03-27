import { describe, it, expect } from 'vitest';
import { formatBalance, formatORB } from '../../src/utils/format';

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
