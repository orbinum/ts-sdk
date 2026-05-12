# @orbinum/sdk

Official TypeScript SDK for Orbinum — a privacy-focused blockchain built on Substrate with an EVM compatibility layer.

The SDK provides typed modules for interacting with the Orbinum protocol: Substrate RPC, EVM JSON-RPC, shielded pool operations, ZK proof generation, encrypted note vault, account identity and mapping, relayer status, `rpc-v2`, ZK verifier, precompiles, and the indexer REST API.

## Installation

```bash
npm install @orbinum/sdk
# or
pnpm add @orbinum/sdk
```

## Requirements

- Node.js 18 or later (WebCrypto API required for vault operations)
- A running Orbinum node (Substrate WebSocket endpoint)
- An EVM JSON-RPC endpoint (optional — required for EVM and precompile operations)

## Quick Start

```ts
import { OrbinumClient } from '@orbinum/sdk';

const client = await OrbinumClient.connect({
    substrateWs: 'ws://localhost:9944',
    evmRpc: 'http://localhost:9933',
});

const chainInfo = await client.substrate.getChainInfo();
const root      = await client.rpcV2.privacy.getMerkleRoot();
const events    = await client.substrate.queryBlockEvents('0xabc...');
```

`OrbinumClient` wires together the SDK surface under a single interface.

- `client.substrate`: Substrate WebSocket RPC, block queries, event decoding, and transaction helpers
- `client.evm`: EVM JSON-RPC client, or `null` if `evmRpc` was not configured
- `client.rpcV2`: typed Orbinum `rpc-v2` namespaces
- `client.shieldedPool`: shielded-pool extrinsics and note helpers
- `client.accountMapping`: alias, chain-link, metadata, and marketplace operations
- `client.precompiles`: EVM precompile wrappers, or `null` if `evmRpc` was not configured

Each module can also be instantiated independently.

## OrbinumClientProvider

`OrbinumClientProvider` wraps `OrbinumClient` with automatic WebSocket reconnection, typed connection status events, and a React-friendly lifecycle.

```ts
import { OrbinumClientProvider } from '@orbinum/sdk';

const provider = new OrbinumClientProvider({
    substrateWs: 'ws://localhost:9944',
    evmRpc: 'http://localhost:9933',
});

provider.on('statusChange', (event) => {
    console.log(event.status); // 'connecting' | 'connected' | 'disconnected' | 'error'
});

await provider.connect();
const client = provider.client; // OrbinumClient once connected
```

## Modules

### SubstrateClient

Thin wrapper over [polkadot-api](https://github.com/polkadot-api/polkadot-api) (PAPI) for Substrate WebSocket communication.

```ts
import { SubstrateClient } from '@orbinum/sdk';

const substrate = await SubstrateClient.connect('ws://localhost:9944');

const info    = await substrate.getChainInfo();
const health  = await substrate.getHealth();
const version = await substrate.getNodeVersion();
const genesis = await substrate.getGenesisHash();

// Block queries
const header = await substrate.getBlockHeader('best');
const hash   = await substrate.getBlockHash(1000);
const block  = await substrate.getBlock('0xabc...');

// Block events — decoded into EventRecord[]
const events = await substrate.queryBlockEvents('0xabc...');

// Block stream
substrate.blocks$.subscribe(block => console.log(block.number));

// Raw JSON-RPC call
const result = await substrate.request('system_name', []);

// Transaction helpers
const tx         = await substrate.txFromCallData(callBytes);
const finalized  = await tx.signAndSubmit(signer);
const finalized2 = await substrate.submit(signedHex);
substrate.submitAndWatch(signedHex).subscribe(event => console.log(event));
```

### EvmClient

Stateless HTTP client following the Ethereum JSON-RPC specification.

```ts
import { EvmClient } from '@orbinum/sdk';

const evm = new EvmClient('http://localhost:9933');

const balance = await evm.getBalance('0xYourAddress');
const chainId = await evm.getChainId();
const txHash  = await evm.sendRawTransaction(signedHex);

// Batch multiple calls in a single HTTP request
const [bal, nonce] = await evm.batchRequest([
    { method: 'eth_getBalance',          params: ['0xAddr', 'latest'] },
    { method: 'eth_getTransactionCount', params: ['0xAddr', 'latest'] },
]);
```

### EvmExplorer

Read-only EVM block and transaction explorer.

```ts
import { EvmExplorer } from '@orbinum/sdk';

const explorer = new EvmExplorer('http://localhost:9933');

const block = await explorer.getBlock(12345);
const tx    = await explorer.getTransaction('0xhash...');
const logs  = await explorer.getLogs({ fromBlock: 100, toBlock: 200, address: '0x...' });
```

Types: `EvmBlock`, `EvmTransaction`, `EvmAddressInfo`, `EvmTxSummary`, `EvmLog`, `TokenInfo`, `TokenTransfer`.

### rpc-v2 / PrivacyModule

Orbinum's `rpc-v2` is organized by namespace. In the SDK, it is exposed through `client.rpcV2`.

```ts
const root   = await client.rpcV2.privacy.getMerkleRoot();
const proof  = await client.rpcV2.privacy.getMerkleProof(12);
// { path: string[]; leafIndex: number; treeDepth: number; }

const status = await client.rpcV2.privacy.getNullifierStatus('0x...');
// { nullifier: string; isSpent: boolean; }

const stats  = await client.rpcV2.privacy.getPoolStats();
// { merkleRoot: string; commitmentCount: number; totalBalance: string; ... }
```

Notes:
- `rpc-v2` responses use `snake_case` from the node; the SDK normalizes them to `camelCase`.
- `u128` values are exposed as decimal strings to avoid precision loss.

### ZkVerifierModule

Typed access to the on-chain ZK verifier — circuit version info, VK hashes, and version history.

```ts
import { ZkVerifierModule } from '@orbinum/sdk';

const zkv     = new ZkVerifierModule(substrate);
const info    = await zkv.getCircuitVersionInfo('circuit-id');
const vkHash  = await zkv.getVkHash('circuit-id', 1);
const stats   = await zkv.getVersionStats('circuit-id');
const history = await zkv.getHistoricalVersions('circuit-id');
```

### ShieldedPoolModule

High-level interface for shielded pool extrinsics. Transactions are built via polkadot-api's UnsafeApi (metadata-driven). Unshield and private transfer are submitted as **unsigned (gasless)** transactions by default — the fee is embedded in the ZK proof.

```ts
import { ShieldedPoolModule } from '@orbinum/sdk';

const pool = new ShieldedPoolModule(substrate);

// Deposit tokens into the shielded pool (signed)
await pool.shield(params, signer);

// Withdraw tokens via ZK proof (unsigned, gasless)
await pool.unshield(params);

// Private transfer between shielded addresses (unsigned, gasless)
await pool.privateTransfer(params);

// Batch shield
await pool.shieldBatch(params, signer);

// Claim accumulated relayer fees
await pool.claimShieldedFees(params, signer);

// Selective disclosure
await pool.requestDisclosure(args, signer);
await pool.disclose(args, signer);
await pool.rejectDisclosure(args, signer);
```

### NoteBuilder

Builds ZK notes (commitment + nullifier + encrypted memo) off-chain, with optional stealth address support. No network calls are made.

Hash scheme:
```
commitment = Poseidon4(value, assetId, ownerPk, blinding)
nullifier  = Poseidon2(commitment, spendingKey)
```

```ts
import { NoteBuilder } from '@orbinum/sdk';

const note = await NoteBuilder.build({
    value:   1_000_000n,
    assetId: 0n,
    ownerPk: myOwnerPk,
    viewingPublicKey: recipientViewingPk,
    // Optional: provide recipientOwnerPk to derive a per-note stealthOwnerPk
    recipientOwnerPk: recipientOwnerPk,
});
// note.commitmentHex, note.nullifierHex, note.encryptedMemo
```

When `recipientOwnerPk` is provided, the commitment uses a fresh `stealthOwnerPk` derived from an ephemeral ECDH key, making each transfer unlinkable even when the same privacy address is reused.

### NoteDecryptor

Scans on-chain commitments and attempts to decrypt them using the viewer's viewing key.

```ts
import { tryDecryptNote, tryDecryptNoteVerbose, computeNullifier } from '@orbinum/sdk';

// Returns a ZkNote on success, null on key mismatch or commitment failure
const note = tryDecryptNote(commitment, viewingSecretKey, spendingKey, ownOwnerPk);

// Returns the note plus a human-readable failure reason (useful for debugging)
const { note, reason } = tryDecryptNoteVerbose(commitment, viewingSecretKey, spendingKey, ownOwnerPk);

// Compute nullifier directly
const nullifier = computeNullifier(commitmentBigint, spendingKey);
```

`ScanCommitment` shape: `{ commitmentHex: string; leafIndex: number; encryptedMemo: string | null }`.

### EncryptedMemo

All memos attached to shielded notes are exactly **168 bytes** (ChaCha20-Poly1305 with ECDH ephemeral key):

```
nonce(12) || ciphertext+MAC(124) || ephPk(32) = 168 bytes
```

```ts
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '@orbinum/sdk';
// ENCRYPTED_MEMO_SIZE === 168

const memo      = await EncryptedMemo.encrypt(payload, recipientViewingPk, commitment);
const decrypted = await EncryptedMemo.decrypt(memoBytes, viewingSecretKey, commitment);

// Validation is called automatically inside ShieldedPoolModule and ShieldedPoolPrecompile.
// It can also be called explicitly:
EncryptedMemo.validate(memoBytes, 'my-context'); // throws if length !== 168
```

### Coin Selection

```ts
import { selectNotes, buildDummyTransferInput } from '@orbinum/sdk';

// Select up to 2 unspent notes covering `needed` planck.
// Priority: single note first, then smallest qualifying pair.
const selected = selectNotes(myNotes, needed);
// [ZkNote, ZkNote | null] | null

// Build a zero-value dummy second input for single-note private transfers.
// The circuit exempts inputs with value == 0 from Merkle membership and EdDSA checks.
const dummy = buildDummyTransferInput(assetId);
```

### Proof Generator

Wrappers around `@orbinum/proof-generator` for generating Groth16 ZK proofs. The `ArtifactProvider` controls where circuit `.wasm` and `.zkey` files are loaded from — use `WebArtifactProvider` in browser environments.

```ts
import {
    generateUnshieldProof,
    generateTransferProof,
    generateFeeClaimProof,
    WebArtifactProvider,
} from '@orbinum/sdk';

const provider = new WebArtifactProvider('/circuits');

// Unshield proof
const result = await generateUnshieldProof({
    merkleRoot, nullifier, amount, assetId, recipient,
    blinding, spendingKey, pathSiblings, leafIndex,
    fee: 0n,          // optional gasless fee
    changeValue: 0n,  // optional change note value
}, provider);
// result.proof, result.publicSignals, result.changeCommitment

// Private transfer proof (exactly 2 inputs and 2 outputs)
const txProof = await generateTransferProof({
    merkleRoot,
    inputs:  [inputNote1, inputNote2],   // use buildDummyTransferInput for single-note transfers
    outputs: [outputNote1, outputNote2],
    fee: 0n,
}, provider);

// Fee-claim proof
const feeProof = await generateFeeClaimProof({
    amount, assetId, ownerPubkey, blinding, commitment,
}, provider);
// feeProof.proof (128-byte 0x-prefixed hex), feeProof.publicSignals (76-byte number[])
```

### RelayerStatusModule

Typed client for `relayer_*` JSON-RPC endpoints.

```ts
import { RelayerStatusModule } from '@orbinum/sdk';

const relayer = new RelayerStatusModule(substrate);

const isRelayer  = await relayer.isRelayer(ss58Address);
const pending    = await relayer.pendingFees(ss58Address, assetId); // bigint
const evmAddress = await relayer.registeredEvmAddress(ss58Address); // string | null
const info       = await relayer.getRelayerInfo(ss58Address);
// { isRelayer: boolean; evmAddress: string | null }
```

### Vault

AES-GCM-256 encrypted local note storage. Works in browser (WebCrypto) and Node.js 18+.

Key derivation uses HKDF-SHA-256 over 32-byte master material derived **before** modular reduction, so the vault key remains stable across circuit field changes.

```ts
import {
    deriveVaultKey,
    encryptNote,
    decryptNoteRecord,
    applyNoteStatus,
    VaultLockedError,
} from '@orbinum/sdk';

// Derive the vault encryption key from master key bytes (pre-modulus)
const vaultKey = await deriveVaultKey(masterBytes);

// Encrypt a ZkNote into an EncryptedNoteRecord
const record = await encryptNote(vaultKey, zkNote);
// { commitmentHex, iv, ciphertext, nullifierHex, assetId, spent?, updatedAt }

// Decrypt
const note = await decryptNoteRecord(vaultKey, record); // ZkNote

// Update spent status without re-encrypting the full ciphertext
const updated = applyNoteStatus(record, { spent: true, spentAt: Date.now() });
```

The `nullifierHex` and `assetId` fields are stored unencrypted so the host application can perform spent-checks and asset filtering without unlocking the vault.

### Privacy Keys

Key derivation follows a deterministic chain from the user's wallet signature. No key material is ever stored by the SDK.

```ts
import {
    PrivacyKeyManager,
    deriveOwnerPk,
    deriveSpendingKeyFromSignature,
    deriveSpendingKeyMessage,
    deriveViewingKey,
} from '@orbinum/sdk';

const message     = deriveSpendingKeyMessage(chainId, evmAddress);
const spendingKey = deriveSpendingKeyFromSignature(sigHex, chainId, evmAddress);

const keyManager = new PrivacyKeyManager();
keyManager.load(spendingKey);

const viewingKey = deriveViewingKey(spendingKey);
const ownerPk    = deriveOwnerPk(spendingKey);
```

### AccountMappingModule

Manage on-chain identity by linking Substrate and EVM accounts, registering aliases, and interacting with the alias marketplace.

```ts
await client.accountMapping.registerAlias({ alias: 'myalias' }, signer);
await client.accountMapping.addChainLink({ chainId: 1, address: '0xEvmAddr' }, signer);

const alias  = await client.accountMapping.getAliasOf(substrateHex);
const linked = await client.accountMapping.getChainLinks(substrateHex);
```

### IndexerClient

HTTP client for the Orbinum indexer REST API. All list endpoints are paginated.

```ts
import { IndexerClient } from '@orbinum/sdk';

const indexer = new IndexerClient({ baseUrl: 'https://indexer.orbinum.io' });

const blocks      = await indexer.getBlocks({ page: 1, limit: 20 });
const extrinsics  = await indexer.getExtrinsics({ address: '5F...' });
const commitments = await indexer.getCommitments({ page: 1, limit: 20 });
const nullifier   = await indexer.getNullifierStatus('0xNullifier');
const roots       = await indexer.getMerkleRoots({ limit: 10 });
const evmTxs      = await indexer.getEvmTransactions({ address: '0xabc...' });
const stats       = await indexer.getStats();
```

### Precompiles

Typed wrappers for Orbinum's EVM precompile contracts.

| Precompile | Address | Description |
|---|---|---|
| `ShieldedPoolPrecompile` | `0x0801` | Shield, unshield, and private transfer from EVM |
| `AccountMappingPrecompile` | `0x0800` | Identity and alias operations from EVM |
| `CryptoPrecompiles` | `0x0400–0x0403` | Frontier crypto utilities |

```ts
import { ShieldedPoolPrecompile, decodePrecompileCalldata } from '@orbinum/sdk';

const precompile = new ShieldedPoolPrecompile(evmClient);
await precompile.shield(amount, tokenAddress, commitment, walletSigner);

// Decode raw EVM calldata for a known precompile
const decoded = decodePrecompileCalldata('0x0800', calldata);
```

### Extrinsic & Event Decoders

```ts
import { mapExtrinsicArgs, mapZkEventData } from '@orbinum/sdk';

const decoded   = mapExtrinsicArgs('shieldedPool', 'shield', rawArgs);
const eventData = mapZkEventData('ProofVerified', rawEventData);
```

### Substrate SCALE Primitives

SCALE codec primitives from `@polkadot-api/substrate-bindings` are re-exported directly. There is no need to install that package separately.

```ts
import { Blake2256, AccountId, u128, u64, Storage, Keccak256 } from '@orbinum/sdk';
import { base58, getSs58AddressInfo } from '@orbinum/sdk';
```

## Key Derivation Chain

```
wallet.sign(message)
        |
        v
deriveSpendingKeyFromSignature()     HKDF-SHA256 over signature bytes, mod BN254_R
        |
        +-- deriveViewingKey()       HKDF-SHA256 → 32-byte ChaCha20 symmetric key
        |                            Used to encrypt/decrypt note memos (EncryptedMemo)
        |
        +-- deriveOwnerPk()          BabyJubJub scalar multiplication → Ax
        |                            Embedded in note commitments: Poseidon4(v, a, ownerPk, b)
        |
        +-- deriveVaultKey()         HKDF-SHA256 (pre-modulus bytes) → AES-GCM-256 key
                                     Stable across circuit field changes
```

### Stealth Addresses

When a sender builds a note for a recipient, a per-note stealth `ownerPk` is derived:

```
ephSk          ← random scalar
sharedSecret   ← ECDH(ephSk, recipientViewingPk)
stealthScalar  ← HKDF-SHA256(sharedSecret, salt=ownerPk_LE, info="orbinum-stealth-v1") % suborder
stealthOwnerPk ← stealthScalar × Base8 + ownerPkPoint
```

The recipient recovers the stealth spending key:

```
stealthSk ← (stealthScalar + spendingKey) % BABYJUB_SUBORDER
```

Each received note has a unique `stealthOwnerPk`, making transfers unlinkable even when the same privacy address is reused. The ZK circuit validates ownership without modification because `BabyPbk(stealthSk).Ax == stealthOwnerPk`.

## Development

### Type Layout

The SDK organizes types by feature ownership.

- `types/index.ts`: public shared types of the feature
- `types/pallet-events.ts`: event payloads and discriminated unions
- `types/pallet-extrinsics.ts`: extrinsic argument types and call unions
- `types/raw.ts`: internal node or RPC response shapes used only for transport mapping

Rules:
1. Public types belong in the feature's `types/index.ts`.
2. Transport-only types belong in `types/raw.ts`.
3. Do not reintroduce a global `src/types.ts` or `src/types/` directory.
4. Export public types from `src/index.ts`, keeping ownership at the feature level.

### Extending `rpc-v2`

Add a new namespace by creating `src/rpc-v2/NetModule.ts`, defining raw response types, mapping them to SDK-facing types, and attaching the module in `RpcV2Module`. Add unit tests verifying RPC method names, params, and response mapping.

### Commands

```bash
pnpm install
pnpm build          # compile to dist/ (ESM + CJS + types)
pnpm test           # run test suite
pnpm typecheck:all  # typecheck src and tests
pnpm lint           # eslint
pnpm format         # prettier
```

## License

ISC
