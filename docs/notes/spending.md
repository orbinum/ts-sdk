# Spending

How a note becomes a transaction: planning, guarding, proving, submitting — and
what to do when the chain says no.

Part of the [note model](./README.md) series — this is the **spend**
station of a note's life.

---

## 1. The three operations

| Operation       | Circuit shape | Fee                                 | Origin             |
| --------------- | ------------- | ----------------------------------- | ------------------ |
| `transferNotes` | 2-in / 2-out  | sender's choice ≥ `MIN_GASLESS_FEE` | unsigned (gasless) |
| `unshieldNote`  | 1-in          | fixed at exactly `MIN_GASLESS_FEE`  | unsigned (gasless) |
| `claimFees`     | value proof   | —                                   | unsigned (gasless) |

Each takes a `submit` callback: **the SDK owns protocol, the host owns
transport.** A spend can be relayed, submitted bare, or routed through the EVM
precompile — the operation neither knows nor cares.

The unsigned origin is a rule worth stating twice: `unshield` and
`private_transfer` are gasless-origin calls, and a _signed_ substrate submit is
rejected with `BadOrigin`. The ZK proof is the authorisation; the fee is inside
it.

## 2. Planning — can this spend happen at all?

`planTransfer` / `planUnshield` / `spendableBalance` answer from notes alone —
pure arithmetic a UI calls on every keystroke, no chain access:

- **Usable notes** are `isSpendable` (unspent, non-zero — a zero-value note is
  a dummy the circuit forces to nullifier 0) **and** `isNoteSelfConsistent`
  (the stored spending key actually derives the stored `ownerPk`). Counting a
  note that fails the second check overstates the balance with money that
  cannot move.
- `plan.maxSpendable` nets the fee and clamps at zero, computed over the same
  notes the spend will use — so a Max button can never offer an amount the
  operation then refuses.
- `planUnshield` encodes that the unshield circuit proves exactly **one**
  input: a balance spread across two notes cannot cover an amount either note
  alone can't (`no-single-note`).
- Pairing rules for a manual selection are `canPairWith`: two inputs must share
  a circuit version **and** a forest tree. Funds spread across trees are
  reported as `needs-consolidation` — an offer to consolidate, not an
  insufficient-funds error.

Plans are plans: nothing is reserved and nothing touches the chain.

## 3. Guards — fail before proving, with a name

Every condition here is enforced by the circuit or the pallet anyway — but only
_after_ the caller has paid seconds of proving, and as an unreadable assert.
The guards run first and name the problem:

| Guard                   | Catches                                                                                                        | Cost                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `noteMatchesCommitment` | a drifted note: recomputes `Poseidon4(value, assetId, BabyPbk(sk).Ax, blinding)` against the stored commitment | ~0.13 ms (one EC mul + one Poseidon) |
| `checkSpendableInputs`  | commitment drift on either input, circuit-version mismatch between them                                        | same                                 |
| `treeOf`                | inputs from different forest trees — their roots can **never** agree                                           | trivial                              |
| `refuseIfAlreadySpent`  | an input the chain already consumed; reconciles the vault on the way out                                       | one RPC per input                    |

`treeOf` and the protocol's `treeIdOf` are one rule with two inputs (a Merkle
proof vs a note), both dividing by `LEAVES_PER_TREE` (2²⁰) — a test pins that
they agree, because a divergence would reject same-tree pairs as cross-tree.

## 4. The transfer, step by step

```
1. plan-level checks (amount > 0, inputs cover amount + fee)
2. guards (§3)
3. nullifier pre-flight (refuseIfAlreadySpent)
4. Merkle proofs + ROOT RECONCILIATION
5. build the two output notes
6. prove (CircuitVersionResolver → pinned artifacts)
7. submit (host callback)
8. persist: markInputsSpent, save change, recover self-stealth
```

### Root reconciliation (step 4)

The circuit proves both inputs under **one** public Merkle root, but each RPC
fetch resolves under its own best block. A commitment landing between the two
fetches anchors the proofs to different roots, and witness generation dies on
the Merkle constraint. The loop refetches (up to 3 rounds, ceiling six RPC
calls) until the roots agree — after first ruling out cross-tree inputs, whose
roots can never converge and would burn every retry.

Kept deliberately small: a tree advancing faster than two fetches can converge
is a chain under load, and retrying harder makes that worse.

### The two outputs (step 5)

- **Recipient note** — encrypted to the recipient's viewing key; with a privacy
  address present, stealth derivation activates and the note's `ownerPk` is a
  one-time key only the recipient can spend from.
- **Change note** — back to the sender, and two details are load-bearing:
    - its viewing key derives from the **input's** spending key, so a rescan
      under the same identity always reopens it;
    - its `counterpartyPk` records the recipient's **one-time stealth key**,
      never their stable identifier — the vault must not become a ledger of who
      was paid.

### Self-transfers (step 8)

A transfer to your own address produces a stealth output that only a rescan
would normally recover. Since the wallet authored the memo, `recoverStealth`
re-derives the stealth spending key immediately — using the wallet's **global**
keys, never the input note's, because an input that itself arrived via stealth
carries keys that derive garbage. A freshly built stealth note stored _as-is_
is unspendable: its stored nullifier was computed from the wrong key.

## 5. Circuit versions — fail closed

A note carries the circuit version it was created under, and its spend must be
proven against **that version's** artifacts and verified against that version's
on-chain VK — never the current active version, or a key rotation would orphan
every older note.

`CircuitVersionResolver.resolve` runs four gates and throws on the first
failure, all before any proving:

1. the note's version is a plausible integer;
2. the prover actually pinned that version (a manifest that ignored the
   override would prove with the wrong circuit);
3. the chain still supports it;
4. the prover's VK hash equals the chain's — compared leniently on formatting
   (`0x`, case) and **strictly on malformation**: an empty hash on both sides
   satisfies `===` and would let a proof be built against artifacts nobody
   verified.

New notes are stamped with `chainActiveCircuitVersion` — read from the chain,
never guessed, because a guessed version surfaces as an unspendable note long
after the mistake.

## 6. Marshalling traps

- **Shield commitments go on chain little-endian** (`buildShieldParams`). The
  chain _accepts_ a big-endian one — and produces a note nobody can ever find:
  not the sender's scan, not a rescan, not the recipient.
- **`addressToFieldElement`** maps an unshield recipient into the circuit:
  `H160 ‖ [0x00; 12]`, reduced mod `BN254_R`. The circuit defines this mapping;
  getting it wrong makes the proof verify against the wrong recipient.
- **`commitmentHexOf` / `scalarToHex`** are the canonical hex forms. Every
  index — scan hints, vault records, history — uses them; a hand-rolled
  encoding that differs matches nothing, silently.

## 7. When the chain says no

`classifyChainError` turns a raw rejection into what a wallet should **do** —
the words shown to a person stay with the host:

| Kind                         | Meaning                                                             | Reaction                                                                             |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `already-spent`              | the vault is behind the chain                                       | resync; the note flips to spent                                                      |
| `ghost-note`                 | an input commitment is not on chain and never will be               | purge it — waiting for the next full rescan leaves an unspendable note in the picker |
| `stale-proof`                | the tree moved between proving and submitting (`UnknownMerkleRoot`) | rescan and retry — **the note is alive; purging here deletes spendable funds**       |
| `amount` / `asset` / `shape` | the request itself is wrong                                         | nothing to retry until the user changes it                                           |
| `proof`                      | verification failed                                                 | not user-correctable; a bug or version mismatch                                      |
| `unknown`                    | a name this SDK version does not know                               | do nothing — guessing is how wallets delete notes                                    |

`stale-proof` vs `ghost-note` is the pair to read twice: both are
proof-versus-tree failures, indistinguishable in a stack trace, with opposite
correct reactions — one of which destroys funds if applied to the other.

### Success bookkeeping

On acceptance, the operation itself — not the caller — marks inputs spent and
saves the change note (`markInputsSpent`, part of the shared spend lifecycle).
Until that runs, the spent inputs still count toward the balance _and_ remain
selectable, so the next spend dies on a duplicate nullifier. The pre-flight
check and this write are one rule in one file for exactly that reason.

### Connection loss mid-submit

A dropped WebSocket after submission does not mean the tx failed.
`txLandedAfterError` polls a host-supplied `landed()` predicate (nullifier
spent? commitment in tree?) before reporting failure — without it, the user
retries a transfer that already succeeded and pays twice.
