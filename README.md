# @orbinum/sdk

Official TypeScript SDK for Orbinum — a privacy-focused blockchain built on
Substrate with an EVM compatibility layer.

**This package is the whole wallet.** Storing notes encrypted, finding your own
without telling anyone which they are, and spending them all live here — not
just the cryptography under them. What a host supplies is UI, transport, and
platform adapters.

The package is environment-agnostic: it uses WebCrypto through the global
`crypto`, and touches no DOM and no Node built-in. It runs in a browser, in an
extension service worker, in React Native, in Node 18+, in Deno, in Bun, and
inside a Web Worker.

## How it is organised

Deep dives live in [`docs/`](./docs): [the SDK's architecture as a
package](./docs/sdk-architecture.md), and the [note model
series](./docs/notes/README.md) — cryptography, identity, vault, discovery,
spending.

Four layers, each depending only downward. Where a symbol sits tells you what it
needs:

| Layer        | Contents                                   | Needs        |
| ------------ | ------------------------------------------ | ------------ |
| `foundation` | encoding, crypto primitives, formatting    | nothing      |
| `protocol`   | what a note IS — build, seal, find, select | no chain     |
| `chain`      | clients, RPC, the pallets                  | a connection |
| `wallet`     | vault, scanner, spend ops, identity        | both         |

Everything is re-exported from the package root, so this matters for reading the
source rather than for importing. The two exceptions are the subpaths under
[Entry points](#entry-points), which exist because each needs something only a
platform can give.

## Installation

```bash
pnpm add @orbinum/sdk polkadot-api @polkadot/util-crypto
```

`polkadot-api` and `@polkadot/util-crypto` are **peer dependencies**. They are
singletons in practice — a second copy of `polkadot-api` means a second
connection and a second view of chain state — so the host application owns the
version.

## Quick start

```ts
import { OrbinumClient } from '@orbinum/sdk';

const client = await OrbinumClient.connect({
    substrateWs: 'ws://localhost:9944',
    evmRpc: 'http://localhost:9933', // optional
});

const info = await client.substrate.getChainInfo();
const root = await client.privacy.getMerkleRoot();
```

`OrbinumClient` exposes:

| Property               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `client.substrate`     | Substrate RPC — blocks, events, transactions             |
| `client.evm`           | EVM JSON-RPC client (`null` when `evmRpc` is unset)      |
| `client.evmExplorer`   | Enriched EVM queries (`null` when `evmRpc` is unset)     |
| `client.privacy`       | `privacy_*` RPC — Merkle roots, proofs, nullifier status |
| `client.chain`         | `chain_*` RPC — validator queries                        |
| `client.shieldedPool`  | Shielded-pool extrinsics                                 |
| `client.zkVerifier`    | Circuit versions and verification keys                   |
| `client.relayerStatus` | Relayer availability                                     |
| `client.precompiles`   | EVM precompile wrappers (`null` when `evmRpc` is unset)  |

Every module also takes a `SubstrateClient` by constructor, so it can be used
without the `OrbinumClient` facade.

## Note cryptography

The shielded-pool primitives are pure and usable on their own — no client, no
transport:

```ts
import {
    NoteBuilder,
    tryDecryptNote,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
} from '@orbinum/sdk';

const ivsk = deriveViewingSecretKey(spendingKey);
const ivk = deriveViewingPublicKey(ivsk);

// A wallet scans by trying every pool hint against its own keys.
const note = tryDecryptNote(hint, ivsk, spendingKey, ownerPk);
```

Two mechanisms make that scan cheaper by letting the receiver _predict_ the
ephemeral key a sender will publish, turning a per-note elliptic-curve
multiplication into a hash lookup:

- `deriveSelfEphSk` / `selfEphWindow` — the wallet's own notes (shields, change)
- `derivePairwiseSharedSecret` / `pairwiseEphWindow` — notes from a counterparty
  whose privacy address you already hold

Both publish a PRF-derived curve point in the field the protocol already
carries, so the wire format is unchanged and a wallet that knows nothing about
them still recovers the note the slow way.

> Reusing an ephemeral index republishes the same point and publicly links the
> two notes. The window functions are pure functions of `(secret, range)` so the
> caller owns that counter — persist it, and never reuse an index.

## Building a wallet

The pieces above are enough to build one by hand. `OrbinumWallet` wires them the
way they have to be wired — one session driving both the vault and the scan, one
storage holding both the notes and the ephemeral counters.

```ts
import { OrbinumWallet, MemoryVaultStorage } from '@orbinum/sdk';
import { createDecryptPool } from '@orbinum/sdk/worker';

const wallet = new OrbinumWallet({
    storage: new MemoryVaultStorage(), // IndexedDbVaultStorage in a browser
    hints: myScanFeed, // ScanHintSource — 1 method, + optional sealed chunks
    nullifiers: mySpentFeed, // NullifierSource — 3 methods
    pool: createDecryptPool({ factory: null }), // main thread; workers in a browser
});

await wallet.unlock(masterBytes); // from a signed SpendingKeyRequest
wallet.onNotesChanged((notes) => render(notes));

const { found } = await wallet.scan({ onProgress: (p) => console.log(p.scanned, p.total) });
const balance = wallet.getNotes().reduce((sum, n) => sum + n.value, 0n);
```

[`examples/node-wallet`](./examples/node-wallet) is that program, complete and
runnable. It runs in CI against a packed tarball, so the snippet above cannot
drift from something that works.

### Spending

The SDK owns the protocol half of a spend; the host owns transport. Each op takes
its dependencies by injection, and `OrbinumWallet` produces all the ones that
involve key material:

```ts
import { transferNotes, planTransfer } from '@orbinum/sdk';

// What a UI needs before enabling a button: inputs, change, ceiling.
const plan = planTransfer({ notes: wallet.getNotes(), amount, fee });
if (!plan.ok) return showProblem(plan.problem); // 'needs-consolidation', …

await transferNotes(
    {
        privacy: client.privacy, // nullifier status + merkle proofs
        resolver: client.circuitVersionResolver, // fail-closed version pinning
        buildNote: wallet.buildOutputNote,
        vault: wallet.vault,
        recoverStealth: wallet.recoverStealth,
        submit: (request) => mySubmit(request), // yours: substrate or EVM
        selfOwnerPk: wallet.spendKeys().ownerPk,
    },
    { inputNotes: plan.inputs!, transferAmount: amount, recipientPk, fee }
);
```

`unshieldNote` and `claimFees` follow the same shape. What lives inside them is
the part that is easy to get wrong and expensive when wrong:

- **Merkle root reconciliation** — the circuit proves both inputs under ONE root,
  but each RPC fetch resolves under its own best block. The ops refetch until
  the roots agree, and rule out cross-tree pairs first, since those can never
  agree.
- **Stealth change** — the change note's key derivation and the memo share one
  ephemeral, so the memo must be submitted verbatim; a regenerated one makes the
  change unspendable.
- **Pre-flight guards** — a drifted note or mixed circuit versions fail here with
  a readable reason instead of as an opaque assert seconds into proving.

`buildShieldParams(note)` marshals a shield: the commitment goes on chain
**little-endian**, and a big-endian one is accepted by the chain while producing
a note nobody can ever find.

[`examples/node-wallet/spend.ts`](./examples/node-wallet/spend.ts) runs this in
CI against the packed tarball.

### Chain rules a wallet cannot derive

Consensus values, not preferences — the chain rejects an extrinsic that
disagrees with them:

```ts
import { MIN_GASLESS_FEE, NATIVE_ASSET_ID, isNativeAsset } from '@orbinum/sdk';

const plan = planTransfer({ notes, amount, fee: MIN_GASLESS_FEE });
```

`planTransfer` and `planUnshield` take a `fee`, and `MIN_GASLESS_FEE` is what
fills it. Below it the pallet rejects with `FeeTooLow`; without the constant the
value has to be recovered from a failed submit.

An unshield's fee is fixed at exactly this minimum. A private transfer's is the
sender's choice at or above it — which is why a reconstructed transfer fee is
unknown rather than assumed.

### When the chain rejects a spend

What a wallet should DO about a failure is protocol knowledge; the words shown
to a person are not:

```ts
import { classifyChainError } from '@orbinum/sdk';

switch (classifyChainError(rawError)) {
    case 'already-spent': // the vault is behind — resync
    case 'stale-proof': // the tree moved — rescan, then retry
    case 'ghost-note': // the commitment is not on chain — purge the note
    case 'amount': // nothing to retry until the user changes it
}
```

`stale-proof` and `ghost-note` are the pair worth reading twice. Both are
proof-versus-tree failures and they look alike in a stack trace, but a ghost note
is gone for good while a stale root means the note IS on chain and only the proof
is old. **Purging on a stale root deletes a live, spendable note.**

`palletErrorKind(name)` classifies a name directly, and `KNOWN_PALLET_ERRORS`
lists every one this version knows — useful for building a copy table. An
unrecognised name returns `unknown`: reacting to it by guessing is how a wallet
deletes notes it should not.

### Outgoing history

The chain never records what a private transfer sent or to whom — that is saved
locally at submission time. `reconstructOutgoingTxRecords` rebuilds it after a
restore from each transfer's shape (`amount = Σ(inputs) − change − fee`), reading
through a `TransferFactsSource` the host implements.

That source is separate from the scan feeds on purpose: unlike `NullifierSource`,
its queries DO send the wallet's own identifiers to the server. It is the
documented linkage trade-off history reconstruction makes, and a host that
prefers not to make it simply does not implement it.

### Storage

`VaultStorage` is an interface, so the vault can live anywhere. Two
implementations ship:

- `MemoryVaultStorage` (root entry) — servers, tests
- `IndexedDbVaultStorage` (`@orbinum/sdk/storage/indexeddb`) — browsers

Both pass the same conformance suite. One requirement is easy to miss when
writing a third: **`updateConfig` must be atomic.** Two callers that read the
same `selfEphCounter` derive the same ephemeral index and publish the same
ephemeral point, which publicly links the two notes. That is a privacy leak, not
a lost update.

### Backing notes up

A backup is **JSON**, and it is closed: each entry carries the note's
commitment and its encrypted memo, never a spending key. Ownership is proved on
import by decrypting the memo, so a backup file that leaks reveals nothing an
observer could not already read off the chain.

```ts
import { encodeNoteBackup, decodeNoteBackup, importNotesFromBackup } from '@orbinum/sdk';

const file = JSON.stringify(encodeNoteBackup(notes));
const mine = importNotesFromBackup(decodeNoteBackup(file), {
    viewingSecretKey,
    spendingKey,
    ownerPk,
});
```

`importNotesFromBackup` silently skips entries that do not decrypt — they belong
to someone else. A malformed entry is rejected by `decodeNoteBackup` before that,
so a hand-edited file cannot plant a note with a broken commitment.

### Porting to another platform

Three adapters are all that differ between a web page, a browser extension and a
mobile app. Everything above them — the encrypted vault, the scan, the identity
cache — is shared.

| Interface        | Browser                         | Extension              | Mobile             |
| ---------------- | ------------------------------- | ---------------------- | ------------------ |
| `VaultStorage`   | `IndexedDbVaultStorage`         | same                   | SQLite, MMKV       |
| `SecretStore`    | `createWebStorageSecretStore`   | `chrome.storage.local` | Keychain, Keystore |
| `DeviceKeyStore` | `createIndexedDbDeviceKeyStore` | same                   | secure enclave     |

The identity cache is what keeps a user from re-signing on every launch. On
Substrate that is more than convenience: sr25519 signatures are randomised, so a
second signature over the same message derives a DIFFERENT key and a different
vault.

```ts
import { cacheSession, restoreSession, createDeviceKeyProvider } from '@orbinum/sdk';

const deviceKey = await createDeviceKeyProvider(myKeyStore)();
await cacheSession({ store: mySecretStore, deviceKey }, address, chainId, manager.exportHex());

// Next launch — no signature needed:
const identity = await restoreSession({ store: mySecretStore, deviceKey }, address, chainId);
```

The cached value is encrypted at rest under a device key that never leaves the
device, and it is scoped per `(chainId, account)` — the chain is part of the key
derivation, so a cache shared across networks would restore one network's
identity into another.

Use `vaultStorageName(address, chainFingerprint)` for the vault's name rather
than composing one. It canonicalises the account exactly as the key derivation
does; keying off the raw address means a wallet that re-lists an account under a
different SS58 prefix derives the same key but opens a different vault, and the
notes are orphaned with no error to explain it.

[`examples/node-wallet/portability.ts`](./examples/node-wallet/portability.ts)
runs the whole flow with none of the browser adapters, in CI.

#### What each host has to provide

The SDK itself uses no browser API outside the `storage/indexeddb` subpath. Two
globals it does assume are missing from React Native and need a polyfill
imported **before** the SDK:

| Global                                    | Needed by                                                  | React Native                             |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `crypto.subtle`, `crypto.getRandomValues` | vault encryption, blinding                                 | `react-native-quick-crypto`              |
| `atob`                                    | `poseidon-lite` decodes its round constants at import time | `react-native-quick-base64` or `base-64` |

The `atob` one fails at **module load**, not on first use, so the symptom is an
import that throws rather than a hash that misbehaves. Everything else — Node,
Deno, Bun, Cloudflare Workers, extension service workers — already has both.

Browser wallet extensions are the one capability that cannot be polyfilled: they
need a page. Call `hasInjectedExtensions()` before offering them, and sign with
`getSubstrateSigner` (a keypair) where it returns false.

### Scanning without leaking what you own

`NullifierSource` has no "is this nullifier spent?" method, and that omission is
the design. The wallet downloads the spent set and intersects it locally, so
every request the server sees is identical regardless of which notes the caller
holds. A per-nullifier lookup would be simpler and would tell the server exactly
what you own.

## Entry points

| Import                           | Contents                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `@orbinum/sdk`                   | Protocol, keys, vault, scanner, wallet facade — environment-agnostic |
| `@orbinum/sdk/storage/indexeddb` | `IndexedDbVaultStorage`, the browser vault backend                   |
| `@orbinum/sdk/worker`            | Trial-decryption kernel and pool, for a Web Worker                   |

The worker entry carries no chain client and no transport, so a worker bundle
built from it stays small.

Web Workers are spawned by the HOST, not by the SDK: `new Worker(new URL(...,
import.meta.url))` is a build-time rewrite that a published package cannot
perform. Pass a `factory` to `createDecryptPool`, or `null` to decrypt on the
calling thread.

## Requirements

- Any runtime with WebCrypto and `fetch` — Node 18+, Deno, Bun, a browser, an
  extension service worker, a Cloudflare Worker
- React Native additionally needs two polyfills imported before the SDK; see
  [What each host has to provide](#what-each-host-has-to-provide)
- An Orbinum node's Substrate WebSocket endpoint

## License

MIT
