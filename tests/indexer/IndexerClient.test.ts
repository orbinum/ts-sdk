import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexerClient } from '../../src/indexer/IndexerClient';
import type {
    IndexedBlock,
    IndexedEvmTx,
    IndexedExtrinsic,
    IndexedSession,
    IndexedValidator,
    IndexerStats,
    IndexerActivity,
    MerkleRoot,
    PaginatedResult,
    RegisteredAsset,
    RelayFeeEvent,
    RelayFeeSummaryEntry,
    Relayer,
    ShieldedAddressEvent,
    ShieldedCommitment,
    SpentNullifier,
    PrivateTransferTimestamp,
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
        })
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
            source: 'shield',
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
            source: 'shield',
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

    // ── getAllSpentNullifiers ─────────────────────────────────────────────────

    it('getAllSpentNullifiers returns empty Set when no nullifiers spent', async () => {
        mockFetch({ data: [] });
        const result = await client.getAllSpentNullifiers();
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
        expect(lastUrl()).toBe(`${BASE}/shielded/nullifiers/all`);
    });

    it('getAllSpentNullifiers returns Set of hex strings', async () => {
        mockFetch({ data: ['0xaaa', '0xbbb', '0xccc'] });
        const result = await client.getAllSpentNullifiers();
        expect(result.size).toBe(3);
        expect(result.has('0xaaa')).toBe(true);
        expect(result.has('0xbbb')).toBe(true);
    });

    it('getAllSpentNullifiers normalizes to lowercase', async () => {
        mockFetch({ data: ['0xAAA', '0xBBB'] });
        const result = await client.getAllSpentNullifiers();
        expect(result.has('0xaaa')).toBe(true);
        expect(result.has('0xbbb')).toBe(true);
        expect(result.has('0xAAA')).toBe(false);
    });

    it('getAllSpentNullifiers calls GET /shielded/nullifiers/all', async () => {
        mockFetch({ data: [] });
        await client.getAllSpentNullifiers();
        expect(lastUrl()).toBe(`${BASE}/shielded/nullifiers/all`);
    });

    // ── getTransfersByNullifiers ──────────────────────────────────────────────

    it('getTransfersByNullifiers returns empty array for empty input', async () => {
        const result = await client.getTransfersByNullifiers([]);
        expect(result).toEqual([]);
    });

    it('getTransfersByNullifiers calls correct URL and returns PrivateTransferTimestamp', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 100,
            extrinsicIndex: 0,
            hash: null,
            timestampMs: 3000,
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByNullifiers(['0xnull1']);
        expect(result).toHaveLength(1);
        expect(result[0]!.blockNumber).toBe(100);
        expect(lastUrl()).toContain('/shielded/transfers/by-nullifiers');
    });

    it('getTransfersByNullifiers passes all nullifiers as comma-separated query param', async () => {
        mockFetch({ data: [], total: 0 });
        await client.getTransfersByNullifiers(['0xaaa', '0xbbb', '0xccc']);
        const url = lastUrl();
        expect(url).toContain('nullifiers=');
        expect(url).toContain('0xaaa');
        expect(url).toContain('0xbbb');
        expect(url).toContain('0xccc');
    });

    it('getTransfersByNullifiers forwards matchedNullifiers from response', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 500,
            extrinsicIndex: 3,
            hash: '0x' + 'ef'.repeat(32),
            timestampMs: 1_700_000_000_000,
            matchedNullifiers: ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByNullifiers([
            '0x' + 'aa'.repeat(32),
            '0x' + 'bb'.repeat(32),
        ]);
        expect(result).toHaveLength(1);
        expect(result[0]!.matchedNullifiers).toHaveLength(2);
        expect(result[0]!.matchedNullifiers).toContain('0x' + 'aa'.repeat(32));
        expect(result[0]!.matchedNullifiers).toContain('0x' + 'bb'.repeat(32));
    });

    it('getTransfersByNullifiers returns matchedNullifiers as undefined when absent in response', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 100,
            extrinsicIndex: 0,
            hash: null,
            timestampMs: null,
            // matchedNullifiers intentionally omitted — server may not include it
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByNullifiers(['0xnull1']);
        expect(result[0]!.matchedNullifiers).toBeUndefined();
    });

    it('getTransfersByNullifiers groups multiple nullifiers from the same extrinsic into one entry', async () => {
        const NULL_A = '0x' + 'aa'.repeat(32);
        const NULL_B = '0x' + 'bb'.repeat(32);
        const ts: PrivateTransferTimestamp = {
            blockNumber: 300,
            extrinsicIndex: 2,
            hash: '0x' + 'cd'.repeat(32),
            timestampMs: 9999,
            matchedNullifiers: [NULL_A, NULL_B],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByNullifiers([NULL_A, NULL_B]);
        // One extrinsic entry for both nullifiers
        expect(result).toHaveLength(1);
        expect(result[0]!.matchedNullifiers).toContain(NULL_A);
        expect(result[0]!.matchedNullifiers).toContain(NULL_B);
    });

    it('getTransfersByNullifiers does not expose inputNullifiersJson or outputCommitmentsJson', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 100,
            extrinsicIndex: 0,
            hash: null,
            timestampMs: null,
            matchedNullifiers: ['0xnull'],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByNullifiers(['0xnull']);
        expect(result[0]).not.toHaveProperty('inputNullifiersJson');
        expect(result[0]).not.toHaveProperty('outputCommitmentsJson');
    });

    // ── getTransfersByCommitments ─────────────────────────────────────────────

    it('getTransfersByCommitments returns empty array for empty input', async () => {
        const result = await client.getTransfersByCommitments([]);
        expect(result).toEqual([]);
    });

    it('getTransfersByCommitments calls correct URL and returns PrivateTransferTimestamp', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 200,
            extrinsicIndex: 1,
            hash: '0xabc',
            timestampMs: null,
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByCommitments(['0xcomm1']);
        expect(result).toHaveLength(1);
        expect(result[0]!.blockNumber).toBe(200);
        expect(lastUrl()).toContain('/shielded/transfers/by-commitments');
    });

    it('getTransfersByCommitments passes all commitments as comma-separated query param', async () => {
        mockFetch({ data: [], total: 0 });
        await client.getTransfersByCommitments(['0xaaa', '0xbbb', '0xccc']);
        const url = lastUrl();
        expect(url).toContain('commitments=');
        expect(url).toContain('0xaaa');
        expect(url).toContain('0xbbb');
        expect(url).toContain('0xccc');
    });

    it('getTransfersByCommitments forwards matchedCommitments from response', async () => {
        const COMM_A = '0x' + 'aa'.repeat(32);
        const COMM_B = '0x' + 'bb'.repeat(32);
        const ts: PrivateTransferTimestamp = {
            blockNumber: 600,
            extrinsicIndex: 4,
            hash: '0x' + 'de'.repeat(32),
            timestampMs: 1_600_000_000_000,
            matchedCommitments: [COMM_A, COMM_B],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByCommitments([COMM_A, COMM_B]);
        expect(result).toHaveLength(1);
        expect(result[0]!.matchedCommitments).toHaveLength(2);
        expect(result[0]!.matchedCommitments).toContain(COMM_A);
        expect(result[0]!.matchedCommitments).toContain(COMM_B);
    });

    it('getTransfersByCommitments returns matchedCommitments as undefined when absent in response', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 200,
            extrinsicIndex: 1,
            hash: null,
            timestampMs: null,
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByCommitments(['0xcomm1']);
        expect(result[0]!.matchedCommitments).toBeUndefined();
    });

    it('getTransfersByCommitments groups multiple commitments from the same extrinsic into one entry', async () => {
        const COMM_A = '0x' + 'cc'.repeat(32);
        const COMM_B = '0x' + 'dd'.repeat(32);
        const ts: PrivateTransferTimestamp = {
            blockNumber: 700,
            extrinsicIndex: 2,
            hash: '0x' + 'ef'.repeat(32),
            timestampMs: 8888,
            matchedCommitments: [COMM_A, COMM_B],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByCommitments([COMM_A, COMM_B]);
        expect(result).toHaveLength(1);
        expect(result[0]!.matchedCommitments).toContain(COMM_A);
        expect(result[0]!.matchedCommitments).toContain(COMM_B);
    });

    it('getTransfersByCommitments does not expose inputNullifiersJson or outputCommitmentsJson', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 200,
            extrinsicIndex: 1,
            hash: null,
            timestampMs: null,
            matchedCommitments: ['0xcomm'],
        };
        mockFetch({ data: [ts], total: 1 });
        const result = await client.getTransfersByCommitments(['0xcomm']);
        expect(result[0]).not.toHaveProperty('inputNullifiersJson');
        expect(result[0]).not.toHaveProperty('outputCommitmentsJson');
    });

    it('both methods can return entries with both matchedNullifiers and matchedCommitments undefined (backward compat)', async () => {
        const ts: PrivateTransferTimestamp = {
            blockNumber: 50,
            extrinsicIndex: null,
            hash: null,
            timestampMs: null,
        };
        mockFetch({ data: [ts], total: 1 });
        const [rN, rC] = await Promise.all([
            client.getTransfersByNullifiers(['0xn']),
            client.getTransfersByCommitments(['0xc']),
        ]);
        expect(rN[0]!.matchedNullifiers).toBeUndefined();
        expect(rC[0]!.matchedCommitments).toBeUndefined();
    });

    // ── getUnshields ─────────────────────────────────────────────────────────

    it('getUnshields calls correct URL', async () => {
        const unshield: Unshield = {
            id: '200-1',
            blockNumber: 200,
            extrinsicIndex: 1,
            hash: null,
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
            number: 5,
            hash: '0xfoo',
            parentHash: '0xbar',
            extrinsicCount: 0,
            evmTxCount: 0,
            evmHash: null,
            author: null,
            timestampMs: null,
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
            extrinsics: { total: 500, signed: 120 },
            evm: { transactions: 200 },
            shielded: { commitments: 50, spentNullifiers: 20, merkleRoot: '0xroot', treeSize: 64 },
            relayers: { active: 3 },
            zkVerifier: { total: 30, successful: 28 },
        };
        mockFetch(stats);
        const result = await client.getStats();
        expect(result.blocks.indexed).toBe(100);
        expect(result.extrinsics.signed).toBe(120);
        expect(result.shielded.commitments).toBe(50);
        expect(result.relayers.active).toBe(3);
        expect(lastUrl()).toBe(`${BASE}/stats`);
    });

    // ── getActivity ──────────────────────────────────────────────────────────

    it('getActivity requests the default 24h window and returns buckets', async () => {
        const activity: IndexerActivity = {
            hours: 24,
            anchorMs: 360000000,
            buckets: [
                { hourStartMs: 356400000, transactions: 1, signedExtrinsics: 1, evmTransactions: 0 },
                { hourStartMs: 360000000, transactions: 3, signedExtrinsics: 2, evmTransactions: 1 },
            ],
        };
        mockFetch(activity);
        const result = await client.getActivity();
        expect(result.buckets).toHaveLength(2);
        expect(result.buckets[1]!.transactions).toBe(3);
        expect(lastUrl()).toBe(`${BASE}/stats/activity?hours=24`);
    });

    it('getActivity passes a custom hours window', async () => {
        mockFetch({ hours: 48, anchorMs: null, buckets: [] } satisfies IndexerActivity);
        await client.getActivity(48);
        expect(lastUrl()).toBe(`${BASE}/stats/activity?hours=48`);
    });

    // ── getRelayers ─────────────────────────────────────────────────────────────

    it('getRelayers calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRelayers();
        expect(lastUrl()).toBe(`${BASE}/relayers`);
    });

    it('getRelayers passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 10, total: 0 } });
        await client.getRelayers({ page: 2, limit: 10 });
        expect(lastUrl()).toBe(`${BASE}/relayers?page=2&limit=10`);
    });

    it('getRelayers passes active=true filter', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRelayers({ active: true });
        expect(lastUrl()).toBe(`${BASE}/relayers?active=true`);
    });

    it('getRelayers passes active=false filter', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRelayers({ active: false });
        expect(lastUrl()).toBe(`${BASE}/relayers?active=false`);
    });

    it('getRelayers returns Relayer array', async () => {
        const relayer: Relayer = {
            evmAddress: '0xabc',
            account: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            active: true,
            registeredAtBlock: 100,
            unregisteredAtBlock: null,
            timestampMs: 1000,
        };
        const payload: PaginatedResult<Relayer> = {
            data: [relayer],
            pagination: { page: 1, limit: 20, total: 1 },
        };
        mockFetch(payload);
        const result = await client.getRelayers();
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.evmAddress).toBe('0xabc');
        expect(result.data[0]!.active).toBe(true);
    });

    // ── getRelayer ──────────────────────────────────────────────────────────────

    it('getRelayer lowercases address and calls correct URL', async () => {
        const relayer: Relayer = {
            evmAddress: '0xabc',
            account: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            active: true,
            registeredAtBlock: 100,
            unregisteredAtBlock: null,
            timestampMs: 1000,
        };
        mockFetch(relayer);
        const result = await client.getRelayer('0xABC');
        expect(result).not.toBeNull();
        expect(result!.evmAddress).toBe('0xabc');
        expect(lastUrl()).toBe(`${BASE}/relayers/0xabc`);
    });

    it('getRelayer returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getRelayer('0xnotfound');
        expect(result).toBeNull();
    });

    // ── getRelayFees ────────────────────────────────────────────────────────────

    it('getRelayFees calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRelayFees();
        expect(lastUrl()).toBe(`${BASE}/relayers/fees`);
    });

    it('getRelayFees passes relayer and type filters', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRelayFees({ relayer: '5GrwvaEF', type: 'accumulated' });
        expect(lastUrl()).toBe(`${BASE}/relayers/fees?relayer=5GrwvaEF&type=accumulated`);
    });

    it('getRelayFees returns RelayFeeEvent array', async () => {
        const event: RelayFeeEvent = {
            id: 1,
            relayer: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            assetId: '0',
            amount: '1000000',
            eventType: 'accumulated',
            blockNumber: 50,
            timestampMs: 2000,
        };
        mockFetch({ data: [event], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getRelayFees();
        expect(result.data[0]!.eventType).toBe('accumulated');
        expect(result.data[0]!.amount).toBe('1000000');
    });

    // ── getRelayFeesSummary ─────────────────────────────────────────────────────

    it('getRelayFeesSummary calls correct URL', async () => {
        mockFetch([]);
        await client.getRelayFeesSummary('5GrwvaEF');
        expect(lastUrl()).toBe(`${BASE}/relayers/fees/summary/5GrwvaEF`);
    });

    it('getRelayFeesSummary returns RelayFeeSummaryEntry array', async () => {
        const summary: RelayFeeSummaryEntry[] = [
            { assetId: '0', accumulated: '5000000', consumed: '2000000', pending: '3000000' },
        ];
        mockFetch(summary);
        const result = await client.getRelayFeesSummary('5GrwvaEF');
        expect(result).toHaveLength(1);
        expect(result[0]!.pending).toBe('3000000');
        expect(result[0]!.assetId).toBe('0');
    });

    // ── getRegisteredAssets ─────────────────────────────────────────────────────

    it('getRegisteredAssets calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getRegisteredAssets();
        expect(lastUrl()).toBe(`${BASE}/shielded/assets`);
    });

    it('getRegisteredAssets passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 5, total: 0 } });
        await client.getRegisteredAssets({ page: 2, limit: 5 });
        expect(lastUrl()).toBe(`${BASE}/shielded/assets?page=2&limit=5`);
    });

    it('getRegisteredAssets returns RegisteredAsset array', async () => {
        const asset: RegisteredAsset = {
            assetId: '1',
            name: 'Test Token',
            symbol: 'TST',
            decimals: 18,
            contractAddress: '0xcontract',
            verified: true,
            registeredAtBlock: 200,
            timestampMs: 3000,
        };
        mockFetch({ data: [asset], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getRegisteredAssets();
        expect(result.data[0]!.symbol).toBe('TST');
        expect(result.data[0]!.verified).toBe(true);
    });

    // ── getRegisteredAsset ───────────────────────────────────────────────────────

    it('getRegisteredAsset calls correct URL', async () => {
        const asset: RegisteredAsset = {
            assetId: '42',
            name: 'Orbinum',
            symbol: 'ORB',
            decimals: 12,
            contractAddress: null,
            verified: true,
            registeredAtBlock: 1,
            timestampMs: null,
        };
        mockFetch(asset);
        const result = await client.getRegisteredAsset('42');
        expect(result).not.toBeNull();
        expect(result!.symbol).toBe('ORB');
        expect(lastUrl()).toBe(`${BASE}/shielded/assets/42`);
    });

    it('getRegisteredAsset returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getRegisteredAsset('999');
        expect(result).toBeNull();
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

    it('getAddressShieldedActivity preserves address case (SS58 is case-sensitive)', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getAddressShieldedActivity('0xABCDEF');
        expect(lastUrl()).toBe(`${BASE}/shielded/address/0xABCDEF`);
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
            source: 'shield',
            sender: '0xabc',
            encryptedMemo: null,
            timestampMs: 1_000_000,
        };
        const unshield: ShieldedAddressEvent = {
            kind: 'unshield',
            id: '100-2',
            blockNumber: 100,
            extrinsicIndex: 2,
            hash: null,
            nullifierHex: '0xabcd',
            assetId: '0',
            amount: '1000000000000',
            recipient: '0xabc',
            timestampMs: 1_000_001,
        };
        const transfer: ShieldedAddressEvent = {
            kind: 'transfer',
            blockNumber: 101,
            extrinsicIndex: 0,
            hash: null,
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

    it('getAddressShieldedActivity passes an SS58 address through verbatim', async () => {
        const ss58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getAddressShieldedActivity(ss58);
        expect(lastUrl()).toBe(`${BASE}/shielded/address/${ss58}`);
    });

    it('getAddressShieldedActivity throws on non-2xx response', async () => {
        mockFetch({}, 500);
        await expect(client.getAddressShieldedActivity('0xabc')).rejects.toThrow(
            'IndexerClient: HTTP 500'
        );
    });

    it('getAddressShieldedActivity returns empty data array when no activity', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        const result = await client.getAddressShieldedActivity('0xunknown');
        expect(result.data).toEqual([]);
        expect(result.pagination.total).toBe(0);
    });

    // ── getValidators ─────────────────────────────────────────────────────────

    it('getValidators calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getValidators();
        expect(lastUrl()).toBe(`${BASE}/validators`);
    });

    it('getValidators passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 10, total: 0 } });
        await client.getValidators({ page: 2, limit: 10 });
        expect(lastUrl()).toBe(`${BASE}/validators?page=2&limit=10`);
    });

    it('getValidators passes status filter', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getValidators({ status: 'approved' });
        expect(lastUrl()).toBe(`${BASE}/validators?status=approved`);
    });

    it('getValidators passes status and pagination together', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 5, total: 0 } });
        await client.getValidators({ page: 1, limit: 5, status: 'pending' });
        expect(lastUrl()).toBe(`${BASE}/validators?page=1&limit=5&status=pending`);
    });

    it('getValidators returns IndexedValidator array', async () => {
        const validator: IndexedValidator = {
            account: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            status: 'approved',
            bondAmount: '1000000000000',
            requestedAtBlock: 100,
            approvedAtBlock: 200,
            removedAtBlock: null,
            timestampMs: 3000,
        };
        const payload: PaginatedResult<IndexedValidator> = {
            data: [validator],
            pagination: { page: 1, limit: 20, total: 1 },
        };
        mockFetch(payload);
        const result = await client.getValidators();
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.status).toBe('approved');
        expect(result.data[0]!.bondAmount).toBe('1000000000000');
        expect(result.pagination.total).toBe(1);
    });

    it('getValidators handles null optional fields', async () => {
        const validator: IndexedValidator = {
            account: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
            status: 'pending',
            bondAmount: null,
            requestedAtBlock: 50,
            approvedAtBlock: null,
            removedAtBlock: null,
            timestampMs: null,
        };
        mockFetch({ data: [validator], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getValidators({ status: 'pending' });
        expect(result.data[0]!.bondAmount).toBeNull();
        expect(result.data[0]!.approvedAtBlock).toBeNull();
        expect(result.data[0]!.timestampMs).toBeNull();
    });

    // ── getValidator ──────────────────────────────────────────────────────────

    it('getValidator calls correct URL', async () => {
        const validator: IndexedValidator = {
            account: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            status: 'approved',
            bondAmount: '5000000000000',
            requestedAtBlock: 100,
            approvedAtBlock: 150,
            removedAtBlock: null,
            timestampMs: 1000,
        };
        mockFetch(validator);
        const result = await client.getValidator('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
        expect(result).not.toBeNull();
        expect(result!.status).toBe('approved');
        expect(lastUrl()).toBe(
            `${BASE}/validators/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
        );
    });

    it('getValidator returns null on 404', async () => {
        mockFetch(null, 404);
        const result = await client.getValidator('5unknown');
        expect(result).toBeNull();
    });

    it('getValidator throws on non-2xx non-404 response', async () => {
        mockFetch({}, 500);
        await expect(client.getValidator('5GrwvaEF')).rejects.toThrow('HTTP 500');
    });

    // ── getSessions ───────────────────────────────────────────────────────────

    it('getSessions calls correct URL with no params', async () => {
        mockFetch({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
        await client.getSessions();
        expect(lastUrl()).toBe(`${BASE}/sessions`);
    });

    it('getSessions passes pagination params', async () => {
        mockFetch({ data: [], pagination: { page: 2, limit: 5, total: 0 } });
        await client.getSessions({ page: 2, limit: 5 });
        expect(lastUrl()).toBe(`${BASE}/sessions?page=2&limit=5`);
    });

    it('getSessions returns IndexedSession array ordered by most recent first', async () => {
        const sessions: IndexedSession[] = [
            { sessionIndex: 10, blockNumber: 6000, timestampMs: 9000 },
            { sessionIndex: 9, blockNumber: 5400, timestampMs: 8400 },
        ];
        mockFetch({ data: sessions, pagination: { page: 1, limit: 20, total: 10 } });
        const result = await client.getSessions();
        expect(result.data).toHaveLength(2);
        expect(result.data[0]!.sessionIndex).toBe(10);
        expect(result.data[1]!.sessionIndex).toBe(9);
        expect(result.pagination.total).toBe(10);
    });

    it('getSessions handles null timestampMs', async () => {
        const session: IndexedSession = {
            sessionIndex: 0,
            blockNumber: 1,
            timestampMs: null,
        };
        mockFetch({ data: [session], pagination: { page: 1, limit: 20, total: 1 } });
        const result = await client.getSessions();
        expect(result.data[0]!.timestampMs).toBeNull();
    });
});
