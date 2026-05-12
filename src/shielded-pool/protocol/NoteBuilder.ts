import type { NoteInput, ZkNote } from './types';
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from './EncryptedMemo';
import { deriveStealthOwnerPk } from '../../utils/stealth';
import { recoverOwnerPkPoint } from '../../utils/bjj';
import { toHex } from '../../utils/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../utils/bytes';
import { mulPointEscalar, unpackPoint } from '@zk-kit/baby-jubjub';
import { randomBytes } from '@noble/ciphers/utils.js';
import { BABYJUB_SUBORDER } from '../../utils/crypto-constants';
import { poseidon2, poseidon4 } from 'poseidon-lite';

// ─── NoteBuilder ─────────────────────────────────────────────────────────────

/**
 * Builds ZK notes (commitment + nullifier) and encrypted memos locally.
 *
 * All computation is off-chain — no network calls are made.
 *
 * Hash scheme (Poseidon, circomlibjs):
 *   commitment = Poseidon(value, assetId, ownerPk, blinding)
 *   nullifier  = Poseidon(commitment, spendingKey)
 *
 * Memo scheme (EncryptedMemo — native TypeScript, no WASM):
 *   ChaCha20-Poly1305 with ECDH ephemeral key — SHA256(sharedSecret || commitment || domain)
 *   Result: nonce(12) || ciphertext(108 + 16 MAC) || ephPk(32) = 168 bytes
 *
 * Stealth scheme (when viewingPublicKey + recipientOwnerPk are both provided):
 *   ephSk is generated once and shared between the ECDH memo and the stealth Pk derivation.
 *   The commitment uses stealthOwnerPk instead of the recipient's global ownerPk, making
 *   each transfer unlinkable even when the same privacy address is reused.
 *   stealthOwnerPk = stealthScalar × Base8 + ownerPkPoint
 *   stealthScalar  = HKDF(sharedSecret, salt=ownerPk_LE, info="orbinum-stealth-v1") % suborder
 */
export class NoteBuilder {
    /**
     * Build a ZkNote from the given inputs.
     *
     * @param input.value            Amount in planck (required).
     * @param input.assetId          Asset ID — default 0n (native ORB-Privacy).
     * @param input.ownerPk          Sender's or recipient's global BabyJubJub Ax — default 0n.
     * @param input.blinding         Random scalar — defaults to BigInt(Date.now()).
     * @param input.spendingKey      Secret key for nullifier — default 0n.
     * @param input.viewingPublicKey Recipient's 32-byte LE packed BJJ ivk. Triggers memo encryption.
     * @param input.recipientOwnerPk Recipient's global ownerPk. Required with viewingPublicKey
     *                               to enable stealth address derivation. Without it, the
     *                               commitment uses ownerPk directly (no stealth).
     */
    static async build(input: NoteInput): Promise<ZkNote> {
        const value = input.value;
        const assetId = input.assetId ?? 0n;
        const ownerPk = input.ownerPk ?? 0n;
        const blinding = input.blinding ?? BigInt(Date.now());
        const spendingKey = input.spendingKey ?? 0n;
        const counterpartyPk = input.counterpartyPk ?? 0n;

        const useStealth =
            input.viewingPublicKey !== undefined && input.recipientOwnerPk !== undefined;

        let memo: number[];

        if (useStealth) {
            const recipientOwnerPk = input.recipientOwnerPk!;
            const recipientIvkPacked = input.viewingPublicKey!;

            // Generate one ephSk shared between memo encryption and stealth derivation.
            const ephSk = randomBytes(32);

            // Derive sharedSecret from the ephSk and the recipient's ivk.
            const ivkPackedBigint = bytesToBigintLE(recipientIvkPacked);
            const ivkPoint = unpackPoint(ivkPackedBigint);
            if (!ivkPoint)
                throw new Error('NoteBuilder.build: invalid recipient viewing public key');
            const ephSkScalar = BigInt(toHex(ephSk)) % BABYJUB_SUBORDER || 1n;
            const sharedPoint = mulPointEscalar(ivkPoint, ephSkScalar);
            const sharedSecret = bigintTo32Le(sharedPoint[0]);

            // Recover the recipient's full BJJ point [Ax, Ay] from the Ax coordinate using
            // the curve equation. Required by deriveStealthOwnerPk.
            const recipientPkPoint = recoverOwnerPkPoint(recipientOwnerPk);
            if (!recipientPkPoint)
                throw new Error(
                    'NoteBuilder.build: recipientOwnerPk is not a valid BJJ x-coordinate'
                );

            const effectiveOwnerPk = deriveStealthOwnerPk(
                sharedSecret,
                recipientOwnerPk,
                recipientPkPoint
            );

            // Commitment uses stealthOwnerPk. Memo uses the same ephSk so recipient can extract sharedSecret.
            const stealthCommitment = poseidon4([value, assetId, effectiveOwnerPk, blinding]);
            const stealthCommitmentBytes = bigintTo32Le(stealthCommitment);

            memo = Array.from(
                EncryptedMemo.encrypt(
                    value,
                    bigintTo32Le(effectiveOwnerPk),
                    bigintTo32Le(blinding),
                    Number(assetId),
                    stealthCommitmentBytes,
                    recipientIvkPacked,
                    bigintTo32Le(counterpartyPk),
                    ephSk
                )
            );

            const commitment = stealthCommitment;
            const nullifier = poseidon2([commitment, spendingKey]);
            const commitmentBytes = stealthCommitmentBytes;
            const nullifierBytes = bigintTo32Le(nullifier);

            if (memo.length !== ENCRYPTED_MEMO_SIZE)
                throw new Error(
                    `NoteBuilder.build: invariant violated — memo must be ${ENCRYPTED_MEMO_SIZE} bytes, got ${memo.length}`
                );

            return {
                value,
                assetId,
                ownerPk: effectiveOwnerPk,
                blinding,
                spendingKey,
                spent: false,
                spentAt: null,
                commitment,
                nullifier,
                commitmentHex: toHex(commitmentBytes),
                nullifierHex: toHex(nullifierBytes),
                memo,
                counterpartyPk,
            };
        }

        // Non-stealth path: own notes (shield, change) — commitment uses ownerPk directly.
        const commitment = poseidon4([value, assetId, ownerPk, blinding]);
        const nullifier = poseidon2([commitment, spendingKey]);
        const commitmentBytes = bigintTo32Le(commitment);
        const nullifierBytes = bigintTo32Le(nullifier);

        memo =
            input.viewingPublicKey !== undefined
                ? Array.from(
                      EncryptedMemo.encrypt(
                          value,
                          bigintTo32Le(ownerPk),
                          bigintTo32Le(blinding),
                          Number(assetId),
                          commitmentBytes,
                          input.viewingPublicKey,
                          bigintTo32Le(counterpartyPk)
                      )
                  )
                : Array.from(EncryptedMemo.dummy());

        if (memo.length !== ENCRYPTED_MEMO_SIZE)
            throw new Error(
                `NoteBuilder.build: invariant violated — memo must be ${ENCRYPTED_MEMO_SIZE} bytes, got ${memo.length}`
            );

        return {
            value,
            assetId,
            ownerPk,
            blinding,
            spendingKey,
            spent: false,
            spentAt: null,
            commitment,
            nullifier,
            commitmentHex: toHex(commitmentBytes),
            nullifierHex: toHex(nullifierBytes),
            memo,
            counterpartyPk,
        };
    }

    /**
     * Build the 168-byte ECDH-encrypted memo for a note.
     *
     * Pure TypeScript implementation — no WASM dependency.
     * Uses ChaCha20-Poly1305 with ECDH key agreement (BabyJubJub ephemeral keypair).
     *
     * @param note                    The ZkNote whose fields populate the plaintext.
     * @param recipientIvkPacked      32-byte LE packed BJJ viewing public key of the recipient.
     *                                Pass `new Uint8Array(32)` (default) for a public/dummy memo.
     * @param counterpartyPk          32-byte counterparty BabyJubJub Ax.
     *                                Pass `new Uint8Array(32)` (default) for no counterparty.
     */
    static buildMemo(
        note: ZkNote,
        recipientIvkPacked?: Uint8Array,
        counterpartyPk?: Uint8Array
    ): Uint8Array {
        return EncryptedMemo.encrypt(
            note.value,
            bigintTo32Le(note.ownerPk),
            bigintTo32Le(note.blinding),
            Number(note.assetId),
            bigintTo32Le(note.commitment),
            recipientIvkPacked ?? new Uint8Array(32),
            counterpartyPk ?? bigintTo32Le(note.counterpartyPk ?? 0n)
        );
    }
}
