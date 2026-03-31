# @orbinum/sdk

Official TypeScript SDK for Orbinum — a privacy-focused blockchain built on Substrate with an EVM compatibility layer.

The SDK provides typed modules for interacting with the Orbinum protocol: Substrate RPC, EVM JSON-RPC, shielded pool operations, account identity and mapping, `rpc-v2`, precompiles, and the indexer REST API.

It also exposes typed access to Orbinum `rpc-v2` namespaces over the Substrate WebSocket connection.

## Installation

```bash
npm install @orbinum/sdk
# or
pnpm add @orbinum/sdk
```

## Requirements

- Node.js 18 or later
- A running Orbinum node (Substrate WebSocket endpoint)
- An EVM JSON-RPC endpoint (optional, required for EVM and precompile operations)

## Quick Start

```ts
import { OrbinumClient } from '@orbinum/sdk';

const client = await OrbinumClient.connect({
    substrateWs: 'ws://localhost:9944',
    evmRpc: 'http://localhost:9933',
});

const chainInfo = await client.substrate.getChainInfo();
const root = await client.rpcV2.privacy.getMerkleRoot();
const tree = await client.shieldedPool.merkle.getTreeInfo();
```

`OrbinumClient` wires together the current SDK surface under a single interface.

- `client.substrate`: Substrate WebSocket RPC and transaction helpers
- `client.evm`: EVM JSON-RPC client, or `null` if `evmRpc` was not configured
- `client.rpcV2`: typed Orbinum `rpc-v2` namespaces
- `client.shieldedPool`: shielded-pool extrinsics, note helpers, and Merkle queries
- `client.accountMapping`: alias, chain-link, metadata, and marketplace operations
- `client.precompiles`: EVM precompile wrappers, or `null` if `evmRpc` was not configured

Each module can also be instantiated independently.

## rpc-v2

Orbinum's `rpc-v2` is organized by namespace.

- Standard Frontier namespaces: `eth_*`, `net_*`, `web3_*`, `txpool_*`, `debug_*`
- Orbinum-specific namespace: `privacy_*`

In the SDK, `rpc-v2` is modeled as a dedicated top-level module, exposed through `client.rpcV2`. Each namespace lives under `src/rpc-v2/` and is grouped there instead of being mixed into legacy protocol modules.

Current typed coverage:

- `client.rpcV2.privacy.getMerkleRoot()`
- `client.rpcV2.privacy.getMerkleProof(leafIndex)`
- `client.rpcV2.privacy.getNullifierStatus(nullifier)`
- `client.rpcV2.privacy.getPoolStats()`

Example:

```ts
const root = await client.rpcV2.privacy.getMerkleRoot();

const proof = await client.rpcV2.privacy.getMerkleProof(12);
// {
//   path: string[];
//   leafIndex: number;
//   treeDepth: number;
// }

const status = await client.rpcV2.privacy.getNullifierStatus('0x...');
// {
//   nullifier: string;
//   isSpent: boolean;
// }

const stats = await client.rpcV2.privacy.getPoolStats();
// {
//   merkleRoot: string;
//   commitmentCount: number;
//   totalBalance: string;
//   assetBalances: { assetId: number; balance: string }[];
//   treeDepth: number;
// }
```

Notes:

- `rpc-v2` responses from the node use `snake_case`; the SDK maps them to `camelCase`.
- `u128` values are exposed as decimal strings to avoid precision loss in JavaScript.
- Privacy queries belong to `client.rpcV2.privacy.*`; they are no longer described as part of `ShieldedPoolModule`.

## Modules

### SubstrateClient

Thin wrapper over [polkadot-api](https://github.com/polkadot-api/polkadot-api) (PAPI) for Substrate WebSocket communication.

```ts
import { SubstrateClient } from '@orbinum/sdk';

const substrate = await SubstrateClient.connect('ws://localhost:9944');

const info = await substrate.getChainInfo();
const health = await substrate.getHealth();
const version = await substrate.getNodeVersion();
const genesis = await substrate.getGenesisHash();

// Raw JSON-RPC call
const result = await substrate.request('system_name', []);

// Build a transaction from pre-encoded SCALE call bytes
const tx = await substrate.txFromCallData(callBytes);
const finalized = await tx.signAndSubmit(signer);

// Submit a pre-signed extrinsic
const finalized = await substrate.submit(signedHex);

// Submit and observe lifecycle events
substrate.submitAndWatch(signedHex).subscribe(event => console.log(event));
```

### EvmClient

Stateless HTTP client following the Ethereum JSON-RPC specification.

```ts
import { EvmClient } from '@orbinum/sdk';

const evm = new EvmClient('http://localhost:9933');

const balance = await evm.getBalance('0xYourAddress');
const chainId = await evm.getChainId();
const txHash = await evm.sendRawTransaction(signedHex);

// Batch multiple calls in a single HTTP request
const [balance, nonce] = await evm.batchRequest([
    { method: 'eth_getBalance', params: ['0xAddr', 'latest'] },
    { method: 'eth_getTransactionCount', params: ['0xAddr', 'latest'] },
]);
```

### RpcV2Module

Top-level typed entry point for Orbinum `rpc-v2` namespaces.

```ts
const root = await client.rpcV2.privacy.getMerkleRoot();
const proof = await client.rpcV2.privacy.getMerkleProof(4);
const nullifier = await client.rpcV2.privacy.getNullifierStatus('0xNullifier');
const stats = await client.rpcV2.privacy.getPoolStats();
```

### ShieldedPoolModule

High-level interface for shielded pool extrinsics and note workflows. Requires a loaded `PrivacyKeyManager` and ZK proofs for unshield and private transfer.

```ts
// Shield (deposit) tokens into the shielded pool
const { txResult, note } = await client.shieldedPool.buildAndShield({
    amount: 1_000_000n,
    assetId: 1,
    tokenAddress: '0xTokenAddress',
}, signer);

const treeInfo = await client.shieldedPool.merkle.getTreeInfo();

// Private transfer between notes
await client.shieldedPool.privateTransfer({ ...params }, signer);

// Unshield (withdraw) tokens to a public address
await client.shieldedPool.unshield({ ...params }, signer);

```

### PrivacyModule (`rpc-v2`)

Typed wrapper for Orbinum `privacy_*` endpoints from `rpc-v2`.

```ts
import { PrivacyModule } from '@orbinum/sdk';

const privacy = new PrivacyModule(client.substrate);

const merkleRoot = await privacy.getMerkleRoot();
const merkleProof = await privacy.getMerkleProof(4);
const nullifier = await privacy.getNullifierStatus('0xNullifier');
const stats = await privacy.getPoolStats();
```

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

// 1. Get the message the user must sign
const message = deriveSpendingKeyMessage(chainId, evmAddress);

// 2. Derive the spending key from the wallet signature
const spendingKey = deriveSpendingKeyFromSignature(sigHex, chainId, evmAddress);

// 3. Load into the key manager
const keyManager = new PrivacyKeyManager();
keyManager.load(spendingKey);

// The manager derives the viewing key (ChaCha20 memo decryption)
// and owner public key (BabyJubJub, used in note commitments)
const viewingKey = deriveViewingKey(spendingKey);
const ownerPk = deriveOwnerPk(spendingKey);
```

### AccountMappingModule

Manage on-chain identity by linking Substrate and EVM accounts, registering aliases, and interacting with the alias marketplace.

```ts
// Register an alias
await client.accountMapping.registerAlias({ alias: 'myalias' }, signer);

// Link an EVM address to a Substrate account
await client.accountMapping.addChainLink({ chainId: 1, address: '0xEvmAddr' }, signer);

// Query
const alias = await client.accountMapping.getAliasOf(substrateHex);
const linked = await client.accountMapping.getChainLinks(substrateHex);
```

### IndexerClient

HTTP client for the Orbinum indexer REST API. The indexer runs as a separate service indexed from node events.

```ts
import { IndexerClient } from '@orbinum/sdk';

const indexer = new IndexerClient({
    baseUrl: 'https://indexer.orbinum.io',
});

const commitments = await indexer.getCommitments({ page: 1, limit: 20 });
const status      = await indexer.getNullifierStatus('0xNullifier');
const roots       = await indexer.getMerkleRoots({ limit: 10 });
const extrinsics  = await indexer.getAddressExtrinsics('5F...');
const evmTxs      = await indexer.getEvmTransactions({ address: '0xabc...' });
```

### Precompiles

Typed wrappers for Orbinum's EVM precompile contracts, callable from any EVM wallet or signer.

| Precompile | Address | Description |
|---|---|---|
| `ShieldedPoolPrecompile` | `0x0801` | Shield, unshield, and private transfer from EVM |
| `AccountMappingPrecompile` | `0x0800` | Identity and alias operations from EVM |
| `CryptoPrecompiles` | `0x0400–0x0403` | Frontier crypto utilities (SHA3, EC recover, Curve25519) |

```ts
import { ShieldedPoolPrecompile } from '@orbinum/sdk';

const precompile = new ShieldedPoolPrecompile(evmClient);
await precompile.shield(amount, tokenAddress, commitment, walletSigner);
```

## Key Derivation Chain

```
wallet.sign(message)
        |
        v
deriveSpendingKeyFromSignature()   -- HKDF-SHA256 over signature bytes, mod BN254_R
        |
        +-- deriveViewingKey()     -- HKDF-SHA256 -> 32-byte ChaCha20 symmetric key
        |                             (used to encrypt/decrypt note memos)
        |
        +-- deriveOwnerPk()        -- BabyJubJub scalar multiplication -> Ax
                                      (embedded in shielded note commitments)
```

## Development

### Typing Layout

The SDK organizes types by feature ownership.

- `types/index.ts`: public shared types of the feature
- `types/pallet-events.ts`: event payloads and discriminated unions for that pallet
- `types/pallet-extrinsics.ts`: extrinsic argument types and call unions for that pallet
- `types/raw.ts`: internal node or RPC response shapes used only for transport mapping

Examples:

- `src/shielded-pool/types/index.ts`
- `src/shielded-pool/types/pallet-events.ts`
- `src/shielded-pool/types/pallet-extrinsics.ts`
- `src/rpc-v2/types/raw.ts`
- `src/indexer/types/index.ts`
- `src/precompiles/types/index.ts`

Rules:

1. If a type is part of the public API of a feature, keep it in that feature's `types/index.ts`.
2. If a type only mirrors a transport payload from RPC, keep it in `types/raw.ts`.
3. Do not reintroduce a global `src/types.ts` or `src/types/` directory.
4. Export public types from `src/index.ts`, but keep ownership at the feature level.

### Extending `rpc-v2`

The intended extension pattern is namespace-oriented and centralized under `RpcV2Module`.

For example, to add `net_*` support:

1. Create `src/rpc-v2/NetModule.ts`
2. Define raw response types that match the node's JSON exactly
3. Map raw `snake_case` or hex-shaped values into stable SDK-facing TypeScript types
4. Export the module from `src/rpc-v2/index.ts`
5. Attach it in `RpcV2Module`, for example as `client.rpcV2.net`
6. Add unit tests that verify RPC method names, params, and response mapping

Minimal shape example:

```ts
export class NetModule {
    constructor(private readonly substrate: SubstrateClient) {}

    async version(): Promise<string> {
        return this.substrate.request<string>('net_version', []);
    }

    async peerCount(): Promise<string> {
        return this.substrate.request<string>('net_peerCount', []);
    }

    async listening(): Promise<boolean> {
        return this.substrate.request<boolean>('net_listening', []);
    }
}
```

The same approach applies to `web3_*`, `txpool_*`, `eth_*`, and any future Orbinum-specific namespaces.

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
