# The Orbinum Note Model

How the pieces of the note model fit together. Each piece has its own document;
this one is the map. The SDK's _code_ architecture — layers, subpaths,
packaging — is a separate concern: [sdk-architecture.md](../sdk-architecture.md).

| Document                                       | Covers                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [note-cryptography.md](./note-cryptography.md) | Keys, commitments, nullifiers, encodings, stealth, slips, disclosure                        |
| [identity.md](./identity.md)                   | Deriving who you are, and keeping it across launches                                        |
| [vault.md](./vault.md)                         | Storing notes encrypted, and what the storage must guarantee                                |
| [note-discovery.md](./note-discovery.md)       | Finding your notes without telling anyone which they are                                    |
| [spending.md](./spending.md)                   | Turning notes into transactions, and surviving rejection                                    |
| [build-on-orbinum.md](./build-on-orbinum.md)   | How a third party builds on Orbinum — and why "one identity per dapp" is the wrong question |

Security posture of the identity — what a hostile clone can and cannot capture,
and which layer closes it — lives one level up, in
[`IDENTITY_SECURITY.md`](../../IDENTITY_SECURITY.md).

---

## 1. The model in one paragraph

A **note** is a private claim on value: `(value, assetId, ownerPk, blinding)`,
committed on-chain as a Poseidon hash in a Merkle forest. Nobody can tell from
the chain who owns a note or what it holds. The owner finds their notes by
trial-decrypting an encrypted **memo** published beside each commitment, stores
them in an encrypted **vault**, and spends them by proving — in zero knowledge —
that they know a committed note's preimage and its spending key. Spending
publishes a **nullifier** that marks the note consumed without revealing which
commitment it was.

Everything in the SDK exists to serve one of those four verbs: **own** (keys),
**find** (scanner), **keep** (vault), **spend** (ops).

---

## 2. Where the model lives in the code

The SDK is five layers — `foundation`, `protocol`, `chain`, `wallet`,
`adapters` — and the note model maps onto the first four cleanly: what a note _is_ lives in `protocol/` (pure,
offline), while finding, keeping and spending live in `wallet/` and reach the
chain through injected contracts. The full layout, the published subpaths and
the packaging rules are in [sdk-architecture.md](../sdk-architecture.md).

## 3. The life of a note

Every note passes through the same stations. The numbers refer to the documents
above.

```
                 IDENTITY (2)
        wallet signature ──HKDF──► master bytes
                 │   (identity v3: every branch a SIBLING, none a parent)
                 ├── spending key (BJJ scalar)  ── owns notes
                 ├── ivsk / ivk                 ── opens incoming memos
                 ├── ovk                        ── reads what was SENT
                 └── vault keys (AES + HMAC)    ── encrypts storage
                 │
                 ▼
   ┌──────────  CREATE  ──────────────────────────────────────────┐
   │  shield: public funds → note        (buildShieldParams)      │
   │  receive: someone's transfer output                          │
   │  change: your own transfer's second output                   │
   │                                                              │
   │  commitment = Poseidon4(value, assetId, ownerPk, blinding)   │
   │  memo       = 180 bytes: nonce ‖ ciphertext ‖ ephPk          │
   │  paid to a privacy address → ownerPk is a ONE-TIME stealth   │
   │  key, so two payments to one address never link on chain     │
   └──────────────────────────┬───────────────────────────────────┘
                              │ on chain: commitment in the Merkle
                              │ forest, memo beside it
                              ▼
   ┌──────────  FIND (4)  ────────────────────────────────────────┐
   │  scan every hint; four shortcuts beat the O(pool) ECDH:      │
   │    self-eph window   — hash lookup for your own notes        │
   │    pairwise window   — hash lookup per known counterparty    │
   │    outgoing window   — the sender re-reads what it SENT      │
   │    view tag          — 1 byte rejects ~255/256 of the rest   │
   │  spent status by PIR-A: download the set, intersect locally  │
   └──────────────────────────┬───────────────────────────────────┘
                              ▼
   ┌──────────  KEEP (3)  ────────────────────────────────────────┐
   │  vault: AES-GCM envelope per note, keyed by a BLIND HMAC     │
   │  tag — storage never learns the on-chain identifiers.        │
   │  Config carries the ephemeral counters; updateConfig is      │
   │  atomic because a lost increment republishes an ephPk.       │
   └──────────────────────────┬───────────────────────────────────┘
                              ▼
   ┌──────────  SPEND (5)  ───────────────────────────────────────┐
   │  plan → guard → prove → submit → persist                     │
   │                                                              │
   │  transfer: 2-in/2-out circuit, root reconciliation,          │
   │            change note back to yourself                      │
   │  unshield: 1 input, fee fixed at the runtime minimum         │
   │                                                              │
   │  success: inputs marked spent, change saved, history row     │
   │  rejection: classified — resync, purge, or leave alone       │
   └──────────────────────────────────────────────────────────────┘
```

---

## 4. Contracts, not clients

The SDK never owns transport. Every capability that needs the outside world is
expressed as a small interface the host implements:

| Contract                               | Methods                                               | Who implements it                                                |
| -------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `VaultStorage`                         | config + notes + nullifier cache + history            | `IndexedDbVaultStorage`, `MemoryVaultStorage`, or the host's own |
| `ScanHintSource`                       | commitment hints by page + optional sealed chunks     | an indexer adapter                                               |
| `NullifierSource`                      | manifest / chunk / tail — **no per-nullifier lookup** | an indexer adapter                                               |
| `TxFactsSource`, `TransferFactsSource` | extrinsic facts for history                           | an indexer adapter                                               |
| `WalletSession`                        | the keys held while unlocked                          | plain object, or the host's store                                |
| `SecretStore`, `DeviceKeyStore`        | small secrets between launches                        | localStorage, chrome.storage, Keychain                           |
| `WorkerFactory`                        | spawn a decrypt worker, or `null`                     | the host's bundler                                               |
| `submit` callback (per spend)          | put an extrinsic on chain                             | the host's client + signer                                       |

The same conformance suite runs against every `VaultStorage` implementation —
a contract verified by one implementation only describes that implementation.

`NullifierSource` deserves its own sentence: it deliberately has **no** "is this
nullifier spent?" method. See [note-discovery.md](./note-discovery.md) §4.

---

## 5. Privacy invariants

The properties everything else must not break, and where each is enforced:

| Invariant                                            | Broken by                                                                         | Enforced in                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| An ephemeral index is used **once**                  | a lost counter increment → same ephPk published twice → two notes publicly linked | `updateConfig` atomicity (vault), reserve-before-use (`buildZkNote`)                      |
| The server never learns which notes you hold         | a per-nullifier query                                                             | `NullifierSource` shape (no such method), identical requests regardless of vault contents |
| Storage cannot be linked to chain activity           | keying records by on-chain hex                                                    | blind HMAC tags (vault)                                                                   |
| The vault never stores who you paid **in the clear** | persisting the recipient's stable key as a readable field                         | change note's `sourcePk` carries the recipient book, XOR-sealed under the `ovk`           |
| A disclosure key grants no spending power            | including the spending key                                                        | `orbdisc` format (cryptography doc §4)                                                    |
| Old notes stay spendable across VK rotations         | proving with the active version                                                   | `CircuitVersionResolver`, fail-closed (spending doc §5)                                   |

---

## 6. Failure philosophy

Three rules recur in every module:

1. **Fail closed on protocol, open on availability.** A guessed circuit version,
   a mismatched VK hash, an unverifiable schema — refuse. One corrupt record,
   one failed history write, an unreachable nullifier feed — degrade and carry
   on. The line: an error that could _corrupt or link_ stops the world; an error
   that costs _freshness_ does not.
2. **The chain is the authority.** The vault reconciles toward it — never the
   reverse. A spend rejected as `already-spent` resyncs; a `ghost-note` purges;
   a `stale-proof` retries. Reacting to an _unrecognised_ failure by guessing is
   how a wallet deletes notes it should not.
3. **Rules live once.** Every constant and predicate the circuit or pallet
   defines — tree size, spendability, pairing, endianness, fee floors — is
   exported exactly once and consumed everywhere, including by the reference
   app. A rule stated in two places is a rule that eventually differs in one.

---

## 7. Where the host begins

Everything above the dashed line is the SDK's; below it is the host's:

```
        vault · scanner · spend ops · identity cache · error taxonomy
 ───────────────────────────────────────────────────────────────────────
        UI state · toasts · scheduling policy · wallet-extension flows
        transport (chain client, signer) · worker spawning · storage backend
```

The rule of thumb: **protocol and consequence** belong to the SDK; **policy and
presentation** belong to the host. "What does `UnknownMerkleRoot` mean" is the
SDK's; "what colour is the toast" is not.

`OrbinumWallet` assembles the SDK pieces into a working wallet in ~20 lines for
hosts that want the default shape. The reference app instead uses the pieces
directly — both are supported, and the facade's own header says so.
