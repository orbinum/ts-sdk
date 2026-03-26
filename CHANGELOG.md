# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
