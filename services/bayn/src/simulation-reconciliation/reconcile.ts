import { pipe, Result } from 'effect'

import { type MarkedEquityReconciliationInput, type SimulationReconciliationResult } from './model'
import { freezePublicIssues, freezePublicProof } from './presentation'
import { reconstructMarkedEquity } from './reconstruction'
import { prepareReconciliation } from './preparation'

export const reconcileMarkedEquity = (input: MarkedEquityReconciliationInput): SimulationReconciliationResult =>
  pipe(
    prepareReconciliation(input),
    Result.flatMap(reconstructMarkedEquity),
    Result.mapError(freezePublicIssues),
    Result.map(freezePublicProof),
  )
