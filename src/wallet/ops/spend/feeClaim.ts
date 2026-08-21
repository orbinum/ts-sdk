/**
 * Claiming accrued relayer fees into a fresh private note.
 *
 * Mints a new note, so the flow is build → prove → submit → persist, with no
 * inputs to spend. The circuit version resolves fail-closed against the chain
 * BEFORE proving: a proof under a stale artifact is rejected anyway.
 *
 * The note is saved on success rather than left to the next scan. A rescan
 * would find it — the ephemeral is deterministic — but until then the claimed
 * fees are missing from the balance, which reads as a claim that did nothing.
 */
import { CircuitType } from '@orbinum/proof-generator';
import { generateFeeClaimProof } from '../../../protocol/proving/fee-claim';
import { fromHex } from '../../../foundation/encoding/hex';
import { stampCreatedTxHash } from '../../vault/index';
import type { TxKind } from '../../vault/index';
import type { VaultStore } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';
import type { CircuitVersionResolver } from '../../../protocol/circuit-version/index';
import type { ShieldedPoolModule } from '../../../chain/pallet/shielded-pool/ShieldedPoolModule';
import type { TxResult } from '../../../chain/client/types';
import type { PolkadotSigner as SubstrateSigner } from 'polkadot-api';

/** Progress steps, in order. A UI maps them to status copy. */
export type FeeClaimStep = 'building-note' | 'generating-proof' | 'submitting-claim';

export interface FeeClaimDeps {
    /**
     * Builds the note the claim mints. Owns key material and the ephemeral-index
     * reservation — which is why it is injected rather than parameterized here.
     */
    buildNote: (params: { value: bigint; assetId: bigint }) => Promise<{ note: ZkNote }>;
    resolver: Pick<CircuitVersionResolver, 'resolve'>;
    pool: Pick<ShieldedPoolModule, 'claimShieldedFees'>;
    /** Where the minted note lands once the claim finalizes. */
    vault: Pick<VaultStore, 'save'>;
    /** Route stamped on the persisted note (explorer link kind). */
    txKind?: TxKind;
}

export interface FeeClaimParams {
    assetId: number;
    /** Pending fee amount to claim, in planck. */
    amount: bigint;
    signer: SubstrateSigner;
}

/**
 * Claims fees into a private note and returns the finalized result.
 * Throws when the chain rejects the claim — there is no partial success to
 * report, since a failed claim leaves no note behind.
 */
export async function claimFees(
    deps: FeeClaimDeps,
    { assetId, amount, signer }: FeeClaimParams,
    onStep?: (step: FeeClaimStep) => void
): Promise<TxResult> {
    onStep?.('building-note');
    const { note } = await deps.buildNote({ value: amount, assetId: BigInt(assetId) });

    const { provider } = await deps.resolver.resolve(CircuitType.ValueProof, note.circuitVersion);

    onStep?.('generating-proof');
    const proofOutput = await generateFeeClaimProof(
        {
            amount: note.value,
            assetId: note.assetId,
            ownerPubkey: note.ownerPk,
            blinding: note.blinding,
            commitment: note.commitment,
        },
        { provider }
    );

    onStep?.('submitting-claim');
    const txResult = await deps.pool.claimShieldedFees(
        {
            commitment: note.commitmentHex,
            amount: note.value,
            assetId,
            proof: fromHex(proofOutput.proof),
            publicSignals: new Uint8Array(proofOutput.publicSignals),
            encryptedMemo: new Uint8Array(note.memo),
            circuitVersion: note.circuitVersion,
        },
        signer
    );

    if (!txResult.ok) {
        throw new Error(txResult.error ?? 'claim_shielded_fees failed');
    }

    // The note is ours and directly spendable — the claim builds it against the
    // wallet's own keys with no stealth derivation, so unlike a transfer's
    // change note it needs no recovery step before storing.
    //
    // Persisted here rather than left to the next scan: a rescan does find it
    // (the ephemeral is deterministic), but until then the claimed fees are
    // missing from the balance, and a user who just claimed sees nothing arrive.
    await deps.vault.save(stampCreatedTxHash(note, txResult.txHash, deps.txKind ?? 'substrate'));

    return txResult;
}
