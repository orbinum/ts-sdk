/**
 * Building the vault's config record.
 *
 * Small, but it guards a rule that costs privacy when broken: an update must
 * carry every ephemeral counter forward. See `buildConfig`.
 */
import type { VaultConfigRecord } from './contract';

/** The schema version this build writes and expects to read back. */
export const VAULT_SCHEMA_VERSION = 4;

/**
 * Lowercases a chain fingerprint, or returns undefined when there is none —
 * so callers can chain `??` without distinguishing empty from absent.
 */
export function normalizeChainFingerprint(chainFingerprint?: string | null): string | undefined {
    return chainFingerprint ? chainFingerprint.toLowerCase() : undefined;
}

/** The counters a config write must never drop. */
export type EphemeralCounters = Pick<
    VaultConfigRecord,
    'createdAt' | 'selfEphCounter' | 'pairwiseCounterparties'
>;

/**
 * Builds a config record ready to persist.
 *
 * Carries `createdAt` and EVERY ephemeral counter forward from an existing
 * config. Dropping a counter would restart it at zero, re-derive an index
 * already used, and republish an ephPk — which publicly links the two notes as
 * sharing a creator. That applies to the self-note counter and to each
 * counterparty's alike.
 *
 * The scan cursor is the one field safe to drop: losing it costs a rescan and
 * nothing else.
 *
 * NOTE: `existing` must be read inside the same atomic transaction that writes
 * the result — see `writeConfig`. Passing a snapshot taken before an await
 * rolls the counters back to it, which is index reuse, not a lost update.
 */
export function buildConfig(
    existing: EphemeralCounters | null,
    chainFingerprint?: string
): VaultConfigRecord {
    const now = Date.now();
    return {
        id: 'main',
        v: VAULT_SCHEMA_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(chainFingerprint ? { chainFingerprint } : {}),
        ...(existing?.selfEphCounter !== undefined
            ? { selfEphCounter: existing.selfEphCounter }
            : {}),
        ...(existing?.pairwiseCounterparties !== undefined
            ? { pairwiseCounterparties: existing.pairwiseCounterparties }
            : {}),
    };
}

/**
 * Writes the config, merging the ephemeral counters against whatever is stored
 * RIGHT NOW rather than against a caller's snapshot.
 *
 * This exists because the counters are the one piece of vault state that cannot
 * be rebuilt. Notes come back from a rescan and the scan cursor only costs
 * time, but an ephemeral index that gets handed out twice has already published
 * the same ephPk on chain, and no local repair un-links those two notes.
 *
 * `unlock` reads the config, then decrypts every note and may await an RPC
 * before writing it back — a window wide enough for a concurrent shield to
 * reserve an index. Going through `updateConfig` closes it: the backend
 * contract requires that read-modify-write be atomic, so the reservation is
 * always visible here.
 *
 * Falls back to a plain `putConfig` only when no config exists yet, which is
 * first-run and has no counters to preserve.
 */
export async function writeConfig(
    storage: ConfigWriter,
    fallback: EphemeralCounters | null,
    chainFingerprint?: string
): Promise<void> {
    const merged = await storage.updateConfig((current) =>
        buildConfig(mergeCounters(current, fallback), chainFingerprint)
    );
    if (merged === null) await storage.putConfig(buildConfig(fallback, chainFingerprint));
}

/** The two writes `writeConfig` needs. Narrower than `NoteStorage` on purpose. */
export interface ConfigWriter {
    putConfig(config: VaultConfigRecord): Promise<void>;
    updateConfig(
        mutate: (config: VaultConfigRecord) => VaultConfigRecord
    ): Promise<VaultConfigRecord | null>;
}

/**
 * Combines a stored config with a caller's snapshot so no counter moves
 * backwards.
 *
 * Every counter is monotonic, so taking the higher of the two sides is always
 * safe: a value only ever moves forward, and skipping an index costs nothing
 * while reusing one leaks. `createdAt` is not a counter — it identifies the
 * vault's birth, so the stored value wins and the snapshot only fills a gap.
 *
 * Exported to be tested directly: this is pure merge arithmetic, and proving it
 * through `writeConfig` alone would need a storage fake per case.
 */
export function mergeCounters(
    current: EphemeralCounters,
    fallback: EphemeralCounters | null
): EphemeralCounters {
    const selfEphCounter = higher(current.selfEphCounter, fallback?.selfEphCounter);
    const parties = mergePairwise(current.pairwiseCounterparties, fallback?.pairwiseCounterparties);

    return {
        createdAt: current.createdAt ?? fallback?.createdAt,
        // Spread-conditional rather than assigning undefined: the record type
        // is exactOptionalPropertyTypes, so an explicit undefined is a type
        // error AND would round-trip through structured clone as a present key.
        ...(selfEphCounter !== undefined ? { selfEphCounter } : {}),
        ...(parties !== undefined ? { pairwiseCounterparties: parties } : {}),
    } as EphemeralCounters;
}

/**
 * A counter value, or undefined when it is not one.
 *
 * Both sides of a merge come from outside this module — one from whatever JSON
 * was on disk, one from a caller's snapshot — so either can be corrupt. That
 * matters more here than it looks, because `Math.max` does not simply prefer
 * the good side: `Math.max(NaN, 9)` is `NaN`, so one bad value POISONS the
 * result and gets persisted as the wallet's counter. `Math.max('50', 9)` is
 * worse still — the string side wins with an index never reserved.
 *
 * Dropping the bad side leaves the good one; dropping both restarts the
 * sequence, the same repair `reserveSelfEphIndex` applies.
 */
const counterOrNone = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The further-along of two monotonic counters, ignoring any that is not one. */
const higher = (a?: number, b?: number): number | undefined => {
    const x = counterOrNone(a);
    const y = counterOrNone(b);
    return x === undefined ? y : y === undefined ? x : Math.max(x, y);
};

/**
 * A counterparty entry with both fields usable, or undefined when the index is
 * not a counter — a hand-edited backup can leave anything under a key, down to
 * a string or no object at all.
 *
 * A corrupt `addedAt` does NOT discard the entry: it is metadata about when the
 * wallet met that counterparty, so it is repaired to the current time while the
 * index, which is the part that decides an ephemeral, is kept.
 */
function usableEntry(entry: unknown): { nextIndex: number; addedAt: number } | undefined {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { nextIndex, addedAt } = entry as { nextIndex?: unknown; addedAt?: unknown };
    const index = counterOrNone(nextIndex);
    if (index === undefined) return undefined;
    return { nextIndex: index, addedAt: counterOrNone(addedAt) ?? Date.now() };
}

/**
 * Union of two counterparty maps, each key taking the higher `nextIndex`.
 *
 * A counterparty registered during the write window must survive, and one
 * already stored must never move backwards. `addedAt` takes the EARLIER value:
 * it records when the wallet first met that counterparty, so the older stamp is
 * the true one.
 *
 * Entries are validated on the way IN rather than only where they are compared,
 * because an unmatched key is copied straight through — so a corrupt entry on
 * one side would otherwise survive untouched whenever the other side has no
 * counterparty by that name. A dropped entry costs the recipient one trial
 * scan; a persisted `NaN` costs an index.
 *
 * Returns undefined when neither side has any, so the caller can omit the key
 * rather than store an empty object.
 */
function mergePairwise(
    current: VaultConfigRecord['pairwiseCounterparties'],
    fallback: VaultConfigRecord['pairwiseCounterparties']
): VaultConfigRecord['pairwiseCounterparties'] {
    if (!current && !fallback) return undefined;

    const merged: NonNullable<VaultConfigRecord['pairwiseCounterparties']> = {};
    for (const [key, entry] of Object.entries(fallback ?? {})) {
        const usable = usableEntry(entry);
        if (usable) merged[key] = usable;
    }
    for (const [key, raw] of Object.entries(current ?? {})) {
        const entry = usableEntry(raw);
        if (!entry) continue;
        const prev = merged[key];
        merged[key] = prev
            ? {
                  nextIndex: Math.max(prev.nextIndex, entry.nextIndex),
                  addedAt: Math.min(prev.addedAt, entry.addedAt),
              }
            : entry;
    }
    return merged;
}
