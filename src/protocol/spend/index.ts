/**
 * Circuit rules for assembling a spend.
 *
 * What the transfer circuit will and will not accept as inputs, expressed once
 * so automatic and manual selection cannot diverge — a UI that enforced only
 * half of it lets a user build a pair whose proof does not exist.
 */
export {
    selectNotes,
    buildDummyTransferInput,
    isSpendable,
    canPairWith,
    treeIdOf,
    isValidLeafIndex,
    LEAVES_PER_TREE,
} from './coinSelection';
export type { CoinSelection } from './coinSelection';
