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

    // ─── The facts crossed a trust boundary ──────────────────────────────────────
    //
    // They were looked up by commitment, and sealing them produces an
    // AUTHENTICATED envelope: a valid MAC proves the sender knew the recipient's
    // viewing key, not that they — or the server that answered — are honest. The
    // recipient's wallet renders those fields with the authority of a decrypted
    // slip, on a device where nothing explains where they came from.

    describe('regeneratePaymentSlip — facts that are not what they claim', () => {
        /** Valid facts with one field replaced, as a server might return them. */
        const withField = (over: Record<string, unknown>): NoteFacts =>
            ({ ...facts, ...over }) as unknown as NoteFacts;

        it('refuses a commitment that is not 32 bytes of hex', () => {
            // A `<script>` sealed here reaches the recipient authenticated.
            for (const bad of ['<script>alert(1)</script>', '0xzz', '', '0x' + 'aa'.repeat(31)]) {
                expect(() =>
                    regeneratePaymentSlip(withField({ commitmentHex: bad }), recipientVpk)
                ).toThrow(/commitmentHex/);
            }
        });

        it('refuses a memo that is not exactly the published size', () => {
            // A half-megabyte memo produced a 1.3 MB slip — a string the recipient's
            // wallet has to accept, store and render.
            for (const bad of ['0x' + 'aa'.repeat(179), '0x' + 'aa'.repeat(500_000), '']) {
                expect(() =>
                    regeneratePaymentSlip(withField({ encryptedMemo: bad }), recipientVpk)
                ).toThrow(/encryptedMemo/);
            }
        });

        it('refuses a leaf index that is not a real tree position', () => {
            for (const bad of [-5, 1.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
                expect(() =>
                    regeneratePaymentSlip(withField({ leafIndex: bad }), recipientVpk)
                ).toThrow(/leafIndex/);
            }
        });

        it('keeps a valid leaf index, and an absent one stays absent', () => {
            // The guard must not reject the legitimate shapes it sits in front of.
            const withIndex = openPaymentSlip(
                recipientIvsk,
                decodePaymentSlip(regeneratePaymentSlip(withField({ leafIndex: 0 }), recipientVpk))!
            )!;
            expect(withIndex.leafIndex).toBe(0);

            const { leafIndex: _dropped, ...noIndex } = facts;
            const without = openPaymentSlip(
                recipientIvsk,
                decodePaymentSlip(regeneratePaymentSlip(noIndex as NoteFacts, recipientVpk))!
            )!;
            expect('leafIndex' in without).toBe(false);
        });

        it('drops a txHash that is not a 32-byte hash instead of failing the slip', () => {
            // txHash is informational and rendered as an explorer link, where an
            // unconstrained string is a URL injection. Dropping it keeps the slip
            // working: the recipient can still rebuild the note.
            for (const bad of ['javascript:alert(1)', 'not-a-hash', '0x1234', '']) {
                const opened = openPaymentSlip(
                    recipientIvsk,
                    decodePaymentSlip(regeneratePaymentSlip(facts, recipientVpk, bad))!
                )!;

                expect('txHash' in opened).toBe(false);
                expect(opened.commitmentHex).toBe(facts.commitmentHex);
            }
        });

        it('refuses a viewing key that is not a curve point', () => {
            expect(() => regeneratePaymentSlip(facts, new Uint8Array(31))).toThrow();
            expect(() => regeneratePaymentSlip(facts, new Uint8Array(32).fill(0xff))).toThrow();
        });
    });
});
