/**
 * Note discovery: walking a commitment feed, recovering the notes a wallet owns,
 * and resolving which of them are spent.
 *
 * ```
 * pipeline.ts   runScan — wires the phases in order, owns no phase logic
 * phases/       collect → spentStatus → persist → persistCursor
 * feed/         the source contracts every phase reads through
 * history/      outgoing-record reconstruction (NOT part of the pipeline)
 * abort.ts      the one abort shape every phase throws
 * selfEphGap.ts the gap-limit sweep that keeps the eph counter honest
 * ```
 *
 * Everything environment-specific is injected — the feed sources, the decrypt
 * pool, the vault — so the same scan runs in a browser tab, in Node, or in a
 * worker. See `feed/sources.ts` for the contracts a host implements, and note
 * that `NullifierSource` offers no per-nullifier lookup by design.
 */
export { runScan } from './pipeline';
export type { RunScanParams, WalletScanKeys } from './pipeline';
export type { ScanProgress, ScanResult } from './types';
export { scanAbortError, isAbortError } from '../../foundation/errors/abort';
export { resolveSelfEphCeiling, windowSizeForCounter, gapMargin } from './selfEphGap';
export * from './feed/index';
export * from './phases/index';
export * from './history/index';
