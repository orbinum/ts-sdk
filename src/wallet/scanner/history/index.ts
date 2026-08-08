/**
 * Outgoing-history reconstruction.
 *
 * NOT part of the scan pipeline — `runScan` never calls any of this. A scan
 * recovers notes; this recovers the record of what the wallet SENT, which the
 * chain does not publish and which only existed locally at submission time.
 *
 * Separate for a privacy reason as well as a structural one: reconstruction
 * queries the feed with the wallet's own identifiers (see `TransferFactsSource`),
 * which the scan deliberately never does. A host can run scans without ever
 * touching this.
 */
export { reconstructOutgoingTxRecords } from './reconstruct';
export type { ReconstructDeps, ReconstructedTxRecord } from './reconstruct';
export { fetchExtrinsicFacts } from './extrinsicFacts';
export type { ExtrinsicFacts } from './extrinsicFacts';
