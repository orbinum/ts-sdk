import type { RawRpcV2PoolAssetBalance } from './types/raw';
import type { RpcV2PoolAssetBalance } from './types';

export function mapAssetBalance(balance: RawRpcV2PoolAssetBalance): RpcV2PoolAssetBalance {
    return {
        assetId: balance.asset_id,
        balance: balance.balance.toString(),
    };
}
