/**
 * VK hash comparison — the last gate before a proof is generated.
 *
 * The prover's artifacts and the chain's verifying key must be the same key.
 * The comparison has to be lenient about formatting (both sides travel as hex
 * through a CDN manifest and an RPC response, either may carry `0x`, either
 * case) and strict about everything else, because the malformed case fails
 * OPEN under a naive check: `'' === ''` is true, so two responses that carried
 * no hash at all would pass and let a proof be built against artifacts nobody
 * verified.
 *
 * Previously exercised only through the resolver, which meant the formatting
 * rules were asserted once and the malformed ones barely at all.
 */
import { describe, it, expect } from 'vitest';
import { vkHashEquals, normalizeVkHash } from '../../../src/protocol/circuit-version/vkHash';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('normalizeVkHash', () => {
    it('strips 0x and lowercases', () => {
        expect(normalizeVkHash(`0x${HASH.toUpperCase()}`)).toBe(HASH);
        expect(normalizeVkHash(HASH)).toBe(HASH);
    });

    it('returns null for anything that is not a 32-byte hex hash', () => {
        expect(normalizeVkHash('')).toBeNull();
        expect(normalizeVkHash('0x')).toBeNull();
        expect(normalizeVkHash('a'.repeat(63))).toBeNull();
        expect(normalizeVkHash('a'.repeat(65))).toBeNull();
        expect(normalizeVkHash(`0x${'z'.repeat(64)}`)).toBeNull();
    });

    it('returns null for a non-string, which an RPC response can carry', () => {
        expect(normalizeVkHash(undefined as unknown as string)).toBeNull();
        expect(normalizeVkHash(null as unknown as string)).toBeNull();
    });
});

describe('vkHashEquals — formatting must not cause a false mismatch', () => {
    it('ignores the 0x prefix on either side', () => {
        expect(vkHashEquals(`0x${HASH}`, HASH)).toBe(true);
        expect(vkHashEquals(HASH, `0x${HASH}`)).toBe(true);
    });

    it('ignores case on either side', () => {
        expect(vkHashEquals(HASH.toUpperCase(), HASH)).toBe(true);
        expect(vkHashEquals(`0X${HASH.toUpperCase()}`, `0x${HASH}`)).toBe(true);
    });

    it('still separates two genuinely different keys', () => {
        expect(vkHashEquals(HASH, OTHER)).toBe(false);
        expect(vkHashEquals(`0x${HASH}`, `0x${OTHER}`)).toBe(false);
    });
});

describe('vkHashEquals — SECURITY: malformed input is never equal', () => {
    it('rejects two identical empty strings', () => {
        // The fail-open this guard exists for: a response that carried no hash
        // on both sides would otherwise satisfy the gate.
        expect(vkHashEquals('', '')).toBe(false);
    });

    it.each([
        ['both bare prefixes', '0x', '0x'],
        ['both truncated', 'a'.repeat(63), 'a'.repeat(63)],
        ['both non-hex', 'z'.repeat(64), 'z'.repeat(64)],
        ['both overlong', 'a'.repeat(65), 'a'.repeat(65)],
    ])('rejects %s even though they are identical', (_label, a, b) => {
        expect(vkHashEquals(a, b)).toBe(false);
    });

    it('rejects when only one side is malformed', () => {
        expect(vkHashEquals(HASH, '')).toBe(false);
        expect(vkHashEquals('', HASH)).toBe(false);
    });

    it('rejects a non-string against a valid hash', () => {
        expect(vkHashEquals(undefined as unknown as string, HASH)).toBe(false);
        expect(vkHashEquals(HASH, null as unknown as string)).toBe(false);
    });

    it('rejects a hash padded with whitespace rather than trimming it', () => {
        // Trimming would be a guess about which stray bytes are insignificant.
        expect(vkHashEquals(` ${HASH}`, HASH)).toBe(false);
    });
});
