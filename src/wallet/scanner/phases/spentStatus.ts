/**
 * Scan phase 2 — resolve which of the wallet's nullifiers are spent, without
 * ever revealing to the server which nullifiers it owns (see spentSet.ts).
 *
 * Degrades safely: on any failure the spent status is left unknown (empty map),
 * so notes stay unspent and are re-verified on the next scan.
 */
import type { ZkNote } from '../../../protocol/types';
import type { NullifierCache, SpendDetails } from '../../vault/index';
import type { NullifierSource } from '../feed/sources';
import { resolveSpentSet } from './spentSet';
import { isAbortError } from '../../../foundation/errors/abort';

/**
 * The nullifiers whose spent status must be checked this pass:
 *   - every note just scanned, plus
 *   - vault notes present on-chain in this window whose memo did NOT decrypt
 *     this pass (so they weren't re-scanned but may have been spent).
 */
export function collectNullifiersToQuery(
    scanEntries: Array<{ note: ZkNote }>,
    onChainHexes: Set<string>,
    vaultNotes: ZkNote[]
): Set<string> {
    const syncedCommitments = new Set(scanEntries.map((e) => e.note.commitmentHex));
    const nullifiers = new Set<string>();

    for (const { note } of scanEntries) {
        nullifiers.add(note.nullifierHex.toLowerCase());
    }
    for (const vaultNote of vaultNotes) {
        if (syncedCommitments.has(vaultNote.commitmentHex)) continue;
        if (!onChainHexes.has(vaultNote.commitmentHex)) continue;
        if (vaultNote.nullifierHex) nullifiers.add(vaultNote.nullifierHex.toLowerCase());
    }
    return nullifiers;
}

/**
 * Resolves the spent members of `nullifiers` as a Map hex → spend details.
 * Never falls back to per-nullifier status lookups — that would leak ownership.
 * On failure (feed down or inconsistent) returns an empty map; an abort
 * propagates.
 */
export async function resolveSpentStatus(params: {
    source: NullifierSource;
    cache: NullifierCache;
    nullifiers: Set<string>;
    signal?: AbortSignal | undefined;
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}): Promise<Map<string, SpendDetails>> {
    if (params.nullifiers.size === 0) return new Map();
    try {
        return await resolveSpentSet({
            source: params.source,
            cache: params.cache,
            ownNullifiers: params.nullifiers,
            signal: params.signal,
            onWarning: params.onWarning,
        });
    } catch (err) {
        if (isAbortError(err)) throw err;
        params.onWarning?.(
            'could not resolve spent-nullifier status (feed unavailable or inconsistent); ' +
                'spent status left unverified this pass',
            err
        );
        return new Map();
    }
}
