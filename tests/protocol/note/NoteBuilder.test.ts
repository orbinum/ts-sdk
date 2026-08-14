import { describe, it, expect } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { ENCRYPTED_MEMO_SIZE } from '../../../src/protocol/memo/EncryptedMemo';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveOutgoingViewingKey,
} from '../../../src/protocol/keys/PrivacyKeys';
import { openOutgoingBlob } from '../../../src/protocol/memo/OutgoingBlob';
import { bytesToBjjScalar } from '../../../src/protocol/memo/EncryptedMemo';
import {
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
} from '../../../src/protocol/eph/index';
import { tryDecryptNote } from '../../../src/protocol/note/NoteDecryptor';
import { toHex } from '../../../src/foundation/encoding/hex';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { fastMulBase } from '../../../src/foundation/crypto/bjj-fast';
import { packPoint } from '@zk-kit/baby-jubjub';

// ─── NoteBuilder.build ────────────────────────────────────────────────────────

describe('NoteBuilder.build', () => {
    it('returns a ZkNote with all required fields', async () => {
        const note = await NoteBuilder.build({ value: 1000n, blinding: 1n });
        expect(note.value).toBe(1000n);
        expect(typeof note.commitment).toBe('bigint');
        expect(typeof note.nullifier).toBe('bigint');
        expect(note.commitmentHex).toMatch(/^0x[0-9a-f]+$/);
        expect(note.nullifierHex).toMatch(/^0x[0-9a-f]+$/);
    });

    it('commitment and nullifier hex are 32 bytes (64 nibbles)', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        expect(note.commitmentHex).toMatch(/^0x[0-9a-f]{64}$/);
        expect(note.nullifierHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('defaults assetId to 0n', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        expect(note.assetId).toBe(0n);
    });

    it('defaults ownerPk to 0n', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        expect(note.ownerPk).toBe(0n);
    });

    it('defaults spendingKey to 0n', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        expect(note.spendingKey).toBe(0n);
    });

    it('stamps the current circuit version by default', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        expect(note.circuitVersion).toBe(1);
    });

    it('honors an explicit circuitVersion (caller resolved from chain)', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n, circuitVersion: 2 });
        expect(note.circuitVersion).toBe(2);
    });

    it('commitment is deterministic for same inputs', async () => {
        const input = { value: 42n, assetId: 1n, ownerPk: 123n, blinding: 456n, spendingKey: 789n };
        const a = await NoteBuilder.build(input);
        const b = await NoteBuilder.build(input);
        expect(a.commitment).toBe(b.commitment);
        expect(a.nullifier).toBe(b.nullifier);
        expect(a.commitmentHex).toBe(b.commitmentHex);
        expect(a.nullifierHex).toBe(b.nullifierHex);
    });

    it('different values produce different commitments', async () => {
        const base = { value: 100n, assetId: 0n, ownerPk: 0n, blinding: 1n, spendingKey: 0n };
        const a = await NoteBuilder.build(base);
        const b = await NoteBuilder.build({ ...base, value: 200n });
        expect(a.commitment).not.toBe(b.commitment);
    });

    it('different assetIds produce different commitments', async () => {
        const base = { value: 100n, ownerPk: 0n, blinding: 1n, spendingKey: 0n };
        const a = await NoteBuilder.build({ ...base, assetId: 0n });
        const b = await NoteBuilder.build({ ...base, assetId: 1n });
        expect(a.commitment).not.toBe(b.commitment);
    });

    it('different blindings produce different commitments (same other inputs)', async () => {
        const base = { value: 100n, assetId: 0n, ownerPk: 0n, spendingKey: 0n };
        const a = await NoteBuilder.build({ ...base, blinding: 1n });
        const b = await NoteBuilder.build({ ...base, blinding: 2n });
        expect(a.commitment).not.toBe(b.commitment);
    });

    it('different spending keys produce the same commitment but different nullifiers', async () => {
        const base = { value: 100n, assetId: 0n, ownerPk: 0n, blinding: 1n };
        const a = await NoteBuilder.build({ ...base, spendingKey: 1n });
        const b = await NoteBuilder.build({ ...base, spendingKey: 2n });
        expect(a.commitment).toBe(b.commitment);
        expect(a.nullifier).not.toBe(b.nullifier);
    });

    it('nullifier depends on commitment (same spendingKey, different commitment)', async () => {
        const a = await NoteBuilder.build({ value: 10n, blinding: 1n, spendingKey: 7n });
        const b = await NoteBuilder.build({ value: 20n, blinding: 1n, spendingKey: 7n });
        expect(a.nullifier).not.toBe(b.nullifier);
    });

    it('preserves explicitly provided fields', async () => {
        const input = {
            value: 99n,
            assetId: 5n,
            ownerPk: 0x1234n,
            blinding: 0x5678n,
            spendingKey: 0xabcdn,
        };
        const note = await NoteBuilder.build(input);
        expect(note.value).toBe(99n);
        expect(note.assetId).toBe(5n);
        expect(note.ownerPk).toBe(0x1234n);
        expect(note.blinding).toBe(0x5678n);
        expect(note.spendingKey).toBe(0xabcdn);
    });

    it('sourcePk defaults to 0n when not provided', async () => {
        const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
        expect(note.sourcePk).toBe(0n);
    });

    it('sourcePk is preserved from input', async () => {
        const cpk = 0xdeadbeefcafen;
        const note = await NoteBuilder.build({ value: 100n, blinding: 1n, sourcePk: cpk });
        expect(note.sourcePk).toBe(cpk);
    });

    it('sourcePk does not affect commitment (same commitment with or without)', async () => {
        const base = { value: 100n, assetId: 0n, ownerPk: 0n, blinding: 1n, spendingKey: 0n };
        const withCpk = await NoteBuilder.build({ ...base, sourcePk: 0xdeadbeefn });
        const withoutCpk = await NoteBuilder.build(base);
        expect(withCpk.commitment).toBe(withoutCpk.commitment);
        expect(withCpk.nullifier).toBe(withoutCpk.nullifier);
    });
});

// ─── NoteBuilder.buildMemo ────────────────────────────────────────────────────

describe('NoteBuilder.buildMemo', () => {
    it('returns a Uint8Array of ENCRYPTED_MEMO_SIZE bytes', async () => {
        const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
        const memo = NoteBuilder.buildMemo(note);
        expect(memo).toBeInstanceOf(Uint8Array);
        expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
    });

    it('produces different memos on each call (random nonce)', async () => {
        const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
        const a = NoteBuilder.buildMemo(note);
        const b = NoteBuilder.buildMemo(note);
        // nonces differ with overwhelming probability
        expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
    });

    it('accepts a custom 32-byte recipient viewing key', async () => {
        const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
        const vk = new Uint8Array(32).fill(0x05);
        const memo = NoteBuilder.buildMemo(note, vk);
        expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
    });

    it('is synchronous (returns Uint8Array directly, not a Promise)', async () => {
        const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
        const result = NoteBuilder.buildMemo(note);
        expect(result).toBeInstanceOf(Uint8Array);
    });
});

// ─── NoteBuilder stealth ─────────────────────────────────────────────────────

describe('NoteBuilder.build — stealth path', () => {
    const RECIPIENT_SK = 99999999999999999n;
    let recipientOwnerPk: bigint;
    let recipientViewingKey: Uint8Array;
    let recipientViewingPublicKey: Uint8Array;

    // Derived once before tests.
    const setup = () => {
        recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
        recipientViewingKey = deriveViewingSecretKey(RECIPIENT_SK);
        recipientViewingPublicKey = deriveViewingPublicKey(recipientViewingKey);
    };
    setup();

    it('stealth commitment differs from plain commitment (stealthOwnerPk ≠ recipientOwnerPk)', async () => {
        const plain = await NoteBuilder.build({
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
        });
        const stealth = await NoteBuilder.build({
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        });
        // Stealth commitment must differ because stealthOwnerPk ≠ recipientOwnerPk.
        expect(stealth.commitment).not.toBe(plain.commitment);
        // But the value is the same.
        expect(stealth.value).toBe(plain.value);
    });

    it('note.ownerPk is the stealthOwnerPk, not the recipient global ownerPk', async () => {
        const stealth = await NoteBuilder.build({
            value: 1000n,
            blinding: 7n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        });
        expect(stealth.ownerPk).not.toBe(recipientOwnerPk);
    });

    it('two stealth notes for the same recipient have different commitments (random ephSk)', async () => {
        const input = {
            value: 100n,
            blinding: 3n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        };
        const a = await NoteBuilder.build(input);
        const b = await NoteBuilder.build(input);
        expect(a.commitment).not.toBe(b.commitment);
    });

    it('memo has ENCRYPTED_MEMO_SIZE bytes on the stealth path', async () => {
        const stealth = await NoteBuilder.build({
            value: 200n,
            blinding: 5n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        });
        expect(stealth.memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
    });

    it('own note (no recipientOwnerPk) uses ownerPk directly in commitment', async () => {
        const ownSk = 777777n;
        const ownPk = deriveOwnerPk(ownSk);
        const ownVsk = deriveViewingSecretKey(ownSk);
        const ownVpk = deriveViewingPublicKey(ownVsk);

        const ownNote = await NoteBuilder.build({
            value: 300n,
            blinding: 9n,
            ownerPk: ownPk,
            spendingKey: ownSk,
            viewingPublicKey: ownVpk,
            // No recipientOwnerPk → non-stealth path
        });
        expect(ownNote.ownerPk).toBe(ownPk);
    });

    // ─── OVK blob emission (Fase 3) ──────────────────────────────────────────

    const senderMaster = new Uint8Array(32).fill(0x5a);
    const senderOvk = deriveOutgoingViewingKey(senderMaster);

    it('stealth build with outgoingViewingKey → 56-byte ovkBlob', async () => {
        const note = await NoteBuilder.build({
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
            outgoingViewingKey: senderOvk,
        });
        expect(note.ovkBlob).toBeDefined();
        expect(note.ovkBlob).toHaveLength(56);
    });

    it('stealth build without outgoingViewingKey → ovkBlob undefined', async () => {
        const note = await NoteBuilder.build({
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        });
        expect(note.ovkBlob).toBeUndefined();
    });

    it('non-stealth build never produces an ovkBlob, even with an ovk', async () => {
        const note = await NoteBuilder.build({
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
            outgoingViewingKey: senderOvk,
            // no viewingPublicKey/recipientOwnerPk → non-stealth
        });
        expect(note.ovkBlob).toBeUndefined();
    });

    it('the ovkBlob is sealed against the memo ephPk (bytes 148..180) and commitment', async () => {
        const note = await NoteBuilder.build({
            value: 777n,
            blinding: 5n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
            outgoingViewingKey: senderOvk,
        });
        const ephPkBytes = Uint8Array.from(note.memo.slice(148, 180));
        const commitmentBytes = Uint8Array.from(
            (note.commitmentHex.slice(2).match(/.{2}/g) ?? []).map((b) => parseInt(b, 16))
        );
        // Opening with the sender ovk against the on-chain ephPk + commitment must
        // succeed and yield a 32-byte shared secret.
        const ss = openOutgoingBlob(
            senderOvk,
            Uint8Array.from(note.ovkBlob!),
            commitmentBytes,
            ephPkBytes
        );
        expect(ss).not.toBeNull();
        expect(ss).toHaveLength(32);
    });

    it('the ovk does not perturb the note shape: same 180-byte memo, only ovkBlob added', async () => {
        // The stealth path generates its own random ephSk (ephSkOverride is
        // ignored here), so the two memos differ by ephemeral key — but both must
        // still be exactly 180 bytes, and only the ovk build carries a blob.
        const base = {
            value: 500n,
            blinding: 1n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientViewingPublicKey,
            recipientOwnerPk,
        };
        const withOvk = await NoteBuilder.build({ ...base, outgoingViewingKey: senderOvk });
        const withoutOvk = await NoteBuilder.build(base);
        expect(withOvk.memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
        expect(withoutOvk.memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
        expect(withOvk.ovkBlob).toBeDefined();
        expect(withoutOvk.ovkBlob).toBeUndefined();
    });
});

// ─── El ephemeral override en la rama stealth ────────────────────────────────

describe('NoteBuilder.build — ephSkOverride en stealth', () => {
    const SENDER_SK = 111n;
    const RECIPIENT_SK = 222n;

    const senderIvsk = deriveViewingSecretKey(SENDER_SK);
    const recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
    const recipientIvk = deriveViewingPublicKey(recipientIvsk);
    const recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);

    /** El ephPk que la efímera derivada debería publicar. */
    const expectedEphPk = (ephSk: Uint8Array) =>
        toHex(bigintTo32Le(packPoint(fastMulBase(bytesToBjjScalar(ephSk))) as bigint));

    /** Los últimos 32 bytes del memo son el ephPk publicado. */
    const publishedEphPk = (note: { memo: number[] }) =>
        toHex(Uint8Array.from(note.memo.slice(148, 180)));

    it('publica la efímera que el llamador pidió, no una aleatoria', async () => {
        // El camino pairwise deriva una efímera determinista para que el
        // receptor encuentre la nota por búsqueda en tabla en vez de un ECDH
        // por hint. Si `build` la descarta, esa optimización no existe: el
        // llamador la calcula y nadie la usa.
        const ephSk = derivePairwiseEphSk(
            derivePairwiseSharedSecret(senderIvsk, recipientIvk),
            0
        );

        const note = await NoteBuilder.build({
            value: 4200n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
            ephSkOverride: ephSk,
        });

        expect(publishedEphPk(note)).toBe(expectedEphPk(ephSk));
    });

    it('sin override sigue siendo aleatoria', async () => {
        // Un primer pago no tiene contador, así que la efímera tiene que seguir
        // siendo impredecible: dos notas iguales no pueden compartir ephPk.
        const params = {
            value: 4200n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
        };

        const a = await NoteBuilder.build(params);
        const b = await NoteBuilder.build(params);

        expect(publishedEphPk(a)).not.toBe(publishedEphPk(b));
    });

    it('el receptor sigue abriendo la nota con la efímera derivada', async () => {
        // El override no puede romper el camino del receptor: la derivación
        // stealth y el cifrado del memo comparten ese mismo ephSk.
        const ephSk = derivePairwiseEphSk(
            derivePairwiseSharedSecret(senderIvsk, recipientIvk),
            5
        );

        const note = await NoteBuilder.build({
            value: 4200n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
            ephSkOverride: ephSk,
        });

        const opened = tryDecryptNote(
            {
                commitmentHex: note.commitmentHex,
                leafIndex: 1,
                encryptedMemo: toHex(Uint8Array.from(note.memo)),
            },
            recipientIvsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );

        expect(opened).not.toBeNull();
        expect(opened!.value).toBe(4200n);
    });

    it('índices distintos publican efímeras distintas', async () => {
        // Reutilizar un índice republica el mismo ephPk y enlaza las dos notas
        // en público — la fuga que el contador existe para evitar.
        const pair = derivePairwiseSharedSecret(senderIvsk, recipientIvk);
        const build = (i: number) =>
            NoteBuilder.build({
                value: 1n,
                blinding: 7n,
                ownerPk: recipientOwnerPk,
                viewingPublicKey: recipientIvk,
                recipientOwnerPk,
                ephSkOverride: derivePairwiseEphSk(pair, i),
            });

        const [a, b] = await Promise.all([build(0), build(1)]);

        expect(publishedEphPk(a)).not.toBe(publishedEphPk(b));
    });
});
