import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceReceipt } from './model'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import { measurePositionEpisodes, type PositionEpisodeEvidence } from './position-episodes'
import type { SystemAssessment } from '../system-assessment/assessment'
import { forwardCostDiagnostics } from './cost-diagnostics'

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
  readonly schemaVersion: 'bayn.forward-performance-report.v7'
  /** Requested query scope; this does not supply missing financial source or strategy evidence. */
  readonly scope: ForwardPerformanceReportScope
  readonly receipt: ForwardPerformanceReceipt
  /** A read-only report does not inspect persistence or certify that its generation has ended. */
  readonly receiptPersistence: 'NOT_CHECKED' | 'PERSISTED_TERMINAL'
  readonly costDiagnostics: ReturnType<typeof forwardCostDiagnostics>
  readonly positionEpisodes: PositionEpisodeEvidence
  readonly inferenceExpenses: readonly ForwardInferenceExpenseSession[]
  readonly operatingCostCoverage: 'COMPLETE' | 'INCOMPLETE'
  readonly operatingCostScope: {
    readonly registrationHash: string
    readonly sourceCutHash: string
    readonly asOf: string
  } | null
  readonly systemAssessment: SystemAssessment | null
  readonly reportHash: string
}

export const makeForwardPerformanceReport = (
  input: ForwardPerformanceEvidenceInput,
  inferenceExpenses: readonly ForwardInferenceExpenseSession[],
  authorityGenerationHash?: string,
  systemAssessment: SystemAssessment | null = null,
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
    const costDiagnostics = forwardCostDiagnostics(receipt, inferenceExpenses, systemAssessment)
    const material = {
      schemaVersion: 'bayn.forward-performance-report.v7' as const,
      scope,
      receipt,
      receiptPersistence: 'NOT_CHECKED' as const,
      costDiagnostics,
      positionEpisodes,
      inferenceExpenses,
      operatingCostCoverage:
        costDiagnostics.assessmentOperatingCosts.coverage === 'COMPLETE'
          ? ('COMPLETE' as const)
          : ('INCOMPLETE' as const),
      operatingCostScope:
        systemAssessment === null
          ? null
          : {
              registrationHash: systemAssessment.registrationHash,
              sourceCutHash: systemAssessment.sourceCutHash,
              asOf: systemAssessment.asOf,
            },
      systemAssessment,
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

/** Call only after the terminal-generation append has committed successfully. */
export const recordForwardPerformancePersistence = (
  report: ForwardPerformanceReport,
): Result.Result<ForwardPerformanceReport, ForwardPerformanceDomainFailure> => {
  const { reportHash: _reportHash, ...previous } = report
  const material = { ...previous, receiptPersistence: 'PERSISTED_TERMINAL' as const }
  return canonicalHashV1Result(material).pipe(
    Result.map((reportHash) => ({ ...material, reportHash })),
    Result.mapError(
      (cause): ForwardPerformanceDomainFailure => ({
        _tag: 'ForwardPerformanceDomainFailure',
        operation: 'hash-report',
        cause,
      }),
    ),
  )
}
