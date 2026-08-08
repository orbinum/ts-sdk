/**
 * Bigint-safe JSON for vault payloads.
 *
 * A note is mostly bigints — value, commitment, blinding, keys — and
 * `JSON.stringify` throws on them outright. They travel as
 * `{ __bigint: "<decimal>" }` and come back as native bigints, so a note
 * survives the storage round trip with its field types intact.
 *
 * Both halves must be used together on every vault read and write. Parsing
 * without the reviver yields an object whose numeric fields are wrapper objects,
 * and the failure surfaces far from here — as `Cannot mix BigInt` during a
 * later arithmetic step.
 */

/** `JSON.stringify` replacer. Pair with `vaultReviver`. */
export function vaultReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return { __bigint: value.toString() };
    return value;
}

/** `JSON.parse` reviver. Pair with `vaultReplacer`. */
export function vaultReviver(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === 'object' && '__bigint' in (value as object)) {
        return BigInt((value as { __bigint: string }).__bigint);
    }
    return value;
}
