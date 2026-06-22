# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.6] - 2026-06-21

### Changed

- **`EvmExplorer` batches block fetches** — `getLatestBlocks` and `getTransactionsByAddress` previously issued one `eth_getBlockByNumber` HTTP request per block (up to `maxBlocks`, default 300), flooding the RPC on explorer page loads. Both now use `EvmClient.batchRequest`: `getLatestBlocks` sends a single batch for all blocks, and `getTransactionsByAddress` fetches blocks in chunks of 50 per batch. A typical explorer load drops from ~169 requests to ~13. No API changes.

---

## [0.7.5] - 2026-06-18

### Fixed

- **EVM address hex validation** — `evmAddressToAccountId`, `evmToImplicitSubstrate`, `evmToSubstrate`, and `addressToAccountIdHex` now validate that the input contains only valid hex characters, not just the correct length. Previously, non-hex input (e.g. `0xzz...`) passed the length check and produced silently corrupted `NaN` bytes; the throwing functions now throw `Expected 20-byte EVM address` and `evmToSubstrate` returns `null`. Centralized into a shared `cleanEvmAddress` helper. (#7)

---

## [0.7.4] - 2026-06-03

### Added

- **`IndexedValidator`** — new type representing a validator node indexed from `pallet-validator-set` events:
  - `account: string` — SS58 validator address.
  - `status: 'pending' | 'approved' | 'rejected' | 'removed'` — lifecycle status.
  - `bondAmount: string | null` — reserved bond amount as decimal string.
  - `requestedAtBlock`, `approvedAtBlock`, `removedAtBlock: number | null` — block numbers for each lifecycle transition.
  - `timestampMs: number | null`.
- **`IndexedSession`** — new type representing a session rotation indexed from `pallet-session NewSession` events:
  - `sessionIndex: number` — monotonically increasing session counter.
  - `blockNumber: number` — block at which the session started.
  - `timestampMs: number | null`.
- **`IndexerClient.getValidators(params?)`** — paginated list of validators. Optional `status` filter (`'pending' | 'approved' | 'rejected' | 'removed'`). Calls `GET /validators`.
- **`IndexerClient.getValidator(account)`** — single validator by account address. Returns `null` on 404. Calls `GET /validators/:account`.
- **`IndexerClient.getSessions(params?)`** — paginated list of session rotations ordered most-recent first. Calls `GET /sessions`.
- Both new types and all three new client methods are exported from the package root (`@orbinum/sdk`).

---

## [0.7.3] - 2026-06-02

### Added

- **`PrivateTransferTimestamp`** — two new optional fields for local transfer reconstruction:
  - `matchedNullifiers?: string[]` — subset of the queried nullifiers that were spent in this specific extrinsic. Returned by `getTransfersByNullifiers()`. Use to identify which input vault notes belong to each outgoing transfer.
  - `matchedCommitments?: string[]` — subset of the queried commitments that were inserted in this specific extrinsic. Returned by `getTransfersByCommitments()`. Use to identify the change note (and thus amount and recipient) per transfer.

### Changed

- **`IndexerClient.getTransfersByNullifiers()`** — response now includes `matchedNullifiers` per extrinsic entry, enabling exact per-transfer input-note identification without requiring the server to expose graph linkability data.
- **`IndexerClient.getTransfersByCommitments()`** — response now includes `matchedCommitments` per extrinsic entry, enabling exact per-transfer output-note identification.

---

## [0.7.2] - 2026-05-20

### Fixed

- **`ShieldedPoolModule`** — eliminado `Binary.fromHex()` en campos de tamaño fijo `[u8;32]` (`merkle_root`, `nullifier`, `change_commitment`, `commitments`, `nullifiers`). El codec `SizedBytes(N)` de PAPI espera una cadena hex directamente; envolver con `Binary.fromHex()` devuelve un `Uint8Array` que falla el check de compatibilidad de tipo, generando el error *"Incompatible runtime entry Tx(ShieldedPool.unshield)"*.
- **`SubstrateClient.submitUnsignedAndWatch`** — cambiada la firma de `(bareTxHex: string)` a `(bareTx: Uint8Array)` y eliminada la llamada `Binary.fromHex()`. `getBareTx()` de PAPI devuelve `Promise<Uint8Array>`, no un hex string; la conversión corrupta los bytes y el nodo rechazaba la tx con *"ExtrinsicFormat 0 not valid"*.
- **`submitBareTx` / `callUnsafeTx`** — tipos de retorno de `getBareTx()` actualizados a `Promise<Uint8Array>` para alinearlos con los tipos reales de PAPI 2.x.
- **`EvmExplorer.getAddressInfo`** — rango de bloques para `eth_getLogs` reducido de 5 000 a 1 000 para respetar el límite `--max-block-range` por defecto del nodo stable2512.

---

## [0.7.1] - 2026-05-18

### Added

- **`IndexerClient.getAllSpentNullifiers()`** — downloads the full global spent-nullifier set from `GET /shielded/nullifiers/all` and returns it as `Promise<Set<string>>` (lowercase hex). Implements the PIR-A privacy model: the server receives an identical GET request regardless of which notes the wallet holds; the spent/unspent intersection is computed locally by the caller.

---

## [0.7.0] - 2026-05-17

### Added

- **`rpc-v2/ChainModule`** — new module for general chain state queries under the `chain_*` RPC namespace:
  - `isValidator(ss58Address)`: returns `true` if the given SS58 account is an active Aura block author. Calls the new `chain_isValidator` node endpoint which reads `pallet_aura::Authorities` directly from storage.
  - Exported from `rpc-v2` and accessible as `client.chain` on `OrbinumClient`.

### Changed

- **`OrbinumClient`** — exposes a new `readonly chain: ChainModule` property.
- **`rpc-v2/RpcV2Module`** — aggregates `chain: ChainModule` alongside the existing `privacy: PrivacyModule`.
- **Dependencies** — major version bumps across all runtime and dev dependencies:
  - `polkadot-api` `1.23.x` → `2.1.3` (breaking — see migration notes below).
  - `@polkadot-api/metadata-builders`, `@polkadot-api/substrate-bindings`, `@polkadot-api/utils` updated to match papi 2.x.
  - `typescript` `5.9.x` → `6.0.3`.
  - `vitest` `3.x` → `4.1.6`.
  - `@noble/curves`, `@noble/hashes`, `@scure/base` updated to latest stable.

#### polkadot-api 2.x migration notes

- Import path changed: `polkadot-api/ws-provider` → `polkadot-api/ws`.
- `Binary` is no longer a class — it is a plain utility object. The `Binary.fromBytes(u8)` method has been removed. Pass `Uint8Array` values directly to extrinsic fields; use `Binary.fromHex(hex)` to convert hex strings to `Uint8Array`.
- `PolkadotClient.submit` and `PolkadotClient.submitAndWatch` now accept `Uint8Array` instead of a hex string. Callers must wrap the signed hex with `Binary.fromHex(hex)` before passing it.

### Removed

- **`RelayerStatusModule.isValidator`** — moved to `ChainModule.isValidator`. The method was calling `relayer_isValidator`, a mis-namespaced endpoint; validator status is a general chain concern, not relayer-specific. Update call sites: `client.relayerStatus.isValidator(addr)` → `client.chain.isValidator(addr)`.

---

## [0.6.0] - 2026-05-17

### Added

- **`shielded-pool/protocol/NoteDisclosure`** — off-chain note disclosure utilities:
  - `createNoteDisclosureKey(note)`: serialises the plaintext preimage of a `ZkNote` into a compact shareable string with prefix `orbdisc:<base64url(JSON)>`. Reveals `value`, `assetId`, `ownerPk` (BJJ Ax), and `blinding` — never `spendingKey`, `nullifier`, or any viewing secret.
  - `decodeNoteDisclosureKey(key)`: parses and cryptographically verifies a disclosure key by recomputing `Poseidon4(value, assetId, ownerPk, blinding)` and comparing it against the embedded commitment hex. Returns `NoteDisclosureKey | null`; `null` on any parse or verification failure.
  - Type `NoteDisclosureKey`: `{ version: 1, commitment, value, assetId, ownerPk, blinding }` (all fields as `bigint`).
  - Exported from `shielded-pool/protocol`.

- **`IndexerClient`** — new relayer and registered-asset endpoints:
  - `getRelayers(params?)`: paginated list of relayers; optional filters `page`, `limit`, `active`.
  - `getRelayer(evmAddress)`: single relayer by EVM address, or `null` if not found.
  - `getRelayFees(params?)`: paginated relay fee events; optional filters `relayer`, `type` (`'accumulated' | 'consumed'`).
  - `getRelayFeesSummary(relayer)`: aggregated relay fee balances per asset for a given relayer account (`accumulated`, `consumed`, `pending` as bigint-safe strings).
  - `getRegisteredAssets(params?)`: paginated list of assets registered via `register_asset`.
  - `getRegisteredAsset(assetId)`: single registered asset by ID, or `null` if not found.
  - New types: `Relayer`, `RelayFeeEvent`, `RelayFeeSummaryEntry`, `RegisteredAsset`.
  - `ShieldedCommitment.source` field: `'shield' | 'transfer' | 'unshield'` — indicates the on-chain origin of a commitment.

- **`precompiles/ShieldedPoolPrecompile`** — claim shielded fees support:
  - `buildClaimShieldedFeesCalldata(params)`: ABI-encodes a `claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes)` call. Validates: `proof` non-empty, `publicSignals` exactly 76 bytes, `encryptedMemo` exactly 176 bytes.
  - `claimShieldedFees(params, signer)`: sends the encoded calldata to the `SHIELDED_POOL` precompile address.
  - `estimateClaimShieldedFeesGas(params, from)`: estimates EVM gas for a `claimShieldedFees` call.
  - `SP_SEL.CLAIM_SHIELDED_FEES` selector `0x42e1e74c` added to `precompiles/addresses`.
  - `precompiles/decode`: calldata decoder now recognises and partially decodes `claimShieldedFees` calls, returning `commitment`, `amount`, and `assetId`.
  - `ClaimShieldedFeesParams` exported from `precompiles/types`.

- **`proof-generator/fee-claim`** — `generateFeeClaimProof` fully implemented (previously a deprecated stub):
  - Uses `CircuitType.ValueProof` (`'value_proof'`) via `@orbinum/proof-generator`.
  - Circuit input mapping: `amount → value`, `assetId → asset_id`, `ownerPubkey → owner_pubkey` (all as decimal strings).
  - Returns `FeeClaimProofOutput`: `proof` (128-byte Groth16 as `0x`-prefixed hex) and `publicSignals` (`number[]` of 76 bytes) with layout: commitment LE [0–32], value u64 LE [32–40], asset_id u32 LE [40–44], owner_hash LE [44–76].
  - Validates `amount > 0n` before invoking the circuit.
  - Accepts optional `provider` and `verbose` options.

- **New tests:**
  - `tests/proof-generator/fee-claim.test.ts` — 24 tests covering circuit type, input field mapping, 76-byte buffer layout, validation, provider handling, and determinism.
  - `tests/precompiles/ShieldedPoolPrecompile.test.ts` — 228 lines added: `buildClaimShieldedFeesCalldata` (selector, determinism, field encoding, error cases), `claimShieldedFees` signer call, and `estimateClaimShieldedFeesGas`.
  - `tests/shielded-pool/NoteDisclosure.test.ts` — 27 tests for `createNoteDisclosureKey` and `decodeNoteDisclosureKey` (roundtrip, commitment verification, tamper rejection, unknown prefix/version handling).
  - `tests/indexer/IndexerClient.test.ts` — relayer and registered-asset endpoint tests added.

### Changed

- **`@orbinum/proof-generator`** dependency updated from `3.6.0` to `3.7.0`.

### Removed

> **Breaking changes** — the selective disclosure API has been removed across all surfaces.

- **`shielded-pool/protocol/disclosure.ts`** deleted — `generateDisclosureProof`, `deriveBabyJubjubKeypair`, `decryptDisclosure`, and `buildDisclosurePublicSignals` are no longer available.
- **`ShieldedPoolModule`** — disclosure extrinsics removed: `requestDisclosure`, `disclose`, `rejectDisclosure`, `pruneExpiredRequest`, `revokeDisclosureRecord`.
- **`ShieldedPoolPrecompile`** — removed `buildRequestDisclosureCalldata`, `requestDisclosure`, `buildDiscloseCalldata`, `disclose`.
- **`precompiles/types`** — removed: `RequestDisclosureParams`, `DiscloseParams`, `RejectDisclosureParams`, `PruneExpiredRequestParams`.
- **`extrinsic/decoded-args`** — removed: `DecodedSetAuditPolicyArgs`, `DecodedRequestDisclosureArgs`, `DecodedRejectDisclosureArgs`.
- **`shielded-pool/pallet/events`** — removed: `AuditPolicySetEvent`, `DisclosedEvent`, and all disclosure-related event types.
- **`shielded-pool/pallet/extrinsics`** — removed: `RequestDisclosureArgs`, `DiscloseArgs`, `RejectDisclosureArgs`, `PruneExpiredRequestArgs`, `RevokeDisclosureRecordArgs`.
- `tests/shielded-pool/disclosure.test.ts` deleted.

## [0.5.0] - 2026-05-12

### Added

- **`vault/`** — AES-GCM-256 encrypted note vault primitives:
  - `deriveVaultKey(masterBytes)`: HKDF-SHA-256 key derivation from 32-byte master material. Key is stable across circuit field changes — derived before modular reduction.
  - `encryptJson(key, payload)` / `decryptJson(key, iv, ciphertext)`: WebCrypto AES-GCM encrypt/decrypt with bigint-safe JSON serialisation.
  - `encryptNote(key, note)` / `decryptNoteRecord(key, record)`: per-note encrypt/decrypt returning `EncryptedNoteRecord`.
  - `applyNoteStatus(record, update)`: applies a `NoteStatusUpdate` without re-encrypting the full payload.
  - `VaultLockedError`: typed error thrown when vault operations are attempted without an unlocked key.
  - Types: `EncryptedNoteRecord`, `NoteStatusUpdate`.
  - `vaultReplacer` / `vaultReviver`: bigint-safe JSON replacer and reviver for vault serialisation.

- **`proof-generator/`** — ZK proof generation wrappers delegating to `@orbinum/proof-generator`:
  - `generateUnshieldProof(inputs, provider)`: builds a Groth16 unshield proof. Inputs: `merkleRoot`, `nullifier`, `amount`, `assetId`, `recipient`, `blinding`, `spendingKey`, `pathSiblings`, `leafIndex`, and optional `fee`, `changeValue`, `changeBlinding`, `changeOwnerPk`. Returns `UnshieldProofResult` with `proof`, `publicSignals`, and `changeCommitment`.
  - `generateTransferProof(inputs, provider)`: builds a Groth16 private-transfer proof for exactly 2 inputs and 2 outputs. Inputs: `merkleRoot`, typed `TransferInputNote[2]`, `TransferOutputNote[2]`, and optional `fee`.
  - `generateFeeClaimProof(inputs, provider)`: builds a Groth16 fee-claim proof for `claimShieldedFees`. Returns `FeeClaimProofOutput` with a 128-byte `proof` hex and 76-byte `publicSignals` buffer.
  - `merkleProofToCircuit(pathSiblings, leafIndex, depth)`: adapts indexer Merkle proof data to the circuit's expected format.
  - `CircuitType`, `WebArtifactProvider`: re-exported from `@orbinum/proof-generator` for consumers that do not install the package directly.
  - Types: `ArtifactProvider`, `ProofResult`, `UnshieldProofInputs`, `UnshieldProofResult`, `TransferInputNote`, `TransferOutputNote`, `PrivateTransferProofInputs`, `FeeClaimProofInputs`, `FeeClaimProofOutput`.

- **`relayer/`** — Typed client for relayer registry JSON-RPC endpoints:
  - `RelayerStatusModule.isRelayer(ss58)`: returns whether an account is a registered relayer.
  - `RelayerStatusModule.pendingFees(ss58, assetId)`: returns pending relayer fees as `bigint`.
  - `RelayerStatusModule.registeredEvmAddress(ss58)`: returns the registered EVM address or `null`.
  - `RelayerStatusModule.getRelayerInfo(ss58)`: convenience wrapper returning a `RelayerInfo` object.
  - Type: `RelayerInfo`.

- **`shielded-pool/pallet/`** — High-level Substrate pallet transaction module:
  - `ShieldedPoolModule`: high-level class for all shielded-pool extrinsics, built on polkadot-api UnsafeApi:
    - `shield(params, signer)`: deposits tokens into the shielded pool (signed tx).
    - `unshield(params, signer?)`: withdraws tokens via ZK proof — submitted as unsigned (gasless) if no signer is provided.
    - `privateTransfer(params, signer?)`: private transfer between two shielded addresses (unsigned gasless).
    - `shieldBatch(params, signer)`: batch shield operation for multiple commitments.
    - `claimShieldedFees(params, signer)`: claims accumulated relayer fees from the pool.
    - Disclosure extrinsics: `requestDisclosure()`, `disclose()`, `rejectDisclosure()`, `pruneExpiredRequest()`, `revokeDisclosureRecord()`.
  - Pallet event and extrinsic type re-exports via `shielded-pool/pallet/index.ts`.

- **`shielded-pool/protocol/`** — Off-chain cryptographic protocol primitives:
  - `NoteBuilder.build(input)`: constructs a `ZkNote` (commitment + nullifier + encrypted memo) from value, assetId, ownerPk, and optional viewing key. Supports stealth addresses: when `viewingPublicKey` and `recipientOwnerPk` are provided, generates a per-note `stealthOwnerPk` so notes are unlinkable across transfers. Hash scheme: `commitment = Poseidon4(value, assetId, ownerPk, blinding)`, `nullifier = Poseidon2(commitment, spendingKey)`.
  - `tryDecryptNote(commitment, viewingSecretKey, spendingKey, ownOwnerPk)`: attempts to decrypt an on-chain commitment. Returns a `ZkNote` on success, `null` on key mismatch or commitment failure.
  - `tryDecryptNoteVerbose(...)`: like `tryDecryptNote` but additionally returns a human-readable `reason` string for failed decryptions.
  - `computeNullifier(commitment, spendingKey)`: computes `Poseidon2(commitment, spendingKey)`.
  - `EncryptedMemo`: 168-byte ChaCha20-Poly1305 encrypted memo with ECDH ephemeral key. `EncryptedMemo.encrypt(payload, viewingPublicKey, commitment)` and `EncryptedMemo.decrypt(bytes, viewingSecretKey, commitment)`. Constant `ENCRYPTED_MEMO_SIZE = 168`.
  - `selectNotes(notes, needed)`: greedy note selection — single note first, then smallest qualifying pair. Returns `null` if no combination covers `needed`.
  - `buildDummyTransferInput(assetId)`: builds a zero-value dummy `TransferInputNote` for the second slot in single-note transfers (circuit-level dummy exemption).
  - `generateDisclosureProof`, `deriveBabyJubjubKeypair(substrateSigningKey)`, `decryptDisclosure(publicSignals, auditorSk)`: selective disclosure utilities for auditor workflows.
  - Types: `ZkNote`, `ScanCommitment`, `DecryptedMemo`, `MerkleTreeInfo`, `ShieldParams`, `UnshieldParams`, `PrivateTransferParams`, `PrivateTransferInput`, `PrivateTransferOutput`, `ShieldBatchParams`, `ClaimShieldedFeesParams`, `NoteInput`, `DisclosureFlags`.

- **New utility functions in `utils/`:**
  - `bjj.ts` — `recoverOwnerPkPoint(ownerPkAx)`: recovers the Baby JubJub `[Ax, Ay]` point from the Ax coordinate alone using the Tonelli-Shanks modular square-root algorithm and the twisted Edwards curve equation. Needed for stealth key derivation when only Ax is stored on-chain.
  - `blinding.ts` — `randomBlinding()`: generates a cryptographically random Poseidon blinding factor in `[1, BN254_R)` using `crypto.getRandomValues`.
  - `crypto-constants.ts` — exports `BABYJUB_SUBORDER` and `BN254_R` BN254 field and subgroup order constants.
  - `encoding.ts` — `toBase64(buf)` / `fromBase64(b64)`: pure browser/Node base-64 encode/decode without external dependencies.
  - `stealth.ts` — `deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint)`: derives the per-note stealth public key for a recipient note (sender side). `deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey)`: derives the stealth spending key for a received note (recipient side). Scheme: `HKDF-SHA256(sharedSecret, salt=ownerPk_LE, info="orbinum-stealth-v1") % BABYJUB_SUBORDER`.

- **New tests** for all added modules: `proof-generator/` (unshield, transfer, merkle, fee-claim), `shielded-pool/` (coinSelection, disclosure, helpers, stealth-integration), and `vault/` (noteOps, errors).

## [0.4.2] - 2026-03-31

### Fixed

- **`SubstrateClient.queryBlockEvents`**: `_buildDataProxy.jsonifyValue` now correctly serialises polkadot-api `Binary` values (H160, H256, etc.) by calling `asHex()` before falling back to generic object traversal. Previously, `Binary` instances produced `{}` which rendered as `[object Object]` in the explorer's FROM/TO columns for `ethereum.transact` extrinsics.
- **`_buildDataProxy.jsonifyValue`**: `Uint8Array` values are now serialised with the `0x` prefix (`"0x..."`) instead of bare hex.

## [0.4.1] - 2026-03-31

### Added

- **`connectInjectedExtension`**, **`getInjectedExtensions`** re-exported from `polkadot-api/pjs-signer` — consumers no longer need to install `polkadot-api` directly to use Substrate browser wallet extensions.
- **`SignPayload`**, **`SignRaw`** types re-exported from `polkadot-api/pjs-signer`.

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
