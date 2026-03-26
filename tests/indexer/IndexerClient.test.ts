import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexerClient } from '../../src/indexer/IndexerClient';
import type {
    ShieldedCommitment,
    SpentNullifier,
    PrivateTransfer,
    Unshield,
    MerkleRoot,
    PaginatedResult,
} from '../../src/indexer/IndexerClient';

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
});
