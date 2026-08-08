/**
 * Comparing the verification-key hash the prover declares against the one the
 * chain will verify with.
 *
 * The comparison is the gate, so it is written to fail closed. Both sides
 * travel as hex strings through a CDN manifest and an RPC response, and either
 * can arrive `0x`-prefixed or not, upper or lower case — a plain `===` would
 * reject a matching pair over formatting alone, and the caller would read that
 * as "the CDN and chain disagree" on a spend that is perfectly valid.
 *
 * The malformed case is the dangerous one and is handled deliberately: an empty
 * or truncated value compares equal to itself under `===`, so a response that
 * carried no hash on BOTH sides would pass a naive check and let a proof be
 * generated against artifacts nobody verified.
 */

/** Length of a VK hash in hex characters — 32 bytes. */
const VK_HASH_HEX_LENGTH = 64;

const HEX_32_BYTES = new RegExp(`^[0-9a-f]{${VK_HASH_HEX_LENGTH}}$`);

/**
 * Lowercases and strips `0x`, or null when the value is not a 32-byte hex hash.
 *
 * Null is the "cannot be compared" signal rather than a thrown error: the
 * caller reports the mismatch with both raw values, which is more useful than
 * an exception from inside a normaliser.
 */
export function normalizeVkHash(hash: string): string | null {
    if (typeof hash !== 'string') return null;
    const lower = hash.toLowerCase();
    const body = lower.startsWith('0x') ? lower.slice(2) : lower;
    return HEX_32_BYTES.test(body) ? body : null;
}

/**
 * Whether two VK hashes are the same key, ignoring case and `0x`.
 *
 * A malformed or empty value on either side is NEVER equal, even to an
 * identical malformed value.
 */
export function vkHashEquals(a: string, b: string): boolean {
    const left = normalizeVkHash(a);
    const right = normalizeVkHash(b);
    if (left === null || right === null) return false;
    return left === right;
}
