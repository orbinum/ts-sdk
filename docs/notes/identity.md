# Identity

Who a wallet _is_: how the keys are derived from a signature, why that identity
must be cached, and what keeps it from leaking or drifting.

Part of the [note model](./README.md) series — this is the **own**
station of a note's life. The cryptographic background (curves, why BJJ) is in
[note-cryptography.md](./note-cryptography.md).

---

## 1. One signature, every key

The entire identity derives from a single wallet signature. **The signed
payload is built by the SDK, never composed by the integrator** — a hand-typed
message that differs by one byte derives a different identity, a different
vault, and orphaned notes with no error anywhere:

| Step                 | Who  | With                                                                                                    |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| build the payload    | SDK  | `deriveSpendingKeyMessageV2(chainId, address)` — or `deriveSpendingKeyTypedData(...)` for EVM (EIP-712) |
| obtain the signature | host | its wallet's signing API — the one genuinely per-platform step                                          |
| derive the identity  | SDK  | `deriveSpendingKeyFromSignature(sig, chainId, address)`                                                 |

```
wallet signs:  "⚠ {SPENDING_KEY_WARNING}\n\n
                orbinum-spending-key-v2\n{chainId}\n{canonicalAccountId(address)}"
        │        (the warning is PART of the signed bytes — it tells the user
        │         what this signature creates, and stripping it changes the key)
        └─ HKDF(info = "orbinum-sk-v2:{chainId}:{account}") ──► master bytes (32)
                      │
                      │   identity v3 — every branch is a SIBLING of the master,
                      │   none descends from another:
                      │
                      ├─ spending key   = HKDF(master, "orbinum-spend-v3")  (moves funds)
                      │     └─ ownerPk  = BabyPbk(spendingKey).Ax
                      ├─ ivsk           = HKDF(master, "orbinum-ivk-v3")    (opens incoming)
                      │     └─ ivk      = packPoint(BJJ_mul(Base8, ivsk))
                      ├─ ovk            = HKDF(master, "orbinum-ovk-v3")    (reads what was SENT)
                      └─ vault keys     = HKDF(master, "orbinum-vault-key-v1" | "…-blind-v1")
```

The `v2` in the signed message and in the HKDF `info` is **not stale**: it
versions the MESSAGE the user signs, and that did not change. `IdentityVersion`
versions the BRANCHES below it. Bumping the message version would force everyone
to re-sign to reach an identity that is otherwise identical.

Three properties of the derivation are protocol, not implementation detail:

- **Both the signed message and the HKDF `info` bind the identity to
  `(chainId, account)`** — they are different strings with the same fields. One wallet
  yields a _different_ spending key per network. A key carried across chains
  would let one network's identity address another's notes.
- **`canonicalAccountId` is the account half** — the same canonicalisation the
  vault name and the session-cache key use. An SS58 address re-listed under a
  different prefix must derive the _same_ identity, or the user's notes sit
  under a name nothing will ever open again.
- **Vault keys come from the master bytes, not the spending-key scalar.** The
  scalar is the master reduced mod the curve order; deriving storage keys from
  it would tie every stored vault to the current modulus.

Derivation v1 (message `orbinum-spending-key-v1:<address>`, no chainId) was
**removed** in 0.20.0. The version lives inside the HKDF `info`, so v2 keys are
disjoint from anything v1 ever produced.

Identity **v2** — where the viewing key descended from the spending key — was
removed the same way, and for the same reason: while it was reachable, so was
the shape that made a watch-only wallet impossible. `IdentityVersion` admits
only `'v3'`, so the compiler refuses the rest, and `deriveIdentity` throws on
anything else reaching it from JavaScript. Nothing migrates: a v2 note is
committed on chain under a v2 `ownerPk`, so re-deriving the identity does not
move it — holders unshield before the switch.

### The entropy guard

A signer that returns low-entropy bytes (a stub, a broken extension, a
constant) would derive a spending key anyone could reproduce.
`deriveSpendingKeyFromSignature` refuses signatures with fewer than 8 distinct
byte values, and signatures shorter than `MIN_SIGNATURE_BYTES`. Fail closed: no
key beats a guessable key.

---

## 2. Why the identity must be cached

**sr25519 signatures are randomised.** Signing the same message twice yields
two different signatures — and therefore two different spending keys and two
different vaults. On Substrate, "just sign again next launch" does not
reproduce the identity; it silently creates a new empty one.

The session cache is what makes the identity stable:

```
cacheSession(deps, address, chainId, manager.exportHex())
restoreSession(deps, address, chainId)   // next launch — no signature
```

- The cached value is the exported **master bytes** (`mk:0x…`), encrypted
  under a **device key** before it touches storage.
- Scoped per `(chainId, account)` — the chain is part of the key derivation,
  so a cache shared across networks would restore one network's identity into
  another and show an empty vault with nothing to explain it.
- A cache that fails to decrypt is **deleted**, not reported: the device key
  rotated or the format changed, and either way it can never be read again.
  The caller falls back to requesting one signature.
- `clearSession` without a `chainId` sweeps _every_ network's cache for the
  account — that is what disconnecting means. This sweep is why `SecretStore`
  must expose `keys()`: the caller cannot construct cache keys for chains it
  does not know the user visited.

### EVM signers

secp256k1 signatures _are_ deterministic, but the same cache flow applies —
signing costs a wallet popup. The request uses an EIP-712 domain
(`SPENDING_KEY_VERIFYING_CONTRACT`), which the wallet renders and a hostile
page cannot suppress — but see the threat model below for what that does and
does not buy. Substrate sr25519 signers go through VRF signing; the VRF
context string is part of the derivation, and changing it rotates every
identity derived through the path.

### Threat model: a clone asking for the same signature

The attack to take seriously is not stealing the cache — it is a hostile site
(a pixel-perfect clone of the app) asking the user's wallet to sign **the same
derivation payload**. A signature-derived identity has no other secret: whoever
obtains one valid signature over the payload derives the spending key and owns
the funds. Nothing stops a page from _requesting_ that signature; the question
per route is what the resulting bytes are worth to the attacker.

| Route               | What a clone captures                    | Why                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sr25519 via VRF     | **a useless identity**                   | the **wallet**, not the page, binds the requesting origin into the VRF transcript (`substrate-vrf` namespace, length-prefixed). A clone at `evil.com` cannot claim `app.orbinum.network`, so its signature derives a different key — one that owns nothing. The only route with cryptographic origin binding. |
| EVM EIP-712         | the real identity, **if the user signs** | the domain and the `warning` field are rendered by the wallet and cannot be reworded — but no wallet verifies that `verifyingContract` matches the requesting origin. Visibility, not impossibility: it still depends on the user reading.                                                                    |
| ed25519 (`signRaw`) | the real identity, if the user signs     | same as EVM: the message is fixed, so an identical request yields identical bytes. The in-text warning is the defense.                                                                                                                                                                                        |

Capture is **all or nothing** — and identity v3 does not change that. The
branches are siblings rather than a chain, which is what makes a viewing key
delegable to an auditor without handing over the spending key; but all of them
hang off the same master bytes, so one captured signature still yields the
entire tree: see, spend, read the payment graph, and decrypt storage. Splitting
the branches solved delegation, not harvesting — the fix for harvesting has to
come from outside the signature channel, and is not built. See
[`IDENTITY_SECURITY.md`](../../IDENTITY_SECURITY.md).

Conversely the VRF route's "useless identity" is useless completely:
the attacker cannot even _see_ the real notes. And no route is silent — the
wallet always prompts, with the signed warning rendered verbatim; the attack is
phishing-with-consent, not extraction.

Two design constraints follow from this, and both are deliberate:

- **The payload carries no nonce, timestamp or challenge.** The obvious
  anti-replay additions would each make the signature — and therefore the key —
  different per session, leaving every previously shielded note unspendable.
  Determinism is not negotiable, which is exactly why the defense has to live
  in origin binding and domain separation rather than in freshness.
- **The session cache is itself a defense.** One signature per
  `(chainId, account)`, ever — so a signing prompt appearing when the user
  did not just set up a wallet is out of the ordinary by construction, and the
  warning text says what signing grants.

The full analysis — attack chain, per-wallet measurements, and the v3
proposal that extends origin binding — is in
`SPENDING_KEY_DERIVATION_SECURITY.md` at the repository root.

---

## 3. The device key

The cache's encryption key is **per-install and never derived from the wallet
signature** — deriving it from the signature would be circular, since avoiding
a re-signature is the reason the cache exists.

| Platform            | Persistence                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser / extension | non-extractable `CryptoKey` stored as a handle via structured clone (`storage/indexeddb` subpath) — the key material is never visible to JavaScript |
| React Native / Node | 32 raw bytes in the platform enclave (Keychain, Keystore), imported non-extractable via `importDeviceKey`                                           |

`createDeviceKeyProvider` generates on first use, caches per process, and
serialises concurrent first calls — two racing callers must not each mint a
key, because the loser's secrets become permanently unreadable.

**Contract worth knowing:** `DeviceKeyStore.load()` returning `null` means "no
key yet" and licenses generating one. An adapter whose backend is _unreachable_
must **throw** instead — a transient failure swallowed into `null` mints a
replacement key and orphans everything encrypted under the real one.

Threat model, stated honestly: code running in the same context can still call
decrypt. That boundary is not defendable from here; the cache is a strict
improvement over storing the master bytes in the clear, not an enclave.

---

## 4. The session

While unlocked, the identity lives in two places with different lifetimes:

| Where                   | Contents                                 | Cleared by                                                                               |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PrivacyKeyManager`     | spending key, viewing keys, ownerPk      | `clear()` on lock / identity switch                                                      |
| `WalletSession`         | the vault's `CryptoKey`s                 | `lock()`                                                                                 |
| worker eph-window cache | **ECDH shared secrets** per counterparty | `clearKnownEphWindow()` — it outlives a scan by design, so lock must clear it explicitly |

An identity _switch_ (another account, another chain) must tear down in order:
**abort any running scan first**, then lock, then clear. A scan reads its keys
once at start but writes through storage that the switch re-points — letting it
finish files one account's notes into another's vault.

Switching accounts does **not** clear the departing account's session cache:
the cache is scoped per account, and coming back should cost zero signatures.
Only a full disconnect sweeps it.

---

## 5. The facade

`OrbinumWallet` takes the **master bytes** and derives everything else
internally. For hosts that spend through the ops directly, it exposes the
pieces rather than forcing a choice between facade and ops:

- `spendKeys()` — the spending key + ownerPk in the exact shape `TransferDeps`
  wants;
- `recoverStealth` / `buildOutputNote` — the two callbacks a spend needs that
  require key material.

The reference app does not use the facade at all — it binds `VaultStore`,
`runScan` and the ops to its own stores. Both shapes are supported; the facade
is the shortest path, not the only one.
