import type { SubstrateClient } from '../substrate/SubstrateClient';
import { ChainModule } from './ChainModule';
import { PrivacyModule } from './PrivacyModule';

/**
 * Entry point agrupado para los namespaces tipados de `rpc-v2`.
 */
export class RpcV2Module {
    /** General chain state endpoints under `chain_*`. */
    readonly chain: ChainModule;
    /** Orbinum privacy endpoints under `privacy_*`. */
    readonly privacy: PrivacyModule;

    constructor(substrate: SubstrateClient) {
        this.chain = new ChainModule(substrate);
        this.privacy = new PrivacyModule(substrate);
    }
}
