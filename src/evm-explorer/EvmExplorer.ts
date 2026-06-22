import { EvmClient } from '../evm/EvmClient';
import { formatBalance } from '../utils/format';
import { hexToNumber } from '../utils/hex';
import type {
    EvmAddressInfo,
    EvmBlock,
    EvmLog,
    EvmTransaction,
    EvmTxSummary,
    TokenInfo,
    TokenTransfer,
} from './types';

// ---------------------------------------------------------------------------
// Raw RPC response shapes
// ---------------------------------------------------------------------------

/**
 * Maximum block range for eth_getLogs queries.
 * Must not exceed the node's --max-block-range setting (default: 1024 in Frontier stable2512+).
 */
const MAX_LOG_BLOCK_RANGE = 1000;

/** Raw JSON-RPC shape of an EVM block (hex-encoded numeric fields). */
interface RawEvmBlock {
    hash: string;
    parentHash: string;
    number: string;
    timestamp: string;
    miner: string;
    transactions: (string | RawEvmTx)[];
    gasUsed: string;
    gasLimit: string;
}

/** Raw JSON-RPC shape of an EVM transaction (hex-encoded numeric fields). */
interface RawEvmTx {
    hash: string;
    from: string;
    to: string | null;
    value: string;
    gasPrice: string;
    gas: string;
    input: string;
    nonce: string;
    blockNumber: string;
    blockHash?: string;
}

/** Raw JSON-RPC shape of an EVM transaction receipt (hex-encoded numeric fields). */
interface RawEvmReceipt {
    status: string;
    gasUsed: string;
    contractAddress?: string | null;
}

/** Raw JSON-RPC shape of an EVM log entry (hex-encoded numeric fields). */
interface RawEvmLog {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

/**
 * High-level EVM read-model explorer built on top of EvmClient.
 * Provides typed block/tx/address/token methods for explorer applications.
 */
export class EvmExplorer {
    /** @param evm - Underlying `EvmClient` used for all RPC calls. */
    constructor(private readonly evm: EvmClient) {}

    // --- Blocks ---

    /** Returns the `count` most recent blocks in descending order (latest first). */
    async getLatestBlocks(count = 10): Promise<EvmBlock[]> {
        const latest = await this.evm.getBlockNumber();
        const nums = Array.from({ length: Math.min(count, latest + 1) }, (_, i) => latest - i);
        const results = await this.evm
            .batchRequest<
                (RawEvmBlock | null)[]
            >(nums.map((n) => ({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] })))
            .catch(() => nums.map(() => null) as (RawEvmBlock | null)[]);
        return results
            .filter((b): b is RawEvmBlock => b !== null && !!b.hash)
            .map((b) => this.parseBlock(b));
    }

    /** Returns a single block by number or hash, or `null` if not found. */
    async getBlock(hashOrNumber: string | number): Promise<EvmBlock | null> {
        const b = await this.fetchBlock(hashOrNumber, false);
        return b ? this.parseBlock(b) : null;
    }

    /** Returns all transactions in a block (with receipts), or `[]` if the block is not found. */
    async getBlockTransactions(hashOrNumber: string | number): Promise<EvmTransaction[]> {
        try {
            const b = await this.fetchBlock(hashOrNumber, true);
            if (!b || !b.transactions.length) return [];
            const txs = b.transactions as RawEvmTx[];
            const receipts = await this.evm
                .batchRequest<
                    (RawEvmReceipt | null)[]
                >(txs.map((tx) => ({ method: 'eth_getTransactionReceipt', params: [tx.hash] })))
                .catch(() => txs.map(() => null));
            return txs.map((tx, i) => this.parseTx(tx, receipts[i] ?? null));
        } catch {
            return [];
        }
    }

    // --- Transactions ---

    /** Returns a single transaction with its receipt, or `null` if not found. */
    async getTransaction(hash: string): Promise<EvmTransaction | null> {
        try {
            const [tx, receipt] = await Promise.all([
                this.evm.request<RawEvmTx | null>('eth_getTransactionByHash', [hash]),
                this.evm
                    .request<RawEvmReceipt | null>('eth_getTransactionReceipt', [hash])
                    .catch(() => null),
            ]);
            if (!tx) return null;
            return this.parseTx(tx, receipt);
        } catch {
            return null;
        }
    }

    /**
     * Returns lightweight summaries of all transactions sent from or to `address`
     * within the last `maxBlocks` blocks, sorted by block number descending.
     */
    async getTransactionsByAddress(address: string, maxBlocks = 300): Promise<EvmTxSummary[]> {
        const addr = address.toLowerCase();
        const latest = await this.evm.getBlockNumber();
        const from = Math.max(0, latest - maxBlocks + 1);
        const blockNums = Array.from({ length: latest - from + 1 }, (_, i) => latest - i);
        const CHUNK = 50;
        const blocks: (RawEvmBlock | null)[] = [];
        for (let i = 0; i < blockNums.length; i += CHUNK) {
            const slice = blockNums.slice(i, i + CHUNK);
            const part = await this.evm
                .batchRequest<(RawEvmBlock | null)[]>(
                    slice.map((n) => ({
                        method: 'eth_getBlockByNumber',
                        params: [`0x${n.toString(16)}`, true],
                    }))
                )
                .catch(() => slice.map(() => null) as (RawEvmBlock | null)[]);
            blocks.push(...part);
        }

        const matchingTxs: Array<{ tx: RawEvmTx; timestamp: number | null }> = [];
        for (const block of blocks) {
            if (!block?.transactions) continue;
            const blockTimestamp = block.timestamp ? hexToNumber(block.timestamp) : null;
            for (const tx of block.transactions as RawEvmTx[]) {
                if (tx.from?.toLowerCase() === addr || tx.to?.toLowerCase() === addr) {
                    matchingTxs.push({ tx, timestamp: blockTimestamp });
                }
            }
        }

        if (!matchingTxs.length) return [];

        const receipts = await this.evm
            .batchRequest<(RawEvmReceipt | null)[]>(
                matchingTxs.map(({ tx }) => ({
                    method: 'eth_getTransactionReceipt',
                    params: [tx.hash],
                }))
            )
            .catch(() => matchingTxs.map(() => null));

        const results: EvmTxSummary[] = matchingTxs.map(({ tx, timestamp }, i) => {
            const receipt = receipts[i] ?? null;
            return {
                hash: tx.hash,
                blockNumber: hexToNumber(tx.blockNumber),
                timestamp,
                from: tx.from,
                to: tx.to,
                value: tx.value ?? '0x0',
                input: tx.input ?? '0x',
                gasUsed: receipt ? hexToNumber(receipt.gasUsed) : hexToNumber(tx.gas),
                gasPrice: tx.gasPrice ?? '0x0',
                status: receipt ? receipt.status === '0x1' : true,
                isContractCreation: !tx.to,
                contractAddress: receipt?.contractAddress ?? null,
            };
        });

        results.sort((a, b) => b.blockNumber - a.blockNumber);
        return results;
    }

    // --- Address ---

    /**
     * Returns aggregated on-chain data for an EVM address: balance, nonce,
     * bytecode (truncated), and up to 50 recent logs from the last 1 000 blocks.
     */
    async getAddressInfo(address: string): Promise<EvmAddressInfo> {
        const latest = await this.evm.getBlockNumber().catch(() => 0);
        const fromBlock = `0x${Math.max(0, latest - MAX_LOG_BLOCK_RANGE).toString(16)}`;
        const [balance, nonce, code, logs] = await Promise.all([
            this.evm
                .request<string | null>('eth_getBalance', [address, 'latest'])
                .catch(() => null),
            this.evm.getTransactionCount(address).catch(() => 0),
            this.evm.request<string | null>('eth_getCode', [address, 'latest']).catch(() => null),
            this.evm
                .request<
                    RawEvmLog[] | null
                >('eth_getLogs', [{ fromBlock, toBlock: 'latest', address }])
                .catch(() => []),
        ]);

        const codeHex = code ?? '0x';
        const isContract = codeHex !== '0x' && codeHex.length > 2;
        const codeBytes = isContract ? Math.floor((codeHex.length - 2) / 2) : 0;
        const recentLogs: EvmLog[] = (logs ?? []).slice(-50).map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hexToNumber(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: hexToNumber(l.logIndex),
        }));

        return {
            address,
            isContract,
            balance: balance ?? '0x0',
            nonce:
                typeof nonce === 'number'
                    ? nonce
                    : hexToNumber((nonce as unknown as string) ?? '0x0'),
            codeSize: codeBytes,
            code: isContract
                ? codeHex.length > 202
                    ? `${codeHex.slice(0, 202)}…`
                    : codeHex
                : '0x',
            recentLogs,
        };
    }

    /** Returns the native token balance of `address`, formatted as a decimal string (no symbol). */
    async getBalance(address: string): Promise<string> {
        try {
            const val = await this.evm.getBalance(address);
            return formatBalance(val, { showSymbol: false, precision: 18 });
        } catch {
            return '0';
        }
    }

    /** Returns the current transaction count (nonce) for `address`, or `0` on error. */
    async getNonce(address: string): Promise<number> {
        try {
            return await this.evm.getTransactionCount(address);
        } catch {
            return 0;
        }
    }

    /** Returns `true` when `address` has non-empty deployed bytecode. */
    async getIsContract(address: string): Promise<boolean> {
        try {
            const code = await this.evm.request<string>('eth_getCode', [address, 'latest']);
            return code !== '0x' && code !== '0x0' && code.length > 2;
        } catch {
            return false;
        }
    }

    // --- Tokens ---

    /**
     * Fetches ERC-20 metadata for a token contract via ABI calls.
     * Returns `null` when the address does not look like an ERC-20 token.
     */
    async getTokenInfo(address: string): Promise<TokenInfo | null> {
        const addr = address.toLowerCase();
        const [name, symbol, decimals, totalSupply] = await this.evm
            .batchRequest<(string | null)[]>([
                { method: 'eth_call', params: [{ to: addr, data: '0x06fdde03' }, 'latest'] },
                { method: 'eth_call', params: [{ to: addr, data: '0x95d89b41' }, 'latest'] },
                { method: 'eth_call', params: [{ to: addr, data: '0x313ce567' }, 'latest'] },
                { method: 'eth_call', params: [{ to: addr, data: '0x18160ddd' }, 'latest'] },
            ])
            .catch(() => [null, null, null, null]);

        const isErc20 = !!(totalSupply && totalSupply !== '0x' && symbol && decimals);
        if (!isErc20 && !name && !symbol) return null;

        return {
            address: addr,
            name: name ? EvmExplorer.decodeAbiString(name) : '',
            symbol: symbol ? EvmExplorer.decodeAbiString(symbol) : '',
            decimals: decimals ? Number(EvmExplorer.decodeAbiUint(decimals)) : 18,
            totalSupply: totalSupply ?? '0x0',
            isErc20,
        };
    }

    /**
     * Returns ERC-20 `Transfer` events for `address` from the last 1 000 blocks.
     * When `holderAddress` is provided, restricts results to transfers sent or received by that address.
     */
    async getTokenTransfers(address: string, holderAddress?: string): Promise<TokenTransfer[]> {
        const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const latest = await this.evm.getBlockNumber().catch(() => 0);
        const fromBlock = `0x${Math.max(0, latest - MAX_LOG_BLOCK_RANGE).toString(16)}`;

        let logs: RawEvmLog[];
        if (holderAddress) {
            const padded = `0x${holderAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
            const [sent, received] = await Promise.all([
                this.evm
                    .request<
                        RawEvmLog[]
                    >('eth_getLogs', [{ fromBlock, toBlock: 'latest', address, topics: [TRANSFER, padded] }])
                    .catch(() => [] as RawEvmLog[]),
                this.evm
                    .request<
                        RawEvmLog[]
                    >('eth_getLogs', [{ fromBlock, toBlock: 'latest', address, topics: [TRANSFER, null, padded] }])
                    .catch(() => [] as RawEvmLog[]),
            ]);
            const merged = [...(sent ?? []), ...(received ?? [])];
            merged.sort((a, b) => hexToNumber(b.blockNumber) - hexToNumber(a.blockNumber));
            logs = merged.slice(0, 100);
        } else {
            const all = await this.evm
                .request<
                    RawEvmLog[]
                >('eth_getLogs', [{ fromBlock, toBlock: 'latest', address, topics: [TRANSFER] }])
                .catch(() => [] as RawEvmLog[]);
            logs = (all ?? []).slice(-100).reverse();
        }

        return logs.map((l) => ({
            transactionHash: l.transactionHash,
            blockNumber: hexToNumber(l.blockNumber),
            from: `0x${(l.topics[1] ?? '').slice(-40)}`,
            to: `0x${(l.topics[2] ?? '').slice(-40)}`,
            value: l.data,
            logIndex: hexToNumber(l.logIndex),
        }));
    }

    /** Returns the raw ERC-20 balance of `holderAddress` for the token at `tokenAddress` (0x-prefixed hex). */
    async getTokenBalance(tokenAddress: string, holderAddress: string): Promise<string> {
        const padded = holderAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
        const result = await this.ethCall(tokenAddress, `0x70a08231${padded}`);
        return result ?? '0x0';
    }

    // --- Private: parsers ---

    /** Maps a raw RPC block object to the public `EvmBlock` shape. */
    private parseBlock(b: RawEvmBlock): EvmBlock {
        return {
            hash: b.hash,
            number: hexToNumber(b.number),
            timestamp: hexToNumber(b.timestamp),
            transactions: b.transactions.map((tx) => (typeof tx === 'string' ? tx : tx.hash)),
            gasUsed: hexToNumber(b.gasUsed).toString(),
            gasLimit: hexToNumber(b.gasLimit).toString(),
            miner: b.miner,
            parentHash: b.parentHash,
        };
    }

    /** Maps a raw RPC transaction + optional receipt to the public `EvmTransaction` shape. */
    private parseTx(tx: RawEvmTx, receipt: RawEvmReceipt | null): EvmTransaction {
        const parsed: EvmTransaction = {
            hash: tx.hash,
            blockNumber: tx.blockNumber ? hexToNumber(tx.blockNumber) : 0,
            from: tx.from,
            to: tx.to ?? null,
            value: tx.value,
            gasUsed: receipt ? hexToNumber(receipt.gasUsed).toString() : '0',
            gasPrice: EvmExplorer.hexToDecimalStr(tx.gasPrice),
            nonce: hexToNumber(tx.nonce),
            input: tx.input ?? '0x',
            status: receipt ? hexToNumber(receipt.status) : 0,
            contractAddress: receipt?.contractAddress ?? null,
            timestamp: null,
        };
        if (tx.blockHash) parsed.blockHash = tx.blockHash;
        return parsed;
    }

    // --- Private: fetch helpers ---

    /**
     * Fetches a raw block by number or hash. Accepts a plain integer, a decimal string,
     * or a 0x-prefixed hash. Returns `null` on any RPC error.
     */
    private async fetchBlock(
        hashOrNumber: string | number,
        withTxObjects: boolean
    ): Promise<RawEvmBlock | null> {
        try {
            if (typeof hashOrNumber === 'number' || /^\d+$/.test(String(hashOrNumber))) {
                const hexN = `0x${parseInt(String(hashOrNumber), 10).toString(16)}`;
                return await this.evm.request<RawEvmBlock | null>('eth_getBlockByNumber', [
                    hexN,
                    withTxObjects,
                ]);
            }
            return await this.evm.request<RawEvmBlock | null>('eth_getBlockByHash', [
                hashOrNumber,
                withTxObjects,
            ]);
        } catch {
            return null;
        }
    }

    /** Executes a read-only `eth_call` and returns the raw hex result, or `null` on error. */
    private async ethCall(to: string, data: string): Promise<string | null> {
        try {
            return await this.evm.call(to, data);
        } catch {
            return null;
        }
    }

    // --- Private static: ABI decoders ---

    /** Decodes an ABI-encoded `string` return value from a raw 0x-prefixed hex string. */
    private static decodeAbiString(hex: string): string {
        if (!hex || hex === '0x') return '';
        const data = hex.startsWith('0x') ? hex.slice(2) : hex;
        if (data.length < 128) return '';
        const length = parseInt(data.slice(64, 128), 16);
        if (!length) return '';
        const strHex = data.slice(128, 128 + length * 2);
        try {
            const bytes = new Uint8Array(strHex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0/g, '');
        } catch {
            return '';
        }
    }

    /** Decodes an ABI-encoded `uint256` return value to a `bigint`. */
    private static decodeAbiUint(hex: string): bigint {
        if (!hex || hex === '0x') return 0n;
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        return BigInt(`0x${clean || '0'}`);
    }

    /** Converts a 0x-prefixed hex number to its decimal string representation. Returns `'0'` on parse error. */
    private static hexToDecimalStr(hex: string): string {
        try {
            return BigInt(hex).toString();
        } catch {
            return '0';
        }
    }
}
