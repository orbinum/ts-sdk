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
    /** Asset ID as decimal string (e.g. "0"). */
    assetId: string;
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
    zkVerifier: {
        total: number;
        successful: number;
    };
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
    /** Asset ID as decimal string (e.g. "0"). */
    assetId: string;
    /** Ephemeral public key (last 32 bytes of encrypted_memo), 0x-prefixed. null if memo absent. */
    ephPkHex: string | null;
    /** Full 168-byte encrypted memo (0x-prefixed hex). null if not present. */
    encryptedMemo: string | null;
}
