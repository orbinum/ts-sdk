# Vault

How notes are kept: the encryption envelope, the blind index, the storage
contract, and the rules that keep two writers from leaking privacy.

Part of the [note model](./README.md) series — this is the **keep**
station of a note's life.

---

## 1. What the vault holds

Three stores, one contract (`VaultStorage`), split by concern:

| Store           | Contents                                                           | Contract slice   |
| --------------- | ------------------------------------------------------------------ | ---------------- |
| Notes           | one encrypted record per note, keyed by blind tag                  | `NoteStorage`    |
| Config          | schema version, chain fingerprint, scan cursor, ephemeral counters | `NoteStorage`    |
| Nullifier cache | the downloaded spent set, for local intersection                   | `NullifierCache` |
| Tx history      | outgoing records only the submitting client could know             | `TxHistoryStore` |

Two implementations ship: `IndexedDbVaultStorage` (browser, in the
`storage/indexeddb` subpath) and `MemoryVaultStorage` (tests, servers, and any
host that deliberately wants nothing to survive a restart). Both pass the same
conformance suite; a host bringing its own backend (SQLite, Keychain-backed,
remote) runs the suite against it too.

---

## 2. The envelope

Every note is sealed independently:

```
record = {
  commitmentTag: HMAC-SHA-256(blindKey, lowercase(commitmentHex)),
  iv:            12 random bytes,             (fresh per write — GCM requires it)
  ciphertext:    AES-256-GCM(vaultKey, JSON(note)),
}
```

- **Per-note sealing** is why one corrupt record cannot take the vault with it:
  unlock keeps every note that decrypts and fails only when _nothing_ does. A
  wrong key and a corrupted disk look identical per record (GCM authentication
  failure); only the aggregate distinguishes them.
- **JSON with a bigint-safe replacer/reviver** (`vaultReplacer`/`vaultReviver`),
  because a note's scalars are bigints and plain JSON silently turns them into
  strings. For notes that crossed a boundary _without_ the replacer,
  `normalizeNote` repairs them — and **throws** on a scalar it cannot read
  rather than defaulting to zero. A zeroed `blinding` or `spendingKey` rebuilds
  a commitment that matches no leaf: a note that sits in the balance and can
  never move. The one exception is `counterpartyPk`, where absent genuinely
  means zero (shield/unshield notes have no counterparty).

### The blind index

Records are keyed by `commitmentTag`, an HMAC under a dedicated `blindKey` —
never by the on-chain commitment hex. A storage dump therefore cannot be joined
against chain data: the tags reveal how many notes exist, and nothing else.
Inputs are lowercased before signing so the same identifier in either case
yields one tag — a mixed-case caller would otherwise store a note it could
never look up again.

The same construction blinds the nullifier cache (`noteBlindTag`).

---

## 3. Keys

The vault uses two keys, both derived from the identity's master bytes (see
[identity.md](./identity.md)):

| Key        | Type                                      | Used for        |
| ---------- | ----------------------------------------- | --------------- |
| `vaultKey` | AES-GCM-256, non-extractable `CryptoKey`  | sealing records |
| `blindKey` | HMAC-SHA-256, non-extractable `CryptoKey` | blind tags      |

Derived from the **master bytes**, not from the spending-key scalar. The scalar
is the master reduced mod the curve order; deriving storage keys from it would
tie every stored vault to the current modulus, and a future curve change would
leave them all unreadable.

While unlocked, the keys live in a `WalletSession` — a two-field object the
host can back with its own state container. `requireSessionKeys` is the single
definition of "unlocked": a half-open session throws `VaultLockedError` rather
than handing back a null key. Unlock is atomic — a failure mid-unlock re-locks,
so the wallet never reports `unlocked: true` with no notes behind it.

---

## 4. Config, and why `updateConfig` is atomic

The config record carries four things, one of which is a privacy control:

```
{
  v:                     4,          // schema version
  chainFingerprint:      genesis hash (lowercased)
  lastScannedLeafIndex:  scan cursor (ABSENT when cleared — see below)
  selfEphCounter:        next self-note ephemeral index
  pairwiseCounterparties: { [viewingPkHex]: { nextIndex, addedAt } }
}
```

**`updateConfig(mutate)` is part of the storage contract, not sugar over
get + put.** Two concurrent callers doing a read-modify-write separately both
read the same `selfEphCounter`, derive the same ephemeral index, and publish the
same `ephPk` on chain — which publicly links two notes as sharing a creator.
That is a privacy leak, not a lost update, and it is irreparable once on chain.
A backend that cannot make the mutation atomic cannot host a vault.

Index reservation follows **reserve-before-use**: the counter is bumped first,
the index used after. A crash between the two _skips_ an index (harmless) and
never _reuses_ one (linkage).

### The cursor deletes, never stores `undefined`

Clearing the scan cursor removes the key. A stored
`lastScannedLeafIndex: undefined` round-trips through structured clone as a
_present_ key, so a reader checking `'lastScannedLeafIndex' in config` would
take a cleared cursor for a real one — and skip exactly the leaves the full
rescan was meant to revisit.

---

## 5. Reset rules

`VaultStore.unlock` resets the vault to empty — notes are recoverable by
rescan — when the stored state cannot be trusted:

| Trigger                                  | Why reset is right                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.v !== expectedSchemaVersion`     | an older shape would be misread; the schema constant is the SDK's (`VAULT_SCHEMA_VERSION`), and the app re-exports it so writer and checker cannot drift |
| stored `chainFingerprint` ≠ live one     | a vault carried across networks holds notes whose commitments do not exist there; the scan would read that absence as "spent or gone"                    |
| nothing decrypts under the presented key | written under a different identity                                                                                                                       |

The reset philosophy: the chain is the source of truth for note existence, so
an untrustworthy vault is cheaper to rebuild than to repair.

---

## 6. Naming

One vault per `(chain, account)`:

```
orbinum-vault-{chainFingerprint}-{canonicalAccountId(address)}
```

Use `vaultStorageName()` — never compose the name by hand. The account is
canonicalised **exactly as the key derivation canonicalises it**; keying off the
raw address means a wallet that re-lists an account under a different SS58
prefix derives the _same_ key but opens a _different_ vault, and the notes sit
orphaned with no error to explain it.

The fingerprint may be unknown early in a connect (the node socket is cold); the
name then scopes by account alone and is promoted once the fingerprint arrives.
Opening under the short name and later the long one is safe — the fingerprint
mismatch rule above catches any real conflict.

---

## 7. What the vault never does

- **Query the chain.** It is pure storage plus cache; reconciliation is the
  scanner's and the spend lifecycle's job.
- **Store who you paid.** A change note's `counterpartyPk` is the recipient's
  one-time stealth key, never their stable identifier.
- **Trust its own contents over the chain.** `markSpent`, purges and resets all
  flow _from_ chain observations _toward_ the vault.
