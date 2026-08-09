/**
 * Spending notes: the three operations, plus what runs before each of them.
 *
 * `plan.ts` answers "can this spend happen at all" from notes alone — pure
 * arithmetic a UI calls on every keystroke. `guards.ts` runs once a spend is
 * actually attempted, turning failures the circuit would report seconds into
 * proving into errors that name the real problem.
 *
 * The three operations own protocol, never transport: each takes a `submit`
 * callback and the host supplies the client. That is what lets one
 * implementation serve a browser, an extension and a mobile runtime.
 */
export { transferNotes } from './transfer';
export type {
    TransferDeps,
    TransferParams,
    TransferStep,
    TransferSubmitRequest,
    TransferResult,
} from './transfer';
export { unshieldNote } from './unshield';
export type {
    UnshieldDeps,
    UnshieldNoteParams,
    UnshieldStep,
    UnshieldSubmitRequest,
} from './unshield';
export { claimFees } from './feeClaim';
export type { FeeClaimDeps, FeeClaimParams, FeeClaimStep } from './feeClaim';
export { noteMatchesCommitment, treeOf, checkSpendableInputs } from './guards';
export { failed, refuseIfAlreadySpent, markInputsSpent } from './lifecycle';
export type { SpendPrivacyReads, SpendVault } from './lifecycle';
export type { SpendableInputsCheck } from './guards';
export { planTransfer, planUnshield, spendableBalance } from './plan';
export type { TransferPlan, UnshieldPlan, SpendPlanProblem } from './plan';
