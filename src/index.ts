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

// ─── Pallet event types ───────────────────────────────────────────────────────

// pallet-shielded-pool events
export type {
    ShieldedEvent,
    PrivateTransferEvent,
    UnshieldedEvent,
    MerkleRootUpdatedEvent,
    AuditPolicySetEvent,
    DisclosedEvent,
    DisclosureRequestedEvent,
    DisclosureRejectedEvent,
    DisclosureRequestExpiredEvent,
    DisclosureRecordRevokedEvent,
    AssetRegisteredEvent,
    AssetVerifiedEvent,
    AssetUnverifiedEvent,
    ShieldedPoolEvent,
} from './types/pallet-events';

// pallet-zk-verifier events
export type {
    VerificationKeyRegisteredEvent,
    ActiveVersionSetEvent,
    VerificationKeyRemovedEvent,
    ProofVerifiedEvent,
    ProofVerificationFailedEvent,
    BatchVerificationKeysRegisteredEvent,
    ZkVerifierEvent,
} from './types/pallet-events';

// pallet-account-mapping events
export type {
    AccountMappedEvent,
    AccountUnmappedEvent,
    AliasRegisteredEvent,
    AliasReleasedEvent,
    AliasTransferredEvent,
    AliasListedForSaleEvent,
    AliasSaleCancelledEvent,
    AliasSoldEvent,
    ChainLinkAddedEvent,
    ChainLinkRemovedEvent,
    MetadataUpdatedEvent,
    SupportedChainAddedEvent,
    SupportedChainRemovedEvent,
    ProxyCallExecutedEvent,
    PrivateChainLinkAddedEvent,
    PrivateChainLinkRemovedEvent,
    PrivateChainLinkRevealedEvent,
    PrivateLinkDispatchExecutedEvent,
    AccountMappingEvent,
} from './types/pallet-events';

// ─── Pallet extrinsic arg types ───────────────────────────────────────────────

// pallet-shielded-pool
export type {
    Bytes32,
    DisclosurePublicSignals,
    Auditor,
    DisclosureCondition,
    BatchDisclosureSubmission,
    ShieldOperation,
    ShieldArgs,
    ShieldBatchArgs,
    PrivateTransferInput,
    PrivateTransferOutput,
    PrivateTransferArgs,
    UnshieldArgs,
    SetAuditPolicyArgs,
    RequestDisclosureArgs,
    DiscloseArgs,
    RejectDisclosureArgs,
    BatchSubmitDisclosureProofsArgs,
    RegisterAssetArgs,
    VerifyAssetArgs,
    UnverifyAssetArgs,
    PruneExpiredRequestArgs,
    RevokeDisclosureRecordArgs,
    ShieldedPoolCall,
} from './types/pallet-extrinsics';

// pallet-zk-verifier
export type {
    CircuitId as CircuitIdType,
    VkEntry,
    RegisterVerificationKeyArgs,
    SetActiveVersionArgs,
    RemoveVerificationKeyArgs,
    VerifyProofArgs,
    BatchRegisterVerificationKeysArgs,
    ZkVerifierCall,
} from './types/pallet-extrinsics';
export { CircuitId } from './types/pallet-extrinsics';

// pallet-account-mapping
export type {
    RegisterAliasArgs,
    TransferAliasArgs,
    PutAliasOnSaleArgs,
    BuyAliasArgs,
    AddChainLinkArgs,
    RemoveChainLinkArgs,
    SetAccountMetadataArgs,
    AddSupportedChainArgs,
    RemoveSupportedChainArgs,
    DispatchAsLinkedAccountArgs,
    RegisterPrivateLinkArgs,
    RemovePrivateLinkArgs,
    RevealPrivateLinkArgs,
    DispatchAsPrivateLinkArgs,
    AccountMappingCall,
} from './types/pallet-extrinsics';
// SignatureScheme already exported from './types' above

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
