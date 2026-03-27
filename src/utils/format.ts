// ─── Internal helpers ─────────────────────────────────────────────────────────

const LOCALE_DECIMAL_SEP: string =
    new Intl.NumberFormat(undefined).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ??
    '.';

/**
 * Formats the integer part of a decimal number with thousands separators
 * using the runtime locale.
 */
function formatIntegerLocale(intPart: string): string {
    try {
        return BigInt(intPart || '0').toLocaleString(undefined);
    } catch {
        return (intPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
}

/**
 * Normalises a decimal string to a display-ready string:
 * - trims trailing zeros from decimal part,
 * - adds thousands separators to integer part,
 * - uses the runtime locale decimal separator.
 *
 * Returns null if the input is empty or not a valid decimal.
 */
function normalizeDecimalForDisplay(raw: string, maxFractionDigits: number): string | null {
    let value = raw.trim();
    if (!value) return null;

    let sign = '';
    if (value.startsWith('-')) {
        sign = '-';
        value = value.slice(1);
    }

    if (!/^\d*(\.\d*)?$/.test(value)) return null;

    let [integerPart = '0', fractionPart = ''] = value.split('.');
    integerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';

    const limit = Math.max(0, maxFractionDigits);
    fractionPart = fractionPart.slice(0, limit).replace(/0+$/, '');

    const formattedInt = formatIntegerLocale(integerPart);
    return fractionPart
        ? `${sign}${formattedInt}${LOCALE_DECIMAL_SEP}${fractionPart}`
        : `${sign}${formattedInt}`;
}

/**
 * Pure-BigInt equivalent of ethers `formatUnits(value, decimals)`.
 * Converts a raw token amount (in smallest unit) to a decimal string.
 */
function bigintFormatUnits(value: bigint, decimals: number): string {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const divider = 10n ** BigInt(decimals);
    const intPart = abs / divider;
    const fracPart = abs % divider;
    const fracStr = fracPart.toString().padStart(decimals, '0');
    return (negative ? '-' : '') + intPart.toString() + '.' + fracStr;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Options for {@link formatBalance}.
 */
export interface FormatOptions {
    /** On-chain token decimals. Defaults to `18`. */
    decimals?: number;
    /** Token symbol appended to the output. Defaults to `'ORB'`. */
    symbol?: string;
    /** Whether to append the symbol. Defaults to `true`. */
    showSymbol?: boolean;
    /** Maximum number of decimal digits shown in output. Defaults to `6`. */
    precision?: number;
}

/**
 * Formats a raw on-chain token amount to a human-readable string.
 *
 * Handles the following input forms:
 * - `bigint` — raw planck/wei amount.
 * - `string` — decimal integer, hex (`0x`-prefixed), or already-formatted decimal.
 * - `number` — interpreted as a plain integer.
 * - `null` / `undefined` — treated as zero.
 *
 * Does NOT depend on `ethers`. Uses pure BigInt arithmetic.
 *
 * @example
 * formatBalance('1000000000000000000') // '1 ORB'
 * formatBalance(500000000000000000n, { precision: 2 }) // '0.50 ORB'
 * formatBalance('0x0de0b6b3a7640000', { showSymbol: false }) // '1'
 * formatBalance(null) // '0 ORB'
 */
export function formatBalance(
    raw: string | bigint | number | null | undefined,
    options: FormatOptions | number = {}
): string {
    const opts = typeof options === 'number' ? { decimals: options } : options;
    const { decimals = 18, symbol = 'ORB', showSymbol = true, precision = 6 } = opts;

    const zero = showSymbol ? `0 ${symbol}` : '0';

    if (raw === null || raw === undefined) return zero;

    const rawStr = String(raw).trim().replace(/,/g, '');
    if (!rawStr || rawStr === '0' || rawStr === '0x0') return zero;

    // Already a decimal string (e.g. already formatted by ethers/viem upstream)
    if (rawStr.includes('.') && !rawStr.startsWith('0x')) {
        const formatted = normalizeDecimalForDisplay(rawStr, precision);
        if (!formatted || formatted === '0' || formatted === '-0') return zero;
        return showSymbol ? `${formatted} ${symbol}` : formatted;
    }

    try {
        const n = BigInt(rawStr);
        const decimalStr = bigintFormatUnits(n, decimals);
        const formatted = normalizeDecimalForDisplay(decimalStr, precision);
        if (!formatted || formatted === '0' || formatted === '-0') return zero;
        return showSymbol ? `${formatted} ${symbol}` : formatted;
    } catch (e) {
        console.warn('[formatBalance] Failed to parse:', raw, e);
        return zero;
    }
}

/**
 * Convenience wrapper for formatting ORB amounts with 18 decimals.
 *
 * @param raw       Raw planck amount (string, bigint, number, or null).
 * @param precision Max decimal digits shown. Defaults to `6`.
 *
 * @example
 * formatORB('1000000000000000000') // '1 ORB'
 * formatORB(500000000000000000n, 2) // '0.50 ORB'
 */
export function formatORB(raw: string | bigint | number | null | undefined, precision = 6): string {
    return formatBalance(raw, { decimals: 18, symbol: 'ORB', showSymbol: true, precision });
}
