/**
 * `@orbinum/sdk` — the public API.
 *
 * The package is four layers, and this file re-exports them in that order.
 * Where a symbol sits tells you what it needs:
 *
 * ```
 * foundation/  encoding, crypto, formatting     no dependencies of its own
 * protocol/    what a note IS                   pure and offline, no chain
 * chain/       talking to a node                needs a connection
 * wallet/      using notes                      needs both
 * ```
 *
 * Two capabilities are NOT here, because each needs something a platform
 * supplies rather than the SDK:
 *
 *   - `@orbinum/sdk/worker`             the decryption kernel, for a Web Worker
 *   - `@orbinum/sdk/storage/indexeddb`  browser storage adapters
 *
 * Everything below is environment-agnostic — a browser tab, an extension
 * service worker, React Native, Node and Cloudflare Workers all run it. The
 * README lists the two globals a mobile runtime has to polyfill first.
 */

// ─── FOUNDATION ──────────────────────────────────────────────────────────────
// Encoding, crypto primitives and formatting. Nothing here depends on a layer
// above it, which is what makes this the safe place for anything shared.

export * from './foundation/index';

// ─── PROTOCOL ────────────────────────────────────────────────────────────────
// What a note is: how one is built, sealed, found and selected for a spend.
// Pure and offline — a wallet does all of this with no node in reach.

export * from './protocol/index';

// Key derivation. The spending key comes from a wallet signature and is bound
// to (chainId, account); see SPENDING_KEY_WARNING before deriving one.
export * from './protocol/keys/index';

// Proving. `ProofOptions.singleThread` is the one worth reading about — a
// phone that spawns a worker per core runs out of memory before it proves.
export * from './protocol/proving/index';

// Pinning a proof to the circuit version its note was created under.
// Fail-closed: a rotated verifying key must not orphan older notes.
export * from './protocol/circuit-version/index';

// ─── CHAIN ───────────────────────────────────────────────────────────────────
// Everything that needs a connection: the clients, the custom RPC endpoints,
// and the pallets that carry notes on chain.

export * from './chain/client/index';
export * from './chain/substrate/index';
export * from './chain/rpc/index';
export * from './chain/pallet/shielded-pool/index';
export * from './chain/pallet/zk-verifier/index';
export * from './chain/pallet/relayer/index';
export { toTxResult, signAndSubmitTx } from './chain/tx';
export type { UnsafeTxOptions } from './chain/tx';

// The EVM side is named rather than splatted: its `precompiles/` barrel also
// carries the ABI encoder/decoder it uses internally, and a consumer has no
// reason to reach for `decodeUint` or a raw selector constant.
export { EvmClient, EvmExplorer } from './chain/evm/index';
export type {
    EvmBlock,
    EvmTransaction,
    EvmAddressInfo,
    EvmTxSummary,
    EvmLog,
    EvmSigner,
    EvmTxRequest,
    TokenInfo,
    TokenTransfer,
} from './chain/evm/index';
export {
    ShieldedPoolPrecompile,
    CryptoPrecompiles,
    PRECOMPILE_ADDR,
    KNOWN_PRECOMPILES,
    getPrecompileLabel,
    decodePrecompileCalldata,
} from './chain/evm/precompiles/index';
export type {
    KnownPrecompileInfo,
    DecodedPrecompile,
    PrecompileMethod,
} from './chain/evm/precompiles/index';

// ─── WALLET ──────────────────────────────────────────────────────────────────
// Using notes: storing them encrypted, finding one's own, and spending them.

// Vault — encrypted note storage, layered crypto → session → storage → notes →
// store. See `wallet/vault/index.ts` for what each layer may depend on.
export * from './wallet/vault/index';

// Scanning. `NullifierSource` has no per-nullifier lookup, deliberately: the
// wallet downloads the spent set and intersects locally, so every request the
// server sees is identical regardless of which notes the caller holds.
export * from './wallet/scanner/index';

// Spending — plans, guards and the three operations. Each takes a `submit`
// callback: the SDK owns protocol, the host owns transport.
export * from './wallet/ops/index';

// Identity persistence — caching a derived identity so a wallet does not
// re-sign on every launch, and naming the vault it belongs to.
export * from './wallet/identity/index';

export * from './wallet/provenance/index';

// The decryption pool's contract. The kernel itself lives in the `/worker`
// subpath, because the Worker is one only a host's bundler can resolve.
export * from './wallet/worker/index';

// The assembled wallet. Use the pieces above directly when a host needs a
// different shape — this is the shortest path, not the only one.
export * from './wallet/index';
