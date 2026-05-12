// Public SDK exports.
// This file defines the public API surface exposed to SDK consumers.

// ─── Main client ─────────────────────────────────────────────────────────────
export { OrbinumClient } from './client/OrbinumClient';
export { OrbinumClientProvider } from './client/OrbinumClientProvider';

// ─── Client types ────────────────────────────────────────────────────────────
export type { OrbinumClientConfig, TxResult } from './client/types';
export type {
    ConnectionStatus,
    StatusChangeEvent,
    StatusListener,
    ClientProviderConfig,
} from './client/OrbinumClientProvider';

// ─── Core modules (for direct import / advanced usage) ───────────────────────
export { SubstrateClient } from './substrate/index';
export type { DynamicBuilder, ExtrinsicDecoder } from './substrate/index';
export { EvmClient } from './evm/index';
export { EvmExplorer } from './evm-explorer/index';
export type {
    ChainInfo,
    SystemHealth,
    EventRecord,
    EventPhase,
    EventData,
    RawBlockHeader,
    RawBlock,
    BlockInfo,
} from './substrate/index';
export type {
    EvmBlock,
    EvmTransaction,
    EvmAddressInfo,
    EvmTxSummary,
    EvmLog,
    TokenInfo,
    TokenTransfer,
} from './evm-explorer/index';

// ─── rpc-v2 ──────────────────────────────────────────────────────────────────
export { PrivacyModule } from './rpc-v2/index';
export type {
    RpcV2MerkleProof,
    PrivacyMerkleProof,
    RpcV2NullifierStatus,
    RpcV2PoolAssetBalance,
    RpcV2PoolStats,
} from './rpc-v2/index';
export { ZkVerifierModule } from './zk-verifier/index';
export type {
    ZkVerifierCircuitVersionInfo,
    ZkVerifierVkHash,
    ZkVerifierVersionStats,
    ZkVerifierHistoricalVersion,
} from './zk-verifier/index';

// ─── Shielded pool ───────────────────────────────────────────────────────────
export {
    NoteBuilder,
    EncryptedMemo,
    ENCRYPTED_MEMO_SIZE,
    ShieldedPoolModule,
    tryDecryptNote,
    tryDecryptNoteVerbose,
    computeNullifier,
    selectNotes,
    buildDummyTransferInput,
    generateDisclosureProof,
    buildDisclosurePublicSignals,
    deriveBabyJubjubKeypair,
    decryptDisclosureSignals,
    type DisclosureFlags,
    type DisclosureProofOutput,
} from './shielded-pool/index';
export { BN254_R, BABYJUB_SUBORDER } from './utils/crypto-constants';
export { randomBlinding } from './utils/blinding';

// ─── Privacy keys ─────────────────────────────────────────────────────────────
export {
    PrivacyKeyManager,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveSpendingKeyMessage,
    deriveSpendingKeyFromSignature,
    deriveMasterKeyBytes,
} from './privacy-keys/index';

// ─── Vault ────────────────────────────────────────────────────────────────────
export {
    deriveVaultKey,
    encryptJson,
    decryptJson,
    vaultReplacer,
    vaultReviver,
    VaultLockedError,
    applyNoteStatus,
    encryptNote,
    decryptNoteRecord,
} from './vault/index';
export type { EncryptedNoteRecord, NoteStatusUpdate } from './vault/index';

// ─── Proof generator ─────────────────────────────────────────────────────────
export {
    generateUnshieldProof,
    generateTransferProof,
    generateFeeClaimProof,
    CircuitType,
    WebArtifactProvider,
} from './proof-generator';
export type {
    ArtifactProvider,
    ProofResult,
    UnshieldProofInputs,
    TransferInputNote,
    TransferOutputNote,
    PrivateTransferProofInputs,
    FeeClaimProofInputs,
} from './proof-generator';
export type {
    MerkleTreeInfo,
    ShieldParams,
    ShieldBatchItem,
    ShieldBatchParams,
    ClaimShieldedFeesParams,
    UnshieldParams,
    PrivateTransferInput,
    PrivateTransferOutput,
    PrivateTransferParams,
    NoteInput,
    ZkNote,
    DecryptedMemo,
    ScanCommitment,
} from './shielded-pool/protocol/types';

// ─── Account mapping ─────────────────────────────────────────────────────────
export { AccountMappingModule } from './account-mapping/index';
export type {
    AddChainLinkParams,
    SetMetadataParams,
    PutOnSaleParams,
    DispatchAsLinkedParams,
} from './account-mapping/index';
export type {
    ChainLink,
    PrivateLink,
    AccountMetadata,
    AliasInfo,
    AliasFullIdentity,
    ListingInfo,
    AccountListing,
    SupportedChain,
} from './account-mapping/types';
export { SignatureScheme, SLIP0044_NAMESPACE } from './account-mapping/types';

// ─── Precompiles ─────────────────────────────────────────────────────────────
export {
    ShieldedPoolPrecompile,
    AccountMappingPrecompile,
    CryptoPrecompiles,
    PRECOMPILE_ADDR,
    KNOWN_PRECOMPILES,
    getPrecompileLabel,
    decodePrecompileCalldata,
} from './precompiles/index';
export type {
    EvmTxRequest,
    EvmSigner,
    ResolvedAlias,
    KnownPrecompileInfo,
    DecodedPrecompile,
    RequestDisclosureParams,
    DiscloseParams,
    RejectDisclosureParams,
    PruneExpiredRequestParams,
} from './precompiles/index';

// ─── Relayer ─────────────────────────────────────────────────────────────────
export { RelayerStatusModule } from './relayer/index';
export type { RelayerInfo } from './relayer/index';

// ─── Runtime event types ─────────────────────────────────────────────────────

// pallet-shielded-pool events
export type {
    ShieldedEvent,
    NullifiersSpentEvent,
    CommitmentsInsertedEvent,
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
} from './shielded-pool/pallet/events';

// pallet-zk-verifier events
export type {
    VerificationKeyRegisteredEvent,
    ActiveVersionSetEvent,
    VerificationKeyRemovedEvent,
    ProofVerifiedEvent,
    ProofVerificationFailedEvent,
    BatchVerificationKeysRegisteredEvent,
    ZkVerifierEvent,
} from './zk-verifier/types/pallet-events';

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
} from './account-mapping/types/pallet-events';

// ─── Runtime extrinsic arg types ─────────────────────────────────────────────

// pallet-shielded-pool
export type {
    Bytes32,
    DisclosurePublicSignals,
    EncryptedDisclosureSignals,
    DisclosureFieldMask,
    Auditor,
    DisclosureCondition,
    ShieldOperation,
    ShieldArgs,
    ShieldBatchArgs,
    RawTransferInput,
    RawTransferOutput,
    PrivateTransferArgs,
    UnshieldArgs,
    RequestDisclosureArgs,
    DiscloseArgs,
    RejectDisclosureArgs,
    RegisterAssetArgs,
    VerifyAssetArgs,
    UnverifyAssetArgs,
    PruneExpiredRequestArgs,
    RevokeDisclosureRecordArgs,
    ShieldedPoolCall,
} from './shielded-pool/pallet/extrinsics';

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
} from './zk-verifier/types/pallet-extrinsics';
export { CircuitId } from './zk-verifier/types/pallet-extrinsics';

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
} from './account-mapping/types/pallet-extrinsics';
// SignatureScheme already exported from './account-mapping/types' above

// ─── Indexer ──────────────────────────────────────────────────────────────────
export { IndexerClient } from './indexer';
export type {
    IndexerClientConfig,
    PaginatedResult,
    IndexedBlock,
    IndexedExtrinsic,
    IndexedEvmTx,
    IndexerStats,
    ShieldedAddressEvent,
    ShieldedCommitment,
    SpentNullifier,
    PrivateTransferTimestamp,
    Unshield,
    MerkleRoot,
    NullifierStatusResult,
    StealthScanHint,
} from './indexer';

// ─── Utilities ───────────────────────────────────────────────────────────────
export { formatBalance, formatORB } from './utils/format';
export type { FormatOptions } from './utils/format';
export { shortHash, truncateMiddle } from './utils/string';
export { toHex, fromHex, ensureHexPrefix, hexToNumber, hexToBigint } from './utils/hex';
export { toTxResult, type UnsafeTxOptions } from './utils/tx';
export { toBase64, fromBase64 } from './utils/encoding';
export { deriveStealthOwnerPk, deriveStealthSk } from './utils/stealth';
export { recoverOwnerPkPoint } from './utils/bjj';
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
    evmToMappedAccountHex,
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

// ─── Extrinsic / event arg mappers ───────────────────────────────────────────
export { mapExtrinsicArgs, mapZkEventData } from './extrinsic/index';

// ─── Decoded pallet arg & event shapes (explorer / read path) ────────────────
export type {
    DecodedShieldArgs,
    DecodedShieldBatchOperation,
    DecodedShieldBatchArgs,
    DecodedPrivateTransferArgs,
    DecodedUnshieldArgs,
    DecodedRequestDisclosureArgs,
    DecodedRejectDisclosureArgs,
    DecodedSubmitDisclosureArgs,
    DecodedTransferArgs,
    DecodedTransferKeepAliveArgs,
    DecodedTransferAllArgs,
    DecodedBatchArgs,
    DecodedSudoArgs,
    DecodedRemarkArgs,
    DecodedRegisterAliasArgs,
    DecodedPutAliasForSaleArgs,
    DecodedSetAccountMetadataArgs,
    DecodedAddChainLinkArgs,
    DecodedRevealPrivateLinkArgs,
    DecodedDispatchAsPrivateLinkArgs,
    DecodedEthereumTransactArgs,
    DecodedEvmCallArgs,
} from './extrinsic/decoded-args';

export type {
    ShieldedEventData,
    NullifiersSpentEventData,
    CommitmentsInsertedEventData,
    UnshieldedEventData,
    MerkleRootUpdatedData,
    DisclosureRequestedData,
    DisclosureRejectedData,
    DisclosureSubmittedData,
    DisclosureVerifiedData,
    TransferEventData,
    EndowedEventData,
    ReservedEventData,
    AliasRegisteredData,
    AliasTransferredData,
    AliasOnSaleData,
    AliasSoldData,
    AccountMappedData,
    EvmExitReason,
    EvmExecutedData,
    EthereumExecutedData,
    DispatchInfo,
    DispatchError,
    ExtrinsicSuccessData,
    ExtrinsicFailedData,
} from './extrinsic/decoded-events';

// ─── Substrate SCALE primitives (re-exported for SDK consumers) ──────────────
export {
    Blake2256,
    AccountId,
    u128,
    u64,
    Storage,
    Keccak256,
} from '@polkadot-api/substrate-bindings';

// ─── Base encoding utilities ─────────────────────────────────────────────────
export { base58 } from '@scure/base';

// ─── Re-export PAPI types used in public APIs ────────────────────────────────
export type { PolkadotSigner } from 'polkadot-api';
// Signers for Node.js (raw keypair testing)
export { getPolkadotSigner } from 'polkadot-api/signer';
// Signer bridge to @polkadot/extension-dapp (browser)
export {
    getPolkadotSignerFromPjs,
    connectInjectedExtension,
    getInjectedExtensions,
} from 'polkadot-api/pjs-signer';
export type { SignPayload, SignRaw } from 'polkadot-api/pjs-signer';
// Ss58 address decoding
export { getSs58AddressInfo } from 'polkadot-api';
