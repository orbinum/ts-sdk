/**
 * stealth-integration.test.ts
 *
 * Fase 2 — Tests de integración end-to-end del esquema stealth.
 *
 * Estos tests usan criptografía real (sin mocks) para verificar que el flujo
 * completo shield → stealth → scan → nota recuperable funciona correctamente.
 *
 * Invariante central:
 *   BJJ(stealthSk).x == stealthOwnerPk
 *
 * El circuito ZK valida exactamente esta relación, por lo que su satisfacción
 * garantiza compatibilidad sin cambios en el circuito.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import { poseidon2 } from 'poseidon-lite';
import { NoteBuilder } from '../../src/shielded-pool/protocol/NoteBuilder';
import {
  tryDecryptNote,
  tryDecryptNoteVerbose,
} from '../../src/shielded-pool/protocol/NoteDecryptor';
import {
  deriveViewingSecretKey,
  deriveViewingPublicKey,
  deriveOwnerPk,
} from '../../src/privacy-keys/PrivacyKeys';
import { toHex } from '../../src/utils/hex';
import type { ScanCommitment } from '../../src/shielded-pool/protocol/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Llaves deterministas para Alice (sender) y Bob (recipient).
// Los valores son arbitrarios pero estables entre ejecuciones del test.

const ALICE_SK = 111_222_333_444_555_666_777n;
const BOB_SK = 999_888_777_666_555_444_333n;

let alice: {
  sk: bigint;
  ownerPk: bigint;
  ivsk: Uint8Array;
  ivk: Uint8Array;
};

let bob: {
  sk: bigint;
  ownerPk: bigint;
  ivsk: Uint8Array;
  ivk: Uint8Array;
};

beforeAll(async () => {
  const aliceIvsk = deriveViewingSecretKey(ALICE_SK);
  alice = {
    sk: ALICE_SK,
    ownerPk: deriveOwnerPk(ALICE_SK),
    ivsk: aliceIvsk,
    ivk: deriveViewingPublicKey(aliceIvsk),
  };

  const bobIvsk = deriveViewingSecretKey(BOB_SK);
  bob = {
    sk: BOB_SK,
    ownerPk: deriveOwnerPk(BOB_SK),
    ivsk: bobIvsk,
    ivk: deriveViewingPublicKey(bobIvsk),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Construye un ScanCommitment a partir de un ZkNote (simula lo que devuelve el indexer). */
function toScanCommitment(note: Awaited<ReturnType<typeof NoteBuilder.build>>, leafIndex = 0): ScanCommitment {
  return {
    commitmentHex: note.commitmentHex,
    leafIndex,
    encryptedMemo: toHex(new Uint8Array(note.memo)),
  };
}

// ─── 2.1 — Shield stealth propio → rescan → nota recuperable ─────────────────

describe('2.1 — shield stealth propio: Alice shield para sí misma con stealth', () => {
  it('Alice puede recuperar su propia nota vía tryDecryptNote con ownOwnerPk', async () => {
    const note = await NoteBuilder.build({
      value: 5_000_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 42n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);

    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(5_000_000n);
    expect(recovered!.blinding).toBe(42n);
    expect(recovered!.assetId).toBe(0n);
  });

  it('el commitment on-chain usa stealthOwnerPk, no el ownerPk global de Alice', async () => {
    const note = await NoteBuilder.build({
      value: 1_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 1n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    // El stealthOwnerPk en el commitment DEBE diferir del ownerPk global
    expect(note.ownerPk).not.toBe(alice.ownerPk);
  });

  it('el nullifier recuperado se puede calcular correctamente (nota gastable)', async () => {
    const note = await NoteBuilder.build({
      value: 2_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 7n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);

    expect(recovered).not.toBeNull();
    // El nullifier usa stealthSk (no alice.sk), ya que el commitment emplea stealthOwnerPk.
    // NoteDecryptor computa: nullifier = Poseidon2(commitment, stealthSk).
    const expectedNullifier = poseidon2([recovered!.commitment, recovered!.spendingKey]);
    expect(recovered!.nullifier).toBe(expectedNullifier);
    expect(recovered!.nullifierHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('invariante BJJ: BJJ(stealthSk).x == stealthOwnerPk', async () => {
    const note = await NoteBuilder.build({
      value: 3_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 13n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);
    expect(recovered).not.toBeNull();

    // El stealthSk recuperado debe producir el stealthOwnerPk vía BJJ
    const derivedPk = mulPointEscalar(Base8, recovered!.spendingKey)[0];
    expect(derivedPk).toBe(note.ownerPk); // stealthOwnerPk
  });
});

// ─── 2.2 — Private transfer stealth → rescan destinatario → nota recuperable ─

describe('2.2 — private transfer stealth: Alice envía a Bob', () => {
  it('Bob puede recuperar la nota con su ivsk y ownOwnerPk', async () => {
    const note = await NoteBuilder.build({
      value: 10_000_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 99n,
      spendingKey: alice.sk, // Alice firma (gasta) pero la nota es de Bob
      viewingPublicKey: bob.ivk,
      recipientOwnerPk: bob.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, bob.ivsk, bob.sk, bob.ownerPk);

    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(10_000_000n);
    expect(recovered!.assetId).toBe(0n);
  });

  it('Alice no puede recuperar la nota de Bob (viewing key incorrecta)', async () => {
    const note = await NoteBuilder.build({
      value: 10_000_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 99n,
      spendingKey: alice.sk,
      viewingPublicKey: bob.ivk,
      recipientOwnerPk: bob.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);
    expect(recovered).toBeNull();
  });

  it('invariante BJJ: BJJ(stealthSk_bob).x == stealthOwnerPk on-chain', async () => {
    const note = await NoteBuilder.build({
      value: 500n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 11n,
      spendingKey: 0n, // spendingKey no relevante para este assert
      viewingPublicKey: bob.ivk,
      recipientOwnerPk: bob.ownerPk,
    });

    const scan = toScanCommitment(note);
    const recovered = tryDecryptNote(scan, bob.ivsk, bob.sk, bob.ownerPk);
    expect(recovered).not.toBeNull();

    const derivedPk = mulPointEscalar(Base8, recovered!.spendingKey)[0];
    expect(derivedPk).toBe(note.ownerPk); // stealthOwnerPk
  });
});

// ─── 2.3 — Unlinkabilidad: 3 notas al mismo destinatario → 3 ownerPk distintos

describe('2.3 — unlinkabilidad: 3 recepciones al mismo destinatario producen ownerPk on-chain distintos', () => {
  it('tres notas enviadas a Bob tienen stealthOwnerPk distintos', async () => {
    const build = (blinding: bigint) =>
      NoteBuilder.build({
        value: 1_000n,
        assetId: 0n,
        ownerPk: bob.ownerPk,
        blinding,
        spendingKey: 0n,
        viewingPublicKey: bob.ivk,
        recipientOwnerPk: bob.ownerPk,
      });

    const [n1, n2, n3] = await Promise.all([build(1n), build(2n), build(3n)]);

    // Todos los ownerPk on-chain son distintos entre sí
    expect(n1.ownerPk).not.toBe(n2.ownerPk);
    expect(n2.ownerPk).not.toBe(n3.ownerPk);
    expect(n1.ownerPk).not.toBe(n3.ownerPk);

    // Y distintos del ownerPk global de Bob
    expect(n1.ownerPk).not.toBe(bob.ownerPk);
    expect(n2.ownerPk).not.toBe(bob.ownerPk);
    expect(n3.ownerPk).not.toBe(bob.ownerPk);
  });

  it('Bob puede recuperar las tres notas', async () => {
    const build = (value: bigint, blinding: bigint) =>
      NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: bob.ownerPk,
        blinding,
        spendingKey: 0n,
        viewingPublicKey: bob.ivk,
        recipientOwnerPk: bob.ownerPk,
      });

    const [n1, n2, n3] = await Promise.all([
      build(100n, 1n),
      build(200n, 2n),
      build(300n, 3n),
    ]);

    const recovered1 = tryDecryptNote(toScanCommitment(n1), bob.ivsk, bob.sk, bob.ownerPk);
    const recovered2 = tryDecryptNote(toScanCommitment(n2), bob.ivsk, bob.sk, bob.ownerPk);
    const recovered3 = tryDecryptNote(toScanCommitment(n3), bob.ivsk, bob.sk, bob.ownerPk);

    expect(recovered1).not.toBeNull();
    expect(recovered2).not.toBeNull();
    expect(recovered3).not.toBeNull();

    expect(recovered1!.value).toBe(100n);
    expect(recovered2!.value).toBe(200n);
    expect(recovered3!.value).toBe(300n);
  });
});

// ─── 2.4 — Change note de transfer: ownerPk on-chain ≠ ownerPk global del sender

describe('2.4 — change note de private transfer: stealthOwnerPk ≠ ownerPk global de Alice', () => {
  it('la change note usa un ownerPk efímero, no el ownerPk global de Alice', async () => {
    const changeNote = await NoteBuilder.build({
      value: 4_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 55n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    expect(changeNote.ownerPk).not.toBe(alice.ownerPk);
  });

  it('Alice recupera la change note con su ivsk + ownOwnerPk', async () => {
    const changeNote = await NoteBuilder.build({
      value: 4_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 55n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(changeNote);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);

    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(4_000n);
  });

  it('la change note y la nota al destinatario tienen ownerPk on-chain distintos', async () => {
    // Simula el flujo transfer: nota al recipient + change note
    const [recipientNote, changeNote] = await Promise.all([
      NoteBuilder.build({
        value: 6_000n,
        assetId: 0n,
        ownerPk: bob.ownerPk,
        blinding: 77n,
        spendingKey: 0n,
        viewingPublicKey: bob.ivk,
        recipientOwnerPk: bob.ownerPk,
      }),
      NoteBuilder.build({
        value: 4_000n,
        assetId: 0n,
        ownerPk: alice.ownerPk,
        blinding: 88n,
        spendingKey: alice.sk,
        viewingPublicKey: alice.ivk,
        recipientOwnerPk: alice.ownerPk,
      }),
    ]);

    expect(recipientNote.ownerPk).not.toBe(changeNote.ownerPk);
  });
});

// ─── 2.5 — Change note de unshield parcial → scan → recuperable + gastable ───

describe('2.5 — change note de unshield parcial: scan → nota recuperable + stealthSk válido', () => {
  it('Alice recupera la change note de un unshield parcial', async () => {
    const changeNote = await NoteBuilder.build({
      value: 8_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 33n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(changeNote);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);

    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(8_000n);
    expect(recovered!.assetId).toBe(0n);
    expect(recovered!.blinding).toBe(33n);
  });

  it('el nullifier de la change note es calculable (nota gastable)', async () => {
    const changeNote = await NoteBuilder.build({
      value: 8_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 33n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(changeNote);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);
    expect(recovered).not.toBeNull();

    // El commitment usa stealthOwnerPk → el nullifier usa stealthSk (no alice.sk).
    // NoteBuilder almacena el nullifier con el spendingKey original, pero el circuito
    // ZK requiere Poseidon2(commitment, stealthSk). NoteDecryptor computa el correcto.
    const expectedNullifier = poseidon2([recovered!.commitment, recovered!.spendingKey]);
    expect(recovered!.nullifier).toBe(expectedNullifier);
    expect(recovered!.nullifierHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('invariante BJJ: BJJ(stealthSk).x == stealthOwnerPk de la change note', async () => {
    const changeNote = await NoteBuilder.build({
      value: 5_000n,
      assetId: 0n,
      ownerPk: alice.ownerPk,
      blinding: 21n,
      spendingKey: alice.sk,
      viewingPublicKey: alice.ivk,
      recipientOwnerPk: alice.ownerPk,
    });

    const scan = toScanCommitment(changeNote);
    const recovered = tryDecryptNote(scan, alice.ivsk, alice.sk, alice.ownerPk);
    expect(recovered).not.toBeNull();

    const derivedPk = mulPointEscalar(Base8, recovered!.spendingKey)[0];
    expect(derivedPk).toBe(changeNote.ownerPk);
  });
});

// ─── 2.6 — Degradación graciosa sin stealth ───────────────────────────────────

describe('2.6 — regression: transfer sin viewingPublicKey → nota recuperable sin stealth', () => {
  it('nota construida sin viewingPublicKey ni recipientOwnerPk usa ownerPk global', async () => {
    const note = await NoteBuilder.build({
      value: 7_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 66n,
      spendingKey: bob.sk,
      // Sin viewingPublicKey ni recipientOwnerPk → no hay stealth
    });

    // ownerPk en el commitment = ownerPk global (sin tweak)
    expect(note.ownerPk).toBe(bob.ownerPk);
  });

  it('nota sin stealth no puede ser descifrada por tryDecryptNote (memo dummy)', async () => {
    const note = await NoteBuilder.build({
      value: 7_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 66n,
      spendingKey: bob.sk,
      // Sin viewingPublicKey → EncryptedMemo.dummy()
    });

    const scan = toScanCommitment(note);
    const result = tryDecryptNoteVerbose(scan, bob.ivsk, bob.sk, bob.ownerPk);

    // El memo dummy no puede ser descifrado con ninguna ivsk real
    expect(result.note).toBeNull();
  });

  it('nota con viewingPublicKey pero sin recipientOwnerPk (no-stealth con memo cifrado) es recuperable', async () => {
    const note = await NoteBuilder.build({
      value: 9_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 44n,
      spendingKey: bob.sk,
      viewingPublicKey: bob.ivk,
      // Sin recipientOwnerPk → no hay stealth aunque hay memo cifrado
    });

    // ownerPk en el commitment = ownerPk global (sin tweak)
    expect(note.ownerPk).toBe(bob.ownerPk);

    const scan = toScanCommitment(note);
    // Con ownOwnerPk=0n (sin detección stealth), tryDecryptNote funciona normalmente
    const recovered = tryDecryptNote(scan, bob.ivsk, bob.sk, 0n);
    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(9_000n);
  });

  it('degradación graciosa: nota no-stealth también es recuperable con ownOwnerPk real', async () => {
    const note = await NoteBuilder.build({
      value: 9_000n,
      assetId: 0n,
      ownerPk: bob.ownerPk,
      blinding: 44n,
      spendingKey: bob.sk,
      viewingPublicKey: bob.ivk,
    });

    const scan = toScanCommitment(note);
    // Con ownOwnerPk=bob.ownerPk: plaintext.ownerPk == ownOwnerPk → no se activa la rama stealth
    const recovered = tryDecryptNote(scan, bob.ivsk, bob.sk, bob.ownerPk);
    expect(recovered).not.toBeNull();
    expect(recovered!.value).toBe(9_000n);
    // El nullifier se calcula con el spendingKey original (no stealth)
    expect(recovered!.nullifierHex).toBe(note.nullifierHex);
  });
});
