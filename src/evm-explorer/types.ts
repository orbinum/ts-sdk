/** Enriched EVM transaction model for explorer UIs. */
export interface EvmTransaction {
    /** 0x-prefixed transaction hash. */
    hash: string;
    /** Block number in which the transaction was included. */
    blockNumber: number;
    /** 0x-prefixed hash of the containing block. Only present when fetched with block context. */
    blockHash?: string;
    /** Sender address (checksummed or lowercase hex). */
    from: string;
    /** Recipient address, or `null` for contract-creation transactions. */
    to: string | null;
    /** Native token value transferred, as a 0x-prefixed hex string (wei). */
    value: string;
    /** Gas actually consumed by the transaction, as a decimal string. */
    gasUsed: string;
    /** Gas price in wei, as a decimal string. */
    gasPrice: string;
    /** Sender nonce at the time of submission. */
    nonce: number;
    /** ABI-encoded call data (0x-prefixed hex). `'0x'` for plain transfers. */
    input: string;
    /** `1` for success, `0` for revert. */
    status: number;
    /** Deployed contract address for contract-creation transactions; `null` otherwise. */
    contractAddress: string | null;
    /** Unix timestamp (seconds) of the containing block, or `null` if unavailable. */
    timestamp: number | null;
}

/** A single EVM event log entry. */
export interface EvmLog {
    /** Address of the contract that emitted the log. */
    address: string;
    /** Indexed event topics; `topics[0]` is the event signature hash. */
    topics: string[];
    /** ABI-encoded non-indexed event data (0x-prefixed hex). */
    data: string;
    /** Block number in which the log was emitted. */
    blockNumber: number;
    /** Hash of the transaction that emitted the log. */
    transactionHash: string;
    /** Position of this log within the block. */
    logIndex: number;
}

/** Aggregated on-chain information about an EVM address. */
export interface EvmAddressInfo {
    /** The queried address (as provided, not normalised). */
    address: string;
    /** `true` when the address has deployed bytecode. */
    isContract: boolean;
    /** Native token balance as a 0x-prefixed hex string (wei). */
    balance: string;
    /** Current transaction count (nonce). */
    nonce: number;
    /** Deployed bytecode size in bytes (`0` for EOAs). */
    codeSize: number;
    /** Deployed bytecode (truncated to 100 bytes + ellipsis for display). `'0x'` for EOAs. */
    code: string;
    /** Up to 50 most recent logs emitted by or received by this address. */
    recentLogs: EvmLog[];
}

/** EVM block header with transaction hashes (not full tx objects). */
export interface EvmBlock {
    /** 0x-prefixed block hash. */
    hash: string;
    /** Block number. */
    number: number;
    /** Unix timestamp (seconds) from the block header. */
    timestamp: number;
    /** Ordered list of transaction hashes included in the block. */
    transactions: string[];
    /** Actual gas consumed by all transactions, as a decimal string. */
    gasUsed: string;
    /** Block gas limit, as a decimal string. */
    gasLimit: string;
    /** Address of the block author / fee recipient. */
    miner: string;
    /** 0x-prefixed hash of the parent block. */
    parentHash: string;
}

/** Lightweight transaction summary used in address and block listing views. */
export interface EvmTxSummary {
    /** 0x-prefixed transaction hash. */
    hash: string;
    /** Block number in which the transaction was included. */
    blockNumber: number;
    /** Unix timestamp (seconds) of the containing block, or `null` if unavailable. */
    timestamp: number | null;
    /** Sender address. */
    from: string;
    /** Recipient address, or `null` for contract-creation transactions. */
    to: string | null;
    /** Native token value transferred, as a 0x-prefixed hex string (wei). */
    value: string;
    /** ABI-encoded call data (0x-prefixed hex). */
    input: string;
    /** Gas actually consumed by the transaction. */
    gasUsed: number;
    /** Gas price in wei, as a 0x-prefixed hex string. */
    gasPrice: string;
    /** `true` when the transaction succeeded (receipt status `0x1`). */
    status: boolean;
    /** `true` when the transaction created a new contract (`to` is `null`). */
    isContractCreation: boolean;
    /** Deployed contract address for contract-creation transactions; `null` otherwise. */
    contractAddress: string | null;
}

/** ERC-20 token metadata fetched via ABI calls (`name`, `symbol`, `decimals`, `totalSupply`). */
export interface TokenInfo {
    /** Checksummed contract address (lowercased as returned by the node). */
    address: string;
    /** Token name (decoded from ABI). Empty string when unavailable. */
    name: string;
    /** Token symbol (decoded from ABI). Empty string when unavailable. */
    symbol: string;
    /** Number of decimal places. Defaults to `18` when not readable from the contract. */
    decimals: number;
    /** Total supply as a 0x-prefixed hex string. */
    totalSupply: string;
    /** `true` when the contract exposes a non-zero `totalSupply`, `symbol`, and `decimals`. */
    isErc20: boolean;
}

/** A single ERC-20 `Transfer` event decoded from an EVM log. */
export interface TokenTransfer {
    /** Hash of the transaction that emitted the transfer event. */
    transactionHash: string;
    /** Block number in which the transfer was included. */
    blockNumber: number;
    /** Sender address (decoded from `topics[1]`). */
    from: string;
    /** Recipient address (decoded from `topics[2]`). */
    to: string;
    /** Transferred amount as a 0x-prefixed hex string (raw `data` field). */
    value: string;
    /** Position of the log within the block. */
    logIndex: number;
}
