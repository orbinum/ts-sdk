# @orbinum/sdk

Official TypeScript SDK for Orbinum — a privacy-focused blockchain built on Substrate with an EVM compatibility layer.

## Installation

```bash
npm install @orbinum/sdk
# or
pnpm add @orbinum/sdk
```

## Requirements

- Node.js 18 or later
- A running Orbinum node (Substrate WebSocket endpoint)

## Quick Start

```ts
import { OrbinumClient } from '@orbinum/sdk';

const client = await OrbinumClient.connect({
    substrateWs: 'ws://localhost:9944',
    evmRpc: 'http://localhost:9933', // optional
});

const info  = await client.substrate.getChainInfo();
const root  = await client.rpcV2.privacy.getMerkleRoot();
const block = await client.substrate.getBlock('best');
```

`OrbinumClient` exposes the following modules:

| Property | Description |
|---|---|
| `client.substrate` | Substrate RPC — blocks, events, transactions |
| `client.evm` | EVM JSON-RPC client (`null` if `evmRpc` not set) |
| `client.rpcV2` | Orbinum `rpc-v2` namespaces (`privacy_*`, etc.) |
| `client.shieldedPool` | Shielded pool extrinsics |
| `client.accountMapping` | Alias, chain-link, and identity operations |
| `client.precompiles` | EVM precompile wrappers (`null` if `evmRpc` not set) |

Each module can also be instantiated independently without `OrbinumClient`.

## License

MIT
