# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
