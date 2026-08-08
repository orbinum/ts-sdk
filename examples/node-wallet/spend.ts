/**
 * Spending notes with the SDK alone — the half a wallet needs beyond finding
 * them.
 *
 * This exists to prove one claim: `OrbinumWallet` can produce every dependency
 * the spend ops take. If a consumer had to reach around the facade for key
 * material, this file would not compile — which is exactly the defect it was
 * written to catch.
 *
 * Everything up to proving is real: the plan arithmetic, the pairing rules, the
 * output-note construction, and the shield marshalling. Proving itself needs
 * circuit artifacts and submitting needs a chain, so the example stops where a
 * host would hand off to those — and demonstrates the hand-off by assembling
 * the dependency object `transferNotes` takes.
 */
import {
    OrbinumWallet,
    MemoryVaultStorage,
    createMemorySecretStore,
    planTransfer,
    planUnshield,
    spendableBalance,
    canPairWith,
    buildShieldParams,
    NoteBuilder,
    deriveSpendingKeyFromMaster,
    deriveOwnerPk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    toHex,
} from '@orbinum/sdk';
import type { ScanHint, ScanHintSource, NullifierSource, TransferDeps } from '@orbinum/sdk';
import { createDecryptPool } from '@orbinum/sdk/worker';

const MASTER = new Uint8Array(32).fill(7);
const CIRCUIT_VERSION = 1;

/** A recipient who shared their privacy address with us. */
const RECIPIENT_MASTER = new Uint8Array(32).fill(9);
const RECIPIENT_SK = deriveSpendingKeyFromMaster(RECIPIENT_MASTER);

/** Builds a feed of notes this wallet owns, so the scan has something to find. */
async function buildOwnNotes(count: number): Promise<ScanHint[]> {
    const spendingKey = deriveSpendingKeyFromMaster(MASTER);
    const viewingPublicKey = deriveViewingPublicKey(deriveViewingSecretKey(spendingKey));
    const hints: ScanHint[] = [];

    for (let i = 0; i < count; i++) {
        const note = await NoteBuilder.build({
            value: BigInt((i + 1) * 1_000_000),
            assetId: 0n,
            ownerPk: deriveOwnerPk(spendingKey),
            spendingKey,
            viewingPublicKey,
            circuitVersion: CIRCUIT_VERSION,
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

function sources(hints: ScanHint[]): { hints: ScanHintSource; nullifiers: NullifierSource } {
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
    const feed = await buildOwnNotes(4);

    const wallet = new OrbinumWallet({
        storage: new MemoryVaultStorage(),
        ...sources(feed),
        pool: createDecryptPool({ factory: null }),
        // Pinned rather than read from a chain, since this example has none.
        // A real wallet passes `zkVerifier` and the version is read fail-closed.
        circuitVersion: CIRCUIT_VERSION,
    });

    await wallet.unlock(MASTER);
    await wallet.scan();

    const notes = wallet.getNotes();
    console.log(`holding ${notes.length} notes, balance ${spendableBalance(notes)}`);

    // ── Planning ─────────────────────────────────────────────────────────────
    // The plan answers what a UI needs before enabling a button: which inputs,
    // how much change, and what the ceiling is.
    const fee = 1_000n;
    const amount = 2_500_000n;

    const plan = planTransfer({ notes, amount, fee });
    if (!plan.ok) throw new Error(`transfer not plannable: ${plan.problem}`);
    console.log(
        `plan: ${plan.inputs![1] ? 'two inputs' : 'one input'}, change ${plan.change}, ` +
            `max spendable ${plan.maxSpendable}`
    );

    // The same rule the automatic selection applies is available directly, so a
    // manual-selection UI cannot enforce a weaker one.
    if (plan.inputs![1] && !canPairWith(plan.inputs![0], plan.inputs![1]!)) {
        throw new Error('planner returned a pair the circuit could not prove');
    }

    // An amount no single note covers is not plannable as an unshield, even
    // when the balance is ample — that circuit takes one input.
    const tooBig = planUnshield({ notes, amount: spendableBalance(notes), fee });
    if (tooBig.ok) throw new Error('unshield should not plan across two notes');
    console.log(`unshield of the full balance: correctly refused (${tooBig.problem})`);

    // ── The spend hand-off ───────────────────────────────────────────────────
    // Every dependency comes from the facade. That is the property under test:
    // a consumer never reaches around it for key material. Assembling this
    // object is what would fail to compile if the facade could not produce it.
    const deps: Omit<TransferDeps, 'privacy' | 'resolver' | 'submit'> = {
        buildNote: wallet.buildOutputNote,
        vault: wallet.vault,
        recoverStealth: wallet.recoverStealth,
        selfOwnerPk: wallet.spendKeys().ownerPk,
    };
    if (typeof deps.buildNote !== 'function' || typeof deps.recoverStealth !== 'function') {
        throw new Error('facade did not produce the spend dependencies');
    }
    console.log('spend dependencies assembled from the facade alone');

    // The outputs a transfer builds, produced the same way the op would.
    const recipientNote = await wallet.buildOutputNote({
        value: amount,
        assetId: 0n,
        ownerPk: deriveOwnerPk(RECIPIENT_SK),
        counterpartyPk: wallet.spendKeys().ownerPk,
        viewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK)),
        recipientOwnerPk: deriveOwnerPk(RECIPIENT_SK),
    });
    if (recipientNote.circuitVersion !== CIRCUIT_VERSION) {
        throw new Error('output note carries the wrong circuit version');
    }
    console.log(`recipient output built (stealth ownerPk, circuit v${recipientNote.circuitVersion})`);

    // ── Shield marshalling ───────────────────────────────────────────────────
    // The commitment goes on chain little-endian; getting that wrong yields a
    // note nobody can ever find, with no error to notice.
    const fresh = await wallet.buildOutputNote({ value: 5_000n });
    const shieldArgs = buildShieldParams(fresh);
    if (!shieldArgs.commitment.startsWith('0x') || shieldArgs.commitment.length !== 66) {
        throw new Error('shield commitment is not a 32-byte hex');
    }
    console.log(`shield args ready for asset ${shieldArgs.assetId}, amount ${shieldArgs.amount}`);

    // A secret store is all a host must supply to keep the identity across
    // launches — proven in portability.ts.
    void createMemorySecretStore();

    console.log('\nOK — spend path wired from the facade alone');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
