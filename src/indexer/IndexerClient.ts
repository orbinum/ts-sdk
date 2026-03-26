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

    private async get<T>(path: string): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`IndexerClient: HTTP ${res.status} for ${path}`);
            }
            return res.json() as Promise<T>;
        } finally {
            clearTimeout(timer);
        }
    }

    private async getOrNull<T>(path: string): Promise<T | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                signal: controller.signal,
            });
            if (res.status === 404) return null;
            if (!res.ok) {
                throw new Error(`IndexerClient: HTTP ${res.status} for ${path}`);
            }
            return res.json() as Promise<T>;
        } finally {
            clearTimeout(timer);
        }
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
}
