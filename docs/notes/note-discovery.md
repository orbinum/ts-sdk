# Note Discovery

How a wallet finds its notes — and how it learns which are spent — without
telling any server which notes it owns.

Part of the [note model](./README.md) series — this is the **find**
station of a note's life.

---

## 1. The problem

A note's commitment reveals nothing about its owner. That privacy has a price:
**the owner cannot be told about their own notes either.** The only way to find
them is to try to open every memo in the pool.

A scan is therefore O(pool): one ECDH per published note, where the answer is
"not mine" for almost every one. Measured on this codebase, a single trial
decryption costs ~895 µs of elliptic-curve work. At a million notes that is
unusable — everything in this document exists to avoid paying it.

## 2. The memo

Beside every commitment the chain stores a 180-byte encrypted memo:

```
memo (180 bytes) = nonce (12) ‖ ciphertext (136 = plaintext 120 + MAC 16) ‖ ephPk (32)
```

The sender encrypts the note's preimage to the recipient's **viewing key** via
ECDH with a fresh ephemeral keypair, publishing the ephemeral public key as the
memo's last 32 bytes. The recipient computes the same shared secret from their
viewing secret key and the published `ephPk`, and decrypts (ChaCha20-Poly1305).

The plaintext carries the note's fields **and its circuit version** — which is
why a note found by scan is immediately spendable under the right verifying key.

## 3. Three shortcuts past the ECDH

The scan tries the cheap paths first; the full ECDH is the last resort.

### Self-ephemeral windows — your own notes

When a wallet builds a note _to itself_ (change, self-transfer, shield), it does
not pick a random ephemeral. It derives one deterministically:

```
ephSk_i = SHA256("orbinum-self-eph-v1" ‖ spendingKey_LE32 ‖ u32le(i))
```

The wallet can therefore precompute the window of ephemeral public keys it would
have published — indices `0..N` — and recognise its own notes by a **hash
lookup** on the memo's `ephPk` field: ~0.10 µs against the 895 µs ECDH it
replaces.

The index `i` comes from the vault's `selfEphCounter`, reserved atomically
before use ([vault.md](./vault.md) §4) — a reused index republishes the same
`ephPk` and publicly links two notes.

After a restore from seed the counter is unknown; `resolveSelfEphCeiling` grows
the window until it finds a run of indices with zero matches, then bumps the
counter past the highest discovered index so new notes never collide with old
ones.

### Pairwise windows — known counterparties

The same trick, per relationship. Both sides of a payment can compute:

```
sharedSecret = ECDH(myViewingSk, theirViewingPk)        (symmetric)
ephSk_i      = SHA256("orbinum-pairwise-eph-v1" ‖ ss ‖ u32le(i))
```

A sender who has the recipient's privacy address publishes the derived
ephemeral; the recipient recognises it by lookup in a per-counterparty window.
No protocol change and no new field — the wire format is untouched, and a
wallet that knows nothing about this still recovers the note the slow way.

Scope, stated plainly: this converts the steady-state case (repeat
counterparties), not the worst case. A wallet restoring with no address book
still pays the full scan, and a stranger's first payment is unaffected.

### Which ephemeral an operation publishes

One decision, made in `buildZkNote` and honoured by `NoteBuilder` on every path:

```
                      viewingPublicKey present?
                              │
              ┌───────────────┴───────────────┐
             no                              yes
              │                               │
      shield · change              counter for this counterparty?
      self-transfer                          │
              │                   ┌───────────┴───────────┐
      deriveSelfEphSk            yes                     no
      (deterministic)             │                       │
              │           derivePairwiseEphSk       randomBytes(32)
              │           (deterministic)           first payment, or
              │                   │                 counter lost
              ▼                   ▼                       ▼
      recipient: lookup   recipient: lookup      recipient: full scan
      sender:    n/a      sender: RECOVERS       sender: cannot recover
```

The derived point is PRF-derived and indistinguishable from a random one to
anyone without the pair secret — the same argument that makes `selfEph` and
BIP-32 public keys safe. Reusing an index is what would leak, and that is the
counter's whole job.

### View tags — everything else

For memos neither window catches, the first nonce byte is a Monero-style tag:

```
nonce[0] = deriveViewTag(sharedSecret)   // 1 byte of the ECDH output
```

The scanner computes the ECDH (unavoidable), but compares one byte before
attempting authenticated decryption — rejecting ~255/256 of foreign notes
without paying the AEAD. Tags activate at a configured leaf
(`viewTagActivationLeaf`); older memos predate them.

## 4. Spent status without asking

Knowing which notes are _yours_ is half the scan; knowing which are _spent_ is
the other half — and the dangerous half, because the obvious API is a trap.

**`NullifierSource` deliberately has no "is this nullifier spent?" method.**
Asking per-nullifier tells the server exactly which notes you own. Instead the
wallet downloads the whole spent set (chunked manifest + tail) and intersects
**locally**:

- Every request the server sees is identical regardless of which notes the
  caller holds. There is a test asserting exactly that.
- Chunks are cached in the vault's `NullifierCache` under blind tags; a
  `generation` bump in the manifest means the operator corrected data —
  resync from zero.
- Nullifier hex is normalised to lowercase **at ingestion**, both tail and
  chunk paths. A casing mismatch makes a spent note look spendable, and the
  failure surfaces later as a rejected spend.

A third party reimplementing discovery gets this wrong by default, which is why
the contract itself — not documentation — forbids the per-nullifier query.

## 5. The pipeline

`runScan` phases, with the property each one protects:

```
1. COLLECT   sealed chunks, then the paginated tail — both through a
             PREFETCH-deep download window — trial-decrypting via the pool
             → each completed batch CHECKPOINTS (checkpoint.ts):
               NEW notes saved, then the cursor advanced past the batch
2. SPENT     resolve the authoritative spent set by local intersection
             → reads only; abortable
3. PERSIST   rewrite existing notes, reconcile spent flags, purge ghosts
4. CURSOR    final lastScannedLeafIndex for the next incremental pass
```

- **Per-batch checkpoints** are why an abort or crash resumes instead of
  restarting: the next scan continues right after the last completed batch.
  Order inside a batch is load-bearing — notes first, cursor second; a cursor
  advanced past unsaved notes would make the next incremental scan skip them
  forever. Checkpoints save **new** notes only, with spent status from the
  locally synced nullifier set; existing notes could be downgraded
  (spent → unspent) by a save without the authoritative map, so phase 3
  remains their only writer.
- **The identity-switch guarantee** still holds, enforced per write instead of
  by a single pre-persist gate: the abort signal is re-checked immediately
  before every checkpoint write, and once more before phase 3's final writes.
  A host that swaps accounts mid-scan aborts, and notes decrypted under one
  account's keys never land in another account's vault.
- **The purge gate**: a full scan may purge vault notes absent from the chain —
  but only when `hintsScanned > 0`. An empty feed (indexer down, wrong URL)
  must read as "no data", never as "your notes are gone".
- **The cursor** advances per completed batch during collection and lands on
  its final value in phase 4; clearing it deletes the key rather than storing
  `undefined` ([vault.md](./vault.md) §4).

## 6. The worker pool

Trial decryption is CPU-bound EC math, so it runs off the main thread when the
host provides workers:

- The kernel (`decryptHintBatch`) is pure and ships as `@orbinum/sdk/worker` —
  a worker bundle carries the decryption path and no chain client.
- The pool takes a **required** `WorkerFactory` — `null` means "run the kernel
  on the calling thread", correct everywhere and the only option outside a
  browser. The SDK cannot spawn workers itself: `new Worker(new URL(...))` is a
  bundler rewrite that does not survive publication.
- A crashed worker fails over to the main-thread path and completes the batch;
  a scan degrades to slow, never to broken.
- The precomputed discovery window is cached at module scope and **holds ECDH
  shared secrets** — `clearKnownEphWindow()` on lock, or the secrets outlive
  the session they belong to.

## 7. Outgoing history

The chain never records what a private transfer sent or to whom. The submitting
client saves that locally at spend time — and a restore loses it.

### Two ways to rebuild it

```
                    restored sender: seed only
                              │
              ┌───────────────┴───────────────┐
   counterparty known                  counterparty unknown
   AND ephemeral derived               OR ephemeral was random
              │                                │
      read the memo back              subtract what is visible
              │                                │
   value, blinding, sourcePk          Σ(inputs) − change − fee
        EXACT                          approximate: overstates
              │                         by the fee when unreadable
              ▼                                ▼
   + re-issued payment slip           no slip: nobody to seal toward
```

### Reading the memo back

A sender cannot open a memo sealed toward someone else — unless they made it.
The pair secret is symmetric, so the ephemeral they used is derivable again:

```
memo (180B, on chain)
  nonce(12) ‖ cipher+MAC(136) ‖ ephPk(32)
                                  └── in the clear

sender, locally:
  window = pairwiseEphWindow(pairSecret, theirIvk, 0, 64)
  match  = window.find(e => e.ephPkHex === publishedEphPk)   ← string compare
              │
              └─► match.sharedSecret ─► decryptWithSharedSecret ─► plaintext
```

No counter is needed and nothing is asked of the server: the published ephPk is
already in a memo the wallet fetched, and the comparison is local. See
`recoverSentNote`.

### The linkage trade-off, unchanged

`TransferFactsSource` is separate from the scan feeds **on purpose**: its
queries do send the wallet's own identifiers to the server. A host that prefers
not to make that trade simply does not implement the source, and discovery
never requires it.

`outputsByExtrinsics` is optional and adds nothing to that exposure — it is only
ever called for extrinsics `byNullifiers` already surfaced, which are extrinsics
this wallet signed.

### Why the first payment stays out

A payment with a random ephemeral cannot be read back, and the first payment to
a new counterparty is exactly that: `reservePairwiseIndex` returns `null`
without history, because *"first payment"* and *"counter lost to a restore"* are
indistinguishable, and guessing wrong republishes an ephPk.

Reconstructing the counter from the chain looks like a fix and is not — an
indexer that hides one extrinsic makes the wallet reuse that index:

```
published 0,1,2 → indexer omits the 2 → wallet picks 2 → COLLISION
```

Omission degrades a *read* (one history row missing) but corrupts a *write* (a
republished ephPk, permanent and public). That asymmetry is why the counter is
reconstructed for recovery and never for choosing what to publish.

Cost: one payment per counterparty. Every later one is derivable.
