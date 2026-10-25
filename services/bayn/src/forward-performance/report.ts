import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceReceipt } from './model'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import { measurePositionEpisodes, type PositionEpisodeEvidence } from './position-episodes'

export enum ForwardPerformanceScopeKind {
  Account = 'ACCOUNT',
  AuthorityGeneration = 'AUTHORITY_GENERATION',
}

export type ForwardPerformanceReportScope =
  | { readonly kind: ForwardPerformanceScopeKind.Account }
  | {
      readonly kind: ForwardPerformanceScopeKind.AuthorityGeneration
      readonly authorityGenerationHash: string
    }

export interface ForwardPerformanceReport {
  readonly schemaVersion: 'bayn.forward-performance-report.v5'
  /** Requested query scope; this does not supply missing financial source or strategy evidence. */
  readonly scope: ForwardPerformanceReportScope
  readonly receipt: ForwardPerformanceReceipt
  readonly positionEpisodes: PositionEpisodeEvidence
  readonly inferenceExpenses: readonly ForwardInferenceExpenseSession[]
  readonly operatingCostCoverage: 'INCOMPLETE'
  readonly reportHash: string
}

export const makeForwardPerformanceReport = (
  input: ForwardPerformanceEvidenceInput,
  inferenceExpenses: readonly ForwardInferenceExpenseSession[],
  authorityGenerationHash?: string,
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
    const scope: ForwardPerformanceReportScope =
      authorityGenerationHash === undefined
        ? { kind: ForwardPerformanceScopeKind.Account }
        : { kind: ForwardPerformanceScopeKind.AuthorityGeneration, authorityGenerationHash }
    const material = {
      schemaVersion: 'bayn.forward-performance-report.v5' as const,
      scope,
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
