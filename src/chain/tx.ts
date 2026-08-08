import type {
    PolkadotSigner as SubstrateSigner,
    TxFinalizedPayload,
    TxOptions,
} from 'polkadot-api';
import type { SubstrateClient } from './substrate/SubstrateClient';
import type { TxResult } from './client/types';

/** Opciones de transacción compatibles con el UnsafeApi de PAPI (sin asset tipado). */
export type UnsafeTxOptions = TxOptions<void, Record<string, unknown>>;

/**
 * `UnsafeTxOptions` plus the one lifecycle hook a wallet UI needs.
 *
 * `onBroadcast` fires when the node's mempool acknowledges the tx — long before
 * finalization. Without it the only observable signal is the finalized block,
 * seconds later, and a UI cannot tell "the tx left the wallet" from "nothing
 * happened yet".
 */
export type SubmitOptions = UnsafeTxOptions & {
    onBroadcast?: () => void;
};

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

export interface UnsafeTx {
    signAndSubmit(signer: SubstrateSigner, options?: UnsafeTxOptions): Promise<TxFinalizedPayload>;
    signSubmitAndWatch(
        signer: SubstrateSigner,
        options?: UnsafeTxOptions
    ): {
        subscribe(observer: {
            next(event: { type: string }): void;
            error(err: unknown): void;
        }): unknown;
    };
    getBareTx(): Promise<Uint8Array>;
}

export function callUnsafeTx(txEntry: unknown, ...args: unknown[]): UnsafeTx {
    return (txEntry as (...a: unknown[]) => UnsafeTx)(...args);
}

/**
 * Signs and submits, resolving on finalization.
 *
 * With `onBroadcast` the tx goes through `signSubmitAndWatch`, whose event
 * stream is the only place the mempool acknowledgement is visible; without it
 * the plain promise path is kept, byte-for-byte the behaviour every existing
 * caller had.
 */
export function signAndSubmitTx(
    tx: UnsafeTx,
    signer: SubstrateSigner,
    options?: SubmitOptions
): Promise<TxResult> {
    const { onBroadcast, ...txOptions } = options ?? {};
    const opts = Object.keys(txOptions).length > 0 ? (txOptions as UnsafeTxOptions) : undefined;

    if (!onBroadcast) {
        return (
            opts !== undefined ? tx.signAndSubmit(signer, opts) : tx.signAndSubmit(signer)
        ).then(toTxResult);
    }

    return new Promise<TxResult>((resolve, reject) => {
        const stream =
            opts !== undefined
                ? tx.signSubmitAndWatch(signer, opts)
                : tx.signSubmitAndWatch(signer);
        stream.subscribe({
            next(event) {
                if (event.type === 'broadcasted') onBroadcast();
                if (event.type === 'finalized')
                    resolve(toTxResult(event as unknown as TxFinalizedPayload));
            },
            error: reject,
        });
    });
}

/**
 * Submits an unsigned (bare) transaction using polkadot-api's getBareTx().
 * Used for gasless private_transfer and unshield where no signer is available.
 */
export async function submitBareTx(
    tx: { getBareTx(): Promise<Uint8Array> },
    client: SubstrateClient,
    onBroadcast?: () => void
): Promise<TxResult> {
    const bareTx = await tx.getBareTx();
    // The unsigned path has no event stream — `submit` resolves only at
    // finalization. Firing before the await is the closest observable moment to
    // "the tx left the wallet", and matches what a signed submit reports.
    onBroadcast?.();
    const payload = await client.submitUnsignedAndWatch(bareTx);
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
