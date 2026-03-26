# @orbinum/sdk

Official TypeScript SDK for Orbinum — a privacy-focused blockchain built on Substrate with an EVM compatibility layer.

The SDK provides typed modules for interacting with the Orbinum protocol: shielded pool operations, account identity and mapping, chain queries, EVM JSON-RPC, and the indexer REST API.

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
```

`OrbinumClient` wires together all modules and exposes them under a single interface. Each module can also be instantiated independently.

## Modules

### SubstrateClient

Thin wrapper over [polkadot-api](https://github.com/polkadot-api/polkadot-api) (PAPI) for Substrate WebSocket communication.

```ts
import { SubstrateClient } from '@orbinum/sdk';

const substrate = await SubstrateClient.connect('ws://localhost:9944');

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

### ShieldedPoolModule

High-level interface for shielded pool operations. Requires a loaded `PrivacyKeyManager` and ZK proofs for unshield and private transfer.

```ts
// Shield (deposit) tokens into the shielded pool
const { txResult, note } = await client.shieldedPool.buildAndShield({
    amount: 1_000_000n,
    tokenAddress: '0xTokenAddress',
}, signer);

// Private transfer between notes
await client.shieldedPool.privateTransfer({ ...params }, signer);

// Unshield (withdraw) tokens to a public address
await client.shieldedPool.unshield({ ...params }, signer);

// Check if a nullifier has been spent
const spent = await client.shieldedPool.isNullifierSpent('0xNullifier');
```

### Privacy Keys

Key derivation follows a deterministic chain from the user's wallet signature. No key material is ever stored by the SDK.

```ts
import { PrivacyKeys, PrivacyKeyManager } from '@orbinum/sdk';

// 1. Get the message the user must sign
const message = PrivacyKeys.deriveSpendingKeyMessage(chainId, evmAddress);

// 2. Derive the spending key from the wallet signature
const spendingKey = PrivacyKeys.deriveSpendingKeyFromSignature(sigHex, chainId, evmAddress);

// 3. Load into the key manager
const keyManager = new PrivacyKeyManager();
keyManager.load(spendingKey);

// The manager derives the viewing key (ChaCha20 memo decryption)
// and owner public key (BabyJubJub, used in note commitments)
const viewingKey = keyManager.getViewingKey();
const ownerPk    = keyManager.getOwnerPk();
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

### ChainModule

Query chain information bridging Substrate and EVM endpoints.

```ts
const info      = await client.chain.getChainInfo();   // name, spec, SS58 prefix
const identity  = await client.chain.getFullIdentity(address);
const health    = await client.chain.getHealth();
const evmBlock  = await client.chain.getEvmBlockNumber();
```

### IndexerClient

HTTP client for the Orbinum indexer REST API. The indexer runs as a separate service indexed from node events.

```ts
import { IndexerClient } from '@orbinum/sdk';

const indexer = new IndexerClient('https://indexer.orbinum.io');

const commitments = await indexer.getCommitments({ page: 1, limit: 20 });
const status      = await indexer.getNullifierStatus('0xNullifier');
const roots       = await indexer.getMerkleRoots({ limit: 10 });
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
