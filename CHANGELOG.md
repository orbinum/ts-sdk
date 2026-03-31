# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-31

### Added

- **`OrbinumClientProvider`**: reactive connection manager with WebSocket reconnection, connection status tracking (`ConnectionStatus`), and typed event listeners (`StatusChangeEvent`, `StatusListener`).
- **`EvmExplorer`**: full EVM block and transaction explorer client — wraps `eth_getBlockByNumber`, `eth_getTransactionByHash`, `eth_getLogs`, and related calls. Exposes typed responses: `EvmBlock`, `EvmTransaction`, `EvmAddressInfo`, `EvmTxSummary`, `EvmLog`, `TokenInfo`, `TokenTransfer`.
- **`ZkVerifierModule`**: typed module for querying the on-chain ZK verifier — circuit version info, VK hashes, version stats, and historical versions. Types: `ZkVerifierCircuitVersionInfo`, `ZkVerifierVkHash`, `ZkVerifierVersionStats`, `ZkVerifierHistoricalVersion`.
- **`SubstrateClient`** — heavily expanded:
  - `blocks$`: observable stream of new blocks from the underlying PAPI client.
  - `getBlockHeader(at?)`: raw block header retrieval.
  - `getBlockHash(blockNumber)`: `chain_getBlockHash` with zero-hash null-guard.
  - `getBlock(blockHash)`: full block info including timestamp and author decoded from digest logs.
  - `queryBlockEvents(blockHash)`: decodes `System.Events` storage at a given block into typed `EventRecord[]`.
  - `_toEventRecords` / `_buildDataProxy`: internal static helpers for converting raw SCALE-decoded events to the `EventRecord` shape used by consumers.
  - `DynamicBuilder` and `ExtrinsicDecoder` type re-exports for advanced usage.
  - New public types: `EventRecord`, `EventPhase`, `EventData`, `RawBlockHeader`, `RawBlock`, `BlockInfo`.
- **`extrinsic/`** module: `mapExtrinsicArgs` and `mapZkEventData` helpers for decoding raw pallet call data and events from the indexer or block scanner. Exports a comprehensive set of decoded arg and event shapes (`DecodedShieldArgs`, `DecodedUnshieldArgs`, `DecodedEthereumTransactArgs`, `ShieldedEventData`, `TransferEventData`, etc.).
- **`IndexerClient`** — fully revised with paginated REST endpoints. New types: `IndexerClientConfig`, `PaginatedResult<T>`, `IndexedBlock`, `IndexedExtrinsic`, `IndexedEvmTx`, `IndexerStats`, `ShieldedAddressEvent`, `ShieldedCommitment`, `SpentNullifier`, `PrivateTransfer`, `Unshield`, `MerkleRoot`, `NullifierStatusResult`.
- **`AccountMappingModule`** — refactored API with additional high-level helpers. New types: `ChainLink`, `PrivateLink`, `AccountMetadata`, `AliasInfo`, `AliasFullIdentity`, `ListingInfo`, `AccountListing`, `SupportedChain`.
- **`precompiles/decode`**: `decodePrecompileCalldata` helper and `DecodedPrecompile` type for parsing raw EVM calldata against known precompile ABIs.
- **`precompiles/helpers`**: additional ABI and address utilities for precompile interactions.
- **Substrate SCALE primitives** re-exported from the SDK barrel: `Blake2256`, `AccountId`, `u128`, `u64`, `Storage`, `Keccak256` (from `@polkadot-api/substrate-bindings`). Consumers no longer need to install `@polkadot-api/substrate-bindings` directly.
- **`base58`** re-exported from `@scure/base` — consumers no longer need to install `@scure/base` directly.
- **`getSs58AddressInfo`** re-exported from `polkadot-api`.
- **`ScanCommitment`** type is now exported from `NoteDecryptor` and re-exported from the SDK barrel.
- `@scure/base` added as a direct SDK dependency.

### Removed

- **`ChainModule`** (`src/chain/`) — all functionality absorbed into the expanded `SubstrateClient`.
- **`MerkleModule`** (`src/shielded-pool/MerkleModule.ts`) — Merkle tree queries are now accessed through `rpc-v2` (`PrivacyModule.getMerkleProof`) or the indexer.
- **`src/types.ts`** (legacy flat type file) — types relocated to feature-level `types/` directories.
- **`src/types/pallet-events/`** (top-level directory) — event types are now owned by each pallet module (`shielded-pool/types/pallet-events.ts`, etc.).
- **`src/types/pallet-extrinsics/`** (top-level directory) — extrinsic types are now owned by each pallet module.

### Changed

- **`src/client.ts`** renamed and relocated to **`src/client/OrbinumClient.ts`** with a revised module boundary. A new `src/client/types.ts` holds `OrbinumClientConfig` and `TxResult`.
- **`AccountMappingModule`** moved its type definitions to `src/account-mapping/types/` (including `raw.ts`, `pallet-events.ts`, `pallet-extrinsics.ts`).
- **`IndexerClient`** API fully revised — endpoint signatures, pagination model, and return types have changed from v0.3.

## [0.3.0] - 2026-03-26

### Added

- **`formatBalance(raw, options?)`**: pure-BigInt formatter that converts raw on-chain token amounts (planck/wei) to human-readable strings. Accepts `bigint`, decimal string, hex `0x`-string, `number`, `null`, or `undefined`. Options: `decimals` (default 18), `symbol` (default `'ORB'`), `showSymbol` (default `true`), `precision` (default 6). Zero deps — no ethers/viem.
- **`formatORB(raw, precision?)`**: convenience wrapper for `formatBalance` with 18 decimals and `'ORB'` symbol.
- **`FormatOptions`**: exported interface for `formatBalance` options.
- **`types/pallet-extrinsics/`**: per-pallet extrinsic argument types, replacing the previous flat `pallet-args.ts` and `pallet-extrinsics.ts`. Organised as a directory with one file per pallet:
  - `shielded-pool.ts` — 15 extrinsic call arg types (`ShieldArgs`, `ShieldBatchArgs`, `PrivateTransferArgs`, `UnshieldArgs`, `SetAuditPolicyArgs`, `RequestDisclosureArgs`, `DiscloseArgs`, `RejectDisclosureArgs`, `BatchSubmitDisclosureProofsArgs`, `RegisterAssetArgs`, `VerifyAssetArgs`, `UnverifyAssetArgs`, `PruneExpiredRequestArgs`, `RevokeDisclosureRecordArgs`) plus supporting types (`Bytes32`, `DisclosurePublicSignals`, `Auditor`, `DisclosureCondition`, `BatchDisclosureSubmission`, `ShieldOperation`) and discriminated union `ShieldedPoolCall`.
  - `zk-verifier.ts` — `CircuitId` const object + type, `VkEntry`, 5 extrinsic arg types (`RegisterVerificationKeyArgs`, `SetActiveVersionArgs`, `RemoveVerificationKeyArgs`, `VerifyProofArgs`, `BatchRegisterVerificationKeysArgs`) and discriminated union `ZkVerifierCall`.
  - `account-mapping.ts` — `SignatureScheme` type, 14 extrinsic arg types (`RegisterAliasArgs`, `TransferAliasArgs`, `PutAliasOnSaleArgs`, `BuyAliasArgs`, `AddChainLinkArgs`, `RemoveChainLinkArgs`, `SetAccountMetadataArgs`, `AddSupportedChainArgs`, `RemoveSupportedChainArgs`, `DispatchAsLinkedAccountArgs`, `RegisterPrivateLinkArgs`, `RemovePrivateLinkArgs`, `RevealPrivateLinkArgs`, `DispatchAsPrivateLinkArgs`) and discriminated union `AccountMappingCall`.
- **`types/pallet-events/`**: per-pallet event types, replacing the previous flat `pallet-events.ts`. Sourced directly from the Rust pallet `#[pallet::event]` definitions:
  - `shielded-pool.ts` — 13 event types covering the full lifecycle: `ShieldedEvent`, `PrivateTransferEvent`, `UnshieldedEvent`, `MerkleRootUpdatedEvent`, `AuditPolicySetEvent`, `DisclosedEvent`, `DisclosureRequestedEvent`, `DisclosureRejectedEvent`, `DisclosureRequestExpiredEvent`, `DisclosureRecordRevokedEvent`, `AssetRegisteredEvent`, `AssetVerifiedEvent`, `AssetUnverifiedEvent` and discriminated union `ShieldedPoolEvent`.
  - `zk-verifier.ts` — 6 event types: `VerificationKeyRegisteredEvent`, `ActiveVersionSetEvent`, `VerificationKeyRemovedEvent`, `ProofVerifiedEvent`, `ProofVerificationFailedEvent`, `BatchVerificationKeysRegisteredEvent` and discriminated union `ZkVerifierEvent`.
  - `account-mapping.ts` — 18 event types covering alias lifecycle, chain links, metadata, governance, private links and proxy dispatch, and discriminated union `AccountMappingEvent`.

### Removed

- `src/types/pallet-args.ts` — absorbed into `types/pallet-extrinsics/shielded-pool.ts`.
- `src/types/pallet-events.ts` — replaced by `types/pallet-events/` directory.
- `src/types/pallet-extrinsics.ts` (flat file) — replaced by `types/pallet-extrinsics/` directory.

## [0.2.0] - 2026-03-26

### Added

- **`KNOWN_PRECOMPILES`**: registry of all known Orbinum EVM precompiles keyed by lowercase address. Covers Ethereum standard (EIP-precompiles 0x01–0x05), Frontier non-standard (0x0400–0x0403), and Orbinum custom precompiles (`AccountMapping` 0x0800, `ShieldedPool` 0x0801). Each entry exposes a human-readable `name` and a map of 4-byte hex selectors to function signatures.
- **`KnownPrecompileInfo`**: TypeScript interface describing a precompile entry (`name: string`, `functions: Record<string, string>`).
- **`getPrecompileLabel(address)`**: helper that returns the human-readable name for a known precompile address, or `null` if the address is not recognised.

## [0.1.0] - 2026-03-26

### Added

- **`SubstrateClient`**: thin wrapper over polkadot-api (PAPI) with WebSocket connection, raw JSON-RPC requests, transaction building from call data, `submit`, `submitAndWatch`, and `signAndSubmit`.
- **`EvmClient`**: EVM-compatible client for interacting with Orbinum's Ethereum-compatible layer.
- **`ShieldedPoolModule`**: high-level module for shield, transfer, and unshield operations on the shielded pool.
- **`MerkleModule`**: Merkle tree utilities for commitment inclusion proofs.
- **`NoteBuilder`** / **`NoteDecryptor`**: note construction and decryption for privacy-preserving transactions.
- **`PrivacyKeyManager`** / **`PrivacyKeys`**: management of spending keys, viewing keys, and nullifiers.
- **`VaultCrypto`**: symmetric encryption/decryption for vault notes using `@noble/ciphers`.
- **`EncryptedMemo`**: encrypted memo encoding and decoding.
- **`AccountMappingModule`**: module for linking substrate and EVM accounts.
- **`ChainModule`**: chain-level queries (block number, finalized head, etc.).
- **`IndexerClient`**: HTTP client for the Orbinum indexer API.
- **Precompiles**: typed wrappers for `AccountMappingPrecompile`, `CryptoPrecompiles`, and `ShieldedPoolPrecompile`.
- **`types/`**: pallet argument types (`pallet-args.ts`) and pallet event types (`pallet-events.ts`).
- **`utils/`**: address, bytes, and hex utility helpers.
- **CI** (`.github/workflows/ci.yml`): typecheck, lint, format check, test, build, and security audit on every push/PR.
- **Release** (`.github/workflows/release.yml`): automated build → GitHub Release → npm publish driven by `package.json` version bump.
