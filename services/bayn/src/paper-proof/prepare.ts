import { Effect } from 'effect'

import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import {
  completePaperProofReceipt,
  lift,
  reconcileExact,
  type PaperProofOperationContext,
  type PaperProofReceiptFields,
} from './operations'
import { proofBinding } from './model'
import type { PaperProofError, PaperProofReceipt, PaperProofReconciliation } from './model'
import { Pipeable } from '../pipeable'

export interface PaperProofPrepareDependencies {
  readonly prepareCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<CapitalGrantGeneration, Error>
  readonly reconcile: Effect.Effect<PaperProofReconciliation, Error>
  readonly currentUtcInstant: Effect.Effect<string, Error>
}

const runPaperProofPrepareDataFirst = (
  context: PaperProofOperationContext<'PREPARE'>,
  dependencies: PaperProofPrepareDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const reconciliation = yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
    const generation = yield* lift(
      'PREPARE',
      'paper proof generation PREPARE failed',
      dependencies.prepareCapitalGrant(proofBinding(context.command)),
    )
    const input: PaperProofReceiptFields = {
      generation,
      reconciliations: [reconciliation],
      restricted: false,
      recoveryRequired: false,
    }
    return yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, input)
  })

export const runPaperProofPrepare = Pipeable.dual(2, runPaperProofPrepareDataFirst)
