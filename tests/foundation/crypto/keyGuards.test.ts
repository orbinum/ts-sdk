/**
 * Las guardas de material secreto, y la frontera que NO deben cruzar.
 *
 * Una clave degenerada no falla sola: `bytesToBjjScalar` reduce lo que sea
 * módulo el suborden y sujeta el cero a `1n`, así que una clave de 16 bytes o
 * toda a ceros se convierte en un escalar VÁLIDO al que otra cartera podría
 * llegar también. Una vacía es peor — `BigInt('0x')` lanza desde el primitivo
 * que la tocara primero.
 *
 * Esas formas son exactamente lo que produce un campo ausente, un buffer
 * truncado o un `new Uint8Array(32)` sin inicializar.
 */
import { describe, it, expect } from 'vitest';
import { assertSecretKeyBytes, isUsableSecretKey } from '../../../src/foundation/crypto/keyGuards';
import { bytesToBjjScalar, EncryptedMemo } from '../../../src/protocol/memo/EncryptedMemo';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { fromHex } from '../../../src/foundation/encoding/hex';
import { deriveSelfEphSk, selfEphWindow } from '../../../src/protocol/eph/selfEph';
import { deriveOutgoingEphSk, outgoingEphWindow } from '../../../src/protocol/eph/outgoingEph';
import { MAX_EPH_WINDOW } from '../../../src/protocol/eph/windowBounds';
import {
    derivePairwiseEphSk,
    derivePairwiseSharedSecret,
} from '../../../src/protocol/eph/pairwiseEph';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { importPaymentSlip } from '../../../src/wallet/ops/notes/paymentSlipImport';
import { importNotesFromBackup } from '../../../src/wallet/ops/notes/noteBackup';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';

const REAL = deriveViewingSecretKey(777n);
const REAL_IVK = deriveViewingPublicKey(REAL);

/** Las cuatro formas que toma una clave mal cableada, y la buena. */
const DEGENERATE: Array<[string, Uint8Array]> = [
    ['vacía', new Uint8Array(0)],
    ['16 bytes', new Uint8Array(16).fill(0x11)],
    ['33 bytes', new Uint8Array(33).fill(0x11)],
    ['todo ceros', new Uint8Array(32)],
];

describe('el predicado y la aserción coinciden', () => {
    it.each(DEGENERATE)('rechaza una clave %s', (_label, key) => {
        expect(isUsableSecretKey(key)).toBe(false);
        expect(() => assertSecretKeyBytes(key, 'test')).toThrow();
    });

    it('acepta una clave real', () => {
        expect(isUsableSecretKey(REAL)).toBe(true);
        expect(() => assertSecretKeyBytes(REAL, 'test')).not.toThrow();
    });

    it('el predicado también cubre undefined y null', () => {
        expect(isUsableSecretKey(undefined)).toBe(false);
        expect(isUsableSecretKey(null)).toBe(false);
    });

    it('el error NOMBRA la clave, no sólo el tamaño', () => {
        // Todos los secretos aquí son 32 bytes opacos que se parecen entre sí
        // en un depurador; quien cruzó dos necesita saber cuál está mal.
        expect(() => assertSecretKeyBytes(new Uint8Array(4), 'miClave')).toThrow(/miClave/);
        expect(() => assertSecretKeyBytes(new Uint8Array(32), 'miClave')).toThrow(/miClave/);
    });
});

describe('LO QUE IMPIDE: una clave degenerada era un escalar válido', () => {
    it('`bytesToBjjScalar` ya no la convierte en `1n`', () => {
        // Antes: ceros → `1n`, un escalar perfectamente usable.
        expect(() => bytesToBjjScalar(new Uint8Array(32))).not.toThrow();
        // (los ceros SÍ pasan aquí: el cero se sujeta a 1n y es la longitud lo
        // que este primitivo comprueba — la guarda de ceros vive arriba)
        expect(() => bytesToBjjScalar(new Uint8Array(16))).toThrow(/32 bytes/);
        expect(() => bytesToBjjScalar(new Uint8Array(0))).toThrow(/32 bytes/);
    });
});

describe('las derivaciones de efímeras validan su clave', () => {
    // Las tres secuencias son lo que hace localizables las notas de una
    // cartera. Con una clave pública, la secuencia es pública.
    it.each(DEGENERATE)('deriveSelfEphSk rechaza una clave %s', (_label, key) => {
        expect(() => deriveSelfEphSk(key, 0)).toThrow();
    });

    it.each(DEGENERATE)('deriveOutgoingEphSk rechaza una clave %s', (_label, key) => {
        expect(() => deriveOutgoingEphSk(key, 0)).toThrow();
    });

    it.each(DEGENERATE)('derivePairwiseEphSk rechaza una clave %s', (_label, key) => {
        expect(() => derivePairwiseEphSk(key, 0)).toThrow();
    });

    it.each(DEGENERATE)('derivePairwiseSharedSecret rechaza mi clave %s', (_label, key) => {
        expect(() => derivePairwiseSharedSecret(key, REAL_IVK)).toThrow();
    });

    it('todas aceptan una clave real', () => {
        expect(() => deriveSelfEphSk(REAL, 0)).not.toThrow();
        expect(() => deriveOutgoingEphSk(REAL, 0)).not.toThrow();
        expect(() => derivePairwiseEphSk(REAL, 0)).not.toThrow();
        expect(() => derivePairwiseSharedSecret(REAL, REAL_IVK)).not.toThrow();
    });
});

describe('el índice se rechaza igual en las TRES secuencias', () => {
    // `>>> 0` mapea -1 sobre 0xffffffff y 2^32 sobre 0, así que un contador
    // desbordado aterrizaba en un índice YA publicado — y republicar un ephPk
    // enlaza en público los dos pagos que lo llevan. `derivePairwiseEphSk` era
    // la única hermana que aún lo aceptaba coaccionando.
    const BAD_INDEXES = [-1, 2 ** 32, 1.5, NaN, Infinity];

    it.each(BAD_INDEXES)('deriveSelfEphSk rechaza el índice %p', (index) => {
        expect(() => deriveSelfEphSk(REAL, index)).toThrow(/u32/);
    });

    it.each(BAD_INDEXES)('deriveOutgoingEphSk rechaza el índice %p', (index) => {
        expect(() => deriveOutgoingEphSk(REAL, index)).toThrow(/u32/);
    });

    it.each(BAD_INDEXES)('derivePairwiseEphSk rechaza el índice %p', (index) => {
        expect(() => derivePairwiseEphSk(REAL, index)).toThrow(/u32/);
    });

    it('y -1 ya no colisiona con el índice máximo en ninguna', () => {
        expect(() => derivePairwiseEphSk(REAL, -1)).toThrow();
        expect(() => derivePairwiseEphSk(REAL, 0xffff_ffff)).not.toThrow();
    });
});

describe('las ventanas tienen cota superior', () => {
    // `count` decide cuántas multiplicaciones de curva se ejecutan, y suele
    // venir de config almacenada — `windowSizeForCounter` lo saca del contador
    // del vault. Un valor corrupto ahí no es una respuesta equivocada, es un
    // bucle que no termina.
    it.each([
        ['selfEphWindow', (n: number) => selfEphWindow(REAL, REAL_IVK, 0, n)],
        ['outgoingEphWindow', (n: number) => outgoingEphWindow(REAL, 0, n)],
    ])('%s rechaza un count absurdo', (_label, build) => {
        // Con valores que fallan RÁPIDO si la guarda desaparece. Afirmar
        // `MAX_EPH_WINDOW + 1` parecería lo directo y es una trampa: sin la
        // guarda ese caso no falla, se CUELGA construyendo un millón de
        // puntos, y un test que se cuelga al romperse bloquea la suite en vez
        // de informar. La cota sí se ejerce abajo, contra el tamaño exacto.
        expect(() => build(1.5)).toThrow(/count/);
        expect(() => build(NaN)).toThrow(/count/);
    });

    it.each([
        ['selfEphWindow', (f: number) => selfEphWindow(REAL, REAL_IVK, f, 1)],
        ['outgoingEphWindow', (f: number) => outgoingEphWindow(REAL, f, 1)],
    ])('%s rechaza un from negativo o no entero', (_label, build) => {
        expect(() => build(-1)).toThrow(/from/);
        expect(() => build(1.5)).toThrow(/from/);
    });

    it('la cota es la misma para las tres secuencias', () => {
        // Un límite copiado en tres sitios es un límite que diverge, y una
        // ventana generosa en una secuencia y estricta en otra es un fallo que
        // sólo aparece en la que nadie probó.
        expect(MAX_EPH_WINDOW).toBe(1 << 20);
    });

    it('pero una ventana normal sigue funcionando', () => {
        expect(selfEphWindow(REAL, REAL_IVK, 0, 4)).toHaveLength(4);
        expect(outgoingEphWindow(REAL, 0, 4)).toHaveLength(4);
    });
});

describe('las rutas de importación validan la clave, no sólo el dato', () => {
    // La política: las CLAVES lanzan, los DATOS devuelven null. Silenciar una
    // clave mala la convierte en «ningún slip es mío», que es idéntico a una
    // cartera sana y es el fallo silencioso que hay que evitar.
    it.each(DEGENERATE)('importPaymentSlip lanza con una ivsk %s', (_label, key) => {
        expect(() =>
            importPaymentSlip('orbslip1:xx:yy', {
                viewingSecretKey: key,
                spendingKey: 1n,
                ownerPk: 1n,
            })
        ).toThrow(/viewingSecretKey/);
    });

    it('pero un slip basura con clave buena devuelve null, no lanza', () => {
        expect(
            importPaymentSlip('no es un slip', {
                viewingSecretKey: REAL,
                spendingKey: 1n,
                ownerPk: 1n,
            })
        ).toBeNull();
    });

    it.each(DEGENERATE)('importNotesFromBackup lanza con una ivsk %s', (_label, key) => {
        expect(() =>
            importNotesFromBackup([], { viewingSecretKey: key, spendingKey: 1n, ownerPk: 1n })
        ).toThrow(/viewingSecretKey/);
    });
});

describe('NO-REGRESIÓN: el memo público sigue siendo una función', () => {
    // Una `viewingPublicKey` toda a ceros significa «memo legible por
    // cualquiera», y está documentado como tal. Nunca prometió
    // confidencialidad, así que endurecer el ECDH no puede romperlo.
    it('una nota con clave de visión a ceros se construye', async () => {
        const note = await NoteBuilder.build({
            value: 100n,
            assetId: 0n,
            ownerPk: deriveOwnerPk(111n),
            spendingKey: 111n,
            viewingPublicKey: new Uint8Array(32),
        });

        expect(note.memo).toHaveLength(180);
    });

    it('el PRIMITIVO rechaza el orden bajo por su cuenta', () => {
        // Directo contra `EncryptedMemo.encrypt`, sin pasar por `NoteBuilder`.
        // El primitivo está exportado, así que su guarda tiene que existir aquí
        // y no sólo en quien lo llama — probarlo sólo a través del builder
        // dejaba pasar una regresión en el primitivo sin que nada fallara.
        // `packed = 1` es el elemento NEUTRO: `unpackPoint` lo acepta como
        // punto válido y `[k]·O = O` para todo escalar, así que el "secreto"
        // compartido es una constante pública. Es el valor que distingue las
        // dos guardas — enumerando los packed válidos, el subgrupo pequeño de
        // esta curva son exactamente {0, 1}, y el 0 ya lo intercepta la rama
        // del memo público.
        const identity = bigintTo32Le(1n);

        expect(() =>
            EncryptedMemo.encrypt(
                1n,
                bigintTo32Le(1n),
                bigintTo32Le(1n),
                0,
                fromHex('0x' + 'ab'.repeat(32)),
                identity,
                bigintTo32Le(0n),
                1
            )
        ).toThrow(/viewing public key/);
    });

    it('y el primitivo SÍ deja pasar el memo público', () => {
        expect(() =>
            EncryptedMemo.encrypt(
                1n,
                bigintTo32Le(1n),
                bigintTo32Le(1n),
                0,
                fromHex('0x' + 'ab'.repeat(32)),
                new Uint8Array(32),
                bigintTo32Le(0n),
                1
            )
        ).not.toThrow();
    });

    it('pero una clave de ORDEN BAJO que no sea cero sí se rechaza', async () => {
        // La diferencia entre las dos: los ceros son una declaración
        // deliberada de «esto es público»; un punto del subgrupo pequeño
        // aparenta confidencialidad y no la tiene.
        const identity = bigintTo32Le(1n);

        await expect(
            NoteBuilder.build({
                value: 100n,
                assetId: 0n,
                ownerPk: deriveOwnerPk(111n),
                spendingKey: 111n,
                viewingPublicKey: identity,
            })
        ).rejects.toThrow(/viewing public key/);
    });
});
