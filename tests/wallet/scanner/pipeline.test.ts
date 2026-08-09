/**
 * runScan — the phases wired together, against a real vault and real storage.
 *
 * These are the tests that would catch a mis-wiring between phases, which unit
 * tests of each phase cannot: a cursor advanced from the wrong field, a purge
 * running on the wrong scan kind, or the self-eph counter failing to move past
 * an index the scan just published.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { collectNullifiersToQuery } from '../../../src/wallet/scanner/phases/spentStatus';
import { VaultStore } from '../../../src/index';
import { MemoryVaultStorage } from '../../../src/index';
import { createNotesCache } from '../../../src/index';
import { createWalletSession } from '../../../src/index';
import { deriveVaultKey, deriveVaultBlindKey } from '../../../src/index';
import { deriveOwnerPk } from '../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../src/protocol/types';
import type { DecryptPool } from '../../../src/index';
import type { ScanHint, ScanHintSource, NullifierSource } from '../../../src/wallet/scanner/feed/sources';

const SPENDING_KEY = 12345678901234567890n;

function note(commitmentHex: string, overrides: Partial<ZkNote> = {}): ZkNote {
    return {
        commitmentHex,
        value: 100n,
        assetId: 0n,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        blinding: 7n,
        spendingKey: SPENDING_KEY,
        nullifierHex: `0xn${commitmentHex.slice(2)}`,
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        ...overrides,
    } as ZkNote;
}

const hint = (i: number): ScanHint => ({
    leafIndex: i,
    commitmentHex: `0xc${i}`,
    ephPkHex: `0xe${i}`,
    encryptedMemo: `0xm${i}`,
    timestampMs: null,
    txHash: null,
});

/** A source serving `size` hints on one page, no sealed chunks. */
function hintSource(size: number): ScanHintSource {
    return {
        async listHints({ limit }) {
            return {
                data: Array.from({ length: size }, (_, i) => hint(i)),
                pagination: { limit, total: size },
            };
        },
    };
}

/** A nullifier source whose whole spent set is `spentHexes`. */
function nullifierSource(spentHexes: string[] = []): NullifierSource {
    return {
        async manifest() {
            return { generation: '1', chunks: [] };
        },
        async chunk() {
            return { data: [] };
        },
        async tail() {
            return {
                afterChunks: 0,
                data: spentHexes,
                timestampsMs: spentHexes.map(() => 4242),
                txHashes: spentHexes.map(() => null),
            };
        },
    };
}

function fakePool(
    decrypt: (h: ScanHint) => ZkNote | null = () => null,
    counts: Partial<{ selfMatched: number; maxSelfEphIndex: number | null }> = {}
): DecryptPool {
    return {
        async decryptBatch(hints: ScanHint[], _keys: unknown, signal?: AbortSignal) {
            // The real pool checks the signal at its yield points; a fake that
            // ignored it would make every abort test pass vacuously.
            if (signal?.aborted) {
                const err = new Error('Scan aborted');
                err.name = 'AbortError';
                throw err;
            }
            return {
                notes: hints.map((h) => decrypt(h)),
                tagFiltered: 0,
                selfMatched: counts.selfMatched ?? 0,
                pairwiseMatched: 0,
                maxSelfEphIndex: counts.maxSelfEphIndex ?? null,
            };
        },
        terminate() {},
    } as unknown as DecryptPool;
}

const KEYS = { viewingKey: new Uint8Array(32).fill(1), spendingKey: SPENDING_KEY, ownerPk: 3n };

describe('runScan', () => {
    let storage: MemoryVaultStorage;
    let vault: VaultStore;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        const session = createWalletSession();
        vault = new VaultStore({ storage, session, notes: createNotesCache() });
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    const scan = (params: Partial<Parameters<typeof runScan>[0]> = {}) =>
        runScan({
            vault,
            storage,
            hints: hintSource(3),
            nullifiers: nullifierSource(),
            pool: fakePool(),
            keys: KEYS,
            ...params,
        });

    it('persists discovered notes and reports them as found', async () => {
        const result = await scan({
            pool: fakePool((h) => note(h.commitmentHex)),
        });

        expect(result.found).toBe(3);
        expect(
            vault
                .getAll()
                .map((n) => n.commitmentHex)
                .sort()
        ).toEqual(['0xc0', '0xc1', '0xc2']);
    });

    it('marks a discovered note spent when its nullifier is in the set', async () => {
        await scan({
            pool: fakePool((h) => (h.commitmentHex === '0xc1' ? note('0xc1') : null)),
            nullifiers: nullifierSource(['0xnc1']),
        });

        const saved = vault.getAll();
        expect(saved).toHaveLength(1);
        expect(saved[0]?.spent).toBe(true);
        expect(saved[0]?.spentAt).toBe(4242);
    });

    it('advances the scan cursor to the highest leaf seen', async () => {
        await scan({ hints: hintSource(5) });

        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(4);
    });

    it('purges a ghost on a full scan but not on an incremental one', async () => {
        await vault.save(note('0xghost'));

        const incremental = await scan({ sinceLeafIndex: 0 });
        expect(incremental.purged).toBe(0);
        expect(incremental.incremental).toBe(true);

        const full = await scan();
        expect(full.purged).toBe(1);
        expect(vault.getAll()).toHaveLength(0);
    });

    it('bumps the self-eph counter past the highest index the scan saw', async () => {
        // Reuse of a published index republishes the same ephPk and links both
        // notes as sharing a creator, so the counter must always end up above it.
        await scan({ pool: fakePool(() => null, { maxSelfEphIndex: 12 }) });

        expect((await storage.getConfig())?.selfEphCounter).toBe(13);
    });

    it('never lowers the self-eph counter', async () => {
        await storage.updateConfig((c) => ({ ...c, selfEphCounter: 99 }));

        await scan({ pool: fakePool(() => null, { maxSelfEphIndex: 5 }) });

        expect((await storage.getConfig())?.selfEphCounter).toBe(99);
    });

    it('degrades to unspent when the nullifier feed fails', async () => {
        // The scan itself succeeded; spent status is simply unverified this pass
        // and re-checked on the next one.
        const broken: NullifierSource = {
            async manifest() {
                throw new Error('indexer down');
            },
            async chunk() {
                throw new Error('indexer down');
            },
            async tail() {
                throw new Error('indexer down');
            },
        };
        const warnings: string[] = [];

        const result = await scan({
            pool: fakePool((h) => note(h.commitmentHex)),
            nullifiers: broken,
            onWarning: (m) => warnings.push(m),
        });

        expect(result.found).toBe(3);
        expect(vault.getAll().every((n) => !n.spent)).toBe(true);
        expect(warnings.some((w) => w.includes('spent-nullifier status'))).toBe(true);
    });

    it('never un-spends a memo-failed note the feed does not report', async () => {
        // The spent set is authoritative about what IS spent, not about what is
        // not — a nullifier can simply be lagging indexing. A note already known
        // spent whose memo no longer decrypts (rotated key) is reconciled from
        // the on-chain set alone, and that path must never flip it back.
        await vault.save(note('0xc1', { spent: true, spentAt: 111 }));

        await scan({
            pool: fakePool(() => null), // nothing decrypts this pass
            nullifiers: nullifierSource([]), // and nothing is reported spent
        });

        const saved = vault.getAll();
        expect(saved).toHaveLength(1);
        expect(saved[0]?.spent).toBe(true);
        expect(saved[0]?.spentAt).toBe(111);
    });

    it('leaves the cursor untouched when the scan aborts', async () => {
        // A cursor advanced from a partial pass would make the next incremental
        // scan skip the leaves this one never finished.
        await storage.updateConfig((c) => ({ ...c, lastScannedLeafIndex: 7 }));
        const controller = new AbortController();
        const source: ScanHintSource = {
            async listHints({ limit }) {
                controller.abort();
                return { data: [hint(99)], pagination: { limit, total: 1 } };
            },
        };

        await expect(scan({ hints: source, signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(7);
    });

    it('SECURITY: an abort after reading but before writing saves nothing', async () => {
        // The window a host aborts for. Reads are harmless; the moment the scan
        // persists, notes decrypted under one account's keys land in whichever
        // vault is open. A wallet that switched account mid-scan aborts exactly
        // here, and the write must not happen.
        const controller = new AbortController();
        const before = vault.getAll().length;

        // Abort from the LAST read phase, so collection and decryption both
        // complete: the scan arrives at the checkpoint holding notes it is about
        // to write. Aborting earlier proves nothing — an earlier checkpoint
        // would catch it.
        // Abort from the LAST read the scan performs, and only after it has
        // returned: `resolveSpentSet` checks the signal at its own entry and
        // exit, so aborting mid-phase would be caught there and prove nothing
        // about the checkpoint that guards the WRITE.
        const base = nullifierSource();
        const nullifiers: NullifierSource = {
            ...base,
            async tail() {
                const result = await base.tail();
                controller.abort();
                return result;
            },
        };

        await expect(
            scan({
                pool: fakePool((h) => note(h.commitmentHex)),
                nullifiers,
                signal: controller.signal,
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(vault.getAll().length).toBe(before);
    });

    it('stays quiet about undecryptable hints when notes were recovered', async () => {
        // Every note owned by someone else lands in decryptFailed, so warning on
        // it would fire on every healthy scan and train the host to ignore the
        // channel.
        const warnings: string[] = [];

        await scan({
            hints: hintSource(3),
            pool: fakePool((h) => (h.commitmentHex === '0xc0' ? note('0xc0') : null)),
            onWarning: (m) => warnings.push(m),
        });

        expect(warnings).toEqual([]);
    });

    it('warns when a non-empty pool yielded nothing at all', async () => {
        // This is the shape of a wrong-keys unlock, and the one case where the
        // count is worth surfacing.
        const warnings: string[] = [];

        await scan({
            hints: hintSource(3),
            pool: fakePool(() => null),
            onWarning: (m) => warnings.push(m),
        });

        expect(warnings.some((w) => w.includes('no notes recovered'))).toBe(true);
    });

    it('skips malformed pairwise counterparties instead of failing the scan', async () => {
        // The vault is local state: one bad key must not stop the wallet from
        // finding the rest of its notes.
        await storage.updateConfig((c) => ({
            ...c,
            pairwiseCounterparties: {
                'not-hex': { nextIndex: 0, addedAt: 1 },
                '0x1234': { nextIndex: 0, addedAt: 1 }, // valid hex, wrong length
            },
        }));

        const result = await scan({ pool: fakePool((h) => note(h.commitmentHex)) });

        expect(result.found).toBe(3);
    });

    it('propagates an abort', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(scan({ signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    /** Two sealed chunks of 5 leaves each; the tail after them is empty. */
    function chunkedSource(): ScanHintSource {
        const chunks = [
            [0, 1, 2, 3, 4].map(hint),
            [5, 6, 7, 8, 9].map(hint),
        ];
        const flat = chunks.flat();
        return {
            async listHints({ limit, sinceLeafIndex }) {
                const from = sinceLeafIndex ?? 0;
                const data = flat.filter((h) => (h.leafIndex ?? 0) >= from);
                return { data, pagination: { limit, total: data.length } };
            },
            chunks: {
                async manifest() {
                    return {
                        chunkSize: 5,
                        chunks: chunks.map((c, i) => ({ idx: i, count: c.length, digest: `d${i}` })),
                        lastSealedLeaf: flat.length - 1,
                        total: flat.length,
                    };
                },
                async chunk(idx: number) {
                    return chunks[idx]!;
                },
            },
        };
    }

    it('checkpoints new notes (with spent status) and the cursor per completed chunk', async () => {
        // Abort after the first chunk fully processed: its notes and the cursor
        // must survive, so the next scan resumes instead of restarting. The
        // spent one must be saved SPENT — a checkpoint that wrote it unspent
        // would overstate the balance until a scan finally completes.
        const controller = new AbortController();

        await expect(
            scan({
                hints: chunkedSource(),
                pool: fakePool((h) =>
                    h.commitmentHex === '0xc1' || h.commitmentHex === '0xc3'
                        ? note(h.commitmentHex)
                        : null
                ),
                nullifiers: nullifierSource(['0xnc3']),
                signal: controller.signal,
                onProgress: (p) => {
                    if (p.scanned === 5) controller.abort();
                },
            })
        ).rejects.toMatchObject({ name: 'AbortError' });

        const saved = new Map(vault.getAll().map((n) => [n.commitmentHex, n]));
        expect([...saved.keys()].sort()).toEqual(['0xc1', '0xc3']);
        expect(saved.get('0xc1')?.spent).toBe(false);
        expect(saved.get('0xc3')?.spent).toBe(true);
        expect(saved.get('0xc3')?.spentAt).toBe(4242);
        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(4);
    });

    it('advances the checkpoint cursor past chunks holding no owned notes', async () => {
        // The common case: a whole chunk of other people's notes. The cursor
        // must still move, or an aborted scan re-decrypts it all next time.
        const controller = new AbortController();

        await expect(
            scan({
                hints: chunkedSource(),
                pool: fakePool(() => null),
                signal: controller.signal,
                onProgress: (p) => {
                    if (p.scanned === 5) controller.abort();
                },
            })
        ).rejects.toMatchObject({ name: 'AbortError' });

        expect(vault.getAll()).toHaveLength(0);
        expect((await storage.getConfig())?.lastScannedLeafIndex).toBe(4);
    });

    it('keeps a bounded window of chunk downloads in flight, processing in order', async () => {
        // The window is what removes the serialized per-chunk round-trip; the
        // in-order processing is what the cursor/checkpoint invariants rest on.
        const chunks = Array.from({ length: 6 }, (_, c) =>
            [0, 1, 2, 3, 4].map((i) => hint(c * 5 + i))
        );
        const flat = chunks.flat();
        let inFlight = 0;
        let maxInFlight = 0;
        const source: ScanHintSource = {
            async listHints({ limit, sinceLeafIndex }) {
                const from = sinceLeafIndex ?? 0;
                const data = flat.filter((h) => (h.leafIndex ?? 0) >= from);
                return { data, pagination: { limit, total: data.length } };
            },
            chunks: {
                async manifest() {
                    return {
                        chunkSize: 5,
                        chunks: chunks.map((c, i) => ({ idx: i, count: c.length, digest: `d${i}` })),
                        lastSealedLeaf: flat.length - 1,
                        total: flat.length,
                    };
                },
                async chunk(idx: number) {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await new Promise((r) => setTimeout(r, 1));
                    inFlight--;
                    return chunks[idx]!;
                },
            },
        };
        const processed: number[] = [];

        await scan({
            hints: source,
            pool: fakePool((h) => {
                processed.push(h.leafIndex!);
                return null;
            }),
        });

        expect(maxInFlight).toBeGreaterThan(1); // the window actually overlaps downloads
        expect(maxInFlight).toBeLessThanOrEqual(3); // and never exceeds PREFETCH
        expect(processed).toEqual(flat.map((h) => h.leafIndex)); // strict ascending order
    });
});

describe('collectNullifiersToQuery', () => {
    it('includes every scanned note', () => {
        const entries = [{ note: note('0xa') }, { note: note('0xb') }];

        expect(collectNullifiersToQuery(entries, new Set(), [])).toEqual(new Set(['0xna', '0xnb']));
    });

    it('includes a vault note the window confirmed but did not re-decrypt', () => {
        // Its memo failed this pass, so it is absent from scanEntries — but it
        // exists on-chain and may have been spent.
        const vaultNotes = [note('0xold')];

        expect(collectNullifiersToQuery([], new Set(['0xold']), vaultNotes)).toEqual(
            new Set(['0xnold'])
        );
    });

    it('skips a vault note the window never confirmed', () => {
        const vaultNotes = [note('0xelsewhere')];

        expect(collectNullifiersToQuery([], new Set(), vaultNotes)).toEqual(new Set());
    });

    it('does not duplicate a note that was both scanned and in the vault', () => {
        const entries = [{ note: note('0xa') }];

        expect(collectNullifiersToQuery(entries, new Set(['0xa']), [note('0xa')])).toEqual(
            new Set(['0xna'])
        );
    });
});
