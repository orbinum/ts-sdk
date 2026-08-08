/**
 * recoverSelfStealthNote — real crypto, no mocked primitives.
 *
 * This runs before a wallet persists a stealth note it authored for itself. What
 * matters is that it returns something SPENDABLE, and that it returns null
 * rather than a corrupt note when the memo does not open with the given keys.
 */
import { describe, it, expect } from 'vitest';
import { recoverSelfStealthNote } from '../../../../src/wallet/ops/notes/selfStealthNote';
import { isNoteSelfConsistent } from '../../../../src/index';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import { BABYJUB_SUBORDER } from '../../../../src/foundation/crypto/constants';
import type { ZkNote } from '../../../../src/protocol/types';
import type { SelfStealthKeys } from '../../../../src/wallet/ops/notes/selfStealthNote';

const GLOBAL_SK = BigInt('0x' + 'cd'.repeat(32)) % BABYJUB_SUBORDER || 1n;
const GLOBAL_IVSK = deriveViewingSecretKey(GLOBAL_SK);
const GLOBAL_IVK_PACKED = deriveViewingPublicKey(GLOBAL_IVSK);
const GLOBAL_OWNER_PK = deriveOwnerPk(GLOBAL_SK);

const KEYS: SelfStealthKeys = {
    viewingSecretKey: GLOBAL_IVSK,
    spendingKey: GLOBAL_SK,
    ownerPk: GLOBAL_OWNER_PK,
};

/** A stealth note addressed to our own wallet, as a partial unshield builds it. */
function buildOwnStealthNote(value: bigint): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: GLOBAL_OWNER_PK,
        spendingKey: GLOBAL_SK,
        viewingPublicKey: GLOBAL_IVK_PACKED,
        recipientOwnerPk: GLOBAL_OWNER_PK,
    });
}

describe('recoverSelfStealthNote', () => {
    it('returns a spendable note from the memo the wallet wrote', async () => {
        const built = await buildOwnStealthNote(4_200n);

        const recovered = recoverSelfStealthNote(built, KEYS);

        expect(recovered).not.toBeNull();
        expect(isNoteSelfConsistent(recovered!)).toBe(true);
        expect(recovered!.value).toBe(4_200n);
        expect(recovered!.commitmentHex).toBe(built.commitmentHex);
    });

    it('keeps the commitment and fixes the spending key', async () => {
        // The commitment is what sits on chain; recovery cannot move it. The
        // spending key is precisely what was wrong in the built note.
        const built = await buildOwnStealthNote(1n);

        const recovered = recoverSelfStealthNote(built, KEYS)!;

        expect(recovered.commitmentHex).toBe(built.commitmentHex);
        expect(recovered.ownerPk).toBe(built.ownerPk);
        expect(recovered.spendingKey).not.toBe(built.spendingKey);
    });

    it('returns null when the memo belongs to another wallet', async () => {
        const built = await buildOwnStealthNote(500n);
        const otherSk = (GLOBAL_SK + 999n) % BABYJUB_SUBORDER || 1n;

        const recovered = recoverSelfStealthNote(built, {
            viewingSecretKey: deriveViewingSecretKey(otherSk),
            spendingKey: otherSk,
            ownerPk: deriveOwnerPk(otherSk),
        });

        expect(recovered).toBeNull();
    });

    it('discards a zero-value note', async () => {
        // The change output of an exact-amount spend. The circuit treats a
        // value-0 input as a dummy and forces its nullifier to 0, so it is
        // unspendable and must never reach the vault.
        const built = await buildOwnStealthNote(0n);

        expect(recoverSelfStealthNote(built, KEYS)).toBeNull();
    });
});
