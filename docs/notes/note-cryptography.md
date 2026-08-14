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
              └─ master bytes (32)
                    └─ spending_key = master mod BABYJUB_SUBORDER  (BJJ scalar)
                          └─ owner_pk = spending_key · G   (BJJ point, Ax in the commitment)
```

The `info` string binds the key to `(chainId, account)`: one wallet yields a
different spending key per network. Derivation v1 (no chainId) was removed in
0.20.0 — the version inside the HKDF `info` keeps v2 keys disjoint from
anything v1 produced.

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

## 5. Payment Slips

A slip is what a **sender** hands a **recipient** so they rebuild a note without
scanning the pool. Every field it carries is already public on chain.

```
SENDER                                                 RECIPIENT
  │                                                        │
  │  sealPaymentSlip(recipientIvk, facts)                   │
  │    ephSk        ← fresh, PER SLIP                       │
  │    sharedSecret = [ephSk]·recipientIvk                  │
  │    slipKey      = HKDF(sharedSecret, "…slip-v1")        │
  │    envelope     = ephPk(32) ‖ nonce(8) ‖ cipher ‖ MAC(16)
  │    wire         = orbslip1:{base64url}:{checksum}       │
  │                                                        │
  └──────── chat · QR (~1685 of ~1800 chars) ──────────────►│
                                                            │
                                            openPaymentSlip(ivsk)
                                              │
                                              ├─ size ≤ 4 KB, checked BEFORE
                                              │  decrypting anything
                                              ├─ ECDH + MAC
                                              └─ rebuild field by field
                                                            │
                                            importPaymentSlip → tryDecryptNote
                                                            │
                                                     SPENDABLE note
```

### Why it is encrypted at all

The fields are public, but *pairing* them off-chain is not: whoever intercepts a
plaintext slip learns that **this** recipient expects **this** payment. The
envelope is sealed toward the recipient with the same ECDH the memo uses.

### What the MAC does not prove

It proves the sender knew the recipient's viewing key. It does **not** prove the
fields are true — anyone handed a privacy address can seal a slip. So the result
is rebuilt field by field rather than returned from `JSON.parse`:

| Field | Rule | If violated |
|---|---|---|
| `commitmentHex` | hex, exactly 32 bytes | slip fails |
| `encryptedMemo` | hex, exactly 180 bytes | slip fails |
| `leafIndex` | `isValidLeafIndex` (u32) | slip fails |
| `txHash` | hex, exactly 32 bytes | **field dropped** |

The commitment and memo are the note's identity — a wrong value there is not a
degraded slip but a different one. `txHash` is informational and renders as an
explorer link, so an unconstrained string is a URL injection; dropping it keeps
the slip working.

### A slip that lies about the note

Caught further in, by **two independent defences, either of which suffices**:

```
        forged (commitment, memo) pair
                    │
     ┌──────────────┴──────────────┐
     │                             │
 encKey = SHA256(ss ‖ commitment)  tryDecryptNote recomputes
 → wrong key → memo MAC fails      Poseidon4 → mismatch
     │                             │
     └──────────────┬──────────────┘
                    ▼
                  null
```

Disabling one alone changes nothing; disabling both lets a phantom note through.

### Re-issuing

A slip is sealed toward the recipient, so the sender keeps no readable copy —
losing the local record used to mean the recipient could never be handed one
again. `regeneratePaymentSlip` seals a fresh envelope from the same public
facts: different bytes (new ephemeral and nonce), identical fields.

It needs the recipient's viewing key. After a restore that comes from the sweep
in [Note Discovery §7](./note-discovery.md#7-outgoing-history), which recovers
*which* counterparty a payment went to.

---

## 6. Summary

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

Disclosure key (orbdisc:...):
  └─ reveals preimage of commitment (value, asset_id, owner_pk, blinding)
  └─ does NOT reveal spending_key, nullifier, or EVM address

Payment slip (orbslip1:...):
  └─ carries public locators (commitment, memo, leaf index) sealed toward the recipient
  └─ grants NO spend power — the stealth key is derived by the recipient, not carried
  └─ a valid MAC proves the sender knew the viewing key, NOT that the fields are true
```
