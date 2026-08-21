/**
 * Recovery after a connection died mid-submit.
 *
 * A WebSocket drop between submit and finalization surfaces as an error for a
 * tx that may have landed anyway. Reporting that as "failed" is the dangerous
 * outcome: the user retries, and the retry double-spends (shield) or dies on a
 * duplicate nullifier (transfer/unshield).
 *
 * So "the chain rejected it" and "we lost the line" are told apart, and only
 * the second is polled — against an on-chain predicate the caller supplies: a
 * nullifier turned spent, a commitment now in the tree.
 */
import type { TxResult } from '../../../chain/client/types';

/**
 * Errors where the submit outcome is UNKNOWN — the connection died mid-flight
 * and the tx may still finalize. Anything else is a real rejection.
 */
const CONNECTION_LOSS_RE = /destroyed|disconnect|unreachable|websocket|closed|timeout/i;

/** Whether an error leaves the submit outcome unknown rather than rejected. */
export function isConnectionLossError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return CONNECTION_LOSS_RE.test(msg);
}

export interface TxLandingPollOptions {
    /** Poll rounds before giving up. Default 6. */
    attempts?: number;
    /** Delay between rounds (ms). Default 5000 — ~30 s across a reconnect. */
    intervalMs?: number;
    /** Injectable for tests; defaults to setTimeout. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * After a connection-loss error, polls `landed()` to learn whether the tx made
 * it on-chain anyway. Returns true only when confirmed; a real rejection or a
 * tx that never appears returns false.
 *
 * A throwing `landed()` keeps polling rather than failing — the client is
 * usually still reconnecting, which is the very situation being recovered from.
 */
export async function txLandedAfterError(
    err: unknown,
    landed: () => Promise<boolean>,
    options: TxLandingPollOptions = {}
): Promise<boolean> {
    if (!isConnectionLossError(err)) return false;
    const attempts = options.attempts ?? 6;
    const intervalMs = options.intervalMs ?? 5_000;
    const sleep = options.sleep ?? defaultSleep;

    for (let i = 0; i < attempts; i++) {
        await sleep(intervalMs);
        try {
            if (await landed()) return true;
        } catch {
            // Still reconnecting — keep polling.
        }
    }
    return false;
}

/**
 * The result for a tx confirmed on-chain after the watching connection died.
 * Block details were lost with the connection — empty on purpose, and a caller
 * that needs them must look the tx up rather than trust these fields.
 */
export const RECOVERED_TX_RESULT: TxResult = {
    txHash: '',
    blockHash: '',
    blockNumber: 0,
    ok: true,
};
