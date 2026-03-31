/** Enriched EVM transaction model for explorer UIs. */
export interface EvmTransaction {
    hash: string;
    blockNumber: number;
    blockHash?: string;
    from: string;
    to: string | null;
    value: string;
    gasUsed: string;
    gasPrice: string;
    nonce: number;
    input: string;
    status: number;
    contractAddress: string | null;
    timestamp: number | null;
}

export interface EvmLog {
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
}

export interface EvmAddressInfo {
    address: string;
    isContract: boolean;
    balance: string;
    nonce: number;
    codeSize: number;
    code: string;
    recentLogs: EvmLog[];
}

export interface EvmBlock {
    hash: string;
    number: number;
    timestamp: number;
    transactions: string[];
    gasUsed: string;
    gasLimit: string;
    miner: string;
    parentHash: string;
}

export interface EvmTxSummary {
    hash: string;
    blockNumber: number;
    timestamp: number | null;
    from: string;
    to: string | null;
    value: string;
    input: string;
    gasUsed: number;
    gasPrice: string;
    status: boolean;
    isContractCreation: boolean;
    contractAddress: string | null;
}

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    isErc20: boolean;
}

export interface TokenTransfer {
    transactionHash: string;
    blockNumber: number;
    from: string;
    to: string;
    value: string;
    logIndex: number;
}
