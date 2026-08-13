# Changelog

All notable changes to the Orbinum TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-08-12

**A restored vault no longer republishes an ephemeral key.**

`reservePairwiseIndex` returned `0` for a counterparty it had no record of,
which is correct on a first payment and a privacy leak on a restored wallet:
paying the same recipient again republished the ephPk of the first payment.
That value travels in the clear in memo bytes 148-180 and is served as an
indexer column, so anyone reading the public feed could group the two notes as
sharing a sender and a recipient — the linkage stealth addresses exist to
prevent.

The counter cannot be recovered. Unlike `selfEphCounter`, whose notes this
wallet decrypts and can therefore re-derive from a rescan, a pairwise index is
published on a note encrypted toward someone else and never appears in the
sender's own scan. Asking a server whether a given ephPk exists would reveal
which notes are yours, which is the query the scan's download-everything design
exists to avoid.

So it is not recovered but detected: `reservePairwiseIndex` now returns `null`
when it has no history for a counterparty, and `buildZkNote` degrades to a
random ephemeral — the rule both files already documented, applied to the case
that slipped through it.

### Changed

- **BREAKING (type):** `reservePairwiseIndex` returns `Promise<number | null>`.
  `null` means "no history", and callers must degrade to a random ephemeral
  rather than assume zero.
- A first payment to any counterparty now uses a random ephemeral. The
  recipient pays one full trial scan for it; every later payment to the same
  address takes the fast path as before. Privacy is not recoverable after the
  fact, performance is.

### Fixed

Both counters are read back from a config that survives restores, migrations,
backups and hand-editing, so it returns whatever JSON was on disk rather than
what this code wrote. Every value below corrupted an index SILENTLY instead of
failing, and each is now rejected in favour of restarting the sequence:

- a fractional index truncated on the u32 derivation write, so `2.5` and `2`
  published the same ephPk;
- a string concatenated instead of incrementing (`'3' + 1 === '31'`);
- `NaN`/`Infinity` derived from a meaningless index;
- a negative index wrapped to a huge one, leaving the note outside the
  recipient's lookup window;
- an index at `Number.MAX_SAFE_INTEGER` made the `+ 1` a no-op, freezing the
  counter so every later payment reused one index forever.

`reserveSelfEphIndex` shared all of the above and is sanitised the same way.

- `mergeCounters` compared counters with `Math.max`, which does not prefer the
  valid side: `Math.max(NaN, 9)` is `NaN`, so one corrupt side poisoned the
  merged value and it was then persisted. `Math.max('50', 9)` is worse — the
  string side won with an index that was never reserved. Non-numeric values on
  either side are now ignored, and counterparty entries are validated as they
  are read rather than only where they are compared, since an entry with no
  counterpart on the other side was copied through untouched.
- `windowSizeForCounter` turned the stored counter into a precompute bound with
  no ceiling. A counter of `NaN` produced an EMPTY discovery window, silently
  disabling the fast path for every note; `Infinity` made the window builder
  loop forever. A merely LARGE counter — which a long-lived wallet reaches with
  no corruption at all — asked for a window proportional to it, at two EC muls
  per entry, and hung the scan. The size is now clamped to `MAX_EPH_WINDOW`
  (64 windows); indexes past it are found by trial decrypt, which is slower and
  correct.

## [1.3.1] - 2026-08-09

**The sealed-chunk phase downloads with a 3-deep window, matching the tail.**
Previously the bulk of a full rescan kept a single next-chunk prefetch in
flight, paying one serialized round-trip per chunk. Now a sliding window of 3
requests (the shared `PREFETCH` constant) keeps the pipe full; on
bandwidth-bound connections total time is unchanged — in-flight requests share
the pipe — so the fixed depth is safe at every connection speed. Chunks are
still processed strictly in ascending leaf order: the cursor and checkpoint
invariants depend on it.

## [1.3.0] - 2026-08-08

**Scans now checkpoint per chunk — aborting no longer loses the work.**
Previously a scan persisted everything at the end: notes in phase 3, the cursor
in phase 4. Closing the tab (or aborting) at 90% of a long rescan threw away
every decrypted batch, and the next scan restarted from the old cursor. Now each
processed chunk/page saves its NEW notes and then advances the cursor, so a
rescan resumes right after the last completed batch. Newly discovered notes also
appear in the vault progressively while the scan runs instead of all at once at
the end.

### Added

- `onBatchDone` callback on `collectScanEntries` — awaited after each fully
  processed chunk/page (after `onPage`) with the highest valid leaf seen so far.
- `openSpentSet` in the spent-set phase: syncs the local nullifier cache once
  (chunks + a consistent tail snapshot) and returns a reusable handle for local
  membership queries. `resolveSpentSet` is now a thin wrapper over it.

### Changed

- `runScan` wires the checkpoints itself: per batch it saves the new notes with
  spent status resolved from the locally synced nullifier set (opened lazily on
  the first batch that finds a note — an incremental tick that finds nothing
  pays no nullifier sync), then persists the cursor. Existing vault notes are
  never rewritten mid-scan — a batch-save without the authoritative spent map
  could downgrade a spent note to unspent; phase 3 remains their only writer.
- Abort remains write-safe: the signal is re-checked immediately before every
  mid-scan write, so an identity-switch abort still prevents notes decrypted
  under one account's keys from landing in another account's vault.

## [1.2.0] - 2026-08-08

**Payment slips — a sender hands the recipient their note, no scan required.**
After a private transfer to another user, the sender can produce an `orbslip1:`
string and give it to the recipient, who rebuilds the note instantly instead of
walking the pool. The slip carries only public on-chain data — the recipient
output's commitment and encrypted memo — sealed toward the recipient so an
interceptor learns nothing, not even that a payment is expected. The recipient
opens it with their own viewing key, derives the stealth spending key, and gets a
fully spendable note; a forged slip reconstructs nothing because the recomputed
commitment must match the chain.

Built on the outgoing viewing key (ovk), a sender-side auditing key that also
lets a sender recover what they sent after a cold restore.

### Added

- **Payment slip (`src/protocol/memo/PaymentSlip.ts`).**
    - `sealPaymentSlip(recipientIvk, fields)` / `openPaymentSlip(recipientIvsk, envelope)`
      — seal a slip toward a recipient and open it (ECDH, ChaCha20-Poly1305,
      domain `orbinum-payment-slip-v1`). `openPaymentSlip` returns `null` for a
      slip that is not ours or is corrupt; it never throws.
    - `encodePaymentSlip` / `decodePaymentSlip` — the `orbslip1:{payload}:{checksum}`
      wire string; a mistyped or truncated slip fails the checksum and decodes to
      `null`.
    - `PAYMENT_SLIP_SCHEME`, and the `PaymentSlipFields` type
      (`commitmentHex`, `encryptedMemo`, `leafIndex?`, `txHash?`).
- **`importPaymentSlip(slip, keys)`** (`src/wallet/ops/notes`) — opens a slip and
  reconstructs a spendable `ZkNote` through the SAME decryption path a scan uses
  (`tryDecryptNote`): decrypt the memo, derive the stealth spending key, verify
  the commitment. Stamps the slip's `txHash` as the note's creating tx so history
  shows its origin. Returns `null` on a foreign or forged slip. Type
  `SlipImportKeys`.
- **`transferNotes` now returns `{ ...txResult, paymentSlip }`** for a transfer to
  another user (type `TransferResult`). Best-effort: sealing the slip can never
  fail the transfer, which has already landed on chain. Absent for self-transfers.
- **Outgoing viewing key (ovk).**
    - `deriveOutgoingViewingKey(masterBytes)` — `HKDF(masterBytes, "orbinum-ovk-v1")`,
      a sibling of the ivsk (neither derives from the other, so incoming- and
      outgoing-audit can be delegated independently). `PrivacyKeyManager` derives
      and exposes it (`getOutgoingViewingKey()`).
    - `sealOutgoingBlob` / `openOutgoingBlob` / `randomOutgoingBlob`,
      `deriveOutgoingCipherKey`, `OVK_BLOB_SIZE` (`src/protocol/memo/OutgoingBlob.ts`)
      — the 56-byte blob that wraps a memo's shared secret under the ovk.
    - `tryRecoverOutgoing(hint, ovk)` → `OutgoingNoteRecord` — rebuilds the public
      facts of a note the caller SENT (value, recipient stealth pk, blinding,
      counterparty). Never a spendable note: no spending key, no nullifier.
    - `NoteBuilder.build` seals an `ovkBlob` onto a stealth recipient note when an
      `outgoingViewingKey` is supplied (`NoteInput.outgoingViewingKey`); the blob
      is not persisted in the vault.
    - Types `OutgoingNoteRecord` (with `blinding`, needed to recompute the
      commitment) and `OutgoingHint`.

### Notes

- **The slip grants no spend power.** It holds only data already public on chain;
  the recipient derives the stealth spending key from their own identity. It is
  not a chain scan — only the one slip is opened.
- **Why it is still encrypted.** The fields are public, but pairing them off-chain
  would leak that this recipient is expecting this payment. Sealing toward the
  recipient hides that correlation.
- `leafIndex` is omitted from a sealed slip — a spend re-fetches the Merkle proof
  by commitment, so it is not needed to reconstruct.
- **Format constants are frozen** (`orbinum-payment-slip-v1`, the `orbslip1:`
  scheme); a golden vector pins them. Changing them requires a new version.
- **Residual, stated not hidden:** a leaked ovk lets an attacker fabricate a
  self-consistent outgoing record — it moves no funds (Zcash accepts the same
  residual), and the app runs recovery only over commitments from extrinsics that
  spent the wallet's own nullifiers. The on-chain wire for the blob is a separate,
  later change; this release ships the crypto and the sender-side slip.

## [1.1.1] - 2026-08-08

### Fixed

- **Note backups now carry spent status.** `encodeNoteBackup` records each note's
  `spent`/`spentAt`, and `importNotesFromBackup` applies them, so a restored vault
  separates available from spent notes instead of importing everything as
  available. The flags are local status, not secrets — no spending key travels.
  The `NoteBackupEntry` type gains optional `spent`/`spentAt` fields; older
  backups without them import as unspent.

## [1.1.0] - 2026-08-08

**Closed note backups — move notes between devices without re-scanning.** A
wallet can now export its notes to a plain JSON file and recover them on another
device, without walking the whole pool. The backup carries only public data
(commitment + encrypted memo), never a spending key: ownership is proven by
DECRYPTING each memo with the importer's own viewing key. A note that decrypts is
theirs and comes back fully spendable (the stealth spending key is derived from
their identity); a note that does not decrypt belongs to someone else and is
skipped. It is not a chain scan — only the backup's own memos are tried.

### Added

- `encodeNoteBackup(notes)` / `decodeNoteBackup(json)` — the closed `NoteBackup`
  format (`{ v, ts, notes: [{ commitmentHex, encryptedMemo, leafIndex? }] }`).
  Public data only; no keys travel.
- `importNotesFromBackup(entries, keys)` — decrypts each entry's memo with the
  importer's `{ viewingSecretKey, spendingKey, ownerPk }` and returns the notes
  that belong to them as spendable `ZkNote`s. Foreign notes are silently skipped.
- Types `NoteBackup`, `NoteBackupEntry`, `BackupImportKeys`.

### Notes

- The Merkle proof and `leafIndex` are not needed to import — a spend re-fetches
  the proof by commitment, so an imported note is spendable as soon as its
  commitment is still on chain.
- Complements the existing QR note-transfer path (`encodeNoteTransferPages`),
  which remains for scanner-based device-to-device transfer.

## [1.0.1] - 2026-08-08

**Privacy addresses gain a checksum (`orbpriv2`).** A privacy address travels by
copy/paste and QR; `orbpriv1` had no integrity check, so a single corrupted
character still parsed — and a payment built on a mangled `ownerPk` lands in a
note nobody can ever spend. This release adds a checksummed format so a
corrupted address fails to decode instead of silently burning funds.

This is the first step ("Fase 0") of the receive-side roadmap in
[`docs/notes/build-on-orbinum.md`](./docs/notes/build-on-orbinum.md): a
verifiable address is the data contract every later piece (on-chain registry,
resolver, indexer) reads and writes.

### Added

- `orbpriv2:{ownerPk}:{ivk}:{checksum}` — the checksum is the first 4 bytes of
  `sha256("orbpriv2:{ownerPk}:{ivk}")`, as 8 lowercase hex chars.
  `PrivacyKeyManager.encodePrivacyAddress()` now emits this format.

### Changed

- `PrivacyKeyManager.decodePrivacyAddress()` verifies the checksum for
  `orbpriv2` inputs (a mismatch returns `null`) and **still reads legacy
  `orbpriv1`** addresses so anything shared before this release keeps resolving.

### Safety

- **No effect on existing notes or keys.** The address codec is not used
  anywhere in note discovery, spending, key derivation, or the vault — it only
  encodes the two public values (`ownerPk`, `ivk`) a sender needs. Field
  semantics are unchanged (`ownerPk` is still the BJJ x-coordinate scalar, `ivk`
  the packed LE point), so commitments, nullifiers and the circuit are
  untouched. Notes received on 1.0.0 remain fully spendable.
- Forward-compat caveat: an `orbpriv2` address is not readable by 1.0.0. This
  only matters when a 1.0.1 user shares their address with someone still on
  1.0.0 for a _new_ payment; it resolves once both update.

## [1.0.0] - 2026-08-07

**The SDK becomes the complete wallet.** Before this release it published
cryptography and chain access; a third party wanting private notes had to
reimplement roughly 5,200 lines of vault, scanner and spend logic — including
the parts where getting it wrong costs privacy or funds. Now the package owns
all of it, and a host supplies only UI, transport and platform adapters.

Everything breaking is here, on purpose. A package meant to be built on cannot
break on minor bumps, so the whole reorganisation lands at once and what follows
is additive.

The four capabilities a wallet could not previously get from this package:

|                   | What a consumer had to write                                    | What they call now                                    |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| **Store notes**   | encrypted IndexedDB layer, atomic counters                      | `VaultStore`                                          |
| **Find notes**    | O(pool) scan, spent-set intersection, cursors                   | `runScan`                                             |
| **Spend notes**   | merkle-root reconciliation, cross-tree guard, change derivation | `transferNotes` / `unshieldNote`                      |
| **Stay portable** | —                                                               | one build, no browser API outside the adapter subpath |

`examples/node-wallet` runs the whole flow in CI against the packed tarball,
importing only published subpaths — which is the only honest proof the package
is self-contained.

### Changed

- **BREAKING — `polkadot-api` and `@polkadot/util-crypto` are now peer dependencies.**
  Add them alongside the SDK:

    ```bash
    pnpm add @orbinum/sdk polkadot-api @polkadot/util-crypto
    ```

    They are singletons in practice. As hard dependencies, an application that
    already used `polkadot-api` ended up with a second copy — a second connection
    and a second view of chain state. The host owns the version now.

- **The README's quick start no longer describes an API that does not exist.**
  It documented `client.rpcV2.privacy.getMerkleRoot()` and
  `client.rpcV2.chain.isValidator()`; there is no `rpcV2` property. The real
  accessors are `client.privacy` and `client.chain`. Every symbol in the README
  is now checked against the exports.

- **BREAKING — `src/` is organised in four layers, and the root barrel follows
  them.** Twenty flat directories became five, each depending only downward:

    ```
    foundation/  encoding, crypto, formatting     no dependencies of its own
    protocol/    what a note IS                   pure and offline, no chain
    chain/       talking to a node                needs a connection
    wallet/      using notes                      needs both
    adapters/    platform implementations
    ```

    Nine of the twenty old directories were chain transport — `client`, `evm`,
    `evm-explorer`, `extrinsic`, `precompiles`, `relayer`, `rpc-v2`, `substrate`,
    `zk-verifier` — sitting beside `vault` and `scanner` with nothing to say which
    layer was which. They are now `chain/`.

    **The published subpath names do not change.** `@orbinum/sdk/worker` and
    `@orbinum/sdk/storage/indexeddb` are what they always were; only the source
    they are built from moved. A consumer importing from the root or either
    subpath needs no change — the exported surface is identical, asserted against
    a snapshot taken before the move.

    The root barrel went from 578 lines of 94 loose statements to 81 organised by
    layer. `export *` was deliberately NOT used throughout: it leaked 37 internals
    into the public API — the precompile ABI encoder, `resetVaultToEmpty`,
    `fastMulBase` — so the layers with internal detail are exported by name.

- **Fixed a dependency cycle between two published subpaths.** `worker` imported
  `scanAbortError` from `scanner`, and `scanner` imported the pool from `worker`.
  Eight lines of function, but a cycle between subpaths survives only as long as
  the bundler deduplicates it. `abort` now lives in `foundation/errors/`, which
  neither layer owns.

### Added

- **`runScan` — finding your own notes without telling anyone which they are.**

    A scan is O(pool): every note on the network costs one elliptic-curve
    multiplication, and the answer is "not mine" almost always. Three routes cut
    that, and all three are now in the package: deterministic self- and
    pairwise-ephemerals turn the check into a hash lookup — 0.10 µs against the
    895 µs ECDH it replaces — and view tags reject most of the remainder before
    any curve work at all.

    **`NullifierSource` has no per-nullifier lookup, and that omission is the
    design.** The wallet downloads the spent set and intersects locally, so every
    request the server sees is identical regardless of which notes the caller
    holds. Asking "is nullifier X spent?" is the obvious API and it tells the
    server exactly what you own — a third party writing this themselves would get
    it wrong by default.

- **`transferNotes`, `unshieldNote`, `claimFees` — spending, minus the
  transport.** Each takes a `submit` callback; the host owns the chain client
  and the signer. What the SDK owns is the part that fails silently when
  guessed:
    - **Merkle-root reconciliation.** The circuit proves both inputs under ONE
      root, but each RPC fetch resolves under its own best block. A commitment
      landing between the two leaves the proofs on different roots and witness
      generation dies on an assert. The loop refetches until they agree — after
      ruling out inputs from different forest trees, whose roots can never agree.
    - **Change-note key derivation.** The change goes back to the sender under a
      viewing key derived from the INPUT's spending key, so a rescan under the
      same identity reopens it. Its `counterpartyPk` records the recipient's
      ONE-TIME stealth key, never their stable identifier.
    - **Little-endian commitment encoding.** `buildShieldParams` gets this right;
      the obvious big-endian guess is accepted by the chain and produces a note
      nobody — not the sender, not a rescan, not the recipient — can ever find.

- **`planTransfer` / `planUnshield` / `spendableBalance`** — the arithmetic a UI
  needs before it can enable a button, including the circuit rules a host would
  otherwise half-enforce per screen. `planUnshield` encodes that the unshield
  circuit proves exactly ONE input, so a balance spread across two notes cannot
  cover an amount either alone can't.

- **`OrbinumWallet`** — the assembled facade. Roughly twenty lines to a working
  private wallet, with the pieces still usable directly when a host needs a
  different shape.

- **Identity persistence: `cacheSession`, `restoreSession`, device keys.**
  Without this a user signs on every launch, and on Substrate that is worse than
  friction: **sr25519 signatures are randomised**, so a second signature over
  the same message derives a DIFFERENT key and a different vault. The cache is
  what makes an identity stable across restarts.

    Encrypted at rest under a device key that is non-extractable where the
    platform allows it, and scoped per `(chainId, account)` because the chain is
    part of the derivation.

- **`palletErrorKind` / `classifyChainError`** — what a wallet should DO about a
  chain failure: retry, resync, purge, or give up. The words shown to a person
  stay with the host; the reaction does not.

    The taxonomy separates `UnknownMerkleRoot` from a genuine ghost note, which
    had been conflated. Both are proof-versus-tree failures, but a ghost note is
    gone for good and gets purged, while a stale root means the note IS on chain
    and a rescan fixes it. Purging on the latter deletes live, spendable notes.

- **Chain constants a wallet cannot derive**: `MIN_GASLESS_FEE` (the runtime's
  `MinGaslessFee` — `planTransfer` requires a `fee` and a host had no basis to
  pick one), `NATIVE_ASSET_ID`, `isNativeAsset`, `TRANSFER_INPUTS/OUTPUTS`.

- **Note transfer between a user's own devices** — `orbinum://notes/v1/` pages,
  encoded for QR. Hand-rolled base64url rather than `btoa`, because React Native
  has neither it nor Buffer, and a wire format a mobile client cannot decode is
  not a wire format.

- **`parseAmount` / `formatAmountPlain`** — display ↔ planck. The SDK had
  planck→display and not the inverse, which is the direction that decides how
  much money a spend moves.

- **`VaultStorage` — the persistence contract a wallet runs on.** `src/vault/types.ts`
  had promised this in a comment ("any backend — IndexedDB, SQLite, remote — must
  produce/consume this shape") without ever declaring it. Now it is a type, split
  by responsibility so an implementation can grow one concern at a time:
  `NoteStorage` (config + notes), `NullifierCache`, `TxHistoryStore`.

    `updateConfig` is part of the contract rather than sugar over get + put, and
    that is a protocol requirement: two callers doing a read-modify-write
    separately both read the same `selfEphCounter`, derive the same ephemeral
    index, and publish the same ephPk. A backend that cannot make it atomic cannot
    host a vault.

- **`@orbinum/sdk/worker` — the trial-decryption kernel and its worker pool.**
  `decryptHintBatch` is where a wallet scan spends its time: one elliptic-curve
  multiplication per note in the pool, with three routes orders of magnitude
  apart (precomputed-window hash lookup, view-tag filter, full decryption).

    Its own entry point so a worker bundle carries the decryption path and nothing
    else — measured at 644 KB in the reference app, with zero references to the
    chain client.

    The worker is not shipped, and cannot be: `new Worker(new URL(..., import.meta.url))`
    is rewritten by a bundler at build time and would resolve differently under
    Vite, webpack and Node. `createDecryptPool` therefore takes the factory as a
    required argument — pass `null` to run the same kernel on the calling thread,
    which is correct everywhere and the only option outside a browser.

- **`WalletSession` + `createWalletSession()` + `requireSessionKeys()`** — the
  keys that exist only while a vault is open, as a two-field interface a host
  can satisfy over its own state container.

    It holds keys and nothing else. An application's session state usually tracks
    the decrypted notes too, because its UI re-renders off them — but that is
    reactivity, and pulling it in would drag a framework's update semantics into
    the SDK. `requireSessionKeys` is the one definition of "unlocked": a half-open
    session throws `VaultLockedError` rather than handing back a null key.

- **`MemoryVaultStorage`** — a working backend for consumers with no persistence
  (a server rebuilding state per request, a test harness), and the second
  implementation the conformance suite runs against. A contract verified by one
  implementation only describes that implementation.

- **`SubstrateClient.adopt(papi, httpUrl?)` — use a chain connection the caller
  already has.** `connect()` builds its provider internally, so an application
  with its own connection manager ended up with two WebSockets and two views of
  chain state. `OrbinumClient.connect()` accepts the same thing:

    ```ts
    const client = await OrbinumClient.connect({ papi: myExistingClient });
    ```

    An adopted client is **not owned**: `destroy()` leaves it running, because the
    rest of the application is still using it. `connect()` is unchanged and still
    closes what it opened. `batchRequest` needs an HTTP endpoint that cannot be
    derived from an arbitrary transport, so it throws with a specific message
    unless one is passed.

- **Subpath exports** — `@orbinum/sdk/storage/indexeddb` and
  `@orbinum/sdk/worker`, declared and built but intentionally empty.

    They are reserved now because adding a subpath _after_ code has shipped from
    the root entry is a breaking change, and both will hold environment-specific
    code: browser persistence and the worker-side decrypt kernel. Reserving them
    up front is what lets the wallet layer arrive as additive minors, and keeps a
    Node consumer from carrying IndexedDB code it can never run.

- `"sideEffects": false`, so a consumer that never imports the browser adapter
  can tree-shake it away.
- `./package.json` in the exports map, for tooling that reads the manifest.
- `tests/packaging.test.ts` — asserts every declared subpath has a source entry,
  is built, and exposes types/import/require, and that the peers are declared as
  peers rather than dependencies. These break only for consumers; a `link:`-ed
  checkout resolves `src/` directly and sails past all of them.

### Fixed

Moving the wallet into the package meant auditing it as library code rather than
as one application's internals. Every fix below is covered by a test that fails
when the fix is reverted.

**Privacy**

- **Ephemeral index reuse through a stale config snapshot.** Two callers doing a
  read-modify-write on `selfEphCounter` separately both read the same value,
  derived the same ephemeral index, and published the same `ephPk` — publicly
  linking two notes. Irreparable once on chain. `updateConfig` is now atomic and
  part of the storage contract.
- **ECDH shared secrets outliving `lock()`.** The precomputed discovery window
  holds secret material derived from the viewing key and is cached at module
  scope; it survived a vault lock until `clearKnownEphWindow` was called.

**Funds**

- **A successful transfer or unshield never marking its inputs spent.** The
  balance kept counting money the chain had taken, and the next spend died on a
  duplicate nullifier. The reference app compensated for this locally, which is
  what hid it.
- **Nullifier hex case making spent notes look spendable.** Normalised at
  ingestion, both on the tail and chunk paths.
- **A stale merkle root purging a live note** — see `classifyChainError` above.
- **A scan that outlived an account switch writing into the wrong vault.** The
  scan reads its keys once but persists through storage the host re-points on a
  switch, so it decrypted with one account's keys and saved into another's. The
  pipeline now has a checkpoint before its first write.
- **`randomBlinding` returning zero.** Any non-zero multiple of `BN254_R`
  reduced to 0; the guard checked before reducing rather than after.

**Availability**

- **One corrupt record wiping an entire vault.** Unlock now keeps every note
  that decrypts and only fails when NOTHING does.
- **An empty feed purging every note.** The purge is gated on having actually
  scanned hints, not on the feed being empty.
- **A poisoned scan cursor blinding a wallet permanently.**
- **A partial unlock leaving the wallet reporting `unlocked: true` with no
  notes.** Unlock is now atomic: a failure re-locks.
- **Zero-entropy signatures deriving a reproducible spending key.** A signer
  returning constant bytes now throws instead of producing a key anyone could
  reconstruct.

**Portability**

- **`btoa`/`atob` in the vault's encryption path.** React Native has neither, so
  the first note a mobile wallet tried to save threw `ReferenceError` and the
  vault never opened. Replaced with a hand-rolled implementation whose output is
  byte-identical to `btoa` across all 256 byte values — existing vaults still
  open, which is asserted rather than assumed.
- **`window` read unguarded by the extension-discovery helpers.** React Native,
  Node, Cloudflare Workers and an extension's own service worker all lack it.
  `hasInjectedExtensions()` gives a checkable answer; `getInjectedExtensions()`
  returns an empty list off-page instead of throwing.
- **`MessageEvent` / `ErrorEvent` in the published root `.d.ts`.** Both are
  `lib.dom`; a React Native consumer compiling with `lib: esnext` and no
  `@types/node` could not typecheck an import it never asked for.
- **`DOMException` constructed unconditionally** on the abort path.

Known limitation, stated rather than hidden: `poseidon-lite` decodes its round
constants with `atob` at module load, so a React Native host must polyfill it
before importing the SDK. The README lists the two globals a mobile runtime
needs.

## [0.25.1] - 2026-08-07

### Fixed

- **Proving on mobile** — bumps `@orbinum/proof-generator` to `5.1.0` and threads its new `singleThread` option through the three proof entry points.

    A user on Android reported `Unshield failed: Failed to execute 'postMessage' on 'Worker': Data cannot be cloned, out of memory.` snarkjs parallelises curve arithmetic through `ffjavascript`, which spawns one Web Worker per logical core, each carrying its own `WebAssembly.Memory`. On a phone that is roughly eight heaps against a per-tab budget a fraction of a desktop's, and transferring the WASM buffer fails outright. The same build proves fine on desktop — a platform limit, not a logic bug.

    Nothing in the SDK needs configuring: `generateProof` is called without `singleThread`, so `@orbinum/proof-generator` decides from the device (`navigator.deviceMemory` at or below 4 GiB, or a mobile user agent). The proof is byte-identical either way, only slower.

### Added

- **`ProofOptions`** (`src/proof-generator/options.ts`): one declaration for the options every proof entry point accepts, replacing the same inline shape written three times. Gains `singleThread`, for a host that knows better than the device heuristic — a desktop app certain of its environment, or a benchmark pinning one mode.

    `toGenerateOptions` omits an unset flag rather than forwarding `undefined`, because the package reads an ABSENT `singleThread` as "decide for me" and an explicit `false` as "use threads". Passing `undefined` would disable the heuristic on exactly the phones it exists for.

- **`shouldProveSingleThreaded`**: re-exported from `@orbinum/proof-generator`, so a host can ask the same question the SDK does before deciding.

## [0.25.0] - 2026-08-06

### Added

- **Pairwise ephemeral keys — a note from a known counterparty costs a hash lookup instead of an elliptic-curve multiplication.** `derivePairwiseSharedSecret`, `derivePairwiseEphSk` and `pairwiseEphWindow`, mirroring the existing `selfEph` module.

    A wallet scan is O(pool): every note in the network costs one ECDH, and the answer is "not mine" 99.99% of the time. `selfEph` already removed that cost for the wallet's own notes by deriving their ephemeral deterministically. This does the same for notes _between two parties who know each other_:

    ```
    sharedSecret = ECDH(myViewingSk, theirViewingPk)     (symmetric)
    ephSk_i      = SHA256("orbinum-pairwise-eph-v1" ‖ ss ‖ u32le(i))
    ```

    The sender publishes the derived ephemeral in the field it already publishes — the memo's last 32 bytes — so the receiver, who can compute the same value, recognises the note by looking it up in a precomputed window. **No protocol change, no new field, no migration**: the wire format is untouched and a wallet that knows nothing about this still recovers the note the slow way.

    Measured: window lookup **0.10 µs** against **895 µs** for the ECDH it replaces. Building a window costs ~905 µs per entry, paid once per counterparty and reused across the whole scan — at a 1M-note pool that amortises to 0.16 µs/hint.

    **Scope, stated plainly**: this helps only where a shared secret exists, i.e. where the receiver has the sender's privacy address. A wallet restoring from seed with no address book still pays the full O(pool) scan, and a stranger's first payment is unaffected. It converts the steady-state case, not the worst case.

    **Viewing keys are used rather than spending keys** deliberately. The pair secret is held by both sides, so it will exist on two devices and in whatever backup either party keeps; deriving it from spending keys would make a compromise of one party's stored secrets bear on the other's ability to spend. With viewing keys the worst case is disclosure of which notes those two parties exchanged — visibility a viewing key already confers — and nothing about authority to spend.

    **Counter reuse is the one way this loses privacy**: republishing an index republishes the same ephemeral, publicly linking the two notes as sharing a sender-receiver pair. `pairwiseEphWindow` is a pure function of (secret, range) so the caller owns that state, exactly as with `selfEph`. Callers must persist the counter and never reuse it.

    Matching is intended to happen **client-side**. Asking a server for a specific ephemeral would tell it which notes are yours, which is what a download-everything scan feed exists to prevent.

## [0.24.0] - 2026-08-06

### Changed

- **`deriveViewingPublicKey` and `deriveOwnerPk` are ~95× faster.** Both still ran on `@zk-kit/baby-jubjub`'s `mulPointEscalar` — a plain double-and-add over raw bigints — while the rest of the shielded-pool code had long since moved to the noble-backed `fastMulBase`. Measured on an M-series laptop under Node 22: **56 ms → 0.59 ms** per generator multiplication, with byte-identical output.

    Both functions produce on-chain formats (the packed ivk a sender encrypts to, and the `ownerPk` a commitment binds), so the port is pinned by an equivalence suite rather than trusted: `tests/utils/bjj-fast.test.ts` now asserts the derived values match the old implementation across a spending-key sweep and the edge scalars (1, suborder−1, over-suborder). A drift here would not throw — it would silently produce keys that decrypt nothing and notes that can never be spent.

    Every caller benefits without changing anything: wallet startup through `PrivacyKeyManager`, private transfers, unshields, and per-note vault validation.

- **`bjj-fast`'s documented timings were wrong and are now corrected.** The module claimed "0.056 ms vs 0.94 ms per mul". Scalar multiplication cost is dominated by the scalar's **bit length**, and those figures came from a small scalar — they do not transfer to the real case. With a full-width 247-bit viewing key, the numbers are roughly an order of magnitude higher; the header now carries the measured table and states the dependency explicitly, so the next reader does not plan against a figure that cannot be reproduced.

### Added

- **`@orbinum/sdk/bench`** — a separate entrypoint exposing deterministic fixtures (`benchWallet`, `plantSchedule`, `generateHintAt`, `buildManifest`, `SeededBytes`) that generate synthetic scan hints with **real** encrypted memos from a seed. They exist so a wallet benchmark and an indexer seeder, in different repositories, can build byte-identical datasets for scale testing.

    Deliberately **not** re-exported from the package root: these are test fixtures, not wallet API, and bundling them cost every consumer ~21 KB of generator code for something no application calls. The main bundle shrinks from 163.65 KB to 142.87 KB (ESM) as a result. No stability guarantee applies to this subpath — the shape of a generated hint may change whenever a benchmark needs it to.

## [0.23.0] - 2026-08-03

### Changed

- **`@orbinum/proof-generator` 4.0.0 → 5.0.0.** That release drops `CircuitType.PrivateLink` and its id-5 entry, matching the circuit's retirement on chain in 0.22.0. Nothing in this package referenced it, so the surface here is unchanged — but the pin has to move or an install resolves a generator that still offers a circuit the runtime answers with `CircuitNotFound`.

## [0.22.0] - 2026-08-03

### Removed

- **BREAKING — `AccountMappingModule`, `AccountMappingPrecompile` and everything around them.** The node dropped `pallet-account-mapping` and its precompile at `0x0800`; calls to either now fail on chain, so shipping the bindings would only let callers build transactions that revert.

    Gone from the public API: `AccountMappingModule`, `AccountMappingPrecompile`, `client.accountMapping`, `client.precompiles.accountMapping`, `PRECOMPILE_ADDR.ACCOUNT_MAPPING`, `AM_SEL`, the `SignatureScheme` enum and `SLIP0044_NAMESPACE`, plus the types `ChainLink`, `PrivateLink`, `AccountMetadata`, `AliasInfo`, `AliasFullIdentity`, `ListingInfo`, `AccountListing`, `SupportedChain`, `ResolvedAlias`, `AddChainLinkParams`, `SetMetadataParams`, `PutOnSaleParams` and `DispatchAsLinkedParams`.

    There is no replacement. Aliases, chain links and the marketplace have no equivalent; the proxy-dispatch routes (`dispatchAsLinkedAccount`, `dispatchAsPrivateLink`) were removed from the runtime rather than reimplemented.

- **BREAKING — `CircuitId.PrivateLink` (5).** The circuit is unregistered on chain and its verification key purged, so proofs built against it fail with `CircuitNotFound`. `tests/zk-verifier/circuit-id.test.ts` now asserts the id cannot come back without a matching node-side circuit.

### Changed

- **EVM → Substrate address derivation is unaffected**, but its docs were wrong. `evmToImplicitSubstrate` and `evmToMappedAccountHex` described the `H160 ++ [0x00; 12]` rule as `pallet-account-mapping`'s "fallback when there is no explicit `map_account` entry". It was never a fallback in the sense that mattered here — the mapping is structural and lives in runtime code, so it is the only rule and always was for callers that never registered an explicit entry. Behaviour is identical; only the comments changed.

## [0.21.1] - 2026-08-01

### Fixed

- **`treeId` never reached callers.** 0.21.0 added the field to `RpcV2MerkleProof` and `RawRpcV2MerkleProof`, but `PrivacyModule` was left mapping the pre-forest fields only, so every proof came back with `treeId: undefined` no matter what the node reported. Consumers deriving the forest tree from a proof — the app's cross-tree transfer guard among them — silently fell back to their `leafIndex` heuristic instead of using the value the chain had already resolved.

## [0.21.0] - 2026-07-30

### Added

- **Forest-aware coin selection.** A transfer proves both of its inputs under a single public `merkle_root`, so a pair must now share a forest tree as well as a `circuitVersion`. Notes in different trees anchor to different roots and can never converge, no matter how many times the caller refetches — the previous code would burn its whole retry budget discovering that. `selectNotes` returns `{ needsConsolidation: true }` when a cross-tree pair _would_ have covered the amount, so a caller can distinguish "your funds are stranded across trees" from "you don't have enough" instead of reporting the wrong one.

- `treeIdOf(note)` — derives the forest tree from a note's leaf index. `LEAVES_PER_TREE` is pinned to 2^20 to match the runtime's `MaxLeavesPerTree`, which the pallet's `integrity_test` forbids from ever changing on a live chain. That on-chain guarantee is what makes deriving tree membership client-side safe, rather than a cached assumption that can silently go stale.

- `ZkNote.leafIndex?` — the note's global Merkle position, populated by `NoteDecryptor` from the scan hint. Optional by design: a vault written before the forest existed needs no migration, and a note with no index necessarily predates the first seal, so tree 0 is the correct answer rather than a fallback.

- `treeId` on `RpcV2MerkleProof` / `RawRpcV2MerkleProof`, mapped through `PrivacyModule`. Absent when talking to a pre-forest node, hence optional rather than defaulted.

### Security

- **A malformed `leafIndex` can no longer strand a wallet's funds.** Scan hints come from the indexer, which is a performance dependency and never a correctness one — but the leaf index was being copied into the vault unvalidated. A single hint carrying `NaN` was enough: `NaN !== NaN` makes every same-tree comparison false, so no pair passes selection and the entire balance becomes unspendable through the normal path. `NoteDecryptor` now persists the index only when it is a valid u32, and `treeIdOf` independently falls back to tree 0 for anything malformed — the second check covers vault entries written before the first one existed.

## [0.20.1] - 2026-07-27

### Fixed

- **An SS58 address no longer rotates the spending key when its network prefix changes.** The address string is load-bearing twice — it goes into the signed payload _and_ into the HKDF `info` — and SS58 encodes the same public key differently per prefix (`5Grwva…` under the generic prefix 42, `kcuMUg…` under 2700). A wallet listing an account under one prefix today and another tomorrow (a wallet setting, a chain-metadata update) therefore derived a **different** spending key for the same account, and the user opened the app to an empty vault with no error: a fresh, valid, empty identity rather than a failure. `canonicalAccountId` now reduces SS58 to the underlying 32-byte public key before it reaches either the message builder or the KDF, so every prefix of one account maps to one identity. EVM addresses pass through lowercased and unchanged. Regression tests pin that the derived key and the signed Substrate message are identical across prefixes 0, 42 and 2700, and that distinct accounts stay distinct.

### Added

- `canonicalAccountId(address)` — the identifier derivation actually uses. Exported so callers can key their own per-identity storage the same way instead of on a prefix-dependent string.

## [0.20.0] - 2026-07-27

### Removed

- **BREAKING: v1 spending key derivation is gone.** `deriveSpendingKeyMessage`, the `KeyVersion` type and the `version` parameter on `deriveMasterKeyBytes` / `deriveSpendingKeyFromSignature` have all been removed. 0.19.0 kept v1 exported so existing notes could be swept into a v2 identity, but on testnet the trapped value is disposable and keeping the old builder alive kept its harvestable `personal_sign` payload reachable from any caller — the exact surface 0.19.0 set out to close. There is now one derivation path and no way to reach the old one.

    **Migration**: nothing to do if you were already on the 0.19.0 defaults. Drop the fourth `version` argument if you passed it explicitly; passing `'v1'` has no replacement by design. Notes shielded under a v1 identity are not readable with a v2 key — users re-shield.

    Regression tests assert the symbol is absent from both the module and the package root, that no builder emits the `orbinum-spending-key-v1` tag, and that derivation never produces the v1 HKDF domain.

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

- `computeNoteCommitment(value, assetId, ownerPk, blinding)` — computes a note commitment (`Poseidon4`), mirroring `NoteCommitment` in `note.circom`. Exported so wallets can verify a stored note against its on-chain commitment _before_ proving. The ZK circuits ignore the ownerPk supplied by the caller and rebuild the commitment from `BabyPbk(spending_key).Ax`; if a stored note's spendingKey, value, assetId or blinding drift from what was committed on-chain, witness generation fails on the Merkle constraint with an opaque `Assert Failed` (e.g. `Unshield_164 line: 82`) after seconds of proving. Recomputing the commitment with `deriveOwnerPk(spendingKey)` and comparing it against the note's `commitmentHex` detects the drift up front — wrong session key (non-deterministic signers: smart/MPC wallets), a mis-recovered stealth key, or a corrupted vault note. Covered by tests pinning it byte-identical to `NoteBuilder`'s commitment, including the re-derived-ownerPk path and the LE `commitmentHex` round-trip.

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

- **`ShieldedPoolModule`** — eliminado `Binary.fromHex()` en campos de tamaño fijo `[u8;32]` (`merkle_root`, `nullifier`, `change_commitment`, `commitments`, `nullifiers`). El codec `SizedBytes(N)` de PAPI espera una cadena hex directamente; envolver con `Binary.fromHex()` devuelve un `Uint8Array` que falla el check de compatibilidad de tipo, generando el error _"Incompatible runtime entry Tx(ShieldedPool.unshield)"_.
- **`SubstrateClient.submitUnsignedAndWatch`** — cambiada la firma de `(bareTxHex: string)` a `(bareTx: Uint8Array)` y eliminada la llamada `Binary.fromHex()`. `getBareTx()` de PAPI devuelve `Promise<Uint8Array>`, no un hex string; la conversión corrupta los bytes y el nodo rechazaba la tx con _"ExtrinsicFormat 0 not valid"_.
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
