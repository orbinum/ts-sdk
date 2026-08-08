/**
 * signAndSubmitTx / submitBareTx — the submit paths and their broadcast hook.
 *
 * The property that matters: `onBroadcast` fires at mempool acknowledgement and
 * the RESULT still resolves at finalization. A wallet UI flips to "submitted" on
 * the first and records the block on the second; collapsing them would either
 * freeze the UI until finality or report a block that does not exist yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { signAndSubmitTx, submitBareTx } from '../../src/chain/tx';
import type { UnsafeTx } from '../../src/chain/tx';
import type { PolkadotSigner as SubstrateSigner } from 'polkadot-api';
import type { SubstrateClient } from '../../src/chain/substrate/SubstrateClient';

const SIGNER = {} as SubstrateSigner;

const FINALIZED = {
    type: 'finalized',
    txHash: '0xabc',
    block: { hash: '0xblock', number: 7 },
    ok: true,
};

/** A tx whose watch stream replays `events` in order; signAndSubmit resolves directly. */
function fakeTx(events: Array<Record<string, unknown>> = [{ ...FINALIZED }]) {
    const signAndSubmit = vi.fn().mockResolvedValue(FINALIZED);
    const signSubmitAndWatch = vi.fn().mockReturnValue({
        subscribe(observer: { next(e: unknown): void; error(e: unknown): void }) {
            for (const event of events) observer.next(event);
            return {};
        },
    });
    return {
        tx: { signAndSubmit, signSubmitAndWatch, getBareTx: vi.fn() } as unknown as UnsafeTx,
        signAndSubmit,
        signSubmitAndWatch,
    };
}

describe('signAndSubmitTx', () => {
    it('keeps the plain promise path when no onBroadcast is given', async () => {
        // The watch stream is a behaviour change; callers that never asked for
        // the hook must stay on the code path they always had.
        const { tx, signAndSubmit, signSubmitAndWatch } = fakeTx();

        const result = await signAndSubmitTx(tx, SIGNER);

        expect(result).toMatchObject({ ok: true, txHash: '0xabc', blockNumber: 7 });
        expect(signAndSubmit).toHaveBeenCalledWith(SIGNER);
        expect(signSubmitAndWatch).not.toHaveBeenCalled();
    });

    it('fires onBroadcast at mempool acknowledgement, resolves at finalization', async () => {
        const { tx } = fakeTx([{ type: 'signed' }, { type: 'broadcasted' }, { ...FINALIZED }]);
        const seen: string[] = [];
        const onBroadcast = () => seen.push('broadcast');

        const result = await signAndSubmitTx(tx, SIGNER, { onBroadcast }).then((r) => {
            seen.push('finalized');
            return r;
        });

        expect(seen).toEqual(['broadcast', 'finalized']);
        expect(result.ok).toBe(true);
    });

    it('still resolves when the stream never emits broadcasted', async () => {
        // A node can finalize faster than it reports intermediate states; the
        // result must not depend on the hook having fired.
        const { tx } = fakeTx([{ ...FINALIZED }]);
        const onBroadcast = vi.fn();

        const result = await signAndSubmitTx(tx, SIGNER, { onBroadcast });

        expect(result.ok).toBe(true);
        expect(onBroadcast).not.toHaveBeenCalled();
    });

    it('rejects when the stream errors', async () => {
        const tx = {
            signAndSubmit: vi.fn(),
            getBareTx: vi.fn(),
            signSubmitAndWatch: () => ({
                subscribe(observer: { error(e: unknown): void }) {
                    observer.error(new Error('dropped'));
                    return {};
                },
            }),
        } as unknown as UnsafeTx;

        await expect(signAndSubmitTx(tx, SIGNER, { onBroadcast: () => {} })).rejects.toThrow(
            'dropped'
        );
    });

    it('carries a dispatch error into the result', async () => {
        const failed = {
            type: 'finalized',
            txHash: '0xabc',
            block: { hash: '0xb', number: 1 },
            ok: false,
            dispatchError: { type: 'Module', value: { type: 'ShieldedPool.InvalidProof' } },
        };
        const { tx } = fakeTx([{ type: 'broadcasted' }, failed]);

        const result = await signAndSubmitTx(tx, SIGNER, { onBroadcast: () => {} });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('InvalidProof');
    });

    it('forwards remaining tx options and strips the hook', async () => {
        // PAPI would choke on an unknown `onBroadcast` field in its options.
        const { tx, signSubmitAndWatch } = fakeTx([{ ...FINALIZED }]);

        await signAndSubmitTx(tx, SIGNER, { onBroadcast: () => {}, mortality: { mortal: false } });

        expect(signSubmitAndWatch).toHaveBeenCalledWith(SIGNER, { mortality: { mortal: false } });
    });
});

describe('submitBareTx', () => {
    it('fires onBroadcast before awaiting finalization', async () => {
        // The unsigned path has no event stream, so "before the await" is the
        // closest observable moment to the tx leaving the wallet.
        const seen: string[] = [];
        const client = {
            submitUnsignedAndWatch: async () => {
                seen.push('submitted');
                return FINALIZED;
            },
        } as unknown as SubstrateClient;
        const tx = { getBareTx: async () => new Uint8Array([1]) };

        const result = await submitBareTx(tx, client, () => seen.push('broadcast'));

        expect(seen).toEqual(['broadcast', 'submitted']);
        expect(result.ok).toBe(true);
    });
});
