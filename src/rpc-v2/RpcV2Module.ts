import type { SubstrateClient } from '../substrate/SubstrateClient';
import { PrivacyModule } from './PrivacyModule';

/**
 * Entry point agrupado para los namespaces tipados de `rpc-v2`.
 */
export class RpcV2Module {
    /** Orbinum privacy endpoints under `privacy_*`. */
    readonly privacy: PrivacyModule;

    constructor(substrate: SubstrateClient) {
        this.privacy = new PrivacyModule(substrate);
    }
}
