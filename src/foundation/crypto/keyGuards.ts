/**
 * Guards for SECRET key material.
 *
 * `unpackUsableViewingKey` covers the public side — a point someone else chose,
 * where the risk is a low-order key that collapses the ECDH. This covers the
 * other side: the 32-byte secrets a caller passes in, where the risk is that
 * nothing checks them at all.
 *
 * ## Why a degenerate secret is not merely weak
 *
 * `bytesToBjjScalar` reduces whatever it gets modulo the suborder and clamps a
 * zero result to `1n`. So an all-zero key, or a 16-byte one, does not fail —
 * it becomes a VALID scalar that some other wallet could also arrive at. An
 * empty array is worse: `BigInt('0x')` throws, which surfaces as an exception
 * from whichever primitive happened to touch it first.
 *
 * The same shapes are what a missing field, a truncated buffer, or an
 * uninitialised `new Uint8Array(32)` decode to, so this is the failure a
 * mis-wired caller actually hits.
 *
 * ## Why these THROW
 *
 * A bad secret key is a programming error, not untrusted input. Returning null
 * would fold it into "this note is not mine" / "this slip is not for me", which
 * is indistinguishable from the ordinary case — the wallet would report an
 * empty scan and look perfectly healthy.
 *
 * Data from the network is the opposite and must NOT use this: a malformed
 * backup entry or scan hint is dropped, never thrown, so one bad record cannot
 * take down the batch. `isUsableSecretKey` exists for the paths that have to
 * make that decision without unwinding.
 */

/** Every secret in this protocol is a 32-byte value. */
const SECRET_KEY_SIZE = 32;

/**
 * True when `key` can be used as secret key material.
 *
 * For callers that must not throw — a scan loop, a window builder — where the
 * answer is "turn this capability off", not "abort".
 */
export function isUsableSecretKey(key: Uint8Array | undefined | null): key is Uint8Array {
    return (
        key !== undefined &&
        key !== null &&
        key.length === SECRET_KEY_SIZE &&
        !key.every((b) => b === 0)
    );
}

/**
 * Throws unless `key` is usable secret key material.
 *
 * @param key   the secret to check
 * @param label what it is, named in the error — a caller that wired two keys
 *              the wrong way round needs to know WHICH one is wrong, and every
 *              secret here is 32 opaque bytes that look alike in a debugger.
 */
export function assertSecretKeyBytes(key: Uint8Array, label: string): void {
    if (key.length !== SECRET_KEY_SIZE) {
        throw new Error(`${label} must be ${SECRET_KEY_SIZE} bytes, got ${key.length}`);
    }
    if (key.every((b) => b === 0)) {
        throw new Error(`${label} is all zeros — that is not key material`);
    }
}
