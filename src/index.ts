// ─── Main client ─────────────────────────────────────────────────────────────
export { OrbinumClient } from './client';

// ─── Modules (for direct import / advanced usage) ────────────────────────────
export { SubstrateClient } from './substrate/index';
export { EvmClient } from './evm/index';
export {
    MerkleModule,
    NoteBuilder,
    EncryptedMemo,
    ShieldedPoolModule,
    PrivacyKeyManager,
    tryDecryptNote,
    deriveViewingKey,
    deriveOwnerPk,
    deriveSpendingKeyMessage,
    deriveSpendingKeyFromSignature,
    deriveVaultKey,
    encryptJson,
    decryptJson,
    vaultReplacer,
    vaultReviver,
} from './shielded-pool/index';
export type { DecryptedMemo, ScanCommitment } from './shielded-pool/index';
export { ChainModule } from './chain/index';
export { AccountMappingModule } from './account-mapping/index';
export type {
    AddChainLinkParams,
    SetMetadataParams,
    PutOnSaleParams,
    DispatchAsLinkedParams,
} from './account-mapping/index';
export {
    ShieldedPoolPrecompile,
    AccountMappingPrecompile,
    CryptoPrecompiles,
    PRECOMPILE_ADDR,
    KNOWN_PRECOMPILES,
    getPrecompileLabel,
} from './precompiles/index';
export type {
    EvmTxRequest,
    EvmSigner,
    ResolvedAlias,
    KnownPrecompileInfo,
} from './precompiles/index';

// ─── Utilities ───────────────────────────────────────────────────────────────
export { formatBalance, formatORB } from './utils/format';
export type { FormatOptions } from './utils/format';
export { toHex, fromHex, ensureHexPrefix } from './utils/hex';
export {
    bigintTo32Le,
    bigintTo32Be,
    bigintTo32LeArr,
    bytesToBigintLE,
    computePathIndices,
    leHexToBigint,
} from './utils/bytes';
export {
    normalizeEvmAddress,
    isSs58,
    isEvmAddress,
    evmAddressToAccountId,
    evmToImplicitSubstrate,
    isImplicitEvmAccount,
    implicitSubstrateToEvm,
    isSubstrateAddress,
    isUnifiedAddress,
    substrateToEvm,
    evmToSubstrate,
    accountIdHexToSs58,
    substrateSs58ToAccountIdHex,
    addressToAccountIdHex,
} from './utils/address';

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
    OrbinumClientConfig,
    TxResult,
    MerkleTreeInfo,
    PoolStats,
    MerkleProof,
    CommitmentMerkleProof,
    NullifierStatus,
    PoolBalance,
    ShieldParams,
    ShieldResult,
    UnshieldParams,
    TransferInput,
    TransferOutput,
    PrivateTransferParams,
    NoteInput,
    ZkNote,
    ChainInfo,
    FullIdentityInfo,
    SignatureScheme,
    ChainLink,
    PrivateLink,
    AccountMetadata,
    AliasInfo,
    AliasFullIdentity,
    ListingInfo,
    AccountListing,
    SupportedChain,
} from './types';
export { SLIP0044_NAMESPACE } from './types';

// ─── Pallet types (args + events) ────────────────────────────────────────────
export type {
    ShieldArgs,
    UnshieldArgs,
    PrivateTransferInput,
    PrivateTransferOutput,
    PrivateTransferArgs,
} from './types/pallet-args';
export type {
    ShieldedEvent,
    PrivateTransferEvent,
    UnshieldedEvent,
    MerkleRootUpdatedEvent,
    ShieldedPoolEvent,
} from './types/pallet-events';

// ─── Indexer ──────────────────────────────────────────────────────────────────
export type {
    IndexerClient,
    IndexerClientConfig,
    PaginatedResult,
    ShieldedCommitment,
    SpentNullifier,
    PrivateTransfer,
    Unshield,
    MerkleRoot,
    NullifierStatusResult,
} from './indexer';

// ─── Re-export PAPI types used in public APIs ────────────────────────────────
export type { PolkadotSigner } from 'polkadot-api';
// Signers for Node.js (raw keypair testing)
export { getPolkadotSigner } from 'polkadot-api/signer';
// Signer bridge to @polkadot/extension-dapp (browser)
export { getPolkadotSignerFromPjs } from 'polkadot-api/pjs-signer';
