/**
 * Extrinsic facts — reads back the two things about an outgoing private
 * transfer that no event reports: the relay fee the sender chose, and whether
 * the call succeeded on chain.
 *
 * Both live only as properties of the submitted extrinsic, which the indexer
 * stores decoded in `argsJson` keyed by the pallet's snake_case parameter
 * names. Reconstruction needs them because `amount = Σ(inputs) − change − fee`
 * is exact only when the real fee is known.
 *
 * Read-only and self-contained: a fact source in, plain facts out. No vault
 * access and no record shape, so reconstruction owns the decision of what to do
 * when a fact is missing.
 */
import type { TxFactsSource } from '../feed/sources';

/** The relay fee and outcome of one outgoing transfer. */
export interface ExtrinsicFacts {
    /** The fee argument the sender chose, or null when it could not be read. */
    fee: bigint | null;
    /** False only when the chain reported the extrinsic as failed. */
    success: boolean;
}

/**
 * What an unreadable extrinsic contributes.
 *
 * `fee: null` is deliberate — the sender picks any value at or above the
 * pallet's `min_relay_fee`, so a missing fee is unknown, NOT the configured
 * minimum. Substituting the minimum understates every transfer that paid more,
 * and persisting that number makes the error permanent and invisible.
 *
 * `success: true` matches how legacy records with no status field are read.
 */
const UNKNOWN: ExtrinsicFacts = { fee: null, success: true };

/**
 * Facts for one extrinsic, by hash.
 *
 * Steps:
 *   1. No hash (an unindexed or pre-hash transfer) → nothing to look up.
 *   2. Fetch the extrinsic; a 404 resolves to null rather than throwing.
 *   3. Parse the fee out of its decoded args and read the on-chain outcome.
 *
 * Never throws: an unreachable indexer yields UNKNOWN so a rescan degrades to
 * an approximate record instead of aborting.
 */
export async function fetchExtrinsicFacts(
    source: TxFactsSource,
    hash: string | null | undefined
): Promise<ExtrinsicFacts> {
    if (!hash) return UNKNOWN;
    try {
        const ext = await source.byHash(hash);
        if (!ext) return UNKNOWN;
        return { fee: parseFeeArg(ext.argsJson), success: ext.success !== false };
    } catch {
        // Not indexed yet, or the indexer is unreachable.
        return UNKNOWN;
    }
}

/**
 * The `fee` argument out of a decoded-args blob, or null when unreadable.
 *
 * Balances are u128: the indexer serializes them as decimal strings, but a
 * small value may survive decoding as a number. Both forms are accepted and
 * anything else is rejected — a half-parsed fee would silently skew the amount.
 */
function parseFeeArg(argsJson: string | null | undefined): bigint | null {
    if (!argsJson) return null;
    try {
        const fee = (JSON.parse(argsJson) as Record<string, unknown>)['fee'];
        if (typeof fee === 'string' && /^\d+$/.test(fee)) return BigInt(fee);
        if (typeof fee === 'number' && Number.isSafeInteger(fee) && fee >= 0) return BigInt(fee);
        return null;
    } catch {
        return null;
    }
}
