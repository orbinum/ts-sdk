/** Configuration for IndexerClient. */
export interface IndexerClientConfig {
    /** Base URL of the indexer REST API (no trailing slash). */
    baseUrl: string;
    /** Request timeout in ms. Default: 10_000. */
    timeoutMs?: number;
}

/** Generic paginated result returned by list endpoints. */
export interface PaginatedResult<T> {
    data: T[];
    pagination: {
        page: number;
        limit: number;
        total: number;
    };
}

/** A shielded commitment (shield event) stored by the indexer. */
export interface ShieldedCommitment {
    commitmentHex: string;
    blockNumber: number;
    extrinsicIndex: number | null;
    leafIndex: number;
    /**
     * Asset ID as decimal string.
     * For `source: 'shield'` and `source: 'unshield'` this reflects the real asset.
     * For `source: 'transfer'` it is always `"0"` — the chain intentionally omits the asset ID
     * from `CommitmentsInserted` events to prevent graph correlation across assets.
     * The true asset is recoverable only by decrypting `encryptedMemo`.
     */
    assetId: string;
    /** Origin of the commitment: direct shield, output of private transfer, or change from unshield. */
    source: 'shield' | 'transfer' | 'unshield';
    /** SS58 or 0x-prefixed depositor address, null if not tracked. */
    sender: string | null;
    /** 0x-prefixed encrypted memo hex, null if not present. */
    encryptedMemo: string | null;
    timestampMs: number | null;
}

/** A spent nullifier stored by the indexer. */
export interface SpentNullifier {
    nullifierHex: string;
    blockNumber: number;
    extrinsicIndex: number | null;
    txType: 'unshield' | 'private_transfer';
    timestampMs: number | null;
}

/** Temporal metadata for a private transfer. No graph data (inputs ↔ outputs) exposed. */
export interface PrivateTransferTimestamp {
    blockNumber: number;
    extrinsicIndex: number | null;
    /** Blake2-256 hash of the raw extrinsic, 0x-prefixed. Null if the extrinsic was not decoded. */
    hash: string | null;
    timestampMs: number | null;
    /**
     * Subset of the queried nullifiers that were spent in this specific extrinsic.
     * Returned by `getTransfersByNullifiers`. Use to identify which input vault notes
     * belong to this transfer for local reconstruction.
     */
    matchedNullifiers?: string[];
    /**
     * Subset of the queried commitments that were inserted in this specific extrinsic.
     * Returned by `getTransfersByCommitments`. Use to identify which output vault notes
     * (change notes or received notes) belong to this transfer.
     */
    matchedCommitments?: string[];
}

/** An unshield event stored by the indexer. */
export interface Unshield {
    /** "{blockNumber}-{extrinsicIndex}" */
    id: string;
    blockNumber: number;
    extrinsicIndex: number | null;
    /** Blake2-256 hash of the raw extrinsic, 0x-prefixed. Null if the extrinsic was not decoded. */
    hash: string | null;
    nullifierHex: string;
    /** Asset ID as decimal string. */
    assetId: string;
    /** Amount as decimal string (bigint-safe). */
    amount: string;
    recipient: string;
    timestampMs: number | null;
}

/** A Merkle root checkpoint stored by the indexer. */
export interface MerkleRoot {
    id: number;
    rootHex: string;
    blockNumber: number;
    oldRootHex: string | null;
    treeSize: number;
    timestampMs: number | null;
}

/** Response from the nullifier status endpoint. */
export interface NullifierStatusResult {
    nullifier: string;
    spent: boolean;
    txType?: 'unshield' | 'private_transfer';
    blockNumber?: number;
}

/** A substrate extrinsic row returned by the address indexer endpoint. */
export interface IndexedExtrinsic {
    id: string;
    blockNumber: number;
    index: number;
    hash: string | null;
    section: string;
    method: string;
    signer: string | null;
    success: boolean;
    feePaid: string | null;
    eventsJson: string;
    argsJson: string;
    timestampMs: number | null;
}

/** An indexed EVM transaction returned by explorer endpoints. */
export interface IndexedEvmTx {
    hash: string;
    blockNumber: number;
    fromAddress: string | null;
    toAddress: string | null;
    value: string;
    gasUsed: number | null;
    gasPrice: string | null;
    status: number | null;
    inputData: string | null;
    nonce: number | null;
    transactionIndex: number | null;
    timestampMs: number | null;
    evmBlockHash: string | null;
}

/** An indexed block returned by the blocks endpoint. */
export interface IndexedBlock {
    number: number;
    hash: string;
    parentHash: string;
    timestampMs: number | null;
    author: string | null;
    extrinsicCount: number;
    evmTxCount: number;
    evmHash: string | null;
    evmParentHash?: string | null;
    evmMiner?: string | null;
    evmGasUsed?: string | null;
    evmGasLimit?: string | null;
    evmBaseFeePerGas?: string | null;
}

/** Aggregated statistics returned by the /stats endpoint. */
export interface IndexerStats {
    blocks: {
        indexed: number;
        latest: number | null;
        latestHash: string | null;
        latestTimestampMs: number | null;
    };
    extrinsics: { total: number };
    evm: { transactions: number };
    shielded: {
        commitments: number;
        spentNullifiers: number;
        merkleRoot: string | null;
        treeSize: number | null;
    };
    relayers: { active: number };
    zkVerifier: {
        total: number;
        successful: number;
    };
}

/** A registered relayer stored by the indexer. */
export interface Relayer {
    evmAddress: string;
    account: string;
    active: boolean;
    registeredAtBlock: number;
    unregisteredAtBlock: number | null;
    timestampMs: number | null;
}

/** A relay fee accumulation or consumption event stored by the indexer. */
export interface RelayFeeEvent {
    id: number;
    relayer: string;
    assetId: string;
    /** Amount as decimal string (bigint-safe). */
    amount: string;
    eventType: 'accumulated' | 'consumed';
    blockNumber: number;
    timestampMs: number | null;
}

/** Aggregated relay fee balance per asset for a given relayer. */
export interface RelayFeeSummaryEntry {
    assetId: string;
    /** Total accumulated (bigint string). */
    accumulated: string;
    /** Total consumed (bigint string). */
    consumed: string;
    /** pending = accumulated − consumed (bigint string). */
    pending: string;
}

/** A registered asset stored by the indexer. */
export interface RegisteredAsset {
    assetId: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    contractAddress: string | null;
    /** Whether the asset is verified by the protocol. */
    verified: boolean;
    registeredAtBlock: number;
    timestampMs: number | null;
}

/**
 * A single shielded activity event tied to an address.
 * The `kind` discriminant identifies whether it is a shield (commitment),
 * unshield, or private transfer event.
 */
export type ShieldedAddressEvent =
    | ({ kind: 'commitment' } & ShieldedCommitment)
    | ({ kind: 'unshield' } & Unshield)
    | ({ kind: 'transfer' } & PrivateTransferTimestamp);

/**
 * Lightweight hint returned by the stealth scan endpoint.
 * Contains only the fields required for a wallet to:
 *   1. Compute ECDH shared secret: ephPkHex × ivsk
 *   2. Attempt ChaCha20-Poly1305 decryption of encryptedMemo
 * Ordered ascending by leafIndex for incremental cursor compatibility.
 */
export interface StealthScanHint {
    leafIndex: number;
    commitmentHex: string;
    /**
     * Asset ID as decimal string.
     * For shield-origin commitments this is the real asset ID.
     * For transfer-origin commitments this is always `"0"` — the chain does not emit the asset ID
     * in `CommitmentsInserted` events by design (privacy: prevents cross-asset graph correlation).
     * Recover the true asset by decrypting `encryptedMemo`.
     */
    assetId: string;
    /** Ephemeral public key (last 32 bytes of encrypted_memo), 0x-prefixed. null if memo absent. */
    ephPkHex: string | null;
    /** Full 168-byte encrypted memo (0x-prefixed hex). null if not present. */
    encryptedMemo: string | null;
}
