import { pipe, Result } from 'effect'

import {
  freezePublicIssues,
  freezePublicProof,
  type MarkedEquityReconciliationInput,
  type SimulationReconciliationResult,
} from './model'
import { reconstructMarkedEquity } from './reconstruction'
import { prepareReconciliation } from './validation'

export const reconcileMarkedEquity = (input: MarkedEquityReconciliationInput): SimulationReconciliationResult =>
  pipe(
    prepareReconciliation(input),
    Result.flatMap(reconstructMarkedEquity),
    Result.mapError(freezePublicIssues),
    Result.map(freezePublicProof),
  )
