import type { SubstrateClient } from '../substrate/SubstrateClient';

/**
 * Typed client for general chain state queries under the `chain_*` namespace.
 */
export class ChainModule {
    constructor(private readonly substrate: SubstrateClient) {}

    /**
     * Returns `true` if the given SS58 account is an active Aura validator.
     *
     * Reads `pallet_aura::Authorities` directly from storage at the best known block.
     */
    async isValidator(ss58Address: string): Promise<boolean> {
        return this.substrate.request<boolean>('chain_isValidator', [ss58Address]);
    }
}
