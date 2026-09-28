import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceReceipt } from './model'
import { measurePositionEpisodes, type PositionEpisodeEvidence } from './position-episodes'

export interface ForwardPerformanceReport {
  readonly schemaVersion: 'bayn.forward-performance-report.v1'
  readonly receipt: ForwardPerformanceReceipt
  readonly positionEpisodes: PositionEpisodeEvidence
  readonly reportHash: string
}

export const makeForwardPerformanceReport = (
  input: ForwardPerformanceEvidenceInput,
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
    const material = { schemaVersion: 'bayn.forward-performance-report.v1' as const, receipt, positionEpisodes }
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
