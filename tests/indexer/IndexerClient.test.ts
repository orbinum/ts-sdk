import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexerClient } from '../../src/indexer/IndexerClient';
import type {
    IndexedBlock,
    IndexedEvmTx,
    IndexedExtrinsic,
    IndexerStats,
    MerkleRoot,
    PaginatedResult,
    ShieldedAddressEvent,
    ShieldedCommitment,
    SpentNullifier,
    PrivateTransfer,
    Unshield,
} from '../../src/indexer/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetch(response: unknown, status = 200): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(response),
        }),
    );
}

function lastUrl(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as any[])[0] as string;
}

const BASE = 'http://localhost:3000';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IndexerClient', () => {
    let client: IndexerClient;

    beforeEach(() => {
        client = new IndexerClient({ baseUrl: BASE });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── constructor ──────────────────────────────────────────────────────────

    it('strips trailing slash from baseUrl', () => {
        const c = new IndexerClient({ baseUrl: 'http://localhost:3000/' });
        mockFetch({ total: 0 });
        c.getCommitmentsCount();
        expect(lastUrl()).toBe('http://localhost:3000/shielded/commitments/count');
    });

    it('uses default timeout 10_000', () => {
        const c = new IndexerClient({ baseUrl: BASE });
        expect((c as unknown as { timeoutMs: number }).timeoutMs).toBe(10_000);
    });

    it('respects custom timeoutMs', () => {
        const c = new IndexerClient({ baseUrl: BASE, timeoutMs: 5_000 });
        expect((c as unknown as { timeoutMs: number }).timeoutMs).toBe(5_000);
    });

    // ── getCommitmentsCount ──────────────────────────────────────────────────

    it('getCommitmentsCount returns total', async () => {
        mockFetch({ total: 42 });
        const count = await client.getCommitmentsCount();
        expect(count).toBe(42);
        expect(lastUrl()).toBe(`${BASE}/shielded/commitments/count`);
    });

    // ── getCommitments ───────────────────────────────────────────────────────

    it('getCommitments calls correct URL with no params', async () => {
        const payload: PaginatedResult<ShieldedCommitment> = {
            data: [],
            pagination: { page: 1, limit: 20, total: 0 },
        };
        mockFetch(payload);
        await client.getCommitments();
        expect(lastUrl()).toBe(`${BASE}/shielded/commitments`);
    });

    it('getCommitments passes query params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 5, total: 0 } });
        await client.getCommitments({ page: 2, limit: 5, sinceLeafIndex: 10 });
        expect(lastUrl()).toBe(`${BASE}/shielded/commitments?page=2&limit=5&since_leaf_index=10`);
    });

    it('getCommitments returns paginated result', async () => {
        const commitment: ShieldedCommitment = {
            commitmentHex: '0xabc',
            blockNumber: 100,
            extrinsicIndex: 0,
            leafIndex: 3,
            assetId: '0',
            sender: null,
            encryptedMemo: null,
            timestampMs: 1000,
        };
        const payload: PaginatedResult<ShieldedCommitment> = {
            data: [commitment],
            pagination: { page: 1, limit: 20, total: 1 },
        };
        mockFetch(payload);
        const result = await client.getCommitments();
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.commitmentHex).toBe('0xabc');
        expect(result.pagination.total).toBe(1);
    });

    // ── getCommitmentByHex ───────────────────────────────────────────────────

    it('getCommitmentByHex returns commitment on success', async () => {
        const commitment: ShieldedCommitment = {
            commitmentHex: '0xdef',
            blockNumber: 200,
            extrinsicIndex: 1,
            leafIndex: 5,
            assetId: '0',
            sender: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            encryptedMemo: '0x00',
            timestampMs: 2000,
        };
        mockFetch(commitment);
        const result = await client.getCommitmentByHex('0xdef');
        expect(result).not.toBeNull();
        expect(result!.leafIndex).toBe(5);
        expect(lastUrl()).toBe(`${BASE}/shielded/commitments/0xdef`);
    });

    it('getCommitmentByHex returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getCommitmentByHex('0xnotfound');
        expect(result).toBeNull();
    });

    // ── getNullifiers ────────────────────────────────────────────────────────

    it('getNullifiers calls correct URL', async () => {
        const payload: PaginatedResult<SpentNullifier> = {
            data: [],
            pagination: { page: 1, limit: 20, total: 0 },
        };
        mockFetch(payload);
        await client.getNullifiers();
        expect(lastUrl()).toBe(`${BASE}/shielded/nullifiers`);
    });

    it('getNullifiers passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 3, limit: 10, total: 0 } });
        await client.getNullifiers({ page: 3, limit: 10 });
        expect(lastUrl()).toBe(`${BASE}/shielded/nullifiers?page=3&limit=10`);
    });

    it('getNullifiers returns correct txType', async () => {
        const nullifier: SpentNullifier = {
            nullifierHex: '0x01',
            blockNumber: 50,
            extrinsicIndex: 0,
            txType: 'unshield',
            timestampMs: null,
        };
        mockFetch({ data: [nullifier], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getNullifiers();
        expect(result.data[0]!.txType).toBe('unshield');
    });

    // ── getNullifierStatus ───────────────────────────────────────────────────

    it('getNullifierStatus returns spent status', async () => {
        mockFetch({ nullifier: '0x01', spent: true, txType: 'unshield', blockNumber: 50 });
        const status = await client.getNullifierStatus('0x01');
        expect(status.spent).toBe(true);
        expect(status.txType).toBe('unshield');
        expect(lastUrl()).toBe(`${BASE}/shielded/nullifier/0x01/status`);
    });

    it('getNullifierStatus returns unspent status', async () => {
        mockFetch({ nullifier: '0x02', spent: false });
        const status = await client.getNullifierStatus('0x02');
        expect(status.spent).toBe(false);
        expect(status.txType).toBeUndefined();
    });

    // ── getTransfers ─────────────────────────────────────────────────────────

    it('getTransfers calls correct URL', async () => {
        const transfer: PrivateTransfer = {
            id: '100-0',
            blockNumber: 100,
            extrinsicIndex: 0,
            inputNullifiersJson: '["0x01"]',
            outputCommitmentsJson: '["0x02"]',
            leafIndicesJson: '[5]',
            timestampMs: 3000,
        };
        mockFetch({ data: [transfer], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getTransfers();
        expect(result.data[0]!.id).toBe('100-0');
        expect(lastUrl()).toBe(`${BASE}/shielded/transfers`);
    });

    // ── getUnshields ─────────────────────────────────────────────────────────

    it('getUnshields calls correct URL', async () => {
        const unshield: Unshield = {
            id: '200-1',
            blockNumber: 200,
            extrinsicIndex: 1,
            nullifierHex: '0x03',
            assetId: '0',
            amount: '1000000',
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            timestampMs: null,
        };
        mockFetch({ data: [unshield], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getUnshields();
        expect(result.data[0]!.amount).toBe('1000000');
        expect(lastUrl()).toBe(`${BASE}/shielded/unshields`);
    });

    // ── getMerkleRoots ───────────────────────────────────────────────────────

    it('getMerkleRoots calls correct URL', async () => {
        const root: MerkleRoot = {
            id: 1,
            rootHex: '0xaaa',
            blockNumber: 50,
            oldRootHex: null,
            treeSize: 8,
            timestampMs: 1234,
        };
        mockFetch({ data: [root], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getMerkleRoots();
        expect(result.data[0]!.rootHex).toBe('0xaaa');
        expect(lastUrl()).toBe(`${BASE}/shielded/merkle-roots`);
    });

    it('getMerkleRoots passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 5, total: 0 } });
        await client.getMerkleRoots({ page: 2, limit: 5 });
        expect(lastUrl()).toBe(`${BASE}/shielded/merkle-roots?page=2&limit=5`);
    });

    // ── getLatestMerkleRoot ──────────────────────────────────────────────────

    it('getLatestMerkleRoot returns root on success', async () => {
        const root: MerkleRoot = {
            id: 3,
            rootHex: '0xbbb',
            blockNumber: 300,
            oldRootHex: '0xaaa',
            treeSize: 16,
            timestampMs: 9999,
        };
        mockFetch(root);
        const result = await client.getLatestMerkleRoot();
        expect(result).not.toBeNull();
        expect(result!.treeSize).toBe(16);
        expect(lastUrl()).toBe(`${BASE}/shielded/merkle-roots/latest`);
    });

    it('getLatestMerkleRoot returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getLatestMerkleRoot();
        expect(result).toBeNull();
    });

    // ── error handling ───────────────────────────────────────────────────────

    it('throws on non-ok, non-404 HTTP response', async () => {
        mockFetch({ error: 'Internal Server Error' }, 500);
        await expect(client.getCommitmentsCount()).rejects.toThrow('HTTP 500');
    });

    // ── getAddressExtrinsics ─────────────────────────────────────────────────

    it('getAddressExtrinsics lowercases the address and returns paginated rows', async () => {
        const row: IndexedExtrinsic = {
            id: '1-0',
            blockNumber: 1,
            index: 0,
            hash: '0xabc',
            section: 'balances',
            method: 'transferKeepAlive',
            signer: '0xabc',
            success: true,
            feePaid: '1',
            eventsJson: '[]',
            argsJson: '{}',
            timestampMs: 1000,
        };
        mockFetch({ data: [row], pagination: { page: 1, limit: 50, total: 1 } });

        const result = await client.getAddressExtrinsics('0xABC', { limit: 50 });

        expect(result.data).toEqual([row]);
        expect(lastUrl()).toBe(`${BASE}/address/0xabc/extrinsics?limit=50`);
    });

    // ── getEvmTransactions ───────────────────────────────────────────────────

    it('getEvmTransactions passes lowercased address and limit', async () => {
        const row: IndexedEvmTx = {
            hash: '0x1',
            blockNumber: 1,
            fromAddress: '0xabc',
            toAddress: '0xdef',
            value: '0',
            gasUsed: 21000,
            gasPrice: '1',
            status: 1,
            inputData: '0x',
            nonce: 0,
            transactionIndex: 0,
            timestampMs: 1000,
            evmBlockHash: '0xblock',
        };
        mockFetch({ data: [row], pagination: { page: 1, limit: 10, total: 1 } });

        const result = await client.getEvmTransactions({ address: '0xABC', limit: 10 });

        expect(result.data).toEqual([row]);
        expect(lastUrl()).toBe(`${BASE}/evm/transactions?limit=10&address=0xabc`);
    });

    it('getEvmTransactionByHash returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getEvmTransactionByHash('0xABC');
        expect(result).toBeNull();
        expect(lastUrl()).toBe(`${BASE}/evm/transactions/0xabc`);
    });

    // ── getBlocks ────────────────────────────────────────────────────────────

    it('getBlocks calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getBlocks();
        expect(lastUrl()).toBe(`${BASE}/blocks`);
    });

    it('getBlocks passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 10, total: 0 } });
        await client.getBlocks({ page: 2, limit: 10 });
        expect(lastUrl()).toBe(`${BASE}/blocks?page=2&limit=10`);
    });

    it('getBlocks returns paginated IndexedBlock array', async () => {
        const block: IndexedBlock = {
            number: 42,
            hash: '0xblockhash',
            parentHash: '0xparent',
            extrinsicCount: 3,
            evmTxCount: 0,
            evmHash: null,
            author: null,
            timestampMs: 5000,
        };
        mockFetch({ data: [block], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getBlocks();
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.number).toBe(42);
    });

    // ── getBlock ─────────────────────────────────────────────────────────────

    it('getBlock returns block by number', async () => {
        const block: IndexedBlock = {
            number: 10,
            hash: '0xhash10',
            parentHash: '0xparent',
            extrinsicCount: 1,
            evmTxCount: 0,
            evmHash: null,
            author: null,
            timestampMs: 1000,
        };
        mockFetch(block);
        const result = await client.getBlock(10);
        expect(result).not.toBeNull();
        expect(result!.number).toBe(10);
        expect(lastUrl()).toBe(`${BASE}/blocks/10`);
    });

    it('getBlock accepts string hash', async () => {
        mockFetch({
            number: 5, hash: '0xfoo', parentHash: '0xbar',
            extrinsicCount: 0, evmTxCount: 0, evmHash: null, author: null, timestampMs: null,
        });
        await client.getBlock('0xfoo');
        expect(lastUrl()).toBe(`${BASE}/blocks/0xfoo`);
    });

    it('getBlock returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getBlock(999);
        expect(result).toBeNull();
    });

    // ── getAddressCommitments ────────────────────────────────────────────────

    it('getAddressCommitments lowercases address and builds correct URL', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getAddressCommitments('0xABC');
        expect(lastUrl()).toBe(`${BASE}/address/0xabc/shielded`);
    });

    it('getAddressCommitments passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 5, total: 0 } });
        await client.getAddressCommitments('0xabc', { page: 2, limit: 5 });
        expect(lastUrl()).toBe(`${BASE}/address/0xabc/shielded?page=2&limit=5`);
    });

    // ── getStats ─────────────────────────────────────────────────────────────

    it('getStats returns indexer statistics', async () => {
        const stats: IndexerStats = {
            blocks: { indexed: 100, latest: 100, latestHash: '0xabc', latestTimestampMs: 1000 },
            extrinsics: { total: 500 },
            evm: { transactions: 200 },
            shielded: { commitments: 50, spentNullifiers: 20, merkleRoot: '0xroot', treeSize: 64 },
            zkVerifier: { total: 30, successful: 28 },
        };
        mockFetch(stats);
        const result = await client.getStats();
        expect(result.blocks.indexed).toBe(100);
        expect(result.shielded.commitments).toBe(50);
        expect(lastUrl()).toBe(`${BASE}/stats`);
    });

    // ── isHealthy ────────────────────────────────────────────────────────────

    it('isHealthy returns true when /health responds ok', async () => {
        mockFetch({}, 200);
        const result = await client.isHealthy();
        expect(result).toBe(true);
    });

    it('isHealthy returns false when /health responds with error status', async () => {
        mockFetch({}, 503);
        const result = await client.isHealthy();
        expect(result).toBe(false);
    });

    it('isHealthy returns false when fetch throws', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
        const result = await client.isHealthy();
        expect(result).toBe(false);
    });

    // ── getAddressShieldedActivity ────────────────────────────────────────────

    it('getAddressShieldedActivity calls correct URL with lowercase address', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getAddressShieldedActivity('0xABCDEF');
        expect(lastUrl()).toBe(`${BASE}/shielded/address/0xabcdef`);
    });

    it('getAddressShieldedActivity passes page param', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 20, total: 0 } });
        await client.getAddressShieldedActivity('0xabc', { page: 2 });
        expect(lastUrl()).toBe(`${BASE}/shielded/address/0xabc?page=2`);
    });

    it('getAddressShieldedActivity passes limit param', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 5, total: 0 } });
        await client.getAddressShieldedActivity('0xabc', { limit: 5 });
        expect(lastUrl()).toBe(`${BASE}/shielded/address/0xabc?limit=5`);
    });

    it('getAddressShieldedActivity passes page and limit together', async () => {
        mockFetch({ data: [], pagination: { page: 3, limit: 10, total: 0 } });
        await client.getAddressShieldedActivity('0xabc', { page: 3, limit: 10 });
        expect(lastUrl()).toBe(`${BASE}/shielded/address/0xabc?page=3&limit=10`);
    });

    it('getAddressShieldedActivity returns PaginatedResult<ShieldedAddressEvent>', async () => {
        const commitment: ShieldedAddressEvent = {
            kind: 'commitment',
            commitmentHex: '0xc0ff',
            blockNumber: 100,
            extrinsicIndex: 1,
            leafIndex: 5,
            assetId: '0',
            sender: '0xabc',
            encryptedMemo: null,
            timestampMs: 1_000_000,
        };
        const unshield: ShieldedAddressEvent = {
            kind: 'unshield',
            id: '100-2',
            blockNumber: 100,
            extrinsicIndex: 2,
            nullifierHex: '0xabcd',
            assetId: '0',
            amount: '1000000000000',
            recipient: '0xabc',
            timestampMs: 1_000_001,
        };
        const transfer: ShieldedAddressEvent = {
            kind: 'transfer',
            id: '101-0',
            blockNumber: 101,
            extrinsicIndex: 0,
            inputNullifiersJson: '["0xn1"]',
            outputCommitmentsJson: '["0xc1"]',
            leafIndicesJson: '[42]',
            timestampMs: 1_000_002,
        };
        const payload: PaginatedResult<ShieldedAddressEvent> = {
            data: [commitment, unshield, transfer],
            pagination: { page: 1, limit: 20, total: 3 },
        };
        mockFetch(payload);
        const result = await client.getAddressShieldedActivity('0xabc');
        expect(result.data).toHaveLength(3);
        expect(result.pagination.total).toBe(3);
        expect(result.data[0]).toMatchObject({ kind: 'commitment', commitmentHex: '0xc0ff' });
        expect(result.data[1]).toMatchObject({ kind: 'unshield', recipient: '0xabc' });
        expect(result.data[2]).toMatchObject({ kind: 'transfer', blockNumber: 101 });
    });

    it('getAddressShieldedActivity encodes special chars in address', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getAddressShieldedActivity('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
        expect(lastUrl()).toContain('/shielded/address/');
        expect(lastUrl()).not.toContain('GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
    });

    it('getAddressShieldedActivity throws on non-2xx response', async () => {
        mockFetch({}, 500);
        await expect(client.getAddressShieldedActivity('0xabc')).rejects.toThrow(
            'IndexerClient: HTTP 500',
        );
    });

    it('getAddressShieldedActivity returns empty data array when no activity', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        const result = await client.getAddressShieldedActivity('0xunknown');
        expect(result.data).toEqual([]);
        expect(result.pagination.total).toBe(0);
    });
});
