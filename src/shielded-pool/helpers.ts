import { sha256 } from '@noble/hashes/sha2.js';

const KEY_DOMAIN = new TextEncoder().encode('orbinum-note-encryption-v1');
const MEMO_PLAINTEXT_SIZE = 76;

export function serializeMemo(
    value: bigint,
    ownerPk: Uint8Array,
    blinding: Uint8Array,
    assetId: number
): Uint8Array {
    const buf = new Uint8Array(MEMO_PLAINTEXT_SIZE);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
    buf.set(ownerPk.slice(0, 32), 8);
    buf.set(blinding.slice(0, 32), 40);
    view.setUint32(72, assetId >>> 0, true);
    return buf;
}

export function deriveEncryptionKey(viewingKey: Uint8Array, commitment: Uint8Array): Uint8Array {
    const h = sha256.create();
    h.update(viewingKey);
    h.update(commitment);
    h.update(KEY_DOMAIN);
    return h.digest();
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str);
}

export function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
