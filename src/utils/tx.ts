import type { PolkadotSigner, TxFinalizedPayload } from 'polkadot-api';
import type { TxResult } from '../client/types';

export function toTxResult(payload: TxFinalizedPayload): TxResult {
    const base = {
        txHash: payload.txHash,
        blockHash: payload.block.hash,
        blockNumber: payload.block.number,
        ok: payload.ok,
    };
    if (!payload.ok) {
        return { ...base, error: payload.dispatchError.type };
    }
    return base;
}

export function callUnsafeTx(
    txEntry: unknown,
    ...args: unknown[]
): { signAndSubmit(signer: PolkadotSigner): Promise<TxFinalizedPayload> } {
    return (
        txEntry as (...a: unknown[]) => {
            signAndSubmit(s: PolkadotSigner): Promise<TxFinalizedPayload>;
        }
    )(...args);
}

export function resolveTx(unsafe: unknown, pallet: string, call: string): unknown {
    const u = unsafe as Record<string, Record<string, Record<string, unknown>>>;
    const p = u['tx']?.[pallet] as Record<string, unknown> | undefined;
    if (p === undefined) throw new Error(`Pallet "${pallet}" not found in runtime metadata`);
    const entry = p[call];
    if (entry === undefined)
        throw new Error(`Call "${pallet}.${call}" not found in runtime metadata`);
    return entry;
}
