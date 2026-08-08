/**
 * The four phases of a scan, in the order `pipeline.ts` runs them:
 *
 *   1. collect      — walk the hint feed, trial-decrypt every memo
 *   2. spentStatus  — resolve spent status by local intersection (spentSet.ts)
 *   3. persist      — one batched write, then the ghost purge on a full scan
 *   4. persistCursor— record the leaf the next incremental pass resumes from
 *
 * Each phase is independently callable and independently testable; the pipeline
 * owns their order and nothing else.
 */
export { collectScanEntries, PAGE_SIZE } from './collect';
export type { ScanOutcome, CollectScanEntriesParams } from './collect';
export { collectNullifiersToQuery, resolveSpentStatus } from './spentStatus';
export { resolveSpentSet } from './spentSet';
export type { ResolveSpentSetParams } from './spentSet';
export { persistScanResults, persistCursor, selectGhosts } from './persist';
export type { PersistParams } from './persist';
