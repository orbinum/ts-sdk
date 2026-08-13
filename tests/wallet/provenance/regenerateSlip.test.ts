/**
 * regeneratePaymentSlip — re-issuing a slip from public chain facts.
 *
 * The scenario worth proving end to end: a sender wipes their device, looks the
 * transfer up by commitment, and hands the recipient a slip that works.
 *
 * The sender never reads the memo — they cannot, it is sealed toward the
 * recipient — they only forward it. Real crypto throughout, no stubs, because
 * the property under test is that an envelope built from public fields alone
 * opens with the recipient's real viewing key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { collectOutgoingFacts } from '../../../src/protocol/note/NoteDecryptor';
import type { OutgoingHint } from '../../../src/protocol/note/NoteDecryptor';
import {
    deriveOwnerPk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
} from '../../../src/protocol/keys/PrivacyKeys';
import { decodePaymentSlip, openPaymentSlip } from '../../../src/protocol/memo/PaymentSlip';
import { regeneratePaymentSlip } from '../../../src/wallet/provenance/index';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { NoteFacts, ZkNote } from '../../../src/protocol/types';

const RECIPIENT_SK = 33333333333333333n;
const TX_HASH = '0x' + 'ab'.repeat(32);

describe('regeneratePaymentSlip', () => {
    let recipientIvsk: Uint8Array;
    let recipientVpk: Uint8Array;
    let sentNote: ZkNote;
    let facts: NoteFacts;

    beforeAll(async () => {
        recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
        recipientVpk = deriveViewingPublicKey(recipientIvsk);
        const recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);

        sentNote = await NoteBuilder.build({
            value: 5000n,
            blinding: 88n,
            ownerPk: recipientOwnerPk,
            sourcePk: deriveOwnerPk(44444444444444444n),
            viewingPublicKey: recipientVpk,
            recipientOwnerPk,
        });

        // What a wiped sender gets back from the chain: public fields only.
        const hint: OutgoingHint = {
            commitmentHex: sentNote.commitmentHex,
            leafIndex: 3,
            encryptedMemo: toHex(new Uint8Array(sentNote.memo)),
        };
        facts = collectOutgoingFacts(hint)!;
        expect(facts).not.toBeNull();
    });

    it('the regenerated slip opens with the recipient’s viewing key', () => {
        const encoded = regeneratePaymentSlip(facts, recipientVpk, TX_HASH);

        const opened = openPaymentSlip(recipientIvsk, decodePaymentSlip(encoded)!);

        expect(opened).not.toBeNull();
        expect(opened!.commitmentHex).toBe(sentNote.commitmentHex);
        expect(opened!.encryptedMemo).toBe(toHex(new Uint8Array(sentNote.memo)));
        expect(opened!.leafIndex).toBe(3);
        expect(opened!.txHash).toBe(TX_HASH);
    });

    it('is an orbslip1: string, like one sealed at send time', () => {
        expect(regeneratePaymentSlip(facts, recipientVpk)).toMatch(/^orbslip1:/);
    });

    it('a stranger’s viewing key cannot open it', () => {
        const stranger = deriveViewingSecretKey(99999999999999999n);
        const encoded = regeneratePaymentSlip(facts, recipientVpk);

        expect(openPaymentSlip(stranger, decodePaymentSlip(encoded)!)).toBeNull();
    });

    it('produces DIFFERENT bytes each time, carrying the same fields', () => {
        // Fresh ephemeral key and nonce per envelope: identical output would mean
        // a reused nonce, which is the one failure this format cannot survive.
        const a = regeneratePaymentSlip(facts, recipientVpk);
        const b = regeneratePaymentSlip(facts, recipientVpk);

        expect(a).not.toBe(b);
        expect(openPaymentSlip(recipientIvsk, decodePaymentSlip(a)!)).toEqual(
            openPaymentSlip(recipientIvsk, decodePaymentSlip(b)!)
        );
    });

    it('omits txHash when the caller has none, rather than writing undefined', () => {
        const opened = openPaymentSlip(
            recipientIvsk,
            decodePaymentSlip(regeneratePaymentSlip(facts, recipientVpk))!
        )!;

        expect('txHash' in opened).toBe(false);
    });
});
