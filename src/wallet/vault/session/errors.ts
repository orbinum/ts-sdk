/**
 * Vault protocol errors.
 */

/** Thrown when a vault operation is attempted while the vault is locked. */
export class VaultLockedError extends Error {
    constructor(message = 'Vault is locked. Connect your wallet to unlock it.') {
        super(message);
        this.name = 'VaultLockedError';
    }
}
