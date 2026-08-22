/**
 * A working Orbinum wallet in Node, importing ONLY published entry points.
 *
 * This runs in the SDK's CI. If it compiles and runs against `@orbinum/sdk` and
 * `@orbinum/sdk/worker` alone, the package is genuinely self-contained — no deep
 * import into `dist/`, no browser API, nothing the exports map does not expose.
 * Nothing else demonstrates that, which is why this is a test and not a snippet
 * in the README.
 *
 * The feed here is a fixture rather than a live indexer, so the example stays
 * runnable offline and in CI. A real host implements the same three interfaces
 * over whatever backend it has.
 */
import {
    OrbinumWallet,
    MemoryVaultStorage,
    deriveIdentity,
    deriveOwnerPk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    NoteBuilder,
    toHex,
} from '@orbinum/sdk';
import type { ScanHint, ScanHintSource, NullifierSource } from '@orbinum/sdk';
import { createDecryptPool } from '@orbinum/sdk/worker';

/**
 * The master key bytes. A real wallet derives these from a signature over a
 * `SpendingKeyRequest`; a fixed value here keeps the example deterministic.
 */
const MASTER = new Uint8Array(32).fill(7);

/** Builds the on-chain feed a wallet with `noteCount` own notes would see. */
async function buildFixture(noteCount: number, poolSize: number) {
    // Derive exactly as the wallet does. Building the feed with a different
    // scheme than the one that scans it produces notes nobody owns — and the
    // scan reports zero found, with nothing to explain why.
    const { spendingKey, ownerPk, viewingPublicKey } = deriveIdentity(MASTER, 'v3');

    const hints: ScanHint[] = [];
    for (let i = 0; i < poolSize; i++) {
        // Ours for the first `noteCount` leaves; the rest belong to other
        // wallets and must not decrypt.
        const mine = i < noteCount;
        const note = await NoteBuilder.build({
            value: BigInt((i + 1) * 1000),
            assetId: 0n,
            ownerPk: mine ? ownerPk : 12345n,
            spendingKey: mine ? spendingKey : 999n,
            viewingPublicKey: mine
                ? viewingPublicKey
                : deriveViewingPublicKey(deriveViewingSecretKey(999n)),
            circuitVersion: 1,
        });
        const memo = new Uint8Array(note.memo);
        hints.push({
            leafIndex: i,
            commitmentHex: note.commitmentHex,
            ephPkHex: toHex(memo.slice(-32)),
            encryptedMemo: toHex(memo),
            timestampMs: 1_700_000_000_000 + i,
            txHash: null,
        });
    }
    return hints;
}

function fixtureSources(hints: ScanHint[]): {
    hints: ScanHintSource;
    nullifiers: NullifierSource;
} {
    return {
        hints: {
            async listHints({ page, limit }) {
                return {
                    data: hints.slice((page - 1) * limit, page * limit),
                    pagination: { limit, total: hints.length },
                };
            },
        },
        nullifiers: {
            // Nothing is spent in this fixture. A real feed serves sealed chunks
            // and a tail; the wallet downloads the whole set and intersects it
            // locally, so the server never learns which nullifiers are ours.
            async manifest() {
                return { generation: '1', chunks: [] };
            },
            async chunk() {
                return { data: [] };
            },
            async tail() {
                return { afterChunks: 0, data: [], timestampsMs: [] };
            },
        },
    };
}

async function main() {
    const OWN_NOTES = 4;
    const POOL_SIZE = 40;

    const hints = await buildFixture(OWN_NOTES, POOL_SIZE);
    const sources = fixtureSources(hints);

    const wallet = new OrbinumWallet({
        storage: new MemoryVaultStorage(),
        hints: sources.hints,
        nullifiers: sources.nullifiers,
        // `factory: null` runs trial decryption on this thread, yielding
        // periodically. On a server that is fine; a browser passes a factory
        // that spawns Web Workers so the UI keeps painting.
        pool: createDecryptPool({ factory: null }),
        onWarning: (message, cause) => console.warn(`[scan] ${message}`, cause ?? ''),
    });

    const { wasReset } = await wallet.unlock(MASTER);
    console.log(`unlocked (vault reset: ${wasReset})`);

    const { ownerPk } = wallet.privacyKeys();
    console.log(`ownerPk: 0x${ownerPk.toString(16).slice(0, 16)}…`);

    wallet.onNotesChanged((notes) => console.log(`  vault now holds ${notes.length} note(s)`));

    const result = await wallet.scan({
        onProgress: (p) => {
            if (p.scanned % 20 === 0) console.log(`  scanned ${p.scanned}/${p.total}`);
        },
    });

    console.log(`scan complete: found ${result.found} of ${POOL_SIZE} commitments`);
    const balance = wallet.getNotes().reduce((sum, n) => sum + n.value, 0n);
    console.log(`balance: ${balance}`);

    // The example is also its own assertion: a silent regression that recovers
    // the wrong number of notes must fail CI, not print a wrong number.
    if (result.found !== OWN_NOTES) {
        throw new Error(`expected ${OWN_NOTES} own notes, recovered ${result.found}`);
    }
    if (wallet.getNotes().length !== OWN_NOTES) {
        throw new Error(`vault holds ${wallet.getNotes().length}, expected ${OWN_NOTES}`);
    }

    // An incremental pass over the same feed finds nothing new — the notes are
    // already held, and re-scanning must not duplicate them.
    const again = await wallet.scan({ sinceLeafIndex: await wallet.scanCursor() });
    if (again.found !== 0 || wallet.getNotes().length !== OWN_NOTES) {
        throw new Error('incremental rescan changed the vault');
    }
    console.log('incremental rescan: no change, as expected');

    console.log('\nOK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
