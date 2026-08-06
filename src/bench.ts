/**
 * `@orbinum/sdk/bench` — deterministic fixtures for scale benchmarks.
 *
 * Kept out of the main entrypoint on purpose: these are test fixtures, not
 * wallet API, and bundling them cost every integrator ~13 KB of generator code
 * for something no application calls. They live behind their own subpath so
 * the wallet bench and the indexer seeder — different repos — can build
 * byte-identical datasets from one seed without that weight landing in a
 * browser bundle.
 *
 * No stability guarantee: the shape of a generated hint may change whenever a
 * benchmark needs it to.
 */
export {
    SeededBytes,
    benchWallet,
    generateForeignHint,
    generateSelfHint,
    generateForeignToMeHint,
    plantSchedule,
    generateHintAt,
    buildManifest,
    resetHintCache,
} from './shielded-pool/protocol/benchGen';
export type {
    BenchHint,
    PlantedHint,
    BenchManifest,
    BenchWallet,
    PlantKind,
} from './shielded-pool/protocol/benchGen';
