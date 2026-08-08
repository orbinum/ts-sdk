export { SubstrateClient } from './SubstrateClient';
export type { DynamicBuilder, ExtrinsicDecoder } from './SubstrateClient';
export type {
    ChainInfo,
    SystemHealth,
    EventRecord,
    EventPhase,
    EventData,
    RawBlockHeader,
    RawBlock,
    BlockInfo,
} from './types';
// Decoding an extrinsic's arguments and the events it emitted.
export * from './extrinsic/index';

// ─── SCALE primitives, re-exported ───────────────────────────────────────────
// A consumer decoding storage or building a call needs these, and pinning them
// here means they cannot drift from the polkadot-api version this SDK compiles
// against.
export {
    Blake2256,
    AccountId,
    u128,
    u64,
    Storage,
    Keccak256,
} from '@polkadot-api/substrate-bindings';
export { base58 } from '@scure/base';
export { getSs58AddressInfo } from 'polkadot-api';
export type { PolkadotSigner as SubstrateSigner } from 'polkadot-api';

// ─── Signers ─────────────────────────────────────────────────────────────────
/** From a raw keypair — servers, tests, and any host with no extension. */
export { getPolkadotSigner as getSubstrateSigner } from 'polkadot-api/signer';
/** From a browser wallet extension. Pair with `hasInjectedExtensions()`. */
export { getPolkadotSignerFromPjs as getSubstrateSignerFromExtension } from 'polkadot-api/pjs-signer';
export type { SignPayload, SignRaw } from 'polkadot-api/pjs-signer';
