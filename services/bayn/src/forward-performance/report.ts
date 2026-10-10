import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceReceipt } from './model'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import { measurePositionEpisodes, type PositionEpisodeEvidence } from './position-episodes'

export interface ForwardPerformanceReport {
  readonly schemaVersion: 'bayn.forward-performance-report.v2'
  readonly receipt: ForwardPerformanceReceipt
  readonly positionEpisodes: PositionEpisodeEvidence
  readonly inferenceExpenses: readonly ForwardInferenceExpenseSession[]
  readonly operatingCostCoverage: 'INCOMPLETE'
  readonly reportHash: string
}

export const makeForwardPerformanceReport = (
  input: ForwardPerformanceEvidenceInput,
  inferenceExpenses: readonly ForwardInferenceExpenseSession[],
): Result.Result<ForwardPerformanceReport, ForwardPerformanceDomainFailure> =>
  Result.gen(function* () {
    const receipt = yield* makeForwardPerformanceReceipt(input)
    const positionEpisodes = yield* measurePositionEpisodes(input).pipe(
      Result.mapError(
        (cause): ForwardPerformanceDomainFailure => ({
          _tag: 'ForwardPerformanceDomainFailure',
          operation: 'hash-position-episodes',
          cause,
        }),
      ),
    )
    const material = {
      schemaVersion: 'bayn.forward-performance-report.v2' as const,
      receipt,
      positionEpisodes,
      inferenceExpenses,
      operatingCostCoverage: 'INCOMPLETE' as const,
    }
    const reportHash = yield* canonicalHashV1Result(material).pipe(
      Result.mapError(
        (cause): ForwardPerformanceDomainFailure => ({
          _tag: 'ForwardPerformanceDomainFailure',
          operation: 'hash-report',
          cause,
        }),
      ),
    )
    return { ...material, reportHash }
  })
