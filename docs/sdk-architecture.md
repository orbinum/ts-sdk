# SDK Architecture

How `@orbinum/sdk` is built as a package: the layer rule, the published
surface, and the properties CI refuses to lose. What the SDK _models_ — notes,
identity, spending — is the [note-model series](./notes/README.md).

---

## 1. The layer rule

Twenty flat directories became five layers, each depending only downward:

```
src/
├── foundation/   encoding, crypto primitives, text, errors      needs nothing
├── protocol/     note, memo, eph, spend, keys, proving,         pure and offline —
│                 circuit-version                                no chain, no storage
├── chain/        client, substrate, evm, rpc, pallet            needs a connection
├── wallet/       vault, scanner, ops, identity, provenance,     needs protocol + chain
│                 worker, OrbinumWallet
└── adapters/     indexeddb                                      needs a browser
```

**`foundation ← protocol ← chain ← wallet`, never the reverse.** Where a symbol
sits tells you what it needs — `protocol/` runs in a Web Worker or fully
offline; only scanning and spending reach `chain/`.

Two placements are worth their own sentence:

- **`foundation/errors/abort.ts`** — `scanner` and `worker` both need the abort
  helper, and neither may own it: they are two _published subpaths_, and a cycle
  between them survives only as long as the bundler deduplicates it.
- **`chain/pallet/`** holds the modules that _move_ notes on chain; what a note
  _is_ stays in `protocol/`. A rotation of the pallet's extrinsic shapes must
  not touch the note format, and vice versa.

No module imports from the root barrel. Doing so drags the whole graph into
whatever imports it — the worker kernel once did, and only the import-graph test
(§5) caught `polkadot-api` bleeding into the worker bundle.

## 2. The public surface

### The root barrel

`src/index.ts` re-exports the layers **in layer order**, one commented section
each. Two rules govern it:

- `export *` only where a layer's barrel _is_ its API. Layers that carry
  internals — the EVM ABI encoder, vault reset helpers, fast-mul variants — are
  exported **by name**, because a blanket splat once leaked 37 internal symbols
  into the public surface.
- The surface is snapshot-checked: a reorganisation must end with **zero lost
  exports** against the pre-move snapshot, on all three entry points.

### Published subpaths

| Import                           | Built from                        | Why it exists                                               |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `@orbinum/sdk`                   | `src/index.ts`                    | everything environment-agnostic                             |
| `@orbinum/sdk/worker`            | `src/wallet/worker/index.ts`      | the decrypt kernel, for a bundle with no chain client in it |
| `@orbinum/sdk/storage/indexeddb` | `src/adapters/indexeddb/index.ts` | browser persistence a Node consumer must not carry          |

**The public names are frozen; the source paths track the layout.** A
reorganisation may change where a subpath is _built from_, never what it is
called — `tests/packaging.test.ts` keeps the two columns apart on purpose.

The subpaths were declared (empty) in 1.0.0's packaging phase _before_ any code
shipped from them: adding a subpath after code has shipped from the root is a
breaking change, reserving one is not.

### Packaging

- `polkadot-api` and `@polkadot/util-crypto` are **peer dependencies** —
  singletons in practice; a second copy of `polkadot-api` is a second WebSocket
  and a second view of chain state.
- `"sideEffects": false`, so the browser adapter tree-shakes out of non-browser
  bundles.
- tsup builds the three entries; shared code lands in common chunks, which is
  what makes module-level state (the eph-window cache) a **single** instance
  even when both the root and `/worker` reach it.

## 3. Portability

The root entry and `/worker` are environment-agnostic. Only
`adapters/indexeddb` may touch a browser API. The rules that keep it true:

| Rule                                                   | Why                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `btoa`/`atob`/`Buffer` — base64 is hand-rolled      | React Native has none of them; the vault envelope encodes through base64, so a missing global is a `ReferenceError` on the first note a phone saves                    |
| No bare `window` — reach through `globalThis`, guarded | extension _service workers_ have `self` but no `window`; `hasInjectedExtensions()` turns the crash into a checkable answer                                             |
| No `lib.dom` names in public types                     | `MessageEvent` in `WorkerLike` broke typechecking for any consumer without `@types/node`; structural stand-ins (`WorkerMessage`, the ambient `CryptoKey`) replace them |
| `DOMException` only behind `typeof`                    | absent in older Node                                                                                                                                                   |
| Workers are spawned by the **host**                    | `new Worker(new URL(...))` is a build-time rewrite a published package cannot perform; `createDecryptPool` takes a required factory, `null` = calling thread           |
| Storage backends resolve **per call**, never at import | a module-scope `indexedDB` touch made _importing_ the subpath crash in a service worker                                                                                |

Assumed present everywhere (browsers, Node 18+, Deno, Bun, Workers):
`crypto.subtle`, `fetch`, `TextEncoder`, timers. React Native additionally
needs two polyfills **before importing the SDK**: WebCrypto
(`react-native-quick-crypto`) and `atob` — the latter not for SDK code but for
`poseidon-lite`, which decodes its round constants with `atob` at module load.

## 4. Contracts, not clients

The SDK owns **protocol and consequence**; the host owns **policy, transport
and presentation**. Every capability needing the outside world is an interface
the host implements — storage, scan feeds, session, secrets, workers, and a
`submit` callback per spend operation. The full table, with the privacy
reasoning per contract, is in [notes/README.md §4](./notes/README.md).

The packaging consequence: because transport is injected, one implementation of
the wallet serves a browser tab, an extension service worker, a mobile runtime
and a server — the SDK never learns which it is in.

`OrbinumWallet` assembles the pieces for hosts that want the default shape
(~20 lines to a working wallet); the reference app binds `VaultStore`,
`runScan` and the ops to its own stores directly. Both are supported surfaces.

## 5. What CI refuses to lose

Each mechanism exists because its failure mode was seen, not imagined:

| Check                                                                                         | Catches                                                                                   |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| conformance suites (`VaultStorage`, `WalletSession`) run against **every** implementation     | a contract verified by one implementation only describes that implementation              |
| `tests/packaging.test.ts`                                                                     | a declared subpath with no source entry, peers demoted to dependencies                    |
| `examples/node-wallet` runs **against the packed tarball**, importing only published subpaths | a broken `exports` map, a missing `files` entry — everything a `link:` install sails past |
| `portability.ts` — full identity + vault flow with no browser API in reach                    | a browser global creeping into the agnostic core                                          |
| `spend.ts` — spend deps assembled from the facade alone                                       | the facade and the ops drifting apart (they once were mutually exclusive)                 |
| the worker import-graph test walks `/worker`'s imports                                        | `polkadot-api` reaching a worker bundle through a careless re-export                      |
| export-surface snapshot                                                                       | a refactor silently dropping public API                                                   |
| mutation checks on security fixes                                                             | a test that passes with the fix reverted is not a test of the fix                         |

The tarball is the honest verifier throughout: a `link:`-ed checkout resolves
`src/` directly and hides exactly the packaging failures a consumer would hit.
