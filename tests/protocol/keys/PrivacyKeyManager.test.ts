import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyKeyManager } from '../../../src/protocol/keys/PrivacyKeyManager';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { toHex, scalarToHex } from '../../../src/foundation/encoding/hex';
import {
    deriveSpendingKeyV3,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
} from '../../../src/protocol/keys/PrivacyKeys';
import { BABYJUB_SUBORDER } from '../../../src/foundation/crypto/constants';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Stable 32-byte master bytes fixture (deterministic, distinct from all-zeros)
const MASTER_BYTES = new Uint8Array(32).fill(0xab);

// La clave de gasto que `load` deriva de esas mismas raíces.
//
// Bajo v2 el escalar era `master % suborden` y `load` lo aceptaba del llamador;
// bajo v3 es una rama HKDF de la raíz, así que la identidad la fija el MASTER y
// el escalar que se pase se ignora. Derivarlo aquí es lo que mantiene al test
// describiendo la identidad que el wallet abre de verdad.
const TEST_SK = deriveSpendingKeyV3(MASTER_BYTES);

// Second distinct masterBytes for isolation tests
const OTHER_MASTER_BYTES = new Uint8Array(32).fill(0x12);
const OTHER_SK = deriveSpendingKeyV3(OTHER_MASTER_BYTES);

const MASTER_HEX =
    'mk:0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');

let pkm: PrivacyKeyManager;

beforeEach(() => {
    pkm = new PrivacyKeyManager();
});

// ─── load / isLoaded / clear ──────────────────────────────────────────────────

describe('pkm.load / isLoaded / clear', () => {
    it('starts unloaded', () => {
        expect(pkm.isLoaded()).toBe(false);
    });

    it('isLoaded returns true after load()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.isLoaded()).toBe(true);
    });

    it('clear() unloads the key', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        pkm.clear();
        expect(pkm.isLoaded()).toBe(false);
    });

    it('loading a second key replaces the first', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
        expect(pkm.getSpendingKey()).toBe(OTHER_SK);
        expect(pkm.getMasterBytes()).toEqual(OTHER_MASTER_BYTES);
    });
});

// ─── getSpendingKey ───────────────────────────────────────────────────────────

describe('pkm.getSpendingKey', () => {
    it('returns the spending key after load()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.getSpendingKey()).toBe(TEST_SK);
    });

    it('throws if not loaded', () => {
        expect(() => pkm.getSpendingKey()).toThrow(/no key loaded/i);
    });
});

// ─── getMasterBytes ───────────────────────────────────────────────────────────

describe('pkm.getMasterBytes', () => {
    it('returns the master bytes after load()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
    });

    it('returns a Uint8Array of exactly 32 bytes', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const mb = pkm.getMasterBytes();
        expect(mb).toBeInstanceOf(Uint8Array);
        expect(mb).toHaveLength(32);
    });

    it('throws if not loaded', () => {
        expect(() => pkm.getMasterBytes()).toThrow(/no key loaded/i);
    });

    it('is cleared by clear()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        pkm.clear();
        expect(() => pkm.getMasterBytes()).toThrow(/no key loaded/i);
    });

    it('different masterBytes are stored independently', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
        expect(pkm.getMasterBytes()).not.toEqual(OTHER_MASTER_BYTES);
    });
});

// ─── getViewingSecretKey ─────────────────────────────────────────────────────────────────────────

describe('pkm.getViewingSecretKey', () => {
    it('devuelve la rama de visión v3 del MASTER, no una cadena desde el escalar', async () => {
        // Bajo v2 la clave de visión colgaba de la de gasto. Bajo v3 son
        // hermanas de la raíz — y ésa es la propiedad que hace posible una
        // cartera watch-only.
        await pkm.load(TEST_SK, MASTER_BYTES);
        const vk = pkm.getViewingSecretKey();
        expect(vk).toBeInstanceOf(Uint8Array);
        expect(vk).toHaveLength(32);
        expect(vk).toEqual(deriveViewingSecretKeyV3(MASTER_BYTES));
    });

    it('throws if not loaded', () => {
        expect(() => pkm.getViewingSecretKey()).toThrow(/no key loaded/i);
    });
});

// ─── getOwnerPk ───────────────────────────────────────────────────────────────

describe('pkm.getOwnerPk', () => {
    it('returns a bigint equal to deriveOwnerPk(sk)', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const pk = pkm.getOwnerPk();
        expect(typeof pk).toBe('bigint');
        expect(pk).toBe(deriveOwnerPk(TEST_SK));
    });

    it('throws if not loaded', () => {
        expect(() => pkm.getOwnerPk()).toThrow(/no key loaded/i);
    });
});

// ─── getSpendingKeyBytes ──────────────────────────────────────────────────────

describe('pkm.getSpendingKeyBytes', () => {
    it('returns bigintTo32Le(spendingKey)', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const bytes = pkm.getSpendingKeyBytes();
        expect(bytes).toEqual(bigintTo32Le(TEST_SK));
    });

    it('throws if not loaded', () => {
        expect(() => pkm.getSpendingKeyBytes()).toThrow(/no key loaded/i);
    });
});

// ─── exportHex ────────────────────────────────────────────────────────────────

describe('pkm.exportHex', () => {
    it('returns a "mk:0x"-prefixed string with 64 hex digits', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const hex = pkm.exportHex();
        expect(hex).toMatch(/^mk:0x[0-9a-f]{64}$/);
    });

    it('encodes masterBytes (not spendingKey scalar) in hex', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.exportHex()).toBe(MASTER_HEX);
    });

    it('different masterBytes produce different exportHex output', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const h1 = pkm.exportHex();
        await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
        const h2 = pkm.exportHex();
        expect(h1).not.toBe(h2);
    });

    it('is deterministic for the same masterBytes', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.exportHex()).toBe(pkm.exportHex());
    });

    it('throws if not loaded', () => {
        expect(() => pkm.exportHex()).toThrow(/no key loaded/i);
    });
});

// ─── importFromHex ────────────────────────────────────────────────────────────

describe('pkm.importFromHex', () => {
    it('loads the correct spendingKey from a valid "mk:0x" string', async () => {
        await pkm.importFromHex(MASTER_HEX);
        expect(pkm.getSpendingKey()).toBe(TEST_SK);
    });

    it('loads the correct masterBytes from a valid "mk:0x" string', async () => {
        await pkm.importFromHex(MASTER_HEX);
        expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
    });

    it('accepts "mk:" without inner "0x" prefix', async () => {
        const noInnerPrefix =
            'mk:' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');
        await pkm.importFromHex(noInnerPrefix);
        expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
    });

    it('sets isLoaded() to true after import', async () => {
        await pkm.importFromHex(MASTER_HEX);
        expect(pkm.isLoaded()).toBe(true);
    });

    it('round-trips through exportHex → importFromHex', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const exported = pkm.exportHex();
        const vk = pkm.getViewingSecretKey();
        const pk = pkm.getOwnerPk();

        pkm.clear();
        await pkm.importFromHex(exported);

        expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
        expect(pkm.getSpendingKey()).toBe(TEST_SK);
        expect(pkm.getViewingSecretKey()).toEqual(vk);
        expect(pkm.getOwnerPk()).toBe(pk);
    });

    it('throws if format does not start with "mk:" (legacy plain hex rejected)', async () => {
        const plainHex =
            '0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');
        await expect(pkm.importFromHex(plainHex)).rejects.toThrow(/invalid cache format/i);
        expect(pkm.isLoaded()).toBe(false);
    });

    it('throws for empty string', async () => {
        await expect(pkm.importFromHex('')).rejects.toThrow();
        expect(pkm.isLoaded()).toBe(false);
    });

    it('throws if decoded bytes are not exactly 32 bytes (too short — 31 bytes)', async () => {
        const short = 'mk:0x' + 'ab'.repeat(31);
        await expect(pkm.importFromHex(short)).rejects.toThrow(/32 bytes/i);
    });

    it('throws if decoded bytes are not exactly 32 bytes (too long — 33 bytes)', async () => {
        const long = 'mk:0x' + 'ab'.repeat(33);
        await expect(pkm.importFromHex(long)).rejects.toThrow(/32 bytes/i);
    });

    it('RECHAZA un master de ceros', async () => {
        // No es una entrada válida por ninguna puerta: todo wallet derivaría la
        // misma identidad. `deriveIdentity` ya lo rechazaba, pero un nivel más
        // adentro — aquí se corta antes de cargar nada.
        await expect(pkm.importFromHex('mk:0x' + '00'.repeat(32))).rejects.toThrow(/zero/i);
        expect(pkm.isLoaded()).toBe(false);
    });

    it('RECHAZA hex inválido en vez de decodificarlo a ceros', async () => {
        // El fallo silencioso que esto cierra: `parseInt('zz', 16)` es NaN y
        // `Uint8Array` lo guarda como 0, así que un cache corrupto decodificaba
        // a 32 bytes de ceros — con la longitud correcta, o sea pasando la única
        // comprobación que había. El wallet se abría sobre una identidad que no
        // era la suya y que cualquiera puede derivar.
        await expect(pkm.importFromHex('mk:0x' + 'zz'.repeat(32))).rejects.toThrow();
        expect(pkm.isLoaded()).toBe(false);
    });

    it('el escalar v3 no tiene el punto muerto que tenía v2', async () => {
        // Bajo v2 el escalar era `master % suborden`, así que un master de ceros
        // daba 0 y había que sujetarlo a 1n. Bajo v3 pasa por HKDF, que no tiene
        // ese punto muerto. Se comprueba sobre la derivación directamente: la
        // propiedad es de `deriveSpendingKeyV3`, no de la puerta de importación
        // — que ahora rechaza esa entrada, y con razón.
        const sk = deriveSpendingKeyV3(new Uint8Array(32));

        expect(sk).toBeGreaterThan(0n);
    });
});

describe('pkm.getOutgoingViewingKey', () => {
    const pkm = new PrivacyKeyManager();

    it('devuelve la rama saliente del master', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);

        expect(pkm.getOutgoingViewingKey()).toEqual(deriveOutgoingViewingKeyV3(MASTER_BYTES));
    });

    it('NO coincide con la clave de visión entrante', async () => {
        // Son ramas hermanas: entregar una no entrega la otra. Confundirlas
        // daría el grafo de pagos a quien sólo debía ver importes.
        await pkm.load(TEST_SK, MASTER_BYTES);

        expect(toHex(pkm.getOutgoingViewingKey())).not.toBe(toHex(pkm.getViewingSecretKey()));
    });

    it('lanza sin identidad cargada', () => {
        expect(() => new PrivacyKeyManager().getOutgoingViewingKey()).toThrow(/no key loaded/);
    });
});

// ─── encodePrivacyAddress ─────────────────────────────────────────────────────

describe('pkm.encodePrivacyAddress', () => {
    it('throws if not loaded', () => {
        expect(() => pkm.encodePrivacyAddress()).toThrow(/no key loaded/i);
    });

    it('returns a string starting with "orbpriv3:"', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        expect(pkm.encodePrivacyAddress()).toMatch(/^orbpriv3:/);
    });

    it('has exactly 4 colon-separated parts (adds a checksum)', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const parts = pkm.encodePrivacyAddress().split(':');
        expect(parts).toHaveLength(4);
    });

    it('checksum part is 8 lowercase hex chars', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const [, , , checksum] = pkm.encodePrivacyAddress().split(':');
        expect(checksum).toMatch(/^[0-9a-f]{8}$/);
    });

    it('ownerPk part is a 0x-prefixed 64-nibble hex string', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const [, ownerPkHex] = pkm.encodePrivacyAddress().split(':');
        expect(ownerPkHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('viewingPublicKey part is a 0x-prefixed 64-nibble hex string (32 bytes)', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const [, , viewingKeyHex] = pkm.encodePrivacyAddress().split(':');
        expect(viewingKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('ownerPk hex encodes getOwnerPk()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const [, ownerPkHex] = pkm.encodePrivacyAddress().split(':');
        const decoded = BigInt(ownerPkHex!);
        expect(decoded).toBe(pkm.getOwnerPk());
    });

    it('viewingPublicKey hex encodes getViewingPublicKeyPacked()', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const [, , viewingPublicKeyHex] = pkm.encodePrivacyAddress().split(':');
        const raw = viewingPublicKeyHex!.slice(2);
        const bytes = new Uint8Array((raw.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
        expect(bytes).toEqual(pkm.getViewingPublicKeyPacked());
    });

    it('is deterministic — same key produces same address', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const a = pkm.encodePrivacyAddress();
        const b = pkm.encodePrivacyAddress();
        expect(a).toBe(b);
    });

    it('different spending keys produce different privacy addresses', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const addr1 = pkm.encodePrivacyAddress();
        await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
        const addr2 = pkm.encodePrivacyAddress();
        expect(addr1).not.toBe(addr2);
    });

    it('round-trips through decodePrivacyAddress', async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
        const addr = pkm.encodePrivacyAddress();
        const decoded = PrivacyKeyManager.decodePrivacyAddress(addr);
        expect(decoded).not.toBeNull();
        expect(BigInt(decoded!.ownerPkHex)).toBe(pkm.getOwnerPk());
        const raw = decoded!.viewingPublicKeyHex.slice(2);
        const bytes = new Uint8Array((raw.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
        expect(bytes).toEqual(pkm.getViewingPublicKeyPacked());
    });
});

// ─── decodePrivacyAddress (static) ───────────────────────────────────────────

describe('PrivacyKeyManager.decodePrivacyAddress', () => {
    it('returns null for empty string', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('')).toBeNull();
    });

    it('returns null for arbitrary string', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('hello')).toBeNull();
    });

    it('returns null for wrong prefix', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpub1:0xaabb:0xccdd')).toBeNull();
    });

    it('returns null when only prefix present (no colons)', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1')).toBeNull();
    });

    it('returns null for too few parts (only prefix + 1)', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaabb')).toBeNull();
    });

    it('returns null for too many parts (4 colons)', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaa:0xbb:0xcc')).toBeNull();
    });

    it('returns null when ownerPkHex part is empty', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1::0xbb')).toBeNull();
    });

    it('returns null when viewingPublicKeyHex part is empty', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaa:')).toBeNull();
    });

    it('returns ownerPkHex and viewingPublicKeyHex for a valid legacy orbpriv1 address', () => {
        // orbpriv1 has no checksum — still read for backwards compat.
        // Campos REALES: la vía legacy no tiene checksum, así que es la más
        // fácil de forjar — por eso valida los campos igual que las demás.
        const pk = '0x' + 'ab'.repeat(32);
        // Una ivk REAL, no bytes repetidos: `0xef…` ni siquiera es un punto de
        // la curva, y la validación ahora lo comprueba — un decodificador que
        // aceptara ese valor estaría aceptando una clave contra la que el ECDH
        // no significa nada.
        const ivk = toHex(deriveViewingPublicKey(deriveViewingSecretKey(777n)));
        const result = PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${pk}:${ivk}`);
        // Reportada como v2: predate el token de versión, y su identidad se
        // derivó con la cadena vieja.
        expect(result).toEqual({
            ownerPkHex: pk,
            viewingPublicKeyHex: ivk,
            scheme: 'orbpriv1',
        });
    });

    it('accepts a well-formed emitted address (checksum matches)', async () => {
        const pkm2 = new PrivacyKeyManager();
        await pkm2.load(TEST_SK, MASTER_BYTES);
        const addr = pkm2.encodePrivacyAddress();
        expect(addr).toMatch(/^orbpriv3:/);
        const result = PrivacyKeyManager.decodePrivacyAddress(addr);
        expect(BigInt(result!.ownerPkHex)).toBe(pkm2.getOwnerPk());
    });

    it('rejects an address with a corrupted body (checksum fails)', async () => {
        const pkm2 = new PrivacyKeyManager();
        await pkm2.load(TEST_SK, MASTER_BYTES);
        const [scheme, ownerPkHex, ivkHex, checksum] = pkm2.encodePrivacyAddress().split(':');
        // Flip one nibble of the ownerPk — checksum no longer matches.
        const flipped = ownerPkHex!.slice(0, -1) + (ownerPkHex!.at(-1) === '0' ? '1' : '0');
        const corrupted = `${scheme}:${flipped}:${ivkHex}:${checksum}`;
        expect(PrivacyKeyManager.decodePrivacyAddress(corrupted)).toBeNull();
    });

    it('rejects an orbpriv2 address with a wrong checksum', () => {
        expect(
            PrivacyKeyManager.decodePrivacyAddress('orbpriv2:0xabcd:0xef01:deadbeef')
        ).toBeNull();
    });

    it('rejects an orbpriv2 address missing the checksum part (only 3 parts)', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv2:0xabcd:0xef01')).toBeNull();
    });

    it('decoded values are exactly the parts after the prefix', async () => {
        const pkm2 = new PrivacyKeyManager();
        await pkm2.load(TEST_SK, MASTER_BYTES);
        const addr = pkm2.encodePrivacyAddress();
        const [, expectedPk, expectedVk] = addr.split(':');
        const result = PrivacyKeyManager.decodePrivacyAddress(addr);
        expect(result?.ownerPkHex).toBe(expectedPk);
        expect(result?.viewingPublicKeyHex).toBe(expectedVk);
    });
});

// ─── El esquema de la dirección ES la versión de derivación ──────────────────

describe('orbpriv3 — la dirección dice de qué esquema viene', () => {
    // Sin esto, una dirección v2 copiada antes de una migración sigue pareciendo
    // válida y el pago cae donde el wallet v3 nunca mira. Los campos son dos
    // escalares en ambos casos, así que el prefijo es el único sitio donde cabe
    // la distinción.
    const pkm = new PrivacyKeyManager();

    beforeEach(async () => {
        await pkm.load(TEST_SK, MASTER_BYTES);
    });

    it('SÓLO emite v3 — no hay otra cosa que emitir', () => {
        expect(pkm.encodePrivacyAddress()).toMatch(/^orbpriv3:/);
        expect(pkm.encodePrivacyAddress('v3')).toMatch(/^orbpriv3:/);
    });

    it('pero sigue LEYENDO los esquemas viejos', () => {
        // Leer una dirección ajena no es soportar su identidad: una dirección
        // son dos claves públicas, y pagarla funciona venga del esquema que
        // venga. Quien la comparte puede no haber actualizado todavía.
        const ownerPkHex = scalarToHex(deriveOwnerPk(TEST_SK));
        const ivkHex = toHex(deriveViewingPublicKey(deriveViewingSecretKey(TEST_SK)));

        const legacy = PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${ownerPkHex}:${ivkHex}`);

        expect(legacy?.scheme).toBe('orbpriv1');
        expect(legacy?.ownerPkHex).toBe(ownerPkHex);
    });

    it('el decodificador informa del ESQUEMA que traía la dirección', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress(pkm.encodePrivacyAddress())?.scheme).toBe(
            'orbpriv3'
        );
    });

    it('una dirección RE-ETIQUETADA no pasa el checksum', () => {
        // El esquema va DENTRO del cuerpo firmado, así que cambiar el prefijo a
        // mano rompe la suma en vez de producir una dirección creíble.
        const v3 = pkm.encodePrivacyAddress();
        const relabelled = v3.replace('orbpriv3:', 'orbpriv2:');

        expect(PrivacyKeyManager.decodePrivacyAddress(relabelled)).toBeNull();
    });

    it('un checksum corrupto sigue rechazándose en v3', () => {
        const v3 = pkm.encodePrivacyAddress();

        expect(PrivacyKeyManager.decodePrivacyAddress(v3.slice(0, -1) + '0')).toBeNull();
    });
});
