/**
 * Vault cryptography: key derivation and the encrypted envelope.
 *
 * The bottom layer — depends on nothing else in `vault/`, and every layer above
 * reaches storage through it.
 */
export { deriveVaultKey, deriveVaultBlindKey, blindTag, encryptJson, decryptJson } from './keys';
export { vaultReplacer, vaultReviver } from './json';
