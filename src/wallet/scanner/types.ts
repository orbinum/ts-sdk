/** Live progress, reported after each scanned page or chunk. */
export interface ScanProgress {
    scanned: number;
    total: number;
    found: number;
}

/** Final outcome of a completed scan. */
export interface ScanResult {
    found: number;
    noMemo: number;
    decryptFailed: number;
    alreadyPresent: number;
    /** Notes removed because their commitment was not found anywhere on-chain. */
    purged: number;
    /** Whether this was a full scan (from leafIndex 0) or an incremental one. */
    incremental: boolean;
}
