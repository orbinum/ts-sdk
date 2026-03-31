import type {
    IndexerClientConfig,
    IndexedBlock,
    IndexedEvmTx,
    IndexedExtrinsic,
    IndexerStats,
    MerkleRoot,
    NullifierStatusResult,
    PaginatedResult,
    PrivateTransfer,
    ShieldedAddressEvent,
    ShieldedCommitment,
    SpentNullifier,
    Unshield,
} from './types';

/**
 * HTTP client for the Orbinum indexer REST API.
 *
 * All methods throw on network errors.
 * Methods returning a single entity return `null` when the server responds 404.
 */
export class IndexerClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;

    constructor(config: IndexerClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.timeoutMs = config.timeoutMs ?? 10_000;
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    private async _fetchResponse(path: string): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    private async get<T>(path: string): Promise<T> {
        const res = await this._fetchResponse(path);
        if (!res.ok) {
            throw new Error(`IndexerClient: HTTP ${res.status} for ${path}`);
        }
        return res.json() as Promise<T>;
    }

    private async getOrNull<T>(path: string): Promise<T | null> {
        const res = await this._fetchResponse(path);
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`IndexerClient: HTTP ${res.status} for ${path}`);
        }
        return res.json() as Promise<T>;
    }

    private buildQuery(params: Record<string, string | number | undefined>): string {
        const entries = Object.entries(params).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return '';
        const qs = entries
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&');
        return `?${qs}`;
    }

    // ─── Commitments ───────────────────────────────────────────────────────────

    /** Returns the total count of shielded commitments. */
    async getCommitmentsCount(): Promise<number> {
        const res = await this.get<{ total: number }>('/shielded/commitments/count');
        return res.total;
    }

    /** Returns a paginated list of shielded commitments. */
    async getCommitments(params?: {
        page?: number;
        limit?: number;
        sinceLeafIndex?: number;
    }): Promise<PaginatedResult<ShieldedCommitment>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            since_leaf_index: params?.sinceLeafIndex,
        });
        return this.get<PaginatedResult<ShieldedCommitment>>(`/shielded/commitments${qs}`);
    }

    /** Returns a single commitment by its hex string, or null if not found. */
    async getCommitmentByHex(hex: string): Promise<ShieldedCommitment | null> {
        return this.getOrNull<ShieldedCommitment>(
            `/shielded/commitments/${encodeURIComponent(hex)}`
        );
    }

    // ─── Nullifiers ────────────────────────────────────────────────────────────

    /** Returns a paginated list of spent nullifiers. */
    async getNullifiers(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<SpentNullifier>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<SpentNullifier>>(`/shielded/nullifiers${qs}`);
    }

    /** Returns the spent/unspent status of a nullifier. */
    async getNullifierStatus(hex: string): Promise<NullifierStatusResult> {
        return this.get<NullifierStatusResult>(
            `/shielded/nullifier/${encodeURIComponent(hex)}/status`
        );
    }

    // ─── Private transfers ─────────────────────────────────────────────────────

    /** Returns a paginated list of private transfer events. */
    async getTransfers(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<PrivateTransfer>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<PrivateTransfer>>(`/shielded/transfers${qs}`);
    }

    // ─── Unshields ─────────────────────────────────────────────────────────────

    /** Returns a paginated list of unshield events. */
    async getUnshields(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<Unshield>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<Unshield>>(`/shielded/unshields${qs}`);
    }

    // ─── Merkle roots ──────────────────────────────────────────────────────────

    /** Returns a paginated list of Merkle root checkpoints. */
    async getMerkleRoots(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<MerkleRoot>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<MerkleRoot>>(`/shielded/merkle-roots${qs}`);
    }

    /** Returns the latest Merkle root, or null if none exists. */
    async getLatestMerkleRoot(): Promise<MerkleRoot | null> {
        return this.getOrNull<MerkleRoot>('/shielded/merkle-roots/latest');
    }

    // ─── Address activity ──────────────────────────────────────────────────────

    /** Returns a paginated list of extrinsics signed by the given address. */
    async getAddressExtrinsics(
        address: string,
        params?: { page?: number; limit?: number }
    ): Promise<PaginatedResult<IndexedExtrinsic>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<IndexedExtrinsic>>(
            `/address/${encodeURIComponent(address.toLowerCase())}/extrinsics${qs}`
        );
    }

    /** Returns a paginated list of EVM transactions filtered by address and/or block number. */
    async getEvmTransactions(params?: {
        page?: number;
        limit?: number;
        address?: string;
        blockNumber?: number;
    }): Promise<PaginatedResult<IndexedEvmTx>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            address: params?.address?.toLowerCase(),
            blockNumber: params?.blockNumber,
        });
        return this.get<PaginatedResult<IndexedEvmTx>>(`/evm/transactions${qs}`);
    }

    /** Returns a single EVM transaction by hash, or null if not found. */
    async getEvmTransactionByHash(hash: string): Promise<IndexedEvmTx | null> {
        return this.getOrNull<IndexedEvmTx>(
            `/evm/transactions/${encodeURIComponent(hash.toLowerCase())}`
        );
    }

    // ─── Blocks ────────────────────────────────────────────────────────────────

    /** Returns a paginated list of indexed blocks. */
    async getBlocks(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<IndexedBlock>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<IndexedBlock>>(`/blocks${qs}`);
    }

    /** Returns a single block by number or hash, or null if not found. */
    async getBlock(numberOrHash: string | number): Promise<IndexedBlock | null> {
        return this.getOrNull<IndexedBlock>(`/blocks/${encodeURIComponent(String(numberOrHash))}`);
    }

    // ─── Address commitments ───────────────────────────────────────────────────

    /** Returns a paginated list of shielded commitments initiated by an address. */
    async getAddressCommitments(
        address: string,
        params?: { page?: number; limit?: number }
    ): Promise<PaginatedResult<ShieldedCommitment>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<ShieldedCommitment>>(
            `/address/${encodeURIComponent(address.toLowerCase())}/shielded${qs}`
        );
    }

    /**
     * Returns a paginated list of all shielded activity (commitments, unshields,
     * private transfers) associated with the given address.
     * Each item is tagged with a `kind` discriminant.
     */
    async getAddressShieldedActivity(
        address: string,
        params?: { page?: number; limit?: number }
    ): Promise<PaginatedResult<ShieldedAddressEvent>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<ShieldedAddressEvent>>(
            `/shielded/address/${encodeURIComponent(address.toLowerCase())}${qs}`
        );
    }

    // ─── Stats & Health ────────────────────────────────────────────────────────

    /** Returns aggregated indexer statistics. */
    async getStats(): Promise<IndexerStats> {
        return this.get<IndexerStats>('/stats');
    }

    /** Returns true if the indexer health endpoint responds OK. */
    async isHealthy(): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await fetch(`${this.baseUrl}/health`, {
                    signal: controller.signal,
                });
                return res.ok;
            } finally {
                clearTimeout(timer);
            }
        } catch {
            return false;
        }
    }
}
