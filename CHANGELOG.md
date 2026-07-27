# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.19.0] - 2026-07-27

### Security

- **Spending key derivation moved to EIP-712 (v2).** v1 signed a fixed public string via `personal_sign`. Because ECDSA `personal_sign` is deterministic (RFC-6979) and that string depends only on public data (`chainId`, `address`), **any dapp the user connected their wallet to could request the exact same signature and reconstruct their spending key, viewing key and vault key** — full compromise of the shielded identity from an innocuous-looking prompt. `deriveSpendingKeyTypedData(chainId, address)` replaces the flat message with typed data whose `verifyingContract` is the shielded pool precompile (2049, `0x…0801`): the wallet renders the domain, so a hostile origin can no longer harvest the signature behind a prompt that looks like something else, and the message's `warning` field is displayed inside the wallet — the one surface the attacker does not control. The payload deliberately carries **no nonce and no timestamp**: the digest must stay a pure function of `(chainId, address, domain)`, or the key would change per session and leave already-shielded notes unspendable. Version separation is cryptographic, not merely textual — the HKDF `info` becomes `orbinum-sk-v2:{chainId}:{address}`, so v1 and v2 are disjoint identities even if the signature bytes were identical. See `SPENDING_KEY_DERIVATION_SECURITY.md`.

- **An invalid signature no longer mints an identity.** HKDF accepts IKM of any length, including zero, so `deriveSpendingKeyFromSignature('')` returned a perfectly usable spending key — derived entirely from **public** inputs (`chainId`, `address`) and therefore reproducible by anyone. A wallet returning `''`, `'0x'` or an error string instead of signing would have silently minted that key, leaving any funds shielded into it spendable by whoever knew the address. `deriveMasterKeyBytes` now validates against `MIN_SIGNATURE_BYTES` (32 — the sr25519 VRF output length, the shortest of the supported schemes) and throws. The guard covers both v1 and v2, so the sweep path cannot mint a bogus identity either.

### Added

- `deriveSpendingKeyTypedData(chainId, address)` — EIP-712 payload for `eth_signTypedData_v4`. The default derivation path on EVM.
- `deriveSpendingKeyMessageV2(chainId, address)` — message for signers without EIP-712 (Substrate), with the warning leading the text, since that is the only channel the extension renders and the attacker cannot rewrite. Wired into both Substrate routes: sr25519 via VRF and ed25519 (Ledger) via `signRaw`. Derives under the same v2 HKDF domain as the EVM route. Note that ed25519 already signs deterministically by design (RFC 8032), so those accounts were harvestable **before** VRF ever landed — determinism solves usability, not security; it is precisely what turns a signature into a stealable bearer token.
- `SPENDING_KEY_VERIFYING_CONTRACT` — the EIP-712 domain's `verifyingContract`, re-exported from `PRECOMPILE_ADDR.SHIELDED_POOL` rather than written out a second time. It is part of the digest: changing it changes every derived spending key and orphans existing notes, so it is a protocol constant, not a config knob. A test pins it against `PRECOMPILE_ADDR` so the two cannot drift apart silently.
- `SPENDING_KEY_WARNING` — the warning text, shared by the EVM and Substrate routes.
- `MIN_SIGNATURE_BYTES` — minimum signature length accepted by derivation (sr25519 VRF = 32, ed25519 = 64, ECDSA = 65).
- `KeyVersion` (`'v1' | 'v2'`) and `SpendingKeyTypedData` types.

### Changed

- **`SpendingKeyRequest` split out of `PrivacyKeys`.** Building what the user signs (typed data / message, platform-specific) and turning that signature into key material (HKDF, platform-agnostic) were distinct responsibilities living in one file. The builders now live in `src/privacy-keys/SpendingKeyRequest.ts` with the threat model documented in one place, leaving `PrivacyKeys` as pure derivation. No behavioural change: the same names are exported from the package root.
- `deriveMasterKeyBytes` and `deriveSpendingKeyFromSignature` take a fourth `version: KeyVersion` parameter defaulting to `'v2'` — no caller lands on the insecure identity by omission. Pass `'v1'` only from the legacy note-sweeping flow.

### Deprecated

- `deriveSpendingKeyMessage(chainId, address)` — v1 derivation, insecure (see above). Kept exported **solely** so existing v1 notes can be swept into a v2 identity via a `private_transfer` to one's own v2 `ownerPk`. Never call it on a connect/login path. A removal date is still to be set.

## [0.18.0] - 2026-07-26

### Fixed

- **A single missed heartbeat probe no longer destroys the client.** `OrbinumClientProvider` tore down the `OrbinumClient` (and rejected every in-flight request with `Client destroyed`) after one failed `system_health` probe — a 4s blip from a throttled background tab, a transient network drop, or the node being CPU-bound verifying a ZK proof. Teardown now requires 2 consecutive failed probes (~10s), and the failure counter resets on recovery.
- **Transactions awaiting finalization keep the connection alive longer.** With a tx in flight the probe-failure threshold rises to 6 (~30s). An unsigned `private_transfer`/`unshield` makes the node CPU-bound on proof verification — exactly when probes time out — so the old behavior destroyed the client while the node was processing the very tx it had submitted, surfacing as `Private Transfer failed: Client destroyed` for a tx that often finalized anyway.
- **`EvmClient.waitForReceipt` no longer reports a live transaction as failed.** On hitting `timeoutMs` it now consults `eth_getTransactionByHash`: a tx the pool no longer knows throws `Transaction dropped from the tx pool` (safe to retry), while a tx still in the pool gets an extended wait (up to 4× `timeoutMs`) before throwing `still pending — check the hash before retrying`. Previously the generic `Transaction not mined within 60000ms` invited a retry against a tx that could still mine — a double-spend risk. A transient RPC failure during the pool check is never read as "dropped".

### Added

- `SubstrateClient.hasInflightTx` — `true` while a promise-based submit (`submit`, `submitUnsignedAndWatch`, `signAndSubmit`) awaits finalization. Used by the provider's heartbeat; observable-based `submitAndWatch` callers are not tracked.
- `EvmClient.getTransactionByHash(txHash)` — returns the tx or `null` when the node no longer knows it. Unlike `request`, a `null` result is a valid answer, not an error.

## [0.17.0] - 2026-07-24

### Added

- `computeNoteCommitment(value, assetId, ownerPk, blinding)` — computes a note commitment (`Poseidon4`), mirroring `NoteCommitment` in `note.circom`. Exported so wallets can verify a stored note against its on-chain commitment *before* proving. The ZK circuits ignore the ownerPk supplied by the caller and rebuild the commitment from `BabyPbk(spending_key).Ax`; if a stored note's spendingKey, value, assetId or blinding drift from what was committed on-chain, witness generation fails on the Merkle constraint with an opaque `Assert Failed` (e.g. `Unshield_164 line: 82`) after seconds of proving. Recomputing the commitment with `deriveOwnerPk(spendingKey)` and comparing it against the note's `commitmentHex` detects the drift up front — wrong session key (non-deterministic signers: smart/MPC wallets), a mis-recovered stealth key, or a corrupted vault note. Covered by tests pinning it byte-identical to `NoteBuilder`'s commitment, including the re-derived-ownerPk path and the LE `commitmentHex` round-trip.

## [0.16.0] - 2026-07-20

### Added

- **Deterministic self-note ephemerals (fast cold restore)**. Notes the wallet creates for itself (shields, change, self-transfers) can derive the memo's ephemeral secret from the seed instead of randomness: `deriveSelfEphSk(spendingKey, index)` = `SHA256("orbinum-self-eph-v1" || spendingKey_LE32 || u32le(index))`, passed via the new `NoteInput.ephSkOverride` (non-stealth path only — the stealth path keeps generating its own coordinated ephemeral). A cold restore then recognizes its own notes by a hash lookup on the published ephPk — zero trial ECDH per pool hint. The published points are PRF-derived and indistinguishable from the random ephemerals used before (same argument as BIP-32 HD public keys). The index is a monotonic per-wallet counter callers must persist and never reuse (an index reuse publishes the same ephPk twice, linking the two notes as same-creator).
- `selfEphWindow(spendingKey, ivkPacked, from, count)` — precomputes the discovery window: for each index, the ephPk the wallet would have published (byte-identical to the memo's last 32 bytes) and the ECDH shared secret needed to decrypt it.
- `tryDecryptNote` / `tryDecryptNoteVerbose` accept `opts.sharedSecret` — a caller-supplied precomputed secret (from a window match) that skips both the ECDH and the view-tag gate; the AEAD decrypt and commitment check still validate the note as usual. A wrong secret fails the MAC — no false accepts.
- Fixed test vector pinning the derivation as a cross-repo contract, plus a triple-agreement test (window path == view-tag path == full path on the same note).

### Changed

- **BabyJubJub scalar multiplication is ~17× faster** (`src/utils/bjj-fast.ts`, backed by `@noble/curves`). `@zk-kit/baby-jubjub`'s plain double-and-add mul made the EC math ~90% of a wallet rescan (~6ms per mul in a browser tab); the noble-backed `fastMulBase` (precomputed generator tables, 11×) and `fastMulPoint` (`multiplyUnsafe`, 17×, same variable-time class as the mul it replaces — no constant-time regression) now serve the hot paths: `EncryptedMemo.encrypt`, `EncryptedMemo.extractSharedSecret` (the per-hint scan ECDH) and `selfEphWindow`. Point packing stays on `@zk-kit` — its packed format is the on-chain memo format and noble's is not compatible. Results are byte-identical, pinned by an equivalence suite (`tests/utils/bjj-fast.test.ts`: scalar sweeps on base and variable points, edge scalars, identity). Measured end-to-end on a 14k-leaf pool: full rescan 106s → 8.9s.
- New dependency: `@noble/curves` (already sharing the `@noble` family with ciphers/hashes).

## [0.15.0] - 2026-07-20

### Added

- **View tags (Monero-style 1-byte fast-scan filter)**. `EncryptedMemo.encrypt` now embeds `view_tag = SHA256("orbinum-view-tag-v1" || sharedSecret)[0]` as the memo's first nonce byte (`nonce[0]`). Memo size (180) and layout are unchanged — no pallet, event, or indexer changes; legacy memos simply carry a random byte there. Nonce safety is unaffected: the ChaCha20-Poly1305 key is unique per note (bound to `sharedSecret || commitment`), so each key encrypts exactly once and 11 random nonce bytes remain. The tag is set before sealing, so the AEAD MAC covers it — a flipped tag cannot silently hide a note from the unfiltered path.
- `deriveViewTag(sharedSecret)`, `EncryptedMemo.checkViewTag(memo, sharedSecret)` (one SHA256 + one byte compare, no AEAD work) and `EncryptedMemo.decryptWithSharedSecret(memo, commitment, sharedSecret)` (skips the ECDH when the caller already extracted the secret).
- `tryDecryptNote` / `tryDecryptNoteVerbose` accept `opts: { viewTag: true }` — the fast path runs the ECDH once, compares the tag and skips the AEAD decrypt on mismatch (`reason: 'view_tag_mismatch'`, 255/256 of foreign notes). The extracted shared secret is reused by the stealth branch (no second ECDH). **Only enable for commitments at/after the wallet's `tagActivationLeaf`** — filtering legacy memos would drop 255/256 of the owner's own pre-activation notes.
- Fixed test vector pinning the derivation as a cross-repo contract (`tests/shielded-pool/ViewTag.test.ts`).

## [0.14.1] - 2026-07-16

### Fixed

- `SubstrateClient.connect` now enables PAPI's ws-level heartbeat (`heartbeatTimeout: 30s`). An intermediary (Cloudflare cuts proxied WebSocket upgrades after ~100–200s of silence) was silently dropping idle sockets, and PAPI eagerly reopened them — measured on the testnet RPC node as hundreds of reconnects per client and a persistently inflated session count. The heartbeat keeps the socket alive under that idle window so it is not dropped and reopened.

## [0.14.0] - 2026-07-16

### Fixed

- Failed/timed-out connection attempts no longer leak PAPI clients that keep reconnecting to the node forever. `SubstrateClient.connect` destroys its client on timeout, and `OrbinumClientProvider` destroys a late-resolving client after its outer race times out. Previously every failed attempt left a zombie WebSocket in an endless internal reconnect loop — the visible symptom was rapid, never-ending reconnects and connection churn on the RPC node.
- `OrbinumClientProvider` now passes its `connectTimeoutMs` down to the inner connect, so the layer that owns cleanup times out first (the inner default of 15s previously outlived the provider's 8s race on every slow connect).

### Changed

- `EvmClient` (`request`, `batchRequest`, `getTransactionReceipt`) now retries HTTP 429/503 with exponential backoff, honoring `Retry-After` — same policy `jsonRpcBatch` already had. Rate-limited single calls no longer surface as hard errors.
- New internal `postJsonWithRetry` util (`utils/jsonRpcHttp`) shared by the EVM client and the Substrate batch transport.

## [0.13.0] - 2026-07-11

### Removed (BREAKING)

- **`IndexerClient` and all indexer types are no longer part of the SDK.** The public SDK must not know the shape of the private indexer's REST API — it now ships only crypto/chain (`substrate`, `evm`, `evmExplorer`, `shieldedPool`, `privacy`, `zkVerifier`, `proof-generator`, `vault`, `precompiles`). Consumers that talked to the indexer must supply their own HTTP client.
  - Removed exports: `IndexerClient`, `normalizeBaseUrl`, and the types `IndexerClientConfig`, `PaginatedResult`, `IndexedBlock`, `IndexedExtrinsic`, `IndexedEvmTx`, `IndexedSession`, `IndexedValidator`, `IndexerStats`, `IndexerActivity`, `ActivityBucket`, `ShieldedAddressEvent`, `ShieldedCommitment`, `SpentNullifier`, `NullifierChunkInfo`, `NullifierManifest`, `NullifierTail`, `PrivateTransferTimestamp`, `Unshield`, `MerkleRoot`, `NullifierStatusResult`, `StealthScanHint`, `Relayer`, `RelayFeeEvent`, `RelayFeeSummaryEntry`, `RegisteredAsset`.
  - `OrbinumClient` no longer has an `indexer` field; `OrbinumClientConfig` / `OrbinumClientProviderConfig` no longer accept `indexerUrl`.
  - **No impact on the shielded-pool crypto**: `IndexerClient` was a leaf — note decryption (`tryDecryptNote`), nullifier derivation, memo encrypt/decrypt, vault, proof generation, and Merkle-proof / nullifier-status (via Substrate RPC) never depended on it. Callers fetch indexer data themselves and feed plain records into the SDK crypto as before.

## [0.12.0] - 2026-07-10

### Changed (BREAKING — encrypted memo wire format)

- **The encrypted memo grew 176 → 180 bytes (plaintext 116 → 120)** to carry the note's `circuit_version` (`src/shielded-pool/protocol/memo.ts`, `EncryptedMemo.ts`). `circuit_version` (u32 LE) now lives in the memo plaintext at offset `[116, 120)`, so a note is **self-contained**: a scan-recovered note keeps its true circuit version without any indexer lookup. `serializeMemo` and `EncryptedMemo.encrypt` / `encryptPublic` gained a `circuitVersion` parameter; `ENCRYPTED_MEMO_SIZE` is now `180`, `MEMO_PLAINTEXT_SIZE` `120`, `CIPHERTEXT_SIZE` `136`. `NoteDecryptor` reads the version from the decrypted memo (not from any feed), and `ScanCommitment.circuitVersion` / `StealthScanHint.circuitVersion` were **removed** (the version no longer travels in the scan feed). Matches the paired node change (`orbinum-encrypted-memo` plaintext 120, `MAX_ENCRYPTED_MEMO_SIZE` 180, runtime `spec_version` 6). **Breaking:** memos written by earlier versions (176 bytes) cannot be decrypted, and vice-versa.

### Added

- **Per-note circuit version** (`src/shielded-pool/protocol/types.ts`, `NoteBuilder`, `NoteDecryptor`, `vault/noteOps.ts`): `ZkNote` now carries a required `circuitVersion` so a note is always proven/verified against the circuit that created it, even after a VK rotation. `NoteBuilder.build` stamps it (default `CURRENT_CIRCUIT_VERSION` = 1, exported; callers may pass an explicit version resolved from the chain) and writes it into the note's encrypted memo; on scan, `NoteDecryptor` recovers it from that memo. Fail-closed: `decryptNoteRecord` throws if a vault record has no `circuitVersion` (invalid/corrupt) rather than defaulting.
- **`CircuitVersionResolver`** (`src/shielded-pool/CircuitVersionResolver.ts`, exported; wired onto `OrbinumClient.circuitVersionResolver`): the single fail-closed choke point for spending a note under its own circuit version. Given a note's `circuitVersion`, it pins the artifact provider to that version, cross-checks the prover's VK hash against the chain's VK hash for that version, confirms the chain still lists it in `supportedVersions`, and returns `{ provider, version }` for the proof generator and the extrinsic. Throws before any proof is generated on an unsupported version, a VK-hash mismatch (CDN vs chain), or a prover/chain version disagreement — never falls back to the active version.
- **`circuitsBaseUrl` config option** on `OrbinumClientConfig` (and `ClientProviderConfig`): points the `CircuitVersionResolver`'s artifact provider at a self-hosted circuits mirror (`manifest.json` + artifacts) instead of the default npm CDN (unpkg). Enables serving a multi-version manifest (e.g. during a VK rotation). Omit to keep the CDN default — backward-compatible.

### Changed

- **Spend extrinsics now carry a required `circuitVersion`** (`ShieldedPoolModule.unshield` / `privateTransfer` / `claimShieldedFees`, and the corresponding `UnshieldParams` / `PrivateTransferParams` / `ClaimShieldedFeesParams`). It is forwarded to the pallet so the proof is verified against that version's VK. Matches the node's consensus change (spec_version 4 / transaction_version 2).
- **EVM precompile ABI: added a trailing `uint32 circuitVersion`** to `privateTransfer`, `unshield` and `claimShieldedFees` (`src/precompiles/{addresses,ShieldedPoolPrecompile,decode}.ts`). Selectors change (**breaking**): `privateTransfer` → `0x66ed2cd4`, `unshield` → `0x4e505348`, `claimShieldedFees` → `0x88d9deba`. The stale `unshield` selector/signature in the registry was also corrected to the on-chain 10-parameter form.
- **`@orbinum/proof-generator` bumped to `4.0.0`** — the published release exposing `WebArtifactProvider.getResolvedVersion` (resolved version + `vkHash` per circuit), the `CIRCUIT_ID` map + `circuitTypeToId()`, and fail-closed artifact integrity (sha256-verified against the manifest). `CircuitVersionResolver` consumes these to pin the prover to a note's circuit version and cross-check the VK hash against the chain before proving.

### Fixed

- **`CircuitId.ValueProof` corrected from 4 to 6** (`src/zk-verifier/types/pallet-extrinsics.ts`): the value the SDK exported did not match the node's on-chain `CircuitId::VALUE_PROOF = 6` (`node/frame/zk-verifier/src/types.rs`), so a version/VK lookup keyed off `ValueProof` (e.g. `getCircuitVersionInfo(4)`) would have queried a non-existent circuit. The constant was unused in flows so far, so this is safe. A new anti-drift test (`tests/zk-verifier/circuit-id.test.ts`) locks all four ids to the node's values.

## [0.11.0] - 2026-07-02

### Changed

- **`IndexerClient` now enforces HTTPS on its `baseUrl`.** The indexer carries the wallet's queries, so a plain-`http://` remote endpoint would send them in cleartext. The constructor validates the transport: `https://` is always allowed, `http://` only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`); any other value — or a non-URL string — throws (fail-closed). Trailing-slash normalization is unchanged.
  - **Breaking:** constructing an `IndexerClient` with a plain-http remote `baseUrl` now throws instead of silently sending cleartext requests. Local development against `http://localhost` is unaffected.
  - New export: `normalizeBaseUrl(baseUrl)` — the validator, usable standalone.

---

## [0.10.0] - 2026-07-02

### Added

- **Incremental nullifier-set transfer (sealed chunks, PIR-A preserving).** New `IndexerClient` methods for the reader's chunked nullifier endpoints — the wallet persists the set locally and re-downloads only new chunks + the tail per rescan, instead of the full set:
  - `getNullifierManifest(): Promise<NullifierManifest | null>` — universal chunk index (identical for every caller); returns `null` on 404 so callers can fall back to `getAllSpentNullifiers` against older readers.
  - `getNullifierChunk(idx, digest): Promise<string[]>` — one immutable sealed chunk (ascending, lowercased). The digest lives in the URL: a corrected chunk is a different URL, safe to cache forever.
  - `getNullifierTail(): Promise<NullifierTail>` — the mutable remainder after the last sealed chunk; `afterChunks` detects a chunk sealed mid-sync.
  - New types: `NullifierManifest`, `NullifierChunkInfo`, `NullifierTail`.
  - No client-supplied position parameter exists anywhere in the flow — no wallet ever expresses interest in a specific nullifier or range (PIR-A preserved).
- `getAllSpentNullifiers` stays as the fallback path; its docstring now points new integrations at the chunk flow.

---

## [0.9.0] - 2026-07-02

### Changed

- **Vault note records now blind their on-chain identifiers at rest.** Previously `EncryptedNoteRecord` stored `commitmentHex`, `nullifierHex` and `assetId` in **plaintext** (for filtering without unlock), so a storage dump (disk image, DevTools, synced data) let anyone link the wallet to its on-chain notes/nullifiers. They are now stored as **blind tags** — `HMAC-SHA-256(blindKey, value)` under a vault blind key derived from the same master bytes (`deriveVaultBlindKey`). Equality lookups still work (compare tags); a dump reveals no linkable identifiers. `spent`/`spentAt` stay plaintext (local flags, no chain linkage).
  - `encryptNote(key, note)` → `encryptNote(key, blindKey, note)`.
  - `EncryptedNoteRecord` fields `commitmentHex`/`nullifierHex`/`assetId` → `commitmentTag`/`nullifierTag`/`assetTag`.
  - New exports: `deriveVaultBlindKey(masterBytes)`, `blindTag(blindKey, value)`, `noteBlindTag(blindKey, hex)`.
  - `decryptNoteRecord` recovers identifiers from the ciphertext (the tags are one-way), so the ZkNote round-trips unchanged.

---

## [0.8.1] - 2026-07-02

### Fixed

- **`getTransfersByNullifiers` / `getTransfersByCommitments` no longer silently lose results for inputs larger than 50.** The reader truncates every request to 50 items server-side; the SDK previously sent the whole array in one query string, so wallets with more than 50 notes silently missed private transfers (broken history rows and failed outgoing-transfer reconstruction). Inputs are now transparently chunked into requests of 50, fetched in parallel, merged per extrinsic (`blockNumber:extrinsicIndex`, matched arrays deduped), and sorted by block descending. These lookups remain a bounded, documented linkage tradeoff — they are never used for spent-status checks (PIR-A: status comes from the anonymous full-set `/shielded/nullifiers/all` download).

---

## [0.8.0] - 2026-07-01

Privacy alignment with Zcash's visibility model: the shielded pool's boundary is public, its interior is opaque. Per-address responses never expose note internals — a public sender→leaf mapping would shrink the pool's anonymity set for everyone. See the indexer's `docs/address-privacy.md` for the full policy.

### Changed

- **BREAKING: `ShieldedAddressEvent` reshaped to boundary-only.** `getAddressShieldedActivity` now returns `{ kind: 'shield' | 'unshield', blockNumber, extrinsicIndex, assetId, amount, timestampMs, hash }` — no more full commitment/unshield rows. The `'transfer'` variant is gone (the reader never returned it: private transfers carry no address, PIR-A). `amount` is null for shields (the shield amount lives in the extrinsic, not the index).

### Removed

- **BREAKING: `getAddressCommitments`.** Its backing route (`GET /address/:addr/shielded`) was removed from the reader: it returned full commitment rows (commitment hex, leaf index, memo, sender) keyed by depositor — exactly the sender→leaf labeling the privacy policy forbids. It had no consumers.
- **BREAKING: `ShieldedCommitment.sender`.** The reader no longer returns the depositor on any commitment response (`/shielded/commitments`, `/shielded/commitments/:hex`); a commitment→depositor reverse lookup enables the leaf-labeling attack one leaf at a time.

### Unchanged

- `getAddressUnshields` / `Unshield` — unshield rows are single-extrinsic public data (recipient, nullifier and amount all appear together in one public transaction); serving them adds no cross-tx correlation. Consumed by the wallet.

---

## [0.7.10] - 2026-07-01

### Fixed

- **`getAddressShieldedActivity` no longer lowercases the address.** SS58 addresses are case-sensitive (base58), so lowercasing corrupted them — the request either 404/400'd at the reader (a lowercased SS58 can contain characters outside the base58 alphabet) or failed to match rows. The address is now passed through as-is; the reader matches case-insensitively on its side, which correctly covers both SS58 and EVM (0x hex) inputs.

---

## [0.7.9] - 2026-07-01

### Fixed

- **`OrbinumClientProvider` reconnect backoff no longer resets on a flapping connection.** The backoff counter was reset to base on every `connected` transition, so a node that connected then immediately dropped would reconnect every `reconnectBaseMs` (default 3s) forever, hammering the node. The backoff is now reset only after the connection stays live for `stableAfterMs` (new config, default `10_000`); a flapping node backs off up to `reconnectMaxMs` instead. Reconnect delays also get **full jitter** (random in `[delay/2, delay]`) so many clients don't retry in lockstep after a shared outage.

### Added

- **`ClientProviderConfig.stableAfterMs`** — how long a connection must stay live before the reconnect backoff resets to base. Default `10_000`.

---

## [0.7.8] - 2026-06-29

### Added

- **`IndexerClient.getActivity(hours = 24)`** — returns transaction activity (signed extrinsics + EVM) bucketed per hour over the last N hours of chain time, from the indexer's `/stats/activity` endpoint. For sparklines / activity charts. New types `IndexerActivity` and `ActivityBucket`.

### Changed

- **`IndexerStats.extrinsics`** now includes `signed` alongside `total` (`{ total, signed }`). `total` counts all extrinsics including per-block inherents; `signed` counts user transactions only. Matches the indexer `/stats` response.

---

## [0.7.7] - 2026-06-29

### Added

- **`SubstrateClient.batchRequest(calls)`** — sends multiple Substrate JSON-RPC calls in a single HTTP request (batch), returning results in call order. PAPI's WebSocket transport does not expose batching, so this uses the node's HTTP RPC endpoint (derived from the WS URL: `ws://`→`http://`, `wss://`→`https://`). Cuts high-throughput backfill from N round-trips to 1 per window (e.g. block hashes, blocks, and `System.Events` reads for a whole window of blocks). Also exposed on the provider as `OrbinumClientProvider.rpcBatch(calls)`.
- **`jsonRpcBatch(httpUrl, calls, options?)`** (`utils/jsonRpcHttp`) — shared JSON-RPC 2.0 HTTP batch transport backing `batchRequest`. Retries on `429`/`503` with exponential backoff (honoring the `Retry-After` header), reorders responses by id, and maps any null / missing / per-call-error result to `null` in its slot. Public RPC nodes rate-limit bursty batches, so the client backs off rather than dropping work.

### Changed

- No breaking changes. `SubstrateClient` remains a thin wrapper over the PAPI WebSocket transport; the new HTTP batch path is isolated in `utils/jsonRpcHttp`, with `SubstrateClient.batchRequest` delegating to it.

---

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
