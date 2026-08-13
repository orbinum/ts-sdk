/**
 * claimFees — build → resolve fail-closed → prove → submit.
 *
 * Two assertions carry weight. The resolver must run BEFORE the prover, because
 * its job is to refuse proving against an artifact the chain no longer accepts —
 * proving first would waste seconds and produce a rejected tx. And the minted
 * note must be PERSISTED on success: it is the only output of the claim, and a
 * claim whose note never reaches the vault reads to the user as one that did
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PolkadotSigner as SubstrateSigner } from 'polkadot-api';

const mocks = vi.hoisted(() => ({ generateFeeClaimProof: vi.fn() }));
vi.mock('../../../../src/protocol/proving/fee-claim', () => ({
    generateFeeClaimProof: mocks.generateFeeClaimProof,
}));

import { claimFees } from '../../../../src/wallet/ops/spend/feeClaim';
import type { FeeClaimDeps } from '../../../../src/wallet/ops/spend/feeClaim';

const NOTE = {
    value: 500n,
    assetId: 0n,
    ownerPk: 1n,
    blinding: 2n,
    commitment: 3n,
    commitmentHex: '0x' + '11'.repeat(32),
    memo: [1, 2, 3],
    circuitVersion: 1,
};

const SIGNER = {} as SubstrateSigner;

function makeDeps() {
    return {
        buildNote: vi.fn().mockResolvedValue(NOTE),
        resolver: {
            resolve: vi.fn().mockResolvedValue({ provider: { tag: 'pinned' }, version: 1 }),
        },
        pool: {
            claimShieldedFees: vi
                .fn()
                .mockResolvedValue({ ok: true, txHash: '0xok', blockHash: '0xb', blockNumber: 1 }),
        },
        vault: { save: vi.fn().mockResolvedValue(undefined) },
    };
}

describe('claimFees', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generateFeeClaimProof.mockResolvedValue({ proof: '0xdead', publicSignals: [7, 8] });
    });

    it('resolves the value-proof version and forwards provider + circuitVersion', async () => {
        const deps = makeDeps();
        const steps: string[] = [];

        const res = await claimFees(
            deps as unknown as FeeClaimDeps,
            { assetId: 0, amount: 500n, signer: SIGNER },
            (s) => steps.push(s)
        );

        expect(res.ok).toBe(true);
        expect(deps.resolver.resolve).toHaveBeenCalledWith('value_proof', 1);
        expect(mocks.generateFeeClaimProof.mock.calls[0]?.[1]).toEqual({
            provider: { tag: 'pinned' },
        });
        expect(deps.pool.claimShieldedFees.mock.calls[0]?.[0]).toMatchObject({ circuitVersion: 1 });
        expect(steps).toEqual(['building-note', 'generating-proof', 'submitting-claim']);
    });

    it('throws when the extrinsic returns !ok', async () => {
        const deps = makeDeps();
        deps.pool.claimShieldedFees.mockResolvedValue({
            ok: false,
            error: 'boom',
            txHash: '',
            blockHash: '0x',
            blockNumber: 0,
        });

        await expect(
            claimFees(deps as unknown as FeeClaimDeps, { assetId: 0, amount: 500n, signer: SIGNER })
        ).rejects.toThrow('boom');
    });

    it('persists the minted note, stamped with the claim tx hash', async () => {
        // The claim's only output. Without this the fees are absent from the
        // balance until the next scan, which reads as a claim that did nothing.
        const deps = makeDeps();

        await claimFees(deps as unknown as FeeClaimDeps, {
            assetId: 0,
            amount: 500n,
            signer: SIGNER,
        });

        expect(deps.vault.save).toHaveBeenCalledOnce();
        expect(deps.vault.save.mock.calls[0]?.[0]).toMatchObject({
            commitmentHex: NOTE.commitmentHex,
            createdTxHash: '0xok',
            txKind: 'substrate',
            // Same ambiguity as unshield change: zero sourcePk, but not a shield.
            origin: 'fee-claim',
        });
    });

    it('honours the caller txKind for the explorer link', async () => {
        const deps = makeDeps();

        await claimFees({ ...deps, txKind: 'evm' } as unknown as FeeClaimDeps, {
            assetId: 0,
            amount: 500n,
            signer: SIGNER,
        });

        expect(deps.vault.save.mock.calls[0]?.[0]).toMatchObject({ txKind: 'evm' });
    });

    it('does not persist when the extrinsic fails', async () => {
        // A rejected claim mints nothing, so storing the note would show the
        // user funds that do not exist on chain.
        const deps = makeDeps();
        deps.pool.claimShieldedFees.mockResolvedValue({
            ok: false,
            error: 'boom',
            txHash: '',
            blockHash: '0x',
            blockNumber: 0,
        });

        await expect(
            claimFees(deps as unknown as FeeClaimDeps, { assetId: 0, amount: 500n, signer: SIGNER })
        ).rejects.toThrow();
        expect(deps.vault.save).not.toHaveBeenCalled();
    });

    it('persists only after the claim is submitted', async () => {
        // Saving before submission would leave a phantom note behind if the
        // submit then threw.
        const deps = makeDeps();
        const order: string[] = [];
        deps.pool.claimShieldedFees.mockImplementation(async () => {
            order.push('submit');
            return { ok: true, txHash: '0xok', blockHash: '0xb', blockNumber: 1 };
        });
        deps.vault.save.mockImplementation(async () => {
            order.push('save');
        });

        await claimFees(deps as unknown as FeeClaimDeps, {
            assetId: 0,
            amount: 500n,
            signer: SIGNER,
        });

        expect(order).toEqual(['submit', 'save']);
    });

    it('propagates a fail-closed resolver throw before any proving', async () => {
        const deps = makeDeps();
        deps.resolver.resolve.mockRejectedValue(new Error('VK hash mismatch'));

        await expect(
            claimFees(deps as unknown as FeeClaimDeps, { assetId: 0, amount: 500n, signer: SIGNER })
        ).rejects.toThrow('VK hash mismatch');
        expect(mocks.generateFeeClaimProof).not.toHaveBeenCalled();
        expect(deps.pool.claimShieldedFees).not.toHaveBeenCalled();
        expect(deps.vault.save).not.toHaveBeenCalled();
    });
});
