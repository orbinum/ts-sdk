/**
 * Rendering on-chain amounts for people.
 *
 * Chain amounts are integers in the smallest unit — 18 decimals for ORB — and
 * every one of these keeps them that way internally: BigInt arithmetic only, no
 * float ever touches a balance. A `number` intermediate would silently lose
 * precision past 2^53, which for 18 decimals starts at about 0.009 ORB.
 *
 * Malformed input yields ZERO rather than a guess. Grouped digits, scientific
 * notation and a leading `+` are all rejected: coercing them would render an
 * amount that is not the one on chain, and a balance nobody can explain is
 * worse than a visible zero.
 */
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

function isCanonicalDecimal(value: string): boolean {
    return /^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value);
}

function isBigIntLikeInteger(value: string): boolean {
    return /^-?\d+$/.test(value) || /^0[xX][0-9a-fA-F]+$/.test(value);
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
    /** MAXIMUM decimal digits shown. Trailing zeros are trimmed, never padded. */
    precision?: number;
}

/**
 * Formats a raw on-chain token amount to a human-readable string.
 *
 * Handles the following input forms:
 * - `bigint` — raw planck/wei amount.
 * - `string` — canonical decimal integer, canonical hex (`0x`/`0X`-prefixed), or canonical decimal.
 * - `number` — converted via `String(number)` and accepted only if it matches one of the
 *   supported canonical numeric formats.
 * - `null` / `undefined` — treated as zero.
 *
 * Rejected string formats return zero instead of being coerced. This includes grouped values
 * such as `1,000`, scientific notation such as `1e18`, underscored numbers, and explicit plus
 * signs such as `+1`.
 *
 * Does NOT depend on `ethers`. Uses pure BigInt arithmetic.
 *
 * @example
 * formatBalance('1000000000000000000') // '1 ORB'
 * formatBalance(500000000000000000n, { precision: 2 }) // '0.5 ORB'  (max, not pad)
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

    if (typeof raw === 'number' && !Number.isFinite(raw)) return zero;

    const rawStr = String(raw).trim();
    if (!rawStr) return zero;

    // Already a decimal string (e.g. already formatted by ethers/viem upstream)
    if (isCanonicalDecimal(rawStr)) {
        const formatted = normalizeDecimalForDisplay(rawStr, precision);
        if (!formatted || formatted === '0' || formatted === '-0') return zero;
        return showSymbol ? `${formatted} ${symbol}` : formatted;
    }

    if (!isBigIntLikeInteger(rawStr)) return zero;

    try {
        const n = BigInt(rawStr);
        const decimalStr = bigintFormatUnits(n, decimals);
        const formatted = normalizeDecimalForDisplay(decimalStr, precision);
        if (!formatted || formatted === '0' || formatted === '-0') return zero;
        return showSymbol ? `${formatted} ${symbol}` : formatted;
    } catch {
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

// ─── Display → planck ────────────────────────────────────────────────────────

/**
 * Parses a human decimal amount into planck. Returns null when it is not a
 * usable positive amount.
 *
 * The inverse of `formatAmountPlain`, and the gate every wallet needs before an
 * amount reaches a spend: a UI collects a string, the chain takes a bigint, and
 * the conversion between them decides how much money moves.
 *
 * Excess fractional digits are TRUNCATED, never rounded. Rounding up would
 * build a spend for more than the user typed, and past the asset's precision
 * the extra digits do not exist on-chain in the first place.
 *
 * Validation is by shape rather than by `Number()`: an amount beyond 2^53
 * planck — around 9 ORB at 18 decimals — loses precision as a float, so
 * checking it that way would reject or mis-read ordinary balances.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;

    const [intStr = '0', fracStr = ''] = trimmed.split('.');
    const frac = fracStr.slice(0, decimals).padEnd(decimals, '0');

    try {
        const planck = BigInt(intStr || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
        return planck > 0n ? planck : null;
    } catch {
        return null;
    }
}

/**
 * Planck → plain decimal string, with no thousands separators.
 *
 * Distinct from `formatBalance`, which groups digits ("1,199") for reading.
 * This one is meant to round-trip: its output feeds back through `parseAmount`
 * and into a numeric input, both of which reject a grouped value.
 */
export function formatAmountPlain(raw: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const int = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${int}.${frac}` : int.toString();
}
