# Note Cryptography

This document explains the cryptographic design of shielded notes in the Orbinum protocol: how keys are structured, how commitments are encoded, and how these concepts relate to what users see in wallets and explorers.

Part of the [note model](./README.md) series. The derivation _lifecycle_ — caching, device keys, session — is in [identity.md](./identity.md).

---

## 1. Two Separate Key Systems

Every user in the Orbinum shielded pool operates with **two completely independent key pairs**:

| Key pair                | Curve             | Where it lives                   | Purpose                                                |
| ----------------------- | ----------------- | -------------------------------- | ------------------------------------------------------ |
| **EVM keypair**         | secp256k1         | Ethereum wallet (MetaMask, etc.) | Signs transactions, pays gas, controls the EVM address |
| **Baby JubJub keypair** | Baby JubJub (BJJ) | Derived inside the SDK           | Owns shielded notes, used inside ZK circuits           |

These are not the same key and they are not mathematically related in a recoverable way. The BJJ key is derived from an EVM signature so that only the wallet owner can produce it, but the two public keys look nothing alike and cannot be used interchangeably.

### Why Baby JubJub?

ZK-SNARK circuits built on the BN254 curve (Groth16) operate inside a finite field whose prime order is ~254 bits. All values inside a circuit must be elements of this field. secp256k1 keys are points on a different curve with a different field — arithmetic on them inside a BN254 circuit is prohibitively expensive (~hundreds of thousands of constraints per operation).

Baby JubJub is a twisted Edwards curve defined **over the BN254 scalar field**. A single BJJ scalar multiplication costs roughly 3,000–4,000 R1CS constraints, making it practical inside a Groth16 circuit.

### Spending Key Derivation

```
Wallet (EVM: EIP-712 typed data · Substrate: VRF sign)
  └─ signature over "orbinum-spending-key-v2\n{chainId}\n{canonicalAccountId(address)}"
        └─ HKDF-SHA256(signature, info="orbinum-sk-v2:{chainId}:{account}")
              └─ master bytes (32) — the root secret every branch hangs off
                    ├─ spending_key = HKDF(master, "orbinum-spend-v3") mod BABYJUB_SUBORDER
                    │     └─ owner_pk = spending_key · G  (BJJ point, Ax in the commitment)
                    ├─ ivsk         = HKDF(master, "orbinum-ivk-v3")    (opens incoming memos)
                    └─ ovk          = HKDF(master, "orbinum-ovk-v3")    (reads what was SENT)
```

The `info` string binds the key to `(chainId, account)`: one wallet yields a
different spending key per network. Derivation v1 (no chainId) was removed in
0.20.0 — the version inside the HKDF `info` keeps v2 keys disjoint from
anything v1 produced.

The `v2` in the message and the `v3` in the branches are **two different
versions and neither is stale**: `v2` versions the string the user signs (it
never changed), `v3` versions the branches below the master. Identity v2 —
where `ivsk` descended from the spending key, leaving no viewing key that could
be handed out — was removed the same way v1 was; `IdentityVersion` admits only
`'v3'`. Details in [identity.md](./identity.md) §1.

Two consequences of the branches being siblings rather than a chain:

- **Spending a received note needs two of them.** The scalar that spends is
  `deriveStealthSk(sharedSecret, ownerPk, spendingKey)`, and the shared secret
  comes from the _viewing_ key. A spending key alone decrypts nothing.
- **Recovery needs the root**, not the spending key: the outgoing branch is
  unreachable from the spending branch, so "back up your key" means "back up
  your master bytes".

The spending key never leaves the SDK. Only its public counterpart (`owner_pk.Ax`) is embedded in the note commitment. On Substrate the signature is **randomised** (sr25519), so the derived identity must be cached rather than re-derived — see [identity.md](./identity.md) §2.

### Why the Owner Public Key ≠ the Wallet Address

The wallet address (`0xf24ff3a9...`) is a 20-byte Ethereum address derived from the secp256k1 public key via `keccak256`. The note's **owner public key** (`0x1d4a09a1...`) is the x-coordinate of a Baby JubJub point. They belong to different curves, different fields, and different key-derivation paths. There is no way to derive one from the other without the original EVM signature.

---

## 2. Note Commitment

A **commitment** is a collision-resistant hash of the note's plaintext contents. It is stored on-chain in the Merkle tree and is the only thing publicly visible about the note.

```
commitment = Poseidon4(value, asset_id, owner_pk_ax, blinding)
```

| Input         | Type                | Description                                                             |
| ------------- | ------------------- | ----------------------------------------------------------------------- |
| `value`       | u64 (field element) | Token amount in the note                                                |
| `asset_id`    | u32 (field element) | Asset identifier                                                        |
| `owner_pk_ax` | BN254 field element | x-coordinate of the owner's BJJ public key                              |
| `blinding`    | BN254 field element | Cryptographically random value preventing brute-force preimage recovery |

**Poseidon** is a ZK-friendly sponge hash function. It produces ~300 R1CS constraints versus ~25,000 for SHA-256, making commitment verification practical inside a circuit.

### Nullifier

The nullifier marks a note as spent without revealing which note was spent:

```
nullifier = Poseidon2(commitment, spending_key)
```

A nullifier is derived from both the commitment and the **secret** spending key. Knowing the commitment alone is not enough to derive the nullifier — this is what prevents third parties from front-running a spend.

---

## 3. Commitment Encoding: Big-Endian vs Little-Endian

This is the most common source of confusion when comparing commitment values across different parts of the system.

### BN254 Field Elements are Little-Endian

Inside ZK circuits, commitments are BN254 scalar field elements. The SDK, the proof generator, and the disclosure key all represent them as **32-byte little-endian arrays** (byte 0 = least significant byte).

### Substrate Stores Hashes as Big-Endian

The Orbinum runtime stores Merkle leaf hashes and commitment indices using the standard Substrate/Rust convention: **big-endian** (byte 0 = most significant byte), consistent with how `H256` is serialised in `scale-codec` and displayed in block explorers.

### Concrete Example

The same commitment represented in both conventions:

```
On-chain / Substrate (big-endian, H256):
  0xa78eebab6fe66b9546ea60a46a548286244f16a680197a009a57fba956ba0a2d

ZK circuit / disclosure key (little-endian, BN254 field element):
  0x2d0aba56a9fb579a007a1980a6164f248682546aa460ea46956be66fabeb8ea7
```

Reversing the bytes of the first value produces the second exactly. They are the **same commitment** — not two different values.

```
BE[0]  = 0xa7  →  LE[31] = 0xa7
BE[1]  = 0x8e  →  LE[30] = 0x8e
  ...
BE[31] = 0x2d  →  LE[0]  = 0x2d
```

### When Does the Conversion Happen?

| Surface                                | Representation               | Notes                                                    |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Block explorer / RPC                   | Big-endian `0x...`           | Standard Substrate `H256`                                |
| `pallet-shielded-pool` storage         | Big-endian                   | Rust `[u8; 32]` stored as-is                             |
| ZK circuit inputs                      | Little-endian decimal string | `commitment.toString()` of a `bigint` read from LE bytes |
| Disclosure key (`orbdisc:...`)         | Little-endian hex string     | Stored as LE so it matches the field element directly    |
| `decodeNoteDisclosureKey` verification | Little-endian bigint         | Poseidon4 is computed over LE field elements             |

The SDK utility `bigintTo32Le(x)` converts a `bigint` to a 32-byte LE `Uint8Array`. Use `fromHex` + `reverse()` to convert a Substrate big-endian commitment to its LE bigint for circuit use.

---

## 4. Note Disclosure Keys

A **disclosure key** (`orbdisc:<base64url>`) is a compact string that encodes the plaintext preimage of a commitment. It allows a third party to verify the note's value and asset without gaining any spending capability.

### What a Disclosure Key Reveals

| Field               | Revealed                                                |
| ------------------- | ------------------------------------------------------- |
| `value`             | Yes — the raw token amount                              |
| `asset_id`          | Yes — the asset type                                    |
| `owner_pk` (BJJ Ax) | Yes — the x-coordinate of the owner's BJJ public key    |
| `blinding`          | Yes — required to reconstruct and verify the commitment |
| `commitment`        | Yes — recomputed and verified via Poseidon4             |

### What a Disclosure Key Does NOT Reveal

| Field                             | Revealed                                                          |
| --------------------------------- | ----------------------------------------------------------------- |
| `spending_key`                    | **No** — never included                                           |
| `nullifier`                       | **No** — requires `spending_key` to compute                       |
| EVM wallet address                | **No** — `owner_pk` (BJJ) cannot be reverse-mapped to the EVM key |
| Other notes owned by the same key | **No** — each disclosure key covers exactly one note              |

### Verification

`decodeNoteDisclosureKey(key)` recomputes `Poseidon4(value, asset_id, owner_pk, blinding)` from the decoded payload and compares it against the embedded `commitment` field. If they do not match, it returns `null`. This makes it impossible to forge a disclosure key with an incorrect value without breaking the hash function.

### Format

```
orbdisc:<base64url(JSON)>

JSON payload (v1):
{
  "v":   1,
  "c":   "0x<commitment, 32 bytes LE hex>",
  "val": "0x<value, 8 bytes LE hex>",
  "aid": "0x<asset_id, 4 bytes LE hex>",
  "opk": "0x<owner_pk_ax, 32 bytes LE hex>",
  "bld": "0x<blinding, 32 bytes LE hex>"
}
```

All numeric fields use little-endian hex encoding to match the BN254 field element representation used by the circuit.

---

## 5. Stealth Addresses

A recipient publishes **one** privacy address, and every payment to it commits
to a **different** owner key. Without this, two payments to the same address
carry the same `owner_pk` in the clear and an observer groups them as one
person's — the memo stays private and the ownership graph does not.

Both sides reach the same one-time key from opposite directions, from the ECDH
secret the memo already established:

```
sender                                     recipient
  sharedSecret from the ephemeral it            sharedSecret recovered from the
  sealed the memo with                          memo's ephPk and their ivsk
       │                                             │
       ▼                                             ▼
stealthScalar = HKDF(sharedSecret, salt = owner_pk_LE, info = "orbinum-stealth-v1")
       │                                             │
       ▼                                             ▼
  stealth_owner_pk =                            stealth_sk =
    (stealthScalar · G + ownerPkPoint).Ax         stealthScalar + spending_key
```

The identity that makes it work with an **unmodified circuit**:

```
BabyPbk(stealth_sk).Ax === deriveStealthOwnerPk(sharedSecret, owner_pk, point)
```

The circuit already proves that the spender's key derives the commitment's
owner. Because the same scalar is added on both sides — to the base point on
one, to the spending key on the other — that check passes untouched. No new
constraint, no new public input.

The **salt is the recipient's global `owner_pk`**, so a shared secret reused
across two recipients still yields different stealth keys.

Practical consequence for the vault: a received note's stored `spendingKey` is
the _stealth_ scalar, not the wallet's global one, and it is a value a rescan
re-derives from the memo. Anything built _from_ a received note — a change note
in particular — must use the wallet's **global** keys instead
([spending.md](./spending.md) §4).

---

## 6. Payment Slips

A slip (`orbslip1:<base64url>:<checksum>`) is what a **sender** hands a
**recipient** so they rebuild their note without scanning the pool.

### What it carries

Only what is already public on chain: the recipient output's `commitment`, its
`encryptedMemo`, and optionally its `leafIndex`. The recipient opens that memo
with their own viewing key, which derives the stealth spending key and verifies
the commitment. **A slip grants no spending power** and reveals nothing the
chain does not already hold.

### Why it is encrypted anyway

The fields are public; _pairing_ them off-chain is not. Whoever intercepts a
plaintext slip learns that this recipient expects this payment — so it is
sealed toward them with the same ECDH the memo uses, under a separate domain:

```
envelope = ephPk(32) ‖ nonce_suffix(8) ‖ ciphertext ‖ MAC(16)
nonce    = "SLP1" ‖ nonce_suffix          (the prefix is not transmitted)
slipKey  = HKDF(sharedSecret, info = "orbinum-payment-slip-v1")
```

### What the MAC does NOT prove

That the fields are **true**. It proves only that whoever sealed the slip knew
the recipient's viewing key — and anyone handed a privacy address knows that.
What comes out of `openPaymentSlip` is attacker-chosen data that merely arrived
authenticated.

Two independent defences catch a lying slip, either one sufficient: the
commitment is mixed into the memo's encryption key, and `tryDecryptNote`
recomputes the commitment from the decrypted plaintext. A slip that names a
note the sender does not own fails to open at all.

---

## 7. Summary

```
EVM wallet (secp256k1)
│
├─ signs message → HKDF → spending_key (BJJ scalar)
│                              └─ owner_pk = spending_key · G  (BJJ point)
│
└─ EVM address (keccak256 of secp256k1 pubkey)   ← completely unrelated to owner_pk

Note commitment:
  Poseidon4(value, asset_id, owner_pk.Ax, blinding)
  ├─ stored on-chain as big-endian H256 (Substrate convention)
  └─ used in circuits as little-endian BN254 field element (same bytes, reversed)

Nullifier:
  Poseidon2(commitment, spending_key)
  └─ spending_key is secret → nullifier cannot be predicted from commitment alone

Stealth (per received note):
  stealth_owner_pk = (HKDF(sharedSecret, salt=owner_pk) · G + ownerPkPoint).Ax
  stealth_sk       = HKDF(sharedSecret, salt=owner_pk) + spending_key
  └─ one-time owner per payment; the circuit verifies it unmodified

The three shareable strings — none carries the spending key:
  orbpriv3:...  owner_pk + ivk (public)  → so someone can pay you
  orbslip1:...  commitment + memo (public, sealed) → so a payee rebuilds a note
  orbdisc:...   preimage of commitment   → so an auditor verifies one note
```
