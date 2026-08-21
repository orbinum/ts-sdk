/**
 * Building a note: its commitment, its nullifier, and the memo that recovers it.
 *
 * Everything is local — no chain access — and every note leaves here in one of
 * two shapes:
 *
 *   - STEALTH, when the caller supplies both halves of a privacy address. The
 *     commitment covers a one-time owner key, so two payments to one address
 *     cannot be linked, and the memo carries what the recipient needs to
 *     rederive the matching spending key.
 *   - PLAIN, for a wallet's own notes (a shield, a change note), where the
 *     commitment covers the wallet's global owner key because it has to find
 *     the note again with its own keys.
 *
 * The blinding is the note's only real secret once an amount is guessed, so an
 * absent one is drawn from a CSPRNG and never from anything predictable.
 */
import { CURRENT_CIRCUIT_VERSION, type NoteInput, type ZkNote } from '../types';
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '../memo/EncryptedMemo';
import { deriveStealthOwnerPk } from '../../foundation/crypto/stealth';
import { recoverOwnerPkPoint, unpackUsableViewingKey } from '../../foundation/crypto/bjj';
import { toHex } from '../../foundation/encoding/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { mulPointEscalar } from '@zk-kit/baby-jubjub';
import { randomBytes } from '@noble/ciphers/utils.js';
import { BABYJUB_SUBORDER } from '../../foundation/crypto/constants';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import { randomBlinding } from '../../foundation/crypto/blinding';

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
 *   Result: nonce(12) || ciphertext(120 + 16 MAC) || ephPk(32) = 180 bytes
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
     * @param input.blinding         Random scalar — defaults to a CSPRNG draw.
     * @param input.spendingKey      Secret key for nullifier — default 0n.
     * @param input.viewingPublicKey Recipient's 32-byte LE packed BJJ ivk. Triggers memo encryption.
     * @param input.recipientOwnerPk Recipient's global ownerPk. Required with viewingPublicKey
     *                               to enable stealth address derivation. Without it, the
     *                               commitment uses ownerPk directly (no stealth).
     */
    static async build(input: NoteInput): Promise<ZkNote> {
        // ── 1. Normalise inputs ───────────────────────────────────────────────
        const value = input.value;
        const assetId = input.assetId ?? 0n;
        const ownerPk = input.ownerPk ?? 0n;
        // A CSPRNG draw, never the clock. The blinding is the ONLY unknown in
        // `Poseidon4(value, assetId, ownerPk, blinding)` once an observer guesses
        // the amount, so it is what makes a commitment hide anything at all. A
        // `Date.now()` default gives it ~41 bits, and the block timestamp is
        // public: that collapses the search to a few thousand candidates, and
        // the commitment falls to brute force in seconds.
        const blinding = input.blinding ?? randomBlinding();
        const spendingKey = input.spendingKey ?? 0n;
        const sourcePk = input.sourcePk ?? 0n;
        const circuitVersion = input.circuitVersion ?? CURRENT_CIRCUIT_VERSION;

        // ── 2. Pick the path ──────────────────────────────────────────────────
        // Stealth needs BOTH halves of the recipient's address: the viewing key
        // to seal toward, and the owner key to derive a one-time owner from.
        const useStealth =
            input.viewingPublicKey !== undefined && input.recipientOwnerPk !== undefined;

        let memo: number[];

        if (useStealth) {
            // ── 3. Stealth path: a one-time owner nobody can link ─────────────
            const recipientOwnerPk = input.recipientOwnerPk!;
            const recipientIvkPacked = input.viewingPublicKey!;

            // 3a. One ephSk shared between memo encryption and stealth derivation.
            //
            // A caller-supplied one is what makes the pairwise path work: the
            // recipient predicts that ephPk and finds the note by table lookup
            // instead of one ECDH per pool hint. It is PRF-derived from a secret
            // only the two of them share, so it is indistinguishable from random
            // to everyone else — the same argument that makes selfEph safe.
            //
            // Absent an override the ephemeral must stay unpredictable: a first
            // payment has no counter, and two notes sharing an ephPk would be
            // publicly linked as coming from the same sender.
            const ephSk = input.ephSkOverride ?? randomBytes(32);

            // 3b. ECDH: the secret both sides reach from opposite directions.
            const ivkPackedBigint = bytesToBigintLE(recipientIvkPacked);
            // Rejects low-order points as well as malformed ones. A key from the
            // cofactor-8 subgroup makes `[ephSk]·ivk` take at most 8 values, so
            // the memo opens by trying them — value, blinding and sourcePk, with
            // no secret at all.
            const ivkPoint = unpackUsableViewingKey(ivkPackedBigint);
            if (!ivkPoint)
                throw new Error('NoteBuilder.build: invalid recipient viewing public key');
            const ephSkScalar = BigInt(toHex(ephSk)) % BABYJUB_SUBORDER || 1n;
            const sharedPoint = mulPointEscalar(ivkPoint, ephSkScalar);
            const sharedSecret = bigintTo32Le(sharedPoint[0]);

            // 3c. Recover the full BJJ point [Ax, Ay] from the Ax coordinate via
            // the curve equation — deriveStealthOwnerPk needs both coordinates.
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

            // 3d. Commitment commits to the STEALTH owner; the memo reuses the
            // same ephSk so the recipient can recompute the shared secret.
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
                    bigintTo32Le(sourcePk),
                    circuitVersion,
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
                circuitVersion,
                spent: false,
                spentAt: null,
                commitment,
                nullifier,
                commitmentHex: toHex(commitmentBytes),
                nullifierHex: toHex(nullifierBytes),
                memo,
                sourcePk,
            };
        }

        // ── 4. Non-stealth path: own notes (shield, change) ───────────────────
        // The commitment commits to `ownerPk` directly: there is no counterparty
        // to hide from, and the wallet has to find this note again by its own key.
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
                          bigintTo32Le(sourcePk),
                          circuitVersion,
                          input.ephSkOverride
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
            circuitVersion,
            spent: false,
            spentAt: null,
            commitment,
            nullifier,
            commitmentHex: toHex(commitmentBytes),
            nullifierHex: toHex(nullifierBytes),
            memo,
            sourcePk,
        };
    }

    /**
     * Build the 180-byte ECDH-encrypted memo for a note.
     *
     * Pure TypeScript implementation — no WASM dependency.
     * Uses ChaCha20-Poly1305 with ECDH key agreement (BabyJubJub ephemeral keypair).
     *
     * @param note                    The ZkNote whose fields populate the plaintext.
     * @param recipientIvkPacked      32-byte LE packed BJJ viewing public key of the recipient.
     *                                Pass `new Uint8Array(32)` (default) for a public/dummy memo.
     * @param sourcePk                32-byte counterparty BabyJubJub Ax.
     *                                Pass `new Uint8Array(32)` (default) for no counterparty.
     */
    static buildMemo(
        note: ZkNote,
        recipientIvkPacked?: Uint8Array,
        sourcePk?: Uint8Array
    ): Uint8Array {
        return EncryptedMemo.encrypt(
            note.value,
            bigintTo32Le(note.ownerPk),
            bigintTo32Le(note.blinding),
            Number(note.assetId),
            bigintTo32Le(note.commitment),
            recipientIvkPacked ?? new Uint8Array(32),
            sourcePk ?? bigintTo32Le(note.sourcePk ?? 0n),
            note.circuitVersion
        );
    }
}
