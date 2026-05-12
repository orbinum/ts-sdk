/**
 * VaultJson
 *
 * BigInt-safe JSON helpers for Orbinum vault payloads.
 *
 * BigInt values are serialised as `{ __bigint: "<decimal string>" }` so that
 * `JSON.stringify` never receives a native bigint (which it cannot handle).
 * Use `vaultReplacer` / `vaultReviver` for every vault read/write operation.
 */

// ─── Replacer ─────────────────────────────────────────────────────────────────

/**
 * `JSON.stringify` replacer that serialises bigint values as
 * `{ __bigint: "<decimal string>" }` (JSON-safe).
 */
export function vaultReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return { __bigint: value.toString() };
    return value;
}

// ─── Reviver ──────────────────────────────────────────────────────────────────

/**
 * `JSON.parse` reviver that deserialises `{ __bigint: "<decimal string>" }`
 * back into native bigint values.
 */
export function vaultReviver(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === 'object' && '__bigint' in (value as object)) {
        return BigInt((value as { __bigint: string }).__bigint);
    }
    return value;
}
