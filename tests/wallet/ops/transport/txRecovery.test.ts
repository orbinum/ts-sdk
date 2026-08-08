/**
 * txLandedAfterError — the tests this logic never had.
 *
 * It shipped untestable: fixed 6×5s constants meant any test took 30 real
 * seconds. The failure it prevents is severe — a WS drop mid-submit reported as
 * "failed" invites a retry, and the retry double-spends — so pinning the
 * behaviour matters more than most.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    txLandedAfterError,
    isConnectionLossError,
    RECOVERED_TX_RESULT,
} from '../../../../src/wallet/ops/transport/txRecovery';

const instant = { intervalMs: 0, sleep: async () => {} };

describe('isConnectionLossError', () => {
    it.each([
        'WebSocket connection closed',
        'client destroyed',
        'node unreachable',
        'request timeout',
        'peer disconnected',
    ])('treats "%s" as unknown-outcome', (msg) => {
        expect(isConnectionLossError(new Error(msg))).toBe(true);
    });

    it.each(['message: Some("InvalidProof")', 'insufficient balance', 'bad signature'])(
        'treats "%s" as a real rejection',
        (msg) => {
            // Polling after a genuine rejection would delay the error the user
            // needs to see — and could "confirm" an unrelated earlier tx.
            expect(isConnectionLossError(new Error(msg))).toBe(false);
        }
    );
});

describe('txLandedAfterError', () => {
    it('returns false immediately for a real rejection, without polling', async () => {
        const landed = vi.fn();

        expect(await txLandedAfterError(new Error('InvalidProof'), landed, instant)).toBe(false);
        expect(landed).not.toHaveBeenCalled();
    });

    it('confirms when the predicate turns true on a later attempt', async () => {
        const landed = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        expect(await txLandedAfterError(new Error('ws closed'), landed, instant)).toBe(true);
        expect(landed).toHaveBeenCalledTimes(3);
    });

    it('keeps polling through a throwing predicate', async () => {
        // The predicate throws while the client reconnects — the very situation
        // being recovered from. Giving up there defeats the whole mechanism.
        const landed = vi
            .fn()
            .mockRejectedValueOnce(new Error('still reconnecting'))
            .mockResolvedValueOnce(true);

        expect(await txLandedAfterError(new Error('ws closed'), landed, instant)).toBe(true);
    });

    it('gives up after the configured attempts', async () => {
        const landed = vi.fn().mockResolvedValue(false);

        const result = await txLandedAfterError(new Error('timeout'), landed, {
            ...instant,
            attempts: 3,
        });

        expect(result).toBe(false);
        expect(landed).toHaveBeenCalledTimes(3);
    });

    it('waits the interval between attempts', async () => {
        const sleeps: number[] = [];
        const landed = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await txLandedAfterError(new Error('ws closed'), landed, {
            attempts: 6,
            intervalMs: 5_000,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });

        // One sleep BEFORE each probe — the tx needs time to land before the
        // first look, or the poll burns an attempt on a guaranteed miss.
        expect(sleeps).toEqual([5_000, 5_000]);
    });
});

describe('RECOVERED_TX_RESULT', () => {
    it('reports success with deliberately empty block details', () => {
        // The connection that knew the block died with the block info; a caller
        // needing it must look the tx up, not trust these fields.
        expect(RECOVERED_TX_RESULT).toEqual({
            txHash: '',
            blockHash: '',
            blockNumber: 0,
            ok: true,
        });
    });
});
