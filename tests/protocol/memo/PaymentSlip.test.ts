import { describe, it, expect, beforeAll } from 'vitest';
import {
    sealPaymentSlip,
    openPaymentSlip,
    encodePaymentSlip,
    decodePaymentSlip,
    PAYMENT_SLIP_SCHEME,
    type PaymentSlipFields,
} from '../../../src/protocol/memo/PaymentSlip';
import { importPaymentSlip } from '../../../src/wallet/ops/notes/paymentSlipImport';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { ZkNote } from '../../../src/protocol/types';

// A recipient identity, and a stealth note SENT to them (the real transfer shape).
const RECIPIENT_SK = 77777777777777777n;
let recipientIvsk: Uint8Array;
let recipientIvk: Uint8Array;
let recipientOwnerPk: bigint;
let sentNote: ZkNote;
let fields: PaymentSlipFields;

beforeAll(async () => {
    recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
    recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
    recipientIvk = deriveViewingPublicKey(recipientIvsk);

    sentNote = await NoteBuilder.build({
        value: 4200n,
        assetId: 0n,
        blinding: 99n,
        ownerPk: recipientOwnerPk,
        viewingPublicKey: recipientIvk,
        recipientOwnerPk,
    });
    fields = {
        commitmentHex: sentNote.commitmentHex,
        encryptedMemo: toHex(Uint8Array.from(sentNote.memo)),
        leafIndex: 5,
        txHash: '0x' + 'ab'.repeat(32),
    };
});

describe('sealPaymentSlip / openPaymentSlip', () => {
    it('round-trips the fields for the intended recipient', () => {
        const env = sealPaymentSlip(recipientIvk, fields);
        const opened = openPaymentSlip(recipientIvsk, env);
        expect(opened).toEqual(fields);
    });

    it('two seals of the same fields differ (fresh ephemeral key)', () => {
        const a = sealPaymentSlip(recipientIvk, fields);
        const b = sealPaymentSlip(recipientIvk, fields);
        expect(a).not.toEqual(b);
        expect(openPaymentSlip(recipientIvsk, a)).toEqual(fields);
        expect(openPaymentSlip(recipientIvsk, b)).toEqual(fields);
    });

    it('a different recipient cannot open it', () => {
        const strangerIvsk = deriveViewingSecretKey(11111111111111111n);
        const env = sealPaymentSlip(recipientIvk, fields);
        expect(openPaymentSlip(strangerIvsk, env)).toBeNull();
    });

    it('a corrupted envelope returns null, not a throw', () => {
        const env = sealPaymentSlip(recipientIvk, fields);
        env[40] = (env[40] ?? 0) ^ 0x01;
        expect(openPaymentSlip(recipientIvsk, env)).toBeNull();
    });

    it('rejects a too-short envelope', () => {
        expect(openPaymentSlip(recipientIvsk, new Uint8Array(10))).toBeNull();
    });
});

describe('encodePaymentSlip / decodePaymentSlip (orbslip1 wire)', () => {
    it('round-trips an envelope through the wire string', () => {
        const env = sealPaymentSlip(recipientIvk, fields);
        const wire = encodePaymentSlip(env);
        expect(wire.startsWith(PAYMENT_SLIP_SCHEME)).toBe(true);
        expect(decodePaymentSlip(wire)).toEqual(env);
    });

    it('rejects a wrong scheme', () => {
        expect(decodePaymentSlip('orbpriv2:whatever')).toBeNull();
    });

    it('rejects a corrupted checksum', () => {
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const broken = wire.slice(0, -1) + (wire.at(-1) === 'a' ? 'b' : 'a');
        expect(decodePaymentSlip(broken)).toBeNull();
    });
});

describe('importPaymentSlip (recipient reconstructs the note)', () => {
    const keys = {
        get viewingSecretKey() {
            return recipientIvsk;
        },
        get spendingKey() {
            return RECIPIENT_SK;
        },
        get ownerPk() {
            return recipientOwnerPk;
        },
    };

    it('reconstructs a spendable note from the wire slip — no scan', () => {
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const note = importPaymentSlip(wire, keys);
        expect(note).not.toBeNull();
        expect(note!.value).toBe(4200n);
        expect(note!.commitmentHex).toBe(sentNote.commitmentHex);
        // Stealth spending key was DERIVED from the recipient identity (not carried
        // in the slip, and not the global key) — its nullifier follows from it.
        expect(note!.spendingKey).not.toBe(0n);
        expect(note!.spendingKey).not.toBe(RECIPIENT_SK);
        expect(note!.ownerPk).toBe(sentNote.ownerPk);
    });

    it('stamps the creating tx hash from the slip onto the note', () => {
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const note = importPaymentSlip(wire, keys);
        // fields.txHash is set in the fixture; the imported note carries it so the
        // "created tx" column is populated instead of blank.
        expect((note as unknown as { createdTxHash?: string }).createdTxHash).toBe(fields.txHash);
    });

    it('accepts a raw envelope too', () => {
        const env = sealPaymentSlip(recipientIvk, fields);
        expect(importPaymentSlip(env, keys)).not.toBeNull();
    });

    it("returns null for a stranger's keys (slip does not open)", () => {
        const strangerSk = 22222222222222222n;
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const note = importPaymentSlip(wire, {
            viewingSecretKey: deriveViewingSecretKey(strangerSk),
            spendingKey: strangerSk,
            ownerPk: deriveOwnerPk(strangerSk),
        });
        expect(note).toBeNull();
    });

    it('returns null for a corrupted wire string', () => {
        expect(importPaymentSlip('orbslip1:garbage:0000', keys)).toBeNull();
    });

    it('rejects a slip whose commitment does not match the memo (forged)', () => {
        // Swap in a different commitment: tryDecryptNote's commitment check fails.
        const forged = { ...fields, commitmentHex: '0x' + 'ab'.repeat(32) };
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, forged));
        expect(importPaymentSlip(wire, keys)).toBeNull();
    });
});
