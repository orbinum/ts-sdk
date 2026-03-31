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

/** A private transfer event stored by the indexer. */
export interface PrivateTransfer {
    /** "{blockNumber}-{extrinsicIndex}" */
    id: string;
    blockNumber: number;
    extrinsicIndex: number | null;
    /** JSON-encoded array of nullifier hex strings. */
    inputNullifiersJson: string;
    /** JSON-encoded array of commitment hex strings. */
    outputCommitmentsJson: string;
    /** JSON-encoded array of leaf index numbers. */
    leafIndicesJson: string;
    timestampMs: number | null;
}

/** An unshield event stored by the indexer. */
export interface Unshield {
    /** "{blockNumber}-{extrinsicIndex}" */
    id: string;
    blockNumber: number;
    extrinsicIndex: number | null;
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
    | ({ kind: 'transfer' } & PrivateTransfer);
