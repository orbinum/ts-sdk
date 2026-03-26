# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
