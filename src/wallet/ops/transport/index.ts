/**
 * The seam between an operation and whatever submits it.
 *
 * Marshalling arguments into the shapes an extrinsic expects, reading the
 * circuit version the chain will accept, and recovering when the connection
 * dies mid-submit. None of it owns a client — a host still supplies transport.
 */
export { buildShieldParams, buildShieldBatchOperations } from './shieldParams';
export { chainActiveCircuitVersion } from './circuitVersion';
export {
    txLandedAfterError,
    isConnectionLossError,
    recoveredTxResult,
    RECOVERED_TX_RESULT,
} from './txRecovery';
export type { TxLandingPollOptions } from './txRecovery';
