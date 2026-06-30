import type {
    IndexerClientConfig,
    IndexedBlock,
    IndexedEvmTx,
    IndexedExtrinsic,
    IndexedSession,
    IndexedValidator,
    IndexerActivity,
    IndexerStats,
    MerkleRoot,
    NullifierStatusResult,
    PaginatedResult,
    PrivateTransferTimestamp,
    RegisteredAsset,
    RelayFeeEvent,
    RelayFeeSummaryEntry,
    Relayer,
    ShieldedAddressEvent,
    ShieldedCommitment,
    SpentNullifier,
    StealthScanHint,
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

    /**
     * Returns a paginated list of stealth scan hints ordered ascending by leafIndex.
     * Each hint contains only the fields required for ECDH triage and decryption:
     * leafIndex, commitmentHex, assetId, ephPkHex, encryptedMemo.
     *
     * Use `sinceLeafIndex` for incremental scans (cursor = last seen leafIndex + 1).
     */
    async getScanHints(params?: {
        page?: number;
        limit?: number;
        sinceLeafIndex?: number;
    }): Promise<PaginatedResult<StealthScanHint>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            since_leaf_index: params?.sinceLeafIndex,
        });
        return this.get<PaginatedResult<StealthScanHint>>(`/shielded/scan-hints${qs}`);
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

    /**
     * Downloads the full spent nullifier set and returns it as a Set of lowercase hex strings.
     *
     * The server sees an identical GET request regardless of which notes the wallet holds —
     * the intersection is computed locally (PIR-A privacy model).
     *
     * Suitable for wallets with up to ~1M spent nullifiers (~70 MB raw, <20 MB gzip).
     * For the current Orbinum testnet/mainnet scale this is the recommended approach.
     */
    async getAllSpentNullifiers(): Promise<Set<string>> {
        const res = await this.get<{ data: string[] }>('/shielded/nullifiers/all');
        return new Set(res.data.map((h) => h.toLowerCase()));
    }

    // ─── Private transfers ─────────────────────────────────────────────────────

    /**
     * Returns temporal metadata for private transfers that spent any of the given nullifiers.
     * Only blockNumber, extrinsicIndex, timestampMs, and hash are returned — no cross-link
     * between inputs and outputs to prevent graph reconstruction.
     * Accepts up to 50 nullifiers (0x-prefixed hex).
     */
    async getTransfersByNullifiers(nullifiers: string[]): Promise<PrivateTransferTimestamp[]> {
        if (nullifiers.length === 0) return [];
        const qs = this.buildQuery({
            nullifiers: nullifiers.map((n) => n.toLowerCase()).join(','),
        });
        const res = await this.get<{ data: PrivateTransferTimestamp[]; total: number }>(
            `/shielded/transfers/by-nullifiers${qs}`
        );
        return res.data;
    }

    /**
     * Returns temporal metadata for private transfers that produced any of the given commitments.
     * Only blockNumber, extrinsicIndex, timestampMs, and hash are returned — no cross-link
     * between outputs and inputs to prevent graph reconstruction.
     * Accepts up to 50 commitments (0x-prefixed hex).
     */
    async getTransfersByCommitments(commitments: string[]): Promise<PrivateTransferTimestamp[]> {
        if (commitments.length === 0) return [];
        const qs = this.buildQuery({
            commitments: commitments.map((c) => c.toLowerCase()).join(','),
        });
        const res = await this.get<{ data: PrivateTransferTimestamp[]; total: number }>(
            `/shielded/transfers/by-commitments${qs}`
        );
        return res.data;
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
     * Returns a paginated list of unshield events where the given address is the recipient.
     * Accepts a 0x-prefixed EVM address or an SS58 Substrate address.
     */
    async getAddressUnshields(
        address: string,
        params?: { page?: number; limit?: number }
    ): Promise<PaginatedResult<Unshield>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<Unshield>>(
            `/address/${encodeURIComponent(address)}/unshields${qs}`
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

    // ─── Relayers ──────────────────────────────────────────────────────────────

    /** Returns a paginated list of relayers. Filter by active status with `active`. */
    async getRelayers(params?: {
        page?: number;
        limit?: number;
        active?: boolean;
    }): Promise<PaginatedResult<Relayer>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            active: params?.active === undefined ? undefined : params.active ? 'true' : 'false',
        });
        return this.get<PaginatedResult<Relayer>>(`/relayers${qs}`);
    }

    /** Returns a single relayer by EVM address, or null if not found. */
    async getRelayer(evmAddress: string): Promise<Relayer | null> {
        return this.getOrNull<Relayer>(`/relayers/${encodeURIComponent(evmAddress.toLowerCase())}`);
    }

    /** Returns a paginated list of relay fee events. */
    async getRelayFees(params?: {
        page?: number;
        limit?: number;
        relayer?: string;
        type?: 'accumulated' | 'consumed';
    }): Promise<PaginatedResult<RelayFeeEvent>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            relayer: params?.relayer,
            type: params?.type,
        });
        return this.get<PaginatedResult<RelayFeeEvent>>(`/relayers/fees${qs}`);
    }

    /** Returns aggregated relay fee balances per asset for a given relayer account. */
    async getRelayFeesSummary(relayer: string): Promise<RelayFeeSummaryEntry[]> {
        return this.get<RelayFeeSummaryEntry[]>(
            `/relayers/fees/summary/${encodeURIComponent(relayer)}`
        );
    }

    // ─── Registered assets ─────────────────────────────────────────────────────

    /** Returns a paginated list of assets registered via register_asset. */
    async getRegisteredAssets(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<RegisteredAsset>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<RegisteredAsset>>(`/shielded/assets${qs}`);
    }

    /** Returns a single registered asset by its ID, or null if not found. */
    async getRegisteredAsset(assetId: string): Promise<RegisteredAsset | null> {
        return this.getOrNull<RegisteredAsset>(`/shielded/assets/${encodeURIComponent(assetId)}`);
    }

    // ─── Validators ────────────────────────────────────────────────────────────

    /** Returns a paginated list of validators. Filter by lifecycle status with `status`. */
    async getValidators(params?: {
        page?: number;
        limit?: number;
        status?: 'pending' | 'approved' | 'rejected' | 'removed';
    }): Promise<PaginatedResult<IndexedValidator>> {
        const qs = this.buildQuery({
            page: params?.page,
            limit: params?.limit,
            status: params?.status,
        });
        return this.get<PaginatedResult<IndexedValidator>>(`/validators${qs}`);
    }

    /** Returns a single validator by account address, or null if not found. */
    async getValidator(account: string): Promise<IndexedValidator | null> {
        return this.getOrNull<IndexedValidator>(`/validators/${encodeURIComponent(account)}`);
    }

    // ─── Sessions ──────────────────────────────────────────────────────────────

    /** Returns a paginated list of session rotations, ordered by most recent first. */
    async getSessions(params?: {
        page?: number;
        limit?: number;
    }): Promise<PaginatedResult<IndexedSession>> {
        const qs = this.buildQuery({ page: params?.page, limit: params?.limit });
        return this.get<PaginatedResult<IndexedSession>>(`/sessions${qs}`);
    }

    // ─── Stats & Health ────────────────────────────────────────────────────────

    /** Returns aggregated indexer statistics. */
    async getStats(): Promise<IndexerStats> {
        return this.get<IndexerStats>('/stats');
    }

    /**
     * Returns transaction activity bucketed per hour over the last `hours` hours
     * of chain time (default 24, max 168). For sparklines / activity charts.
     */
    async getActivity(hours = 24): Promise<IndexerActivity> {
        return this.get<IndexerActivity>(`/stats/activity?hours=${hours}`);
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
