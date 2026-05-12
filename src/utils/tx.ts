import type { PolkadotSigner, TxFinalizedPayload, TxOptions } from 'polkadot-api';
import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { TxResult } from '../client/types';

/** Opciones de transacción compatibles con el UnsafeApi de PAPI (sin asset tipado). */
export type UnsafeTxOptions = TxOptions<void, Record<string, unknown>>;

/**
 * Formats a `dispatchError` from polkadot-api into a human-readable string.
 *
 * polkadot-api surfaces: `{ type: string; value: unknown }`
 *  - `type === "Module"` → `value` is `{ type: "PalletName.ErrorVariant"; value: unknown }`
 *  - `type === "Other" | "BadOrigin" | ...` → no inner value needed
 */
function formatDispatchError(err: { type: string; value: unknown }): string {
    if (err.type === 'Module') {
        const inner = err.value as { type?: string; value?: unknown } | undefined;
        if (inner?.type) {
            return `Module(${inner.type})`;
        }
    }
    // Fallback: serialize whatever we have for maximum debuggability
    try {
        const detail = JSON.stringify(err.value);
        return detail && detail !== 'null' ? `${err.type}(${detail})` : err.type;
    } catch {
        return err.type;
    }
}

export function toTxResult(payload: TxFinalizedPayload): TxResult {
    const base = {
        txHash: payload.txHash,
        blockHash: payload.block.hash,
        blockNumber: payload.block.number,
        ok: payload.ok,
    };
    if (!payload.ok) {
        return { ...base, error: formatDispatchError(payload.dispatchError) };
    }
    return base;
}

export function callUnsafeTx(
    txEntry: unknown,
    ...args: unknown[]
): {
    signAndSubmit(signer: PolkadotSigner, options?: UnsafeTxOptions): Promise<TxFinalizedPayload>;
    getBareTx(): Promise<string>;
} {
    return (
        txEntry as (...a: unknown[]) => {
            signAndSubmit(s: PolkadotSigner, o?: UnsafeTxOptions): Promise<TxFinalizedPayload>;
            getBareTx(): Promise<string>;
        }
    )(...args);
}

/**
 * Submits an unsigned (bare) transaction using polkadot-api's getBareTx().
 * Used for gasless private_transfer and unshield where no signer is available.
 */
export async function submitBareTx(
    tx: { getBareTx(): Promise<string> },
    client: SubstrateClient
): Promise<TxResult> {
    const bareTxHex = await tx.getBareTx();
    const payload = await client.submitUnsignedAndWatch(bareTxHex);
    return toTxResult(payload);
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
