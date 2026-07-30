import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import * as vm from 'node:vm'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, pipe, Result, Schema } from 'effect'

import {
  candidateDevelopmentComparisonSemantics,
  candidateDevelopmentDoubledCostContract,
  candidateDevelopmentStatisticsPolicy,
  runCandidateDevelopment,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentEvaluation,
  type CandidateDevelopmentPreflightPass,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { frozenCandidateDevelopmentTrialHistory } from './candidate-development-calendar'
import {
  type DailyPerformancePoint,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
} from './evidence-contracts'
import { elapsedCalendarDays, MICROS, referencePriceMicros } from './execution-model'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { DIRECT_VOLATILITY_WINDOW, ExecutionModelSchema } from './protocol'
import {
  DigitsSchema,
  IsoDateSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SourceRevisionSchema,
  SymbolSchema,
  UnitIntervalSchema,
  strictParseOptions,
} from './schemas'
import { calculateExactPerformanceMetrics, buildVerdict } from './simulation/metrics'
import { alignBars, directVolatilityWeights, simulate, type AlignedSession, type SimulationTarget } from './simulation'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type EvaluationResult,
  type IsoDate,
  type PerformanceMetrics,
  type SimulationProtocol,
} from './types'

export const candidateDevelopmentExecutableProgramSchemaVersion =
  'bayn.candidate-development-executable-program.v5' as const

export interface CandidateDevelopmentSourceManifest {
  readonly schemaVersion: 'bayn.candidate-development-source-manifest.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly modulePath: string
  readonly moduleFormat: 'self-contained-esm-v1'
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
}

export interface CandidateDevelopmentVerifiedSource {
  readonly schemaVersion: 'bayn.candidate-development-verified-source.v1'
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly sourceManifest: CandidateDevelopmentSourceManifest
  readonly baselineRunId: string
  readonly stressedRunId: string
}

export interface CandidateDevelopmentVerifiedSourceFiles extends Omit<
  CandidateDevelopmentVerifiedSource,
  'schemaVersion' | 'baselineRunId' | 'stressedRunId'
> {
  readonly schemaVersion: 'bayn.candidate-development-verified-source-files.v1'
}

export interface CandidateDevelopmentMarketDataWitness {
  readonly schemaVersion: 'bayn.candidate-development-market-data-witness.v1'
  readonly snapshotId: string
  readonly inputManifestHash: string
  readonly contentHash: string
  readonly bars: readonly DailyBar[]
}

export interface CandidateDevelopmentStrategyProtocol extends SimulationProtocol {
  readonly schemaVersion: 'bayn.candidate-development-strategy-protocol.v2'
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-contract.v1'
    readonly snapshotId: string
    readonly contentHash: string
  }
  readonly benchmarks: {
    readonly schemaVersion: 'bayn.candidate-development-benchmark-policy.v1'
    readonly symbol: string
    readonly directVolatilityWindow: typeof DIRECT_VOLATILITY_WINDOW
    readonly terminalPolicy: 'last-all-cash-strategy-decision'
  }
}

export interface CandidateDevelopmentAccountingEvidence {
  readonly schemaVersion: 'bayn.candidate-development-accounting-evidence.v2'
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly events: EvaluationResult['events']
  readonly baselineSimulation: EvaluationResult['simulation']
  readonly equitySeries: EvaluationResult['equitySeries']
  readonly markedEquityReconciliation: EvaluationResult['markedEquityReconciliation']
  readonly signalDecisions: EvaluationResult['signalDecisions']
  readonly stressedRunId: string
  readonly stressedEvaluatorTotalFeesMicros: string
  readonly stressedEvaluatorEndingEquityMicros: string
  readonly stressedEvents: EvaluationResult['events']
  readonly stressedSimulation: EvaluationResult['simulation']
  readonly stressedEquitySeries: EvaluationResult['equitySeries']
  readonly stressedMarkedEquityReconciliation: EvaluationResult['markedEquityReconciliation']
}

export interface CandidateDevelopmentCommandEvaluation extends CandidateDevelopmentEvaluation {
  readonly accounting: CandidateDevelopmentAccountingEvidence
  readonly marketData: CandidateDevelopmentMarketDataWitness
}

export interface CandidateDevelopmentCommandEffects<Registration, DevelopmentData, Error, Requirements> extends Omit<
  CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements>,
  'evaluateDevelopment'
> {
  readonly evaluateDevelopment: (
    data: DevelopmentData,
    preflight: CandidateDevelopmentPreflightPass,
    verifiedSource: CandidateDevelopmentVerifiedSource,
  ) => Effect.Effect<CandidateDevelopmentCommandEvaluation, Error, Requirements>
}

export interface CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements> {
  readonly schemaVersion: typeof candidateDevelopmentExecutableProgramSchemaVersion
  readonly input: CandidateDevelopmentPreflightInput
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly effects: CandidateDevelopmentCommandEffects<Registration, DevelopmentData, Error, Requirements>
}

type CandidateDevelopmentComparisonGateName =
  (typeof candidateDevelopmentComparisonSemantics.gates)[keyof typeof candidateDevelopmentComparisonSemantics.gates]['name']

export interface CandidateDevelopmentCommandGate {
  readonly name:
    | CandidateDevelopmentComparisonGateName
    | 'double_cost_return'
    | 'economic_verdict'
    | 'baseline_terminal_cash'
    | 'stressed_terminal_cash'
  readonly passed: boolean
  readonly actual: number | boolean
  readonly required: number | boolean
}

export interface CandidateDevelopmentCommandDecision {
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly selectedBenchmark: 'buy-and-hold' | 'direct-volatility-timing'
  readonly gates: readonly CandidateDevelopmentCommandGate[]
}

export interface CandidateDevelopmentCommandReportMaterial {
  readonly schemaVersion: 'bayn.candidate-development-command-report.v6'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly officialSessions: CandidateDevelopmentPreflightInput['officialSessions']
  readonly marketData: CandidateDevelopmentMarketDataWitness
  readonly verifiedSource: CandidateDevelopmentVerifiedSource
  readonly decision: CandidateDevelopmentCommandDecision
  readonly baseline: EvaluationResult
  readonly accounting: CandidateDevelopmentAccountingEvidence
  readonly development: CandidateDevelopmentReport
}

export interface CandidateDevelopmentCommandReport extends CandidateDevelopmentCommandReportMaterial {
  readonly contentHash: string
}

export type CandidateDevelopmentCommandFailure =
  | CandidateDevelopmentRunFailure
  | {
      readonly _tag: 'CandidateDevelopmentCommandHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModulePathMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandSourceManifestPathMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed'
      readonly operation:
        | 'resolve-repository'
        | 'read-module'
        | 'read-source-manifest'
        | 'decode-source-manifest'
        | 'verify-source-paths'
        | 'verify-head'
        | 'verify-module-blob'
        | 'verify-module-format'
        | 'verify-preregistration-blob'
        | 'verify-preregistration-lineage'
        | 'verify-source-manifest-blob'
        | 'verify-program-binding'
        | 'derive-run-identity'
        | 'verify-post-import'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModuleLoadFailed'
      readonly modulePath: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramInvalid'
      readonly reason:
        | 'module-export-missing'
        | 'schema-version-mismatch'
        | 'input-missing'
        | 'input-invalid'
        | 'strategy-protocol-missing'
        | 'strategy-protocol-invalid'
        | 'strategy-protocol-hash-mismatch'
        | 'effects-missing'
        | 'effect-function-missing'
        | 'evaluation-invalid'
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEvaluationMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramExecutionFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandOutputFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid'
      readonly series:
        | 'strategy'
        | 'buy-and-hold'
        | 'direct-volatility-timing'
        | 'double-cost-series'
        | 'double-cost-stressed'
      readonly reason:
        | 'observations-insufficient'
        | 'micros-invalid'
        | 'cumulative-mismatch'
        | 'return-mismatch'
        | 'session-mismatch'
        | 'metrics-failed'
        | 'metrics-mismatch'
      readonly index: number | null
      readonly field: string | null
      readonly expected: unknown
      readonly observed: unknown
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid'
      readonly reason: 'binding-mismatch' | 'reconstruction-failed' | 'proof-mismatch' | 'selected-trace-mismatch'
      readonly index: number | null
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid'
      readonly expectedGateNames: readonly string[]
      readonly observedGateNames: readonly string[]
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicGateInvalid'
      readonly index: number
      readonly expected: EvaluationResult['verdict']['gates'][number]
      readonly observed: EvaluationResult['verdict']['gates'][number]
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid'
      readonly expectedStatus: EvaluationResult['verdict']['status']
      readonly observedStatus: EvaluationResult['verdict']['status']
      readonly failedGateNames: readonly string[]
    }

const terminalCash = (marks: EvaluationResult['simulation']['dailyMarks']): boolean => {
  const last = marks.at(-1)
  return last !== undefined && last.positions.every((position) => position.quantityMicros === '0')
}

type CandidateDevelopmentPerformanceSeries = readonly (DailyPerformancePoint & {
  readonly positions?: EvaluationResult['simulation']['dailyMarks'][number]['positions']
})[]

type CandidateDevelopmentPerformanceSeriesName = Extract<
  CandidateDevelopmentCommandFailure,
  { readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' }
>['series']

const performanceMetricFields = [
  'observations',
  'totalReturn',
  'annualizedReturn',
  'annualizedVolatility',
  'sharpe',
  'maximumDrawdown',
  'annualTurnover',
  'totalFeesMicros',
  'totalSpreadCostMicros',
  'totalSlippageCostMicros',
  'totalCashYieldMicros',
  'endingEquityMicros',
] as const satisfies readonly (keyof PerformanceMetrics)[]

const cumulativeMicrosFields = [
  ['turnoverMicros', 'cumulativeTurnoverMicros'],
  ['feeMicros', 'cumulativeFeesMicros'],
  ['spreadCostMicros', 'cumulativeSpreadCostMicros'],
  ['slippageCostMicros', 'cumulativeSlippageCostMicros'],
  ['cashYieldMicros', 'cumulativeCashYieldMicros'],
] as const

const performanceEvidenceFailure = (
  series: CandidateDevelopmentPerformanceSeriesName,
  reason: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' }
  >['reason'],
  index: number | null,
  field: string | null,
  expected: unknown,
  observed: unknown,
  cause?: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
  series,
  reason,
  index,
  field,
  expected,
  observed,
  ...(cause === undefined ? {} : { cause }),
})

const unsignedMicros = (
  series: CandidateDevelopmentPerformanceSeriesName,
  index: number,
  field: string,
  value: string,
): Result.Result<bigint, CandidateDevelopmentCommandFailure> =>
  /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(performanceEvidenceFailure(series, 'micros-invalid', index, field, 'unsigned micros', value))

const recomputePerformanceMetrics = (
  seriesName: CandidateDevelopmentPerformanceSeriesName,
  points: CandidateDevelopmentPerformanceSeries,
  initialCapitalMicros: string,
  firstPreviousEquityMicros: string = initialCapitalMicros,
): Result.Result<PerformanceMetrics, CandidateDevelopmentCommandFailure> => {
  if (points.length < 2) {
    return Result.fail(
      performanceEvidenceFailure(seriesName, 'observations-insufficient', null, null, '>=2', points.length),
    )
  }
  const initialCapital = /^(?:[1-9][0-9]*)$/.test(initialCapitalMicros)
    ? Result.succeed(BigInt(initialCapitalMicros))
    : Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'micros-invalid',
          null,
          'initialCapitalMicros',
          'positive micros',
          initialCapitalMicros,
        ),
      )
  if (Result.isFailure(initialCapital)) return Result.fail(initialCapital.failure)
  const firstPreviousEquity = /^(?:[1-9][0-9]*)$/.test(firstPreviousEquityMicros)
    ? Result.succeed(BigInt(firstPreviousEquityMicros))
    : Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'micros-invalid',
          null,
          'firstPreviousEquityMicros',
          'positive micros',
          firstPreviousEquityMicros,
        ),
      )
  if (Result.isFailure(firstPreviousEquity)) return Result.fail(firstPreviousEquity.failure)

  const equityMicros: bigint[] = []
  const cumulative = Object.fromEntries(cumulativeMicrosFields.map(([, field]) => [field, 0n])) as Record<
    (typeof cumulativeMicrosFields)[number][1],
    bigint
  >
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const previous = points[index - 1]
    if (previous !== undefined && previous.sessionDate >= point.sessionDate) {
      return Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'session-mismatch',
          index,
          'sessionDate',
          `>${previous.sessionDate}`,
          point.sessionDate,
        ),
      )
    }
    const equity = unsignedMicros(seriesName, index, 'equityMicros', point.equityMicros)
    if (Result.isFailure(equity)) return Result.fail(equity.failure)
    if (equity.success === 0n) {
      return Result.fail(
        performanceEvidenceFailure(seriesName, 'micros-invalid', index, 'equityMicros', 'positive micros', '0'),
      )
    }
    equityMicros.push(equity.success)
    const previousEquity = index === 0 ? firstPreviousEquity.success : equityMicros[index - 1]
    const expectedReturn = Number(equity.success) / Number(previousEquity) - 1
    if (!Number.isFinite(expectedReturn) || !Object.is(point.netReturn, expectedReturn)) {
      return Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'return-mismatch',
          index,
          'netReturn',
          Number.isFinite(expectedReturn) ? expectedReturn : 'finite return',
          point.netReturn,
        ),
      )
    }

    for (const [dailyField, cumulativeField] of cumulativeMicrosFields) {
      const daily = unsignedMicros(seriesName, index, dailyField, point[dailyField])
      if (Result.isFailure(daily)) return Result.fail(daily.failure)
      const observedCumulative = unsignedMicros(seriesName, index, cumulativeField, point[cumulativeField])
      if (Result.isFailure(observedCumulative)) return Result.fail(observedCumulative.failure)
      const prior = cumulative[cumulativeField]
      const expected = index === 0 ? observedCumulative.success : prior + daily.success
      if (index === 0 ? observedCumulative.success < daily.success : observedCumulative.success !== expected) {
        return Result.fail(
          performanceEvidenceFailure(
            seriesName,
            'cumulative-mismatch',
            index,
            cumulativeField,
            index === 0 ? `>=${daily.success}` : expected.toString(),
            observedCumulative.success.toString(),
          ),
        )
      }
      cumulative[cumulativeField] = observedCumulative.success
    }
  }

  return pipe(
    calculateExactPerformanceMetrics(
      equityMicros,
      cumulative.cumulativeTurnoverMicros,
      cumulative.cumulativeFeesMicros,
      cumulative.cumulativeSpreadCostMicros,
      cumulative.cumulativeSlippageCostMicros,
      cumulative.cumulativeCashYieldMicros,
      initialCapital.success,
    ),
    Result.mapError((cause) => performanceEvidenceFailure(seriesName, 'metrics-failed', null, null, null, null, cause)),
  )
}

const validatePerformanceMetrics = (
  series: CandidateDevelopmentPerformanceSeriesName,
  expected: PerformanceMetrics,
  observed: PerformanceMetrics,
): Result.Result<PerformanceMetrics, CandidateDevelopmentCommandFailure> => {
  for (const field of performanceMetricFields) {
    if (!Object.is(expected[field], observed[field])) {
      return Result.fail(
        performanceEvidenceFailure(series, 'metrics-mismatch', null, field, expected[field], observed[field]),
      )
    }
  }
  return Result.succeed(expected)
}

const validateSeriesSessions = (
  expected: CandidateDevelopmentPerformanceSeries,
  observed: CandidateDevelopmentPerformanceSeries,
  series: CandidateDevelopmentPerformanceSeriesName,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const count = Math.max(expected.length, observed.length)
  for (let index = 0; index < count; index += 1) {
    if (expected[index]?.sessionDate !== observed[index]?.sessionDate) {
      return Result.fail(
        performanceEvidenceFailure(
          series,
          'session-mismatch',
          index,
          'sessionDate',
          expected[index]?.sessionDate ?? null,
          observed[index]?.sessionDate ?? null,
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

const markedEquityFailure = (
  reason: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid' }
  >['reason'],
  index: number | null,
  field: string,
  expected: unknown,
  observed: unknown,
  cause?: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
  reason,
  index,
  field,
  expected,
  observed,
  ...(cause === undefined ? {} : { cause }),
})

const canonicalEvidenceHash = (
  field: string,
  value: unknown,
): Result.Result<string, CandidateDevelopmentCommandFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError((cause) => markedEquityFailure('binding-mismatch', null, field, 'canonical evidence', null, cause)),
  )

const sourceVerificationFailure = (
  operation: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed' }
  >['operation'],
  cause: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
  operation,
  cause,
})

export const bindCandidateDevelopmentVerifiedSource = (
  files: CandidateDevelopmentVerifiedSourceFiles,
  input: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentVerifiedSource, CandidateDevelopmentCommandFailure> => {
  const completedCandidateOrdinals = frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals
  for (let index = 0; index < completedCandidateOrdinals.length; index += 1) {
    if (completedCandidateOrdinals[index] !== index + 1) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'trialHistory.completedCandidateOrdinals',
          expected: index + 1,
          observed: completedCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestTerminalEvidence = frozenCandidateDevelopmentTrialHistory.latestTerminalEvidence
  if (
    latestTerminalEvidence.candidateOrdinal !== completedCandidateOrdinals.length ||
    latestTerminalEvidence.priorTrialCount !== latestTerminalEvidence.candidateOrdinal - 1
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.latestTerminalEvidence',
        expected: {
          candidateOrdinal: completedCandidateOrdinals.length,
          priorTrialCount: completedCandidateOrdinals.length - 1,
        },
        observed: latestTerminalEvidence,
      }),
    )
  }
  const nextCandidatePreregistration = frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration
  if (nextCandidatePreregistration !== null) {
    const expectedNextCandidateOrdinal = completedCandidateOrdinals.length + 1
    const expectedPriorTrialCount = completedCandidateOrdinals.length
    const nextBindings = [
      ['candidateOrdinal', expectedNextCandidateOrdinal, nextCandidatePreregistration.candidateOrdinal],
      ['priorTrialCount', expectedPriorTrialCount, nextCandidatePreregistration.priorTrialCount],
      ['input.candidateOrdinal', nextCandidatePreregistration.candidateOrdinal, input.candidateOrdinal],
      ['input.priorTrialCount', nextCandidatePreregistration.priorTrialCount, input.priorTrialCount],
      ['strategyProtocolHash', nextCandidatePreregistration.strategyProtocolHash, input.expectedStrategyProtocolHash],
      ['modulePath', nextCandidatePreregistration.modulePath, files.modulePath],
    ] as const
    for (const [field, expected, observed] of nextBindings) {
      if (expected !== observed) {
        return Result.fail(
          sourceVerificationFailure('verify-program-binding', {
            field: `trialHistory.nextCandidatePreregistration.${field}`,
            expected,
            observed,
          }),
        )
      }
    }
  }
  const candidatePreregistration =
    nextCandidatePreregistration ?? frozenCandidateDevelopmentTrialHistory.candidatePreregistration
  if (
    input.candidateOrdinal !== candidatePreregistration.candidateOrdinal ||
    input.priorTrialCount !== candidatePreregistration.priorTrialCount
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.candidatePreregistration',
        expected: candidatePreregistration,
        observed: {
          candidateOrdinal: input.candidateOrdinal,
          priorTrialCount: input.priorTrialCount,
        },
      }),
    )
  }
  const manifest = files.sourceManifest
  const mismatches = [
    ['candidateOrdinal', input.candidateOrdinal, manifest.candidateOrdinal],
    ['priorTrialCount', input.priorTrialCount, manifest.priorTrialCount],
    ['strategyProtocolHash', input.expectedStrategyProtocolHash, manifest.strategyProtocolHash],
    ['modulePath', files.modulePath, manifest.modulePath],
  ] as const
  for (const [field, expected, observed] of mismatches) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field,
          expected,
          observed,
        }),
      )
    }
  }
  return pipe(
    canonicalHashV1Result({
      schemaVersion: 'bayn.candidate-development-verified-run.v1',
      sourceRevision: files.sourceRevision,
      module: {
        path: files.modulePath,
        blobOid: files.moduleBlobOid,
        sha256: files.moduleSha256,
      },
      sourceManifest: {
        path: files.sourceManifestPath,
        blobOid: files.sourceManifestBlobOid,
        sha256: files.sourceManifestSha256,
      },
      trialHistory: frozenCandidateDevelopmentTrialHistory,
      input,
    }),
    Result.mapError((cause) => sourceVerificationFailure('derive-run-identity', cause)),
    Result.flatMap((baselineRunId) =>
      pipe(
        canonicalHashV1Result({
          schemaVersion: 'bayn.candidate-development-verified-stressed-run.v1',
          baselineRunId,
          costMultiplierMicros: candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
        }),
        Result.mapError((cause) => sourceVerificationFailure('derive-run-identity', cause)),
        Result.map(
          (stressedRunId): CandidateDevelopmentVerifiedSource => ({
            schemaVersion: 'bayn.candidate-development-verified-source.v1',
            sourceRevision: files.sourceRevision,
            modulePath: files.modulePath,
            moduleBlobOid: files.moduleBlobOid,
            moduleSha256: files.moduleSha256,
            sourceManifestPath: files.sourceManifestPath,
            sourceManifestBlobOid: files.sourceManifestBlobOid,
            sourceManifestSha256: files.sourceManifestSha256,
            sourceManifest: files.sourceManifest,
            baselineRunId,
            stressedRunId,
          }),
        ),
      ),
    ),
  )
}

const preregisterCandidateDevelopmentAttempt = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const nextCandidatePreregistration = frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration
  if (nextCandidatePreregistration === null) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.nextCandidatePreregistration',
        expected: 'separately reviewed preregistration after consumed Candidate 16',
        observed: null,
        latestTerminalEvidence: frozenCandidateDevelopmentTrialHistory.latestTerminalEvidence,
      }),
    )
  }
  const completedCandidateOrdinals = frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals
  const sourceManifest = verifiedSource.sourceManifest
  const bindings = [
    ['candidateOrdinal', completedCandidateOrdinals.length + 1, nextCandidatePreregistration.candidateOrdinal],
    ['priorTrialCount', completedCandidateOrdinals.length, nextCandidatePreregistration.priorTrialCount],
    ['source.candidateOrdinal', nextCandidatePreregistration.candidateOrdinal, sourceManifest.candidateOrdinal],
    ['source.priorTrialCount', nextCandidatePreregistration.priorTrialCount, sourceManifest.priorTrialCount],
    [
      'source.strategyProtocolHash',
      nextCandidatePreregistration.strategyProtocolHash,
      sourceManifest.strategyProtocolHash,
    ],
    ['source.modulePath', nextCandidatePreregistration.modulePath, verifiedSource.modulePath],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.nextCandidatePreregistration.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  return Result.succeed(verifiedSource.sourceManifestSha256)
}

const requireCanonicalEvidenceEqual = (
  field: string,
  expected: unknown,
  observed: unknown,
): Result.Result<void, CandidateDevelopmentCommandFailure> =>
  pipe(
    Result.all({
      expected: canonicalEvidenceHash(`${field}.expected`, expected),
      observed: canonicalEvidenceHash(field, observed),
    }),
    Result.flatMap(({ expected: expectedHash, observed: observedHash }) =>
      expectedHash === observedHash
        ? Result.succeed(undefined)
        : Result.fail(markedEquityFailure('binding-mismatch', null, field, expectedHash, observedHash)),
    ),
  )

interface PreparedCandidateDevelopmentMarketData {
  readonly witness: CandidateDevelopmentMarketDataWitness
  readonly sessions: readonly AlignedSession[]
  readonly sessionIndexByDate: ReadonlyMap<string, number>
}

const compareMarketBars = (left: DailyBar, right: DailyBar): number =>
  left.sessionDate === right.sessionDate
    ? left.symbol.localeCompare(right.symbol)
    : left.sessionDate.localeCompare(right.sessionDate)

const prepareCandidateDevelopmentMarketData = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<PreparedCandidateDevelopmentMarketData, CandidateDevelopmentCommandFailure> => {
  const { baseline, marketData } = evaluation
  const committed = verifiedSource.sourceManifest.marketData
  const { contentHash: observedContentHash, ...content } = marketData
  const expectedContentHash = canonicalEvidenceHash('marketData.content', content)
  if (Result.isFailure(expectedContentHash)) return Result.fail(expectedContentHash.failure)
  const scalarBindings = [
    ['marketData.committedContentHash', committed.boundedContentHash, observedContentHash],
    ['marketData.protocolContentHash', committed.boundedContentHash, strategyProtocol.marketData.contentHash],
    ['marketData.recomputedContentHash', expectedContentHash.success, observedContentHash],
    ['marketData.committedSnapshotId', committed.snapshotId, marketData.snapshotId],
    ['marketData.protocolSnapshotId', committed.snapshotId, strategyProtocol.marketData.snapshotId],
    ['marketData.manifestSnapshotId', baseline.inputManifest.finalizedSnapshot.snapshotId, marketData.snapshotId],
    [
      'marketData.finalizedSnapshotContentHash',
      committed.finalizedSnapshotContentHash,
      baseline.inputManifest.finalizedSnapshot.contentHash,
    ],
    ['marketData.committedInputManifestHash', committed.inputManifestHash, marketData.inputManifestHash],
    ['marketData.inputManifestHash', baseline.inputManifest.hash, marketData.inputManifestHash],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  for (let index = 1; index < marketData.bars.length; index += 1) {
    const previous = marketData.bars[index - 1]
    const current = marketData.bars[index]
    if (compareMarketBars(previous, current) >= 0) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, 'marketData.bars.order', 'strict session-date/symbol order', {
          previous: [previous.sessionDate, previous.symbol],
          current: [current.sessionDate, current.symbol],
        }),
      )
    }
  }
  const snapshot = baseline.inputManifest.finalizedSnapshot
  for (let index = 0; index < marketData.bars.length; index += 1) {
    const bar = marketData.bars[index]
    const expected = {
      source: snapshot.source,
      sourceFeed: snapshot.sourceFeed,
      adjustment: snapshot.adjustment,
      publicationSchemaVersion: snapshot.publicationSchemaVersion,
    }
    const observed = {
      source: bar.source,
      sourceFeed: bar.sourceFeed,
      adjustment: bar.adjustment,
      publicationSchemaVersion: bar.publicationSchemaVersion,
    }
    if (
      expected.source !== observed.source ||
      expected.sourceFeed !== observed.sourceFeed ||
      expected.adjustment !== observed.adjustment ||
      expected.publicationSchemaVersion !== observed.publicationSchemaVersion
    ) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, 'marketData.bars.provenance', expected, observed),
      )
    }
  }
  return pipe(
    alignBars(marketData.bars, strategyProtocol.universe, baseline.inputManifest),
    Result.mapError((cause) =>
      markedEquityFailure('binding-mismatch', null, 'marketData.bars', 'manifest-bound aligned bars', null, cause),
    ),
    Result.flatMap((sessions) => {
      if (sessions.length !== officialSessions.length) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            null,
            'marketData.sessions.length',
            officialSessions.length,
            sessions.length,
          ),
        )
      }
      for (let index = 0; index < officialSessions.length; index += 1) {
        if (sessions[index]?.date !== officialSessions[index]) {
          return Result.fail(
            markedEquityFailure(
              'binding-mismatch',
              index,
              'marketData.sessions.sessionDate',
              officialSessions[index],
              sessions[index]?.date ?? null,
            ),
          )
        }
      }
      return Result.succeed({
        witness: marketData,
        sessions,
        sessionIndexByDate: new Map(sessions.map((session, index) => [session.date, index] as const)),
      })
    }),
  )
}

const validateCandidateDevelopmentStrategyProtocol = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const protocolHash = canonicalEvidenceHash('strategyProtocol', strategyProtocol)
  if (Result.isFailure(protocolHash)) return Result.fail(protocolHash.failure)
  const expectedHash = report.comparisonSemantics.strategyProtocolHash
  if (protocolHash.success !== expectedHash || evaluation.baseline.protocolHash !== expectedHash) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, 'strategyProtocolHash', expectedHash, {
        document: protocolHash.success,
        evaluation: evaluation.baseline.protocolHash,
      }),
    )
  }
  const scalarBindings = [
    ['initialCapitalMicros', strategyProtocol.initialCapitalMicros, evaluation.baseline.initialCapitalMicros],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, `strategyProtocol.${field}`, expected, observed))
    }
  }
  const bindings = [
    [
      'strategyProtocol.universe',
      strategyProtocol.universe,
      evaluation.baseline.inputManifest.symbols.map(({ symbol }) => symbol),
    ],
    [
      'strategyProtocol.baselineExecutionModel',
      strategyProtocol.executionModel,
      evaluation.baseline.simulation.executionModel,
    ],
    [
      'strategyProtocol.stressedExecutionModel',
      strategyProtocol.executionModel,
      report.doubledCost.stressed.simulation.executionModel,
    ],
  ] as const
  for (const [field, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(field, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  return Result.succeed(undefined)
}

const validateCandidateDevelopmentVerifiedSource = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const bindings = [
    ['verifiedSource.codeRevision', verifiedSource.sourceRevision, evaluation.baseline.codeRevision],
    ['verifiedSource.baselineRunId', verifiedSource.baselineRunId, evaluation.baseline.runId],
    ['verifiedSource.accountingRunId', verifiedSource.baselineRunId, evaluation.accounting.runId],
    ['verifiedSource.stressedRunId', verifiedSource.stressedRunId, evaluation.accounting.stressedRunId],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  return Result.succeed(undefined)
}

const validateDecisionEventBinding = (
  field: 'baseline' | 'stressed',
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const first = signalDecisions.at(0)
  if (first === undefined) {
    return Result.fail(markedEquityFailure('binding-mismatch', null, `${field}.signalDecisions`, 'nonempty', 0))
  }
  const decisionEvents = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'decision' }> =>
      event.kind === 'decision',
  )
  if (decisionEvents.length !== signalDecisions.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.decisionCount`,
        signalDecisions.length,
        decisionEvents.length,
      ),
    )
  }
  for (let index = 0; index < signalDecisions.length; index += 1) {
    const signal = signalDecisions[index]
    const event = decisionEvents[index]
    const scalars = [
      ['decisionId', signal.decisionId, event?.id],
      ['signalDate', signal.signalDate, event?.signalDate],
      ['executionDate', signal.executionDate, event?.executionDate],
    ] as const
    for (const [name, expected, observed] of scalars) {
      if (expected !== observed) {
        return Result.fail(
          markedEquityFailure('binding-mismatch', index, `${field}.decision.${name}`, expected, observed ?? null),
        )
      }
    }
    const weights = requireCanonicalEvidenceEqual(
      `${field}.decision.targetWeights`,
      signal.targetWeights,
      event?.targetWeights ?? null,
    )
    if (Result.isFailure(weights)) return Result.fail(weights.failure)
  }
  return Result.succeed(undefined)
}

const governedPriceMicros = (
  field: string,
  index: number,
  price: number,
  protocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<string, CandidateDevelopmentCommandFailure> =>
  pipe(
    referencePriceMicros(price, protocol.executionModel),
    Result.map((value) => value.toString()),
    Result.mapError((cause) =>
      markedEquityFailure('binding-mismatch', index, field, 'quantized governed market-data price', price, cause),
    ),
  )

const validateAccountingPrices = (
  field: 'baseline' | 'stressed',
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
  marketData: PreparedCandidateDevelopmentMarketData,
  protocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const sessionFor = (sessionDate: string): AlignedSession | undefined => {
    const index = marketData.sessionIndexByDate.get(sessionDate)
    return index === undefined ? undefined : marketData.sessions[index]
  }
  const fills = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'fill' }> => event.kind === 'fill',
  )
  for (let index = 0; index < fills.length; index += 1) {
    const fill = fills[index]
    const bar = sessionFor(fill.sessionDate)?.bars[fill.symbol]
    if (bar === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.fills.referencePriceMicros`,
          'governed execution-session bar',
          { symbol: fill.symbol, sessionDate: fill.sessionDate },
        ),
      )
    }
    const expected = governedPriceMicros(`${field}.fills.referencePriceMicros`, index, bar.open, protocol)
    if (Result.isFailure(expected)) return Result.fail(expected.failure)
    if (expected.success !== fill.referencePriceMicros) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.fills.referencePriceMicros`,
          expected.success,
          fill.referencePriceMicros,
        ),
      )
    }
  }
  for (let markIndex = 0; markIndex < simulation.dailyMarks.length; markIndex += 1) {
    const mark = simulation.dailyMarks[markIndex]
    const session = sessionFor(mark.sessionDate)
    if (session === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          markIndex,
          `${field}.dailyMarks.priceMicros`,
          'governed mark session',
          mark.sessionDate,
        ),
      )
    }
    for (let positionIndex = 0; positionIndex < mark.positions.length; positionIndex += 1) {
      const position = mark.positions[positionIndex]
      const bar = session.bars[position.symbol]
      if (bar === undefined) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            markIndex,
            `${field}.dailyMarks.priceMicros`,
            'governed symbol bar',
            position.symbol,
          ),
        )
      }
      const expected = governedPriceMicros(`${field}.dailyMarks.priceMicros`, positionIndex, bar.close, protocol)
      if (Result.isFailure(expected)) return Result.fail(expected.failure)
      if (expected.success !== position.priceMicros) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            markIndex,
            `${field}.dailyMarks.priceMicros`,
            expected.success,
            position.priceMicros,
          ),
        )
      }
    }
  }
  return Result.succeed(undefined)
}

const validateCashYieldIntervals = (
  field: 'baseline' | 'stressed',
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const markIndexBySession = new Map(simulation.dailyMarks.map((mark, index) => [mark.sessionDate, index] as const))
  if (markIndexBySession.size !== simulation.dailyMarks.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.cashYield.calendar`,
        'unique accounting sessions',
        simulation.dailyMarks.length - markIndexBySession.size,
      ),
    )
  }
  const seenSessions = new Set<string>()
  const firstRebalanceEventBySession = new Map<string, { readonly index: number; readonly kind: 'fill' | 'fee' }>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind === 'fill' || event.kind === 'fee') {
      if (!firstRebalanceEventBySession.has(event.sessionDate)) {
        firstRebalanceEventBySession.set(event.sessionDate, { index, kind: event.kind })
      }
      continue
    }
    if (event.kind !== 'cash-yield') continue
    const priorRebalanceEvent = firstRebalanceEventBySession.get(event.sessionDate)
    if (priorRebalanceEvent !== undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.order`,
          'before every same-session fill and fee',
          priorRebalanceEvent,
        ),
      )
    }
    if (seenSessions.has(event.sessionDate)) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.sessionDate`,
          'one cash-yield event per accounting session',
          event.sessionDate,
        ),
      )
    }
    seenSessions.add(event.sessionDate)
    const markIndex = markIndexBySession.get(event.sessionDate)
    const previous = markIndex === undefined ? undefined : simulation.dailyMarks[markIndex - 1]
    if (markIndex === undefined || previous === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          'accounting session with a predecessor',
          event.sessionDate,
        ),
      )
    }
    const elapsed = elapsedCalendarDays(previous.sessionDate, event.sessionDate)
    if (Result.isFailure(elapsed)) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          `calendar interval after ${previous.sessionDate}`,
          event.elapsedDays,
          elapsed.failure,
        ),
      )
    }
    if (elapsed.success !== event.elapsedDays) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          elapsed.success,
          event.elapsedDays,
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

const validateAccountingCalendar = (
  field: 'baseline' | 'stressed',
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const first = simulation.dailyMarks.at(0)
  if (first === undefined) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, `${field}.calendar`, 'nonempty accounting marks', 0),
    )
  }
  const startIndex = officialSessions.indexOf(first.sessionDate)
  if (startIndex < 0 || startIndex + simulation.dailyMarks.length > officialSessions.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.calendar.start`,
        'contiguous slice of official sessions',
        first.sessionDate,
      ),
    )
  }
  for (let index = 0; index < simulation.dailyMarks.length; index += 1) {
    const expected = officialSessions[startIndex + index]
    const observed = simulation.dailyMarks[index].sessionDate
    if (expected !== observed) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, `${field}.calendar.sessionDate`, expected ?? null, observed),
      )
    }
  }
  return Result.succeed(undefined)
}

const validateAccountingUniverse = (
  field: 'baseline' | 'stressed',
  universe: readonly string[],
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const governed = new Set(universe)
  const validateSymbol = (
    evidenceField: string,
    index: number,
    symbol: string,
  ): Result.Result<void, CandidateDevelopmentCommandFailure> =>
    governed.has(symbol)
      ? Result.succeed(undefined)
      : Result.fail(markedEquityFailure('binding-mismatch', index, `${field}.${evidenceField}`, universe, symbol))
  const validateWeights = (
    evidenceField: string,
    index: number,
    weights: Readonly<Record<string, number>>,
  ): Result.Result<void, CandidateDevelopmentCommandFailure> => {
    for (const symbol of Object.keys(weights)) {
      const valid = validateSymbol(evidenceField, index, symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
    return Result.succeed(undefined)
  }

  for (let index = 0; index < signalDecisions.length; index += 1) {
    const decision = signalDecisions[index]
    const weights = validateWeights('signalDecisions.targetWeights', index, decision.targetWeights)
    if (Result.isFailure(weights)) return Result.fail(weights.failure)
    for (const signal of decision.signals) {
      const valid = validateSymbol('signalDecisions.signals.symbol', index, signal.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind === 'decision') {
      const weights = validateWeights('events.targetWeights', index, event.targetWeights)
      if (Result.isFailure(weights)) return Result.fail(weights.failure)
    } else if (event.kind === 'fill') {
      const valid = validateSymbol('events.symbol', index, event.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  for (let index = 0; index < simulation.orders.length; index += 1) {
    const valid = validateSymbol('orders.symbol', index, simulation.orders[index].symbol)
    if (Result.isFailure(valid)) return Result.fail(valid.failure)
  }
  for (let markIndex = 0; markIndex < simulation.dailyMarks.length; markIndex += 1) {
    for (const position of simulation.dailyMarks[markIndex].positions) {
      const valid = validateSymbol('positions.symbol', markIndex, position.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  return Result.succeed(undefined)
}

const selectedTracePreviousEquity = (
  field: 'baselineSimulation' | 'stressedSimulation',
  full: EvaluationResult['simulation'],
  selected: EvaluationResult['simulation'],
  events: EvaluationResult['events'],
  initialCapitalMicros: string,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const first = selected.dailyMarks.at(0)
  if (first === undefined) {
    return Result.fail(markedEquityFailure('selected-trace-mismatch', null, field, 'nonempty selected trace', 0))
  }
  const startIndex = full.dailyMarks.findIndex((mark) => mark.sessionDate === first.sessionDate)
  if (startIndex < 0) {
    return Result.fail(
      markedEquityFailure('selected-trace-mismatch', null, `${field}.firstSession`, first.sessionDate, null),
    )
  }
  if (startIndex !== 1) {
    return Result.fail(markedEquityFailure('selected-trace-mismatch', null, `${field}.predecessorCount`, 1, startIndex))
  }
  const predecessor = full.dailyMarks[0]
  const predecessorBindings = [
    ['equityMicros', initialCapitalMicros, predecessor.equityMicros],
    ['netReturn', 0, predecessor.netReturn],
    ['turnoverMicros', '0', predecessor.turnoverMicros],
    ['cumulativeTurnoverMicros', '0', predecessor.cumulativeTurnoverMicros],
    ['feeMicros', '0', predecessor.feeMicros],
    ['cumulativeFeesMicros', '0', predecessor.cumulativeFeesMicros],
    ['spreadCostMicros', '0', predecessor.spreadCostMicros],
    ['cumulativeSpreadCostMicros', '0', predecessor.cumulativeSpreadCostMicros],
    ['slippageCostMicros', '0', predecessor.slippageCostMicros],
    ['cumulativeSlippageCostMicros', '0', predecessor.cumulativeSlippageCostMicros],
    ['cashYieldMicros', '0', predecessor.cashYieldMicros],
    ['cumulativeCashYieldMicros', '0', predecessor.cumulativeCashYieldMicros],
    ['peakEquityMicros', initialCapitalMicros, predecessor.peakEquityMicros],
    ['drawdown', 0, predecessor.drawdown],
    ['cashMicros', initialCapitalMicros, predecessor.cashMicros],
  ] as const
  for (const [name, expected, observed] of predecessorBindings) {
    if (expected !== observed) {
      return Result.fail(
        markedEquityFailure('selected-trace-mismatch', 0, `${field}.predecessor.${name}`, expected, observed),
      )
    }
  }
  const nonzeroPosition = predecessor.positions.findIndex(
    ({ quantityMicros, costBasisMicros, marketValueMicros }) =>
      quantityMicros !== '0' || costBasisMicros !== '0' || marketValueMicros !== '0',
  )
  if (nonzeroPosition >= 0) {
    return Result.fail(
      markedEquityFailure(
        'selected-trace-mismatch',
        nonzeroPosition,
        `${field}.predecessor.positions`,
        'all-zero positions',
        predecessor.positions[nonzeroPosition],
      ),
    )
  }
  const last = selected.dailyMarks.at(-1)
  if (last === undefined || startIndex + selected.dailyMarks.length !== full.dailyMarks.length) {
    return Result.fail(
      markedEquityFailure(
        'selected-trace-mismatch',
        null,
        `${field}.terminalSession`,
        last?.sessionDate ?? null,
        full.dailyMarks.at(-1)?.sessionDate ?? null,
      ),
    )
  }
  for (let index = 0; index < selected.dailyMarks.length; index += 1) {
    const expected = selected.dailyMarks[index]
    const observed = full.dailyMarks[startIndex + index]
    if (observed === undefined) {
      return Result.fail(markedEquityFailure('selected-trace-mismatch', index, field, expected.sessionDate, null))
    }
    const equality = requireCanonicalEvidenceEqual(`${field}.dailyMarks[${index}]`, expected, observed)
    if (Result.isFailure(equality)) return Result.fail(equality.failure)
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const evidenceDates =
      event.kind === 'decision'
        ? ([
            ['signalDate', event.signalDate],
            ['executionDate', event.executionDate],
          ] as const)
        : ([['sessionDate', event.sessionDate]] as const)
    for (const [dateField, observed] of evidenceDates) {
      const isEconomicBeforeWindow =
        event.kind === 'decision'
          ? dateField === 'executionDate' && observed < first.sessionDate
          : observed < first.sessionDate
      if (isEconomicBeforeWindow) {
        return Result.fail(
          markedEquityFailure(
            'selected-trace-mismatch',
            index,
            `${field}.events.${dateField}`,
            `>=${first.sessionDate}`,
            observed,
          ),
        )
      }
      if (observed > last.sessionDate) {
        return Result.fail(
          markedEquityFailure(
            'selected-trace-mismatch',
            index,
            `${field}.events.${dateField}`,
            `<=${last.sessionDate}`,
            observed,
          ),
        )
      }
    }
  }
  for (let index = 0; index < full.orders.length; index += 1) {
    const observed = full.orders[index].sessionDate
    if (observed < first.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.orders.sessionDate`,
          `>=${first.sessionDate}`,
          observed,
        ),
      )
    }
    if (observed > last.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.orders.sessionDate`,
          `<=${last.sessionDate}`,
          observed,
        ),
      )
    }
  }
  for (let index = 0; index < full.cashChanges.length; index += 1) {
    const observed = full.cashChanges[index].sessionDate
    if (observed < first.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.cashChanges.sessionDate`,
          `>=${first.sessionDate}`,
          observed,
        ),
      )
    }
    if (observed > last.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.cashChanges.sessionDate`,
          `<=${last.sessionDate}`,
          observed,
        ),
      )
    }
  }
  return Result.succeed(initialCapitalMicros)
}

interface CandidateDevelopmentAccountingValidation {
  readonly strategyPreviousEquityMicros: string
  readonly stressedPreviousEquityMicros: string
}

interface CandidateDevelopmentRebuiltBenchmarks {
  readonly buyAndHold: readonly DailyPerformancePoint[]
  readonly directVolTiming: readonly DailyPerformancePoint[]
}

const decisionTarget = (
  decision: EvaluationResult['signalDecisions'][number],
  marketData: PreparedCandidateDevelopmentMarketData,
  weights: Readonly<Record<string, number>> = decision.targetWeights,
): Result.Result<SimulationTarget, CandidateDevelopmentCommandFailure> => {
  const signalIndex = marketData.sessionIndexByDate.get(decision.signalDate)
  const executionIndex = marketData.sessionIndexByDate.get(decision.executionDate)
  if (signalIndex === undefined || executionIndex === undefined) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.schedule',
        'signal and execution dates in market-data witness',
        { signalDate: decision.signalDate, executionDate: decision.executionDate },
      ),
    )
  }
  const { decisionId: _, executionDate: __, ...plan } = decision
  return Result.succeed({ signalIndex, executionIndex, weights, decision: plan })
}

export const validateCandidateDevelopmentAccountingReplay = (
  field: 'baseline' | 'stressed',
  runId: string,
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
  marketData: PreparedCandidateDevelopmentMarketData,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const firstMark = simulation.dailyMarks.at(0)
  const lastMark = simulation.dailyMarks.at(-1)
  const startIndex = firstMark === undefined ? undefined : marketData.sessionIndexByDate.get(firstMark.sessionDate)
  const endIndex = lastMark === undefined ? undefined : marketData.sessionIndexByDate.get(lastMark.sessionDate)
  if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.replay.window`,
        'bounded accounting window in market-data witness',
        { first: firstMark?.sessionDate ?? null, last: lastMark?.sessionDate ?? null },
      ),
    )
  }
  const targets = Result.all(signalDecisions.map((decision) => decisionTarget(decision, marketData)))
  if (Result.isFailure(targets)) return Result.fail(targets.failure)
  const replay = simulate(
    marketData.sessions.slice(0, endIndex + 1),
    targets.success,
    startIndex,
    strategyProtocol,
    BigInt(simulation.costMultiplierMicros),
    runId,
    true,
  )
  if (Result.isFailure(replay) || replay.success.simulation === null) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        `${field}.replay`,
        'deterministic simulation replay from bound decisions and market data',
        null,
        Result.isFailure(replay) ? replay.failure : undefined,
      ),
    )
  }
  const monetaryEvents = events.filter((event) => event.kind !== 'decision')
  const replayedMonetaryEvents = replay.success.events.filter((event) => event.kind !== 'decision')
  const bindings = [
    [`${field}.replay.signalDecisions`, replay.success.signalDecisions, signalDecisions],
    [`${field}.replay.monetaryEvents`, replayedMonetaryEvents, monetaryEvents],
    [`${field}.replay.orders`, replay.success.simulation.orders, simulation.orders],
    [`${field}.replay.cashChanges`, replay.success.simulation.cashChanges, simulation.cashChanges],
    [`${field}.replay.dailyMarks`, replay.success.simulation.dailyMarks, simulation.dailyMarks],
  ] as const
  for (const [name, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(name, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  return Result.succeed(undefined)
}

const selectRebuiltBenchmarkSeries = (
  series: readonly DailyPerformancePoint[],
  selectedSessions: readonly IsoDate[],
  initialCapitalMicros: string,
  name: 'buy-and-hold' | 'direct-volatility-timing',
): Result.Result<readonly DailyPerformancePoint[], CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(series.map((point) => [point.sessionDate, point] as const))
  const selected = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = selected.findIndex((point) => point === undefined)
  if (missing >= 0) {
    return Result.fail(
      performanceEvidenceFailure(name, 'session-mismatch', missing, 'sessionDate', selectedSessions[missing], null),
    )
  }
  const complete = selected as readonly DailyPerformancePoint[]
  const first = complete.at(0)
  if (first === undefined) {
    return Result.fail(performanceEvidenceFailure(name, 'observations-insufficient', null, null, '>=2', 0))
  }
  const normalizedReturn = Number(first.equityMicros) / Number(initialCapitalMicros) - 1
  if (!Number.isFinite(normalizedReturn)) {
    return Result.fail(
      performanceEvidenceFailure(name, 'return-mismatch', 0, 'netReturn', 'finite normalized return', normalizedReturn),
    )
  }
  return Result.succeed([{ ...first, netReturn: normalizedReturn }, ...complete.slice(1)])
}

const rebuildCandidateDevelopmentBenchmarks = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  marketData: PreparedCandidateDevelopmentMarketData,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentRebuiltBenchmarks, CandidateDevelopmentCommandFailure> => {
  const { accounting, baseline } = evaluation
  const decisions = accounting.signalDecisions
  const terminal = decisions.at(-1)
  const firstMark = accounting.baselineSimulation.dailyMarks.at(0)
  const lastMark = accounting.baselineSimulation.dailyMarks.at(-1)
  if (terminal === undefined || firstMark === undefined || lastMark === undefined) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.inputs',
        'nonempty decisions and accounting marks',
        null,
      ),
    )
  }
  if (Object.values(terminal.targetWeights).some((weight) => weight !== 0)) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        decisions.length - 1,
        'benchmarks.terminalDecision',
        'all-cash target weights',
        terminal.targetWeights,
      ),
    )
  }
  const benchmarkSymbol = strategyProtocol.benchmarks.symbol
  if (!strategyProtocol.universe.includes(benchmarkSymbol)) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, 'benchmarks.symbol', strategyProtocol.universe, benchmarkSymbol),
    )
  }
  const startIndex = marketData.sessionIndexByDate.get(firstMark.sessionDate)
  const endIndex = marketData.sessionIndexByDate.get(lastMark.sessionDate)
  if (startIndex === undefined || endIndex === undefined || startIndex <= 0 || endIndex < startIndex) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.window',
        'bounded accounting window with a prior signal session',
        { first: firstMark.sessionDate, last: lastMark.sessionDate },
      ),
    )
  }
  const benchmarkProtocol: SimulationProtocol = { ...strategyProtocol, universe: [benchmarkSymbol] }
  const terminalTarget = decisionTarget(terminal, marketData, { [benchmarkSymbol]: 0 })
  if (Result.isFailure(terminalTarget)) return Result.fail(terminalTarget.failure)
  const directTargets = Result.all(
    decisions.slice(0, -1).map((decision, index) => {
      const signalIndex = marketData.sessionIndexByDate.get(decision.signalDate)
      if (signalIndex === undefined) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            index,
            'benchmarks.directVolatility.signalDate',
            'market session',
            decision.signalDate,
          ),
        )
      }
      return pipe(
        directVolatilityWeights(marketData.sessions, signalIndex, benchmarkProtocol),
        Result.mapError((cause) =>
          markedEquityFailure(
            'reconstruction-failed',
            index,
            'benchmarks.directVolatility',
            'governed direct-volatility weights',
            null,
            cause,
          ),
        ),
        Result.flatMap((weights) => decisionTarget(decision, marketData, weights)),
      )
    }),
  )
  if (Result.isFailure(directTargets)) return Result.fail(directTargets.failure)
  const benchmarkRunId = canonicalEvidenceHash('benchmarks.runId', {
    schemaVersion: 'bayn.candidate-development-benchmark-run.v1',
    candidateRunId: baseline.runId,
    marketDataContentHash: marketData.witness.contentHash,
    policy: strategyProtocol.benchmarks,
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const sessions = marketData.sessions.slice(0, endIndex + 1)
  const buyAndHold = simulate(
    sessions,
    [
      {
        signalIndex: startIndex - 1,
        executionIndex: startIndex,
        weights: { [benchmarkSymbol]: 1 },
      },
      terminalTarget.success,
    ],
    startIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(buyAndHold)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'benchmarks.buyAndHold',
        'governed benchmark replay',
        null,
        buyAndHold.failure,
      ),
    )
  }
  const directVolTiming = simulate(
    sessions,
    [...directTargets.success, terminalTarget.success],
    startIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(directVolTiming)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'benchmarks.directVolatility',
        'governed benchmark replay',
        null,
        directVolTiming.failure,
      ),
    )
  }
  const selectedSessions = baseline.simulation.dailyMarks.map((mark) => mark.sessionDate)
  return Result.all({
    buyAndHold: selectRebuiltBenchmarkSeries(
      buyAndHold.success.dailyPerformance,
      selectedSessions,
      baseline.initialCapitalMicros,
      'buy-and-hold',
    ),
    directVolTiming: selectRebuiltBenchmarkSeries(
      directVolTiming.success.dailyPerformance,
      selectedSessions,
      baseline.initialCapitalMicros,
      'direct-volatility-timing',
    ),
  })
}

const validateCandidateDevelopmentAccounting = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  marketData: PreparedCandidateDevelopmentMarketData,
): Result.Result<CandidateDevelopmentAccountingValidation, CandidateDevelopmentCommandFailure> => {
  const { accounting, baseline } = evaluation
  const scalarBindings = [
    ['runId', baseline.runId, accounting.runId],
    ['initialCapitalMicros', baseline.initialCapitalMicros, accounting.initialCapitalMicros],
    ['evaluatorTotalFeesMicros', baseline.strategy.totalFeesMicros, accounting.evaluatorTotalFeesMicros],
    ['evaluatorEndingEquityMicros', baseline.strategy.endingEquityMicros, accounting.evaluatorEndingEquityMicros],
    [
      'stressedEvaluatorTotalFeesMicros',
      baseline.doubleCostStrategy.totalFeesMicros,
      accounting.stressedEvaluatorTotalFeesMicros,
    ],
    [
      'stressedEvaluatorEndingEquityMicros',
      baseline.doubleCostStrategy.endingEquityMicros,
      accounting.stressedEvaluatorEndingEquityMicros,
    ],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  const bindings = [
    ['events', baseline.events, accounting.events],
    ['baseline.orders', baseline.simulation.orders, accounting.baselineSimulation.orders],
    ['baseline.cashChanges', baseline.simulation.cashChanges, accounting.baselineSimulation.cashChanges],
    ['baseline.executionModel', baseline.simulation.executionModel, accounting.baselineSimulation.executionModel],
    [
      'baseline.costMultiplierMicros',
      baseline.simulation.costMultiplierMicros,
      accounting.baselineSimulation.costMultiplierMicros,
    ],
    ['stressed.orders', report.doubledCost.stressed.simulation.orders, accounting.stressedSimulation.orders],
    [
      'stressed.cashChanges',
      report.doubledCost.stressed.simulation.cashChanges,
      accounting.stressedSimulation.cashChanges,
    ],
    [
      'stressed.executionModel',
      report.doubledCost.stressed.simulation.executionModel,
      accounting.stressedSimulation.executionModel,
    ],
    [
      'stressed.costMultiplierMicros',
      report.doubledCost.stressed.simulation.costMultiplierMicros,
      accounting.stressedSimulation.costMultiplierMicros,
    ],
    ['equitySeries', baseline.equitySeries, accounting.equitySeries],
    ['markedEquityReconciliation', baseline.markedEquityReconciliation, accounting.markedEquityReconciliation],
  ] as const
  for (const [field, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(field, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  const selectedTraceBindings = Result.all({
    strategyPreviousEquityMicros: selectedTracePreviousEquity(
      'baselineSimulation',
      accounting.baselineSimulation,
      baseline.simulation,
      accounting.events,
      baseline.initialCapitalMicros,
    ),
    stressedPreviousEquityMicros: selectedTracePreviousEquity(
      'stressedSimulation',
      accounting.stressedSimulation,
      report.doubledCost.stressed.simulation,
      accounting.stressedEvents,
      baseline.initialCapitalMicros,
    ),
  })
  if (Result.isFailure(selectedTraceBindings)) return Result.fail(selectedTraceBindings.failure)
  const domainBindings = Result.all({
    baselineCalendar: validateAccountingCalendar('baseline', officialSessions, accounting.baselineSimulation),
    stressedCalendar: validateAccountingCalendar('stressed', officialSessions, accounting.stressedSimulation),
    baselineUniverse: validateAccountingUniverse(
      'baseline',
      strategyProtocol.universe,
      baseline.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
    ),
    stressedUniverse: validateAccountingUniverse(
      'stressed',
      strategyProtocol.universe,
      report.doubledCost.stressed.signalDecisions,
      accounting.stressedEvents,
      accounting.stressedSimulation,
    ),
    baselineCashYield: validateCashYieldIntervals('baseline', accounting.events, accounting.baselineSimulation),
    stressedCashYield: validateCashYieldIntervals('stressed', accounting.stressedEvents, accounting.stressedSimulation),
    baselinePrices: validateAccountingPrices(
      'baseline',
      accounting.events,
      accounting.baselineSimulation,
      marketData,
      strategyProtocol,
    ),
    stressedPrices: validateAccountingPrices(
      'stressed',
      accounting.stressedEvents,
      accounting.stressedSimulation,
      marketData,
      strategyProtocol,
    ),
    baselineReplay: validateCandidateDevelopmentAccountingReplay(
      'baseline',
      accounting.runId,
      baseline.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
      marketData,
      strategyProtocol,
    ),
    stressedReplay: validateCandidateDevelopmentAccountingReplay(
      'stressed',
      accounting.stressedRunId,
      report.doubledCost.stressed.signalDecisions,
      accounting.stressedEvents,
      accounting.stressedSimulation,
      marketData,
      strategyProtocol,
    ),
  })
  if (Result.isFailure(domainBindings)) return Result.fail(domainBindings.failure)
  const decisionBindings = Result.all({
    baselinePlans: requireCanonicalEvidenceEqual(
      'baseline.signalDecisions',
      baseline.signalDecisions,
      accounting.signalDecisions,
    ),
    stressedPlans: requireCanonicalEvidenceEqual(
      'stressed.signalDecisions',
      report.doubledCost.stressed.signalDecisions,
      accounting.signalDecisions,
    ),
    baselineFull: validateDecisionEventBinding('baseline', accounting.signalDecisions, accounting.events),
    baselineSelected: validateDecisionEventBinding('baseline', baseline.signalDecisions, accounting.events),
    stressed: validateDecisionEventBinding('stressed', accounting.signalDecisions, accounting.stressedEvents),
    stressedSelected: validateDecisionEventBinding(
      'stressed',
      report.doubledCost.stressed.signalDecisions,
      accounting.stressedEvents,
    ),
  })
  if (Result.isFailure(decisionBindings)) return Result.fail(decisionBindings.failure)
  const proof = reconcileMarkedEquity({
    runId: accounting.runId,
    initialCapitalMicros: accounting.initialCapitalMicros,
    evaluatorTotalFeesMicros: accounting.evaluatorTotalFeesMicros,
    evaluatorEndingEquityMicros: accounting.evaluatorEndingEquityMicros,
    events: accounting.events,
    simulation: accounting.baselineSimulation,
  })
  if (Result.isFailure(proof)) {
    return Result.fail(
      markedEquityFailure('reconstruction-failed', null, 'accounting', 'reconciled marked equity', null, proof.failure),
    )
  }
  const proofBinding = requireCanonicalEvidenceEqual(
    'accounting.markedEquityProof',
    { reconciliation: accounting.markedEquityReconciliation, equitySeries: accounting.equitySeries },
    proof.success,
  )
  if (Result.isFailure(proofBinding)) {
    return Result.fail(
      markedEquityFailure(
        'proof-mismatch',
        null,
        'accounting.markedEquityProof',
        accounting.markedEquityReconciliation,
        proof.success.reconciliation,
        proofBinding.failure,
      ),
    )
  }
  const stressedProof = reconcileMarkedEquity({
    runId: accounting.stressedRunId,
    initialCapitalMicros: accounting.initialCapitalMicros,
    evaluatorTotalFeesMicros: accounting.stressedEvaluatorTotalFeesMicros,
    evaluatorEndingEquityMicros: accounting.stressedEvaluatorEndingEquityMicros,
    events: accounting.stressedEvents,
    simulation: accounting.stressedSimulation,
  })
  if (Result.isFailure(stressedProof)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'accounting.stressed',
        'reconciled stressed marked equity',
        null,
        stressedProof.failure,
      ),
    )
  }
  const stressedProofBinding = requireCanonicalEvidenceEqual(
    'accounting.stressedMarkedEquityProof',
    {
      reconciliation: accounting.stressedMarkedEquityReconciliation,
      equitySeries: accounting.stressedEquitySeries,
    },
    stressedProof.success,
  )
  if (Result.isFailure(stressedProofBinding)) {
    return Result.fail(
      markedEquityFailure(
        'proof-mismatch',
        null,
        'accounting.stressedMarkedEquityProof',
        accounting.stressedMarkedEquityReconciliation,
        stressedProof.success.reconciliation,
        stressedProofBinding.failure,
      ),
    )
  }
  return Result.succeed(selectedTraceBindings.success)
}

interface CandidateDevelopmentRecomputedMetrics {
  readonly strategy: PerformanceMetrics
  readonly buyAndHold: PerformanceMetrics
  readonly directVolTiming: PerformanceMetrics
  readonly doubleCostStrategy: PerformanceMetrics
}

const recomputeCandidateDevelopmentMetrics = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  accounting: CandidateDevelopmentAccountingValidation,
  benchmarks: CandidateDevelopmentRebuiltBenchmarks,
): Result.Result<CandidateDevelopmentRecomputedMetrics, CandidateDevelopmentCommandFailure> => {
  const { baseline } = evaluation
  const strategyPoints = baseline.simulation.dailyMarks
  const stressedPoints = report.doubledCost.stressed.simulation.dailyMarks
  return pipe(
    Result.all({
      buyBinding: requireCanonicalEvidenceEqual(
        'benchmarks.buyAndHold',
        benchmarks.buyAndHold,
        baseline.benchmarkSeries.buyAndHold,
      ),
      directVolBinding: requireCanonicalEvidenceEqual(
        'benchmarks.directVolatilityTiming',
        benchmarks.directVolTiming,
        baseline.benchmarkSeries.directVolTiming,
      ),
      buySessions: validateSeriesSessions(strategyPoints, benchmarks.buyAndHold, 'buy-and-hold'),
      volSessions: validateSeriesSessions(strategyPoints, benchmarks.directVolTiming, 'direct-volatility-timing'),
      doubleSessions: validateSeriesSessions(
        strategyPoints,
        baseline.benchmarkSeries.doubleCostStrategy,
        'double-cost-series',
      ),
      stressedSessions: validateSeriesSessions(strategyPoints, stressedPoints, 'double-cost-stressed'),
      strategy: recomputePerformanceMetrics(
        'strategy',
        strategyPoints,
        baseline.initialCapitalMicros,
        accounting.strategyPreviousEquityMicros,
      ),
      buyAndHold: recomputePerformanceMetrics('buy-and-hold', benchmarks.buyAndHold, baseline.initialCapitalMicros),
      directVolTiming: recomputePerformanceMetrics(
        'direct-volatility-timing',
        benchmarks.directVolTiming,
        baseline.initialCapitalMicros,
      ),
      doubleCostSeries: recomputePerformanceMetrics(
        'double-cost-series',
        baseline.benchmarkSeries.doubleCostStrategy,
        baseline.initialCapitalMicros,
      ),
      doubleCostStressed: recomputePerformanceMetrics(
        'double-cost-stressed',
        stressedPoints,
        baseline.initialCapitalMicros,
        accounting.stressedPreviousEquityMicros,
      ),
    }),
    Result.flatMap(({ buyAndHold, directVolTiming, doubleCostSeries, doubleCostStressed, strategy }) =>
      pipe(
        Result.all({
          strategy: validatePerformanceMetrics('strategy', strategy, baseline.strategy),
          buyAndHold: validatePerformanceMetrics('buy-and-hold', buyAndHold, baseline.buyAndHold),
          directVolTiming: validatePerformanceMetrics(
            'direct-volatility-timing',
            directVolTiming,
            baseline.directVolTiming,
          ),
          doubleCostSeries: validatePerformanceMetrics(
            'double-cost-series',
            doubleCostSeries,
            baseline.doubleCostStrategy,
          ),
          doubleCostStressed: validatePerformanceMetrics(
            'double-cost-stressed',
            doubleCostStressed,
            baseline.doubleCostStrategy,
          ),
        }),
        Result.map(
          ({ buyAndHold: buy, directVolTiming: vol, doubleCostStressed: doubleCost, strategy: candidate }) => ({
            strategy: candidate,
            buyAndHold: buy,
            directVolTiming: vol,
            doubleCostStrategy: doubleCost,
          }),
        ),
      ),
    ),
  )
}

const rebuildCandidateDevelopmentEconomicVerdict = (
  metrics: CandidateDevelopmentRecomputedMetrics,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): EvaluationResult['verdict'] =>
  buildVerdict(
    metrics.strategy,
    metrics.buyAndHold,
    metrics.directVolTiming,
    metrics.doubleCostStrategy,
    strategyProtocol,
  )

const economicGateEqual = (
  expected: EvaluationResult['verdict']['gates'][number],
  observed: EvaluationResult['verdict']['gates'][number],
): boolean =>
  expected.name === observed.name &&
  expected.passed === observed.passed &&
  Object.is(expected.actual, observed.actual) &&
  Object.is(expected.required, observed.required)

export const deriveCandidateDevelopmentEconomicPass = (
  baseline: EvaluationResult,
  metrics: CandidateDevelopmentRecomputedMetrics,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<boolean, CandidateDevelopmentCommandFailure> => {
  const expectedVerdict = rebuildCandidateDevelopmentEconomicVerdict(metrics, strategyProtocol)
  const expectedGateNames = expectedVerdict.gates.map((gate) => gate.name)
  const observedGateNames = baseline.verdict.gates.map((gate) => gate.name)
  if (
    observedGateNames.length !== expectedGateNames.length ||
    expectedGateNames.some((expected, index) => observedGateNames[index] !== expected)
  ) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
      expectedGateNames,
      observedGateNames,
    })
  }
  for (let index = 0; index < expectedVerdict.gates.length; index += 1) {
    const expected = expectedVerdict.gates[index]
    const observed = baseline.verdict.gates[index]
    if (expected === undefined || observed === undefined || !economicGateEqual(expected, observed)) {
      if (expected !== undefined && observed !== undefined) {
        return Result.fail({
          _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
          index,
          expected,
          observed,
        })
      }
      return Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
        expectedGateNames,
        observedGateNames,
      })
    }
  }
  const economicPass = expectedVerdict.gates.every((gate) => gate.passed)
  const failedGateNames = expectedVerdict.gates.filter((gate) => !gate.passed).map((gate) => gate.name)
  const expectedStatus = economicPass ? 'PASS' : 'FAIL_CLOSED'
  return baseline.verdict.status === expectedStatus
    ? Result.succeed(economicPass)
    : Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus,
        observedStatus: baseline.verdict.status,
        failedGateNames,
      })
}

const decideCandidateDevelopment = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  doubledCostAnnualizedReturn: number,
  economicPass: boolean,
): CandidateDevelopmentCommandDecision => {
  const { bootstrap, power, walkForward } = report.comparisonSemantics.analysis
  const protocolGates = candidateDevelopmentComparisonSemantics.gates
  const gates: readonly CandidateDevelopmentCommandGate[] = [
    {
      name: protocolGates.power.name,
      passed: power.sufficient,
      actual: power.sufficient,
      required: true,
    },
    {
      name: protocolGates.bootstrapTailResolution.name,
      passed: bootstrap.tailResolutionSufficient,
      actual: bootstrap.tailSampleCount,
      required: bootstrap.minimumTailSamples,
    },
    {
      name: protocolGates.annualizedExcessReturnLowerBound.name,
      passed: bootstrap.annualizedReturnDifferenceLowerBound > 0,
      actual: bootstrap.annualizedReturnDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.sharpeDifferenceLowerBound.name,
      passed: bootstrap.sharpeDifferenceLowerBound > 0,
      actual: bootstrap.sharpeDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.walkForwardFolds.name,
      passed: walkForward.sufficient,
      actual: walkForward.folds.length,
      required: walkForward.requiredFolds,
    },
    {
      name: protocolGates.walkForwardPositiveFraction.name,
      passed: walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
      actual: walkForward.positiveFoldFraction,
      required: walkForward.requiredPositiveFoldFraction,
    },
    {
      name: protocolGates.walkForwardDrawdown.name,
      passed: walkForward.allDrawdownsWithinLimit,
      actual: walkForward.maximumFoldDrawdown,
      required: candidateDevelopmentStatisticsPolicy.walkForward.maximumFoldDrawdown,
    },
    {
      name: 'double_cost_return',
      passed: doubledCostAnnualizedReturn > 0,
      actual: doubledCostAnnualizedReturn,
      required: 0,
    },
    {
      name: 'economic_verdict',
      passed: economicPass,
      actual: economicPass,
      required: true,
    },
    {
      name: 'baseline_terminal_cash',
      passed: terminalCash(baseline.simulation.dailyMarks),
      actual: terminalCash(baseline.simulation.dailyMarks),
      required: true,
    },
    {
      name: 'stressed_terminal_cash',
      passed: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      actual: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      required: true,
    },
  ]
  return {
    status: gates.every((gate) => gate.passed) ? 'PASS' : 'HOLD_REJECT',
    selectedBenchmark: bootstrap.selectedBenchmark,
    gates,
  }
}

export const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  pipe(
    Result.all({
      protocol: validateCandidateDevelopmentStrategyProtocol(report, evaluation, strategyProtocol),
      source: validateCandidateDevelopmentVerifiedSource(evaluation, verifiedSource),
    }),
    Result.flatMap(() =>
      prepareCandidateDevelopmentMarketData(evaluation, strategyProtocol, officialSessions, verifiedSource),
    ),
    Result.flatMap((marketData) =>
      pipe(
        Result.all({
          accounting: validateCandidateDevelopmentAccounting(
            report,
            evaluation,
            strategyProtocol,
            officialSessions,
            marketData,
          ),
          benchmarks: rebuildCandidateDevelopmentBenchmarks(evaluation, marketData, strategyProtocol),
        }),
        Result.flatMap(({ accounting, benchmarks }) =>
          recomputeCandidateDevelopmentMetrics(report, evaluation, accounting, benchmarks),
        ),
      ),
    ),
    Result.flatMap((metrics) =>
      pipe(
        Result.all({
          economicPass: deriveCandidateDevelopmentEconomicPass(evaluation.baseline, metrics, strategyProtocol),
        }),
        Result.map(({ economicPass }) => ({
          doubledCostAnnualizedReturn: metrics.doubleCostStrategy.annualizedReturn,
          economicPass,
        })),
      ),
    ),
    Result.flatMap(({ doubledCostAnnualizedReturn, economicPass }) => {
      const material: CandidateDevelopmentCommandReportMaterial = {
        schemaVersion: 'bayn.candidate-development-command-report.v6',
        candidateOrdinal: report.protocolIdentity.candidateOrdinal,
        priorTrialCount: report.protocolIdentity.priorTrialCount,
        strategyProtocolHash: report.comparisonSemantics.strategyProtocolHash,
        strategyProtocol,
        officialSessions,
        marketData: evaluation.marketData,
        verifiedSource,
        decision: decideCandidateDevelopment(report, evaluation.baseline, doubledCostAnnualizedReturn, economicPass),
        baseline: evaluation.baseline,
        accounting: evaluation.accounting,
        development: report,
      }
      return pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CandidateDevelopmentCommandFailure => ({
            _tag: 'CandidateDevelopmentCommandHashFailed',
            cause,
          }),
        ),
        Result.map((contentHash) => ({ ...material, contentHash })),
      )
    }),
  )

export const executeCandidateDevelopmentProgram = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> => {
  let evaluation: CandidateDevelopmentCommandEvaluation | undefined
  const effects: CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements> = {
    ...program.effects,
    evaluateDevelopment: (data, preflight) =>
      program.effects.evaluateDevelopment(data, preflight, verifiedSource).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            evaluation = value
          }),
        ),
      ),
  }
  return runCandidateDevelopment(program.input, effects).pipe(
    Effect.flatMap((report) =>
      evaluation === undefined
        ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandEvaluationMissing' })
        : Effect.fromResult(
            buildCandidateDevelopmentCommandReport(
              report,
              evaluation,
              program.strategyProtocol,
              program.input.officialSessions,
              verifiedSource,
            ),
          ),
    ),
  )
}

export const renderCandidateDevelopmentCommandReport = (report: CandidateDevelopmentCommandReport): string =>
  `${JSON.stringify(report)}\n`

export type CandidateDevelopmentCommandReportWriter = (
  renderedReport: string,
) => Effect.Effect<void, CandidateDevelopmentCommandFailure>

export interface CandidateDevelopmentCommandOutput {
  readonly write: (renderedReport: string, callback: (error?: Error | null) => void) => unknown
  readonly destroy: (error?: Error) => void
}

export const makeCandidateDevelopmentCommandReportWriter =
  (output: CandidateDevelopmentCommandOutput): CandidateDevelopmentCommandReportWriter =>
  (renderedReport) =>
    Effect.callback<void, CandidateDevelopmentCommandFailure>((resume) => {
      let pending = true
      const complete = (error?: Error | null) => {
        if (!pending) return
        pending = false
        resume(
          error === null || error === undefined
            ? Effect.succeed(undefined)
            : Effect.fail({ _tag: 'CandidateDevelopmentCommandOutputFailed', cause: error }),
        )
      }
      try {
        output.write(renderedReport, complete)
      } catch (cause) {
        pending = false
        resume(Effect.fail({ _tag: 'CandidateDevelopmentCommandOutputFailed', cause }))
      }
      return Effect.sync(() => {
        if (!pending) return
        pending = false
        output.destroy(new Error('candidate development report output interrupted'))
      })
    })

const writeCandidateDevelopmentCommandReportToStdout = makeCandidateDevelopmentCommandReportWriter(process.stdout)

export const writeCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentCommandReport,
  writer: CandidateDevelopmentCommandReportWriter = writeCandidateDevelopmentCommandReportToStdout,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> => writer(renderCandidateDevelopmentCommandReport(report))

export const runCandidateDevelopmentCommand = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> =>
  executeCandidateDevelopmentProgram(program, verifiedSource).pipe(Effect.tap(writeCandidateDevelopmentCommandReport))

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

export interface CandidateDevelopmentLoadedExecutableProgram {
  readonly program: ExecutableProgram
  readonly verifiedSource: CandidateDevelopmentVerifiedSource
}

export interface CandidateDevelopmentVerifiedModuleSource {
  readonly files: CandidateDevelopmentVerifiedSourceFiles
  readonly moduleUrl: string
}

const CandidateDevelopmentPreflightInputSchema = Schema.Struct({
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  expectedStrategyProtocolHash: Sha256Schema,
  officialSessions: Schema.Array(IsoDateSchema),
  signalSessionDates: Schema.Array(IsoDateSchema),
  featureLookbackSessions: NonNegativeIntegerSchema,
})

const CandidateDevelopmentSimulatedOrderSchema = Schema.Struct({
  id: Sha256Schema,
  decisionId: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  requestedQuantityMicros: DigitsSchema,
  filledQuantityMicros: DigitsSchema,
  status: Schema.Literals(['filled', 'partially-filled', 'rejected']),
  rejectionReason: Schema.NullOr(
    Schema.Literals(['below-minimum-buy-notional', 'zero-after-rounding', 'insufficient-buying-power']),
  ),
  unfilledRemainder: Schema.Literals(['none', 'canceled']),
})

const CandidateDevelopmentCashChangeSchema = Schema.Struct({
  id: Sha256Schema,
  sourceKind: Schema.Literals(['fill', 'fee', 'cash-yield']),
  sourceId: Sha256Schema,
  sessionDate: IsoDateSchema,
  amountMicros: SignedMicrosSchema,
  cashAfterMicros: SignedMicrosSchema,
})

const CandidateDevelopmentSimulationTraceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulation-trace.v3'),
  executionModel: ExecutionModelSchema,
  costMultiplierMicros: DigitsSchema,
  orders: Schema.Array(CandidateDevelopmentSimulatedOrderSchema),
  cashChanges: Schema.Array(CandidateDevelopmentCashChangeSchema),
  dailyMarks: DailyPositionMarksArtifactSchema.fields.items,
})

const CandidateDevelopmentEvaluationResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evaluation.v6'),
  runId: Sha256Schema,
  codeRevision: SourceRevisionSchema,
  protocolHash: Sha256Schema,
  initialCapitalMicros: DigitsSchema,
  inputManifest: InputManifestArtifactSchema,
  strategy: EvaluationSummarySchema.fields.strategy,
  buyAndHold: EvaluationSummarySchema.fields.buyAndHold,
  directVolTiming: EvaluationSummarySchema.fields.directVolTiming,
  doubleCostStrategy: EvaluationSummarySchema.fields.doubleCostStrategy,
  verdict: EvaluationSummarySchema.fields.verdict,
  events: EvaluationEventsSchema,
  simulation: CandidateDevelopmentSimulationTraceSchema,
  benchmarkSeries: Schema.Struct({
    buyAndHold: DailyPerformanceSeriesArtifactSchema.fields.items,
    directVolTiming: DailyPerformanceSeriesArtifactSchema.fields.items,
    doubleCostStrategy: DailyPerformanceSeriesArtifactSchema.fields.items,
  }),
  equitySeries: EquitySeriesArtifactSchema.fields.items,
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
})

const CandidateDevelopmentAccountingEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-accounting-evidence.v2'),
  runId: Sha256Schema,
  initialCapitalMicros: DigitsSchema,
  evaluatorTotalFeesMicros: DigitsSchema,
  evaluatorEndingEquityMicros: DigitsSchema,
  events: EvaluationEventsSchema,
  baselineSimulation: CandidateDevelopmentSimulationTraceSchema,
  equitySeries: EquitySeriesArtifactSchema.fields.items,
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
  stressedRunId: Sha256Schema,
  stressedEvaluatorTotalFeesMicros: DigitsSchema,
  stressedEvaluatorEndingEquityMicros: DigitsSchema,
  stressedEvents: EvaluationEventsSchema,
  stressedSimulation: CandidateDevelopmentSimulationTraceSchema,
  stressedEquitySeries: EquitySeriesArtifactSchema.fields.items,
  stressedMarkedEquityReconciliation: MarkedEquityReconciliationSchema,
})

const CandidateDevelopmentDailyBarBase = Schema.Struct({
  symbol: SymbolSchema,
  sessionDate: IsoDateSchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeFiniteSchema,
  source: Schema.Enum(DataSource),
  sourceFeed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  publicationSchemaVersion: Schema.Enum(PublicationSchema),
})

const CandidateDevelopmentDailyBarSchema = CandidateDevelopmentDailyBarBase.check(
  Schema.makeFilter((bar): readonly Schema.FilterIssue[] =>
    bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.low <= bar.high
      ? []
      : [
          {
            path: ['low'],
            issue: 'must satisfy low <= min(open, close) <= max(open, close) <= high',
          },
        ],
  ),
)

const CandidateDevelopmentMarketDataWitnessSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-market-data-witness.v1'),
  snapshotId: Sha256Schema,
  inputManifestHash: Sha256Schema,
  contentHash: Sha256Schema,
  bars: Schema.Array(CandidateDevelopmentDailyBarSchema).check(Schema.isMinLength(1)),
})

const CandidateDevelopmentStrategyProtocolSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-protocol.v2'),
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1)),
  directVolatilityTarget: PositiveFiniteSchema,
  initialCapitalMicros: PositiveMicrosSchema,
  executionModel: ExecutionModelSchema,
  thresholds: Schema.Struct({
    minimumObservations: PositiveIntegerSchema,
    minimumAnnualizedReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
    minimumSharpeImprovement: Schema.Finite,
    maximumDrawdown: UnitIntervalSchema,
    maximumAnnualTurnover: PositiveFiniteSchema,
    requirePositiveDoubleCostReturn: Schema.Boolean,
  }),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-contract.v1'),
    snapshotId: Sha256Schema,
    contentHash: Sha256Schema,
  }),
  benchmarks: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-benchmark-policy.v1'),
    symbol: SymbolSchema,
    directVolatilityWindow: Schema.Literal(DIRECT_VOLATILITY_WINDOW),
    terminalPolicy: Schema.Literal('last-all-cash-strategy-decision'),
  }),
})

const CandidateDevelopmentSourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-source-manifest.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  modulePath: Schema.String.check(Schema.isMinLength(1)),
  moduleFormat: Schema.Literal('self-contained-esm-v1'),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

const CandidateDevelopmentComparisonSemanticsEvidenceBoundarySchema = Schema.Struct({
  schemaVersion: Schema.Literal(candidateDevelopmentComparisonSemantics.evidence.schemaVersion),
  candidateDevelopmentProtocolHash: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  comparisonSemantics: Schema.Unknown,
  analysis: Schema.Unknown,
})

const CandidateDevelopmentDoubledCostRunSchema = Schema.Struct({
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
  simulation: CandidateDevelopmentSimulationTraceSchema,
})

const CandidateDevelopmentEvaluationSchema = Schema.Struct({
  baseline: CandidateDevelopmentEvaluationResultSchema,
  comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidenceBoundarySchema,
  stressed: CandidateDevelopmentDoubledCostRunSchema,
  accounting: CandidateDevelopmentAccountingEvidenceSchema,
  marketData: CandidateDevelopmentMarketDataWitnessSchema,
})

const decodeCandidateDevelopmentPreflightInput = Schema.decodeUnknownResult(
  CandidateDevelopmentPreflightInputSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentEvaluation = Schema.decodeUnknownResult(
  CandidateDevelopmentEvaluationSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentStrategyProtocol = Schema.decodeUnknownResult(
  CandidateDevelopmentStrategyProtocolSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentSourceManifest = Schema.decodeUnknownResult(
  CandidateDevelopmentSourceManifestSchema,
  strictParseOptions,
)

export const validateCandidateDevelopmentCommandEvaluation = (
  value: unknown,
): Result.Result<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> =>
  pipe(
    decodeCandidateDevelopmentEvaluation(value),
    Result.map((evaluation) => evaluation as CandidateDevelopmentCommandEvaluation),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'evaluation-invalid',
        cause,
      }),
    ),
  )

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const validateCandidateDevelopmentExecutableProgram = (
  value: unknown,
): Result.Result<ExecutableProgram, CandidateDevelopmentCommandFailure> => {
  const program = recordOf(value)
  if (program === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'module-export-missing' })
  }
  if (program.schemaVersion !== candidateDevelopmentExecutableProgramSchemaVersion) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' })
  }
  if (recordOf(program.input) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
  }
  if (recordOf(program.strategyProtocol) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'strategy-protocol-missing' })
  }
  const effects = recordOf(program.effects)
  if (effects === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effects-missing' })
  }
  if (
    typeof effects.preregisterCandidate !== 'function' ||
    typeof effects.loadDevelopmentData !== 'function' ||
    typeof effects.evaluateDevelopment !== 'function'
  ) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' })
  }
  const input = decodeCandidateDevelopmentPreflightInput(program.input)
  if (Result.isFailure(input)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: input.failure,
    })
  }
  const strategyProtocol = decodeCandidateDevelopmentStrategyProtocol(program.strategyProtocol)
  if (Result.isFailure(strategyProtocol)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-invalid',
      cause: strategyProtocol.failure,
    })
  }
  const strategyProtocolHash = canonicalHashV1Result(strategyProtocol.success)
  if (Result.isFailure(strategyProtocolHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-invalid',
      cause: strategyProtocolHash.failure,
    })
  }
  if (strategyProtocolHash.success !== input.success.expectedStrategyProtocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'strategy-protocol-hash-mismatch',
      cause: {
        expected: input.success.expectedStrategyProtocolHash,
        observed: strategyProtocolHash.success,
      },
    })
  }
  const typedEffects = effects as unknown as ExecutableProgram['effects']
  return Result.succeed({
    schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
    input: input.success,
    strategyProtocol: strategyProtocol.success as CandidateDevelopmentStrategyProtocol,
    effects: {
      ...typedEffects,
      evaluateDevelopment: (data, preflight, verifiedSource) =>
        typedEffects
          .evaluateDevelopment(data, preflight, verifiedSource)
          .pipe(
            Effect.flatMap((evaluation) =>
              Effect.fromResult(validateCandidateDevelopmentCommandEvaluation(evaluation)),
            ),
          ),
    },
  })
}

export type CandidateDevelopmentModuleImporter = (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
) => Effect.Effect<unknown, CandidateDevelopmentCommandFailure>

export type CandidateDevelopmentSourceVerifier = (
  modulePath: string,
  sourceManifestPath: string,
  sourceGit?: CandidateDevelopmentSourceGit,
) => Effect.Effect<CandidateDevelopmentVerifiedModuleSource, CandidateDevelopmentCommandFailure>

class CandidateDevelopmentSourceVerificationError extends Error {
  readonly operation: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed' }
  >['operation']
  readonly sourceCause: unknown

  constructor(operation: CandidateDevelopmentSourceVerificationError['operation'], sourceCause: unknown) {
    super(`candidate development source verification failed during ${operation}`)
    this.operation = operation
    this.sourceCause = sourceCause
  }
}

const sourceStep = async <A>(
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  step: () => Promise<A>,
): Promise<A> => {
  try {
    return await step()
  } catch (cause) {
    throw new CandidateDevelopmentSourceVerificationError(operation, cause)
  }
}

const gitText = (repositoryRoot: string, args: readonly string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout) => {
        if (error === null) resolveGit(stdout.trim())
        else rejectGit(error)
      },
    )
  })

const gitBytes = (repositoryRoot: string, args: readonly string[], signal?: AbortSignal): Promise<Buffer> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal },
      (error, stdout) => {
        if (error === null) resolveGit(stdout)
        else rejectGit(error)
      },
    )
  })

export interface CandidateDevelopmentSourceGit {
  readonly text: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<string>
  readonly bytes: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<Buffer>
}

const candidateDevelopmentSourceGit: CandidateDevelopmentSourceGit = {
  text: gitText,
  bytes: gitBytes,
}

const runCandidateDevelopmentSourcePair = async <Left, Right>(
  outerSignal: AbortSignal,
  left: (signal: AbortSignal) => Promise<Left>,
  right: (signal: AbortSignal) => Promise<Right>,
): Promise<readonly [Left, Right]> => {
  const controller = new AbortController()
  const signal = AbortSignal.any([outerSignal, controller.signal])
  const leftPromise = left(signal)
  const rightPromise = right(signal)
  try {
    return await Promise.all([leftPromise, rightPromise])
  } catch (cause) {
    controller.abort(cause)
    await Promise.allSettled([leftPromise, rightPromise])
    throw cause
  }
}

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const forbiddenCandidateArtifactIdentifiers = new Set([
  'Atomics',
  'Bun',
  'Date',
  'EventSource',
  'FinalizationRegistry',
  'Function',
  'Intl',
  'Loader',
  'Promise',
  'ShadowRealm',
  'SharedArrayBuffer',
  'SharedWorker',
  'Temporal',
  'WebAssembly',
  'WebSocket',
  'WeakRef',
  'Worker',
  'XMLHttpRequest',
  'async',
  'await',
  'console',
  'crypto',
  'eval',
  'fetch',
  'import',
  'localeCompare',
  'module',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
])

const candidateArtifactIdentifierIssues = (source: string): readonly string[] => {
  const issues: string[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === "'" || character === '"') {
      const quote = character
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index] === quote) {
          index += 1
          break
        } else index += 1
      }
      continue
    }
    if (character === '`') {
      issues.push('template-literal')
      break
    }
    if (character === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (character !== undefined && /[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end] ?? '')) end += 1
      const identifier = source.slice(index, end)
      if (forbiddenCandidateArtifactIdentifiers.has(identifier)) issues.push(identifier)
      index = end
      continue
    }
    index += 1
  }
  return [...new Set(issues)].sort()
}

const verifySelfContainedEsm = (
  source: string,
  modulePath: string,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  try {
    const transpiler = new Bun.Transpiler({ loader: 'js' })
    const imports = transpiler.scanImports(source)
    const normalized = transpiler.transformSync(source)
    const identifiers = candidateArtifactIdentifierIssues(normalized)
    return imports.length === 0 && identifiers.length === 0
      ? Result.succeed(undefined)
      : Result.fail(sourceVerificationFailure('verify-module-format', { modulePath, imports, identifiers }))
  } catch (cause) {
    return Result.fail(sourceVerificationFailure('verify-module-format', { modulePath, cause }))
  }
}

const repositoryRelativePath = (
  repositoryRoot: string,
  absolutePath: string,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const path = relative(repositoryRoot, absolutePath)
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`)
    ? Result.succeed(path.split(sep).join('/'))
    : Result.fail(
        sourceVerificationFailure('verify-source-paths', {
          repositoryRoot,
          absolutePath,
        }),
      )
}

export const verifyCandidateDevelopmentSourceFiles: CandidateDevelopmentSourceVerifier = (
  modulePath,
  sourceManifestPath,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const absoluteModulePath = await sourceStep('read-module', () => realpath(resolve(modulePath)))
      const absoluteSourceManifestPath = await sourceStep('read-source-manifest', () =>
        realpath(resolve(sourceManifestPath)),
      )
      const repositoryRoot = await sourceStep('resolve-repository', () =>
        sourceGit.text(dirname(absoluteModulePath), ['rev-parse', '--show-toplevel'], signal),
      )
      const moduleRepositoryPath = repositoryRelativePath(repositoryRoot, absoluteModulePath)
      if (Result.isFailure(moduleRepositoryPath)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-source-paths', moduleRepositoryPath.failure)
      }
      const sourceManifestRepositoryPath = repositoryRelativePath(repositoryRoot, absoluteSourceManifestPath)
      if (Result.isFailure(sourceManifestRepositoryPath)) {
        throw new CandidateDevelopmentSourceVerificationError(
          'verify-source-paths',
          sourceManifestRepositoryPath.failure,
        )
      }
      const sourceRevision = await sourceStep('verify-head', () =>
        sourceGit.text(repositoryRoot, ['rev-parse', 'HEAD'], signal),
      )
      if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-head', {
          expected: 'lowercase 40-character Git revision',
          observed: sourceRevision,
        })
      }
      const nextCandidatePreregistration = frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration
      if (nextCandidatePreregistration !== null) {
        const preregistration = nextCandidatePreregistration.preregistration
        if (
          !/^[0-9a-f]{40}$/.test(preregistration.sourceRevision) ||
          !/^[0-9a-f]{40}$/.test(preregistration.blobOid) ||
          preregistration.path.length === 0 ||
          preregistration.path.startsWith('/') ||
          preregistration.path === '..' ||
          preregistration.path.startsWith('../') ||
          preregistration.path.includes('/../')
        ) {
          throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-blob', {
            expected: 'lowercase Git revision/blob OID and repository-relative preregistration path',
            observed: preregistration,
          })
        }
        const preregistrationSpec = `${preregistration.sourceRevision}:${preregistration.path}`
        const [, preregistrationBlobOid] = await runCandidateDevelopmentSourcePair(
          signal,
          (batchSignal) =>
            sourceStep('verify-preregistration-blob', () =>
              sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', preregistrationSpec], batchSignal),
            ),
          (batchSignal) =>
            sourceStep('verify-preregistration-blob', () =>
              sourceGit.text(repositoryRoot, ['rev-parse', preregistrationSpec], batchSignal),
            ),
        )
        if (preregistrationBlobOid !== preregistration.blobOid) {
          throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-blob', {
            revision: preregistration.sourceRevision,
            path: preregistration.path,
            expected: preregistration.blobOid,
            observed: preregistrationBlobOid,
          })
        }
        await sourceStep('verify-preregistration-lineage', () =>
          sourceGit.text(
            repositoryRoot,
            ['merge-base', '--is-ancestor', preregistration.sourceRevision, sourceRevision],
            signal,
          ),
        )
      }
      const moduleSpec = `${sourceRevision}:${moduleRepositoryPath.success}`
      const sourceManifestSpec = `${sourceRevision}:${sourceManifestRepositoryPath.success}`
      const [moduleGitBytes, sourceManifestGitBytes] = await runCandidateDevelopmentSourcePair(
        signal,
        (batchSignal) =>
          sourceStep('verify-module-blob', () =>
            sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', moduleSpec], batchSignal),
          ),
        (batchSignal) =>
          sourceStep('verify-source-manifest-blob', () =>
            sourceGit.bytes(repositoryRoot, ['cat-file', 'blob', sourceManifestSpec], batchSignal),
          ),
      )
      const sourceManifestJson = await sourceStep(
        'decode-source-manifest',
        async () => JSON.parse(sourceManifestGitBytes.toString('utf8')) as unknown,
      )
      const sourceManifest = decodeCandidateDevelopmentSourceManifest(sourceManifestJson)
      if (Result.isFailure(sourceManifest)) {
        throw new CandidateDevelopmentSourceVerificationError('decode-source-manifest', sourceManifest.failure)
      }
      if (sourceManifest.success.modulePath !== moduleRepositoryPath.success) {
        throw new CandidateDevelopmentSourceVerificationError('verify-source-paths', {
          expected: moduleRepositoryPath.success,
          observed: sourceManifest.success.modulePath,
        })
      }
      const moduleFormat = verifySelfContainedEsm(moduleGitBytes.toString('utf8'), moduleRepositoryPath.success)
      if (Result.isFailure(moduleFormat)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-module-format', moduleFormat.failure)
      }
      const [moduleBlobOid, sourceManifestBlobOid] = await runCandidateDevelopmentSourcePair(
        signal,
        (batchSignal) =>
          sourceStep('verify-module-blob', () =>
            sourceGit.text(repositoryRoot, ['rev-parse', moduleSpec], batchSignal),
          ),
        (batchSignal) =>
          sourceStep('verify-source-manifest-blob', () =>
            sourceGit.text(repositoryRoot, ['rev-parse', sourceManifestSpec], batchSignal),
          ),
      )
      const files: CandidateDevelopmentVerifiedSourceFiles = {
        schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
        sourceRevision,
        modulePath: moduleRepositoryPath.success,
        moduleBlobOid,
        moduleSha256: sha256Bytes(moduleGitBytes),
        sourceManifestPath: sourceManifestRepositoryPath.success,
        sourceManifestBlobOid,
        sourceManifestSha256: sha256Bytes(sourceManifestGitBytes),
        sourceManifest: sourceManifest.success as CandidateDevelopmentSourceManifest,
      }
      return {
        files,
        moduleUrl: `data:text/javascript;base64,${moduleGitBytes.toString('base64')}`,
      }
    },
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('resolve-repository', cause),
  })

const candidateDevelopmentArtifactSchemaVersion = 'bayn.candidate-development-artifact.v1' as const
const candidateDevelopmentArtifactEvaluationTimeoutMs = 120_000
const candidateDevelopmentArtifactInitializationTimeoutMs = 10_000

const candidateDevelopmentArtifactSource = (moduleUrl: string): string => {
  const prefix = 'data:text/javascript;base64,'
  if (!moduleUrl.startsWith(prefix)) throw new Error('candidate artifact URL is not a base64 JavaScript data URL')
  return Buffer.from(moduleUrl.slice(prefix.length), 'base64').toString('utf8')
}

const candidateDevelopmentArtifactContext = (): vm.Context => {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
    name: 'bayn-candidate-development-artifact',
  })
  vm.runInContext(
    `
      Object.defineProperty(globalThis, 'constructor', {
        value: null,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'prepareStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'captureStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Error.stackTraceLimit = 0
      for (const name of [
        'process',
        'Bun',
        'console',
        'Date',
        'Intl',
        'Loader',
        'Temporal',
        'performance',
        'crypto',
        'navigator',
        'fetch',
        'require',
        'module',
        'exports',
        'Promise',
        'ShadowRealm',
        'Atomics',
        'SharedArrayBuffer',
        'FinalizationRegistry',
        'WeakRef',
        'WebAssembly',
        'Worker',
        'SharedWorker',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'queueMicrotask',
      ]) {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        })
      }
      Object.defineProperty(Math, 'random', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      for (const [prototype, names] of [
        [String.prototype, ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']],
        [Number.prototype, ['toLocaleString']],
        [BigInt.prototype, ['toLocaleString']],
      ]) {
        for (const name of names) {
          Object.defineProperty(prototype, name, {
            value: undefined,
            writable: false,
            configurable: false,
          })
        }
      }
    `,
    context,
    { timeout: candidateDevelopmentArtifactInitializationTimeoutMs },
  )
  return context
}

const runCandidateDevelopmentArtifactEvaluation = (
  context: vm.Context,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): CandidateDevelopmentCommandEvaluation => {
  const verifiedSourceJson = JSON.stringify(verifiedSource)
  Object.defineProperty(context, '__candidateDevelopmentVerifiedSourceJson', {
    value: verifiedSourceJson,
    writable: false,
    configurable: true,
  })
  try {
    const output = vm.runInContext(
      `
        (() => {
          const evaluation = globalThis.__candidateDevelopmentArtifact.buildEvaluation(
            JSON.parse(globalThis.__candidateDevelopmentVerifiedSourceJson),
          )
          if (
            evaluation !== null &&
            (typeof evaluation === 'object' || typeof evaluation === 'function') &&
            typeof evaluation.then === 'function'
          ) {
            throw new TypeError('candidate artifact buildEvaluation must be synchronous')
          }
          const encoded = JSON.stringify(evaluation)
          if (typeof encoded !== 'string') {
            throw new TypeError('candidate artifact evaluation must be JSON serializable')
          }
          return encoded
        })()
      `,
      context,
      { timeout: candidateDevelopmentArtifactEvaluationTimeoutMs },
    )
    if (typeof output !== 'string') throw new TypeError('candidate artifact evaluation did not return JSON')
    const decoded = validateCandidateDevelopmentCommandEvaluation(JSON.parse(output) as unknown)
    if (Result.isFailure(decoded)) throw decoded.failure
    return decoded.success
  } finally {
    Reflect.deleteProperty(context, '__candidateDevelopmentVerifiedSourceJson')
  }
}

interface CandidateDevelopmentArtifactWorkerRequest {
  readonly _tag: 'CandidateDevelopmentArtifactWorkerRequest'
  readonly mode: 'definition' | 'evaluation'
  readonly moduleUrl: string
  readonly verifiedFiles: CandidateDevelopmentVerifiedSourceFiles
  readonly verifiedSource?: CandidateDevelopmentVerifiedSource
}

type CandidateDevelopmentArtifactWorkerResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

const candidateDevelopmentArtifactWorkerRequest = (
  value: unknown,
): value is CandidateDevelopmentArtifactWorkerRequest => {
  const request = recordOf(value)
  return (
    request?._tag === 'CandidateDevelopmentArtifactWorkerRequest' &&
    (request.mode === 'definition' || request.mode === 'evaluation') &&
    typeof request.moduleUrl === 'string' &&
    recordOf(request.verifiedFiles) !== undefined
  )
}

const cloneableWorkerError = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause
  return { name: cause.name, message: cause.message, stack: cause.stack }
}

const loadCandidateDevelopmentArtifactContext = async (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
): Promise<{ readonly context: vm.Context; readonly definition: unknown }> => {
  const source = candidateDevelopmentArtifactSource(moduleUrl)
  const moduleFormat = verifySelfContainedEsm(source, verifiedFiles.modulePath)
  if (Result.isFailure(moduleFormat)) throw moduleFormat.failure
  const context = candidateDevelopmentArtifactContext()
  const artifactModule = new vm.SourceTextModule(source, {
    context,
    identifier: `git:${verifiedFiles.sourceRevision}:${verifiedFiles.moduleBlobOid}`,
    initializeImportMeta: (meta) => Object.freeze(meta),
  })
  await artifactModule.link(() => {
    throw new TypeError('candidate artifact imports are prohibited')
  })
  await artifactModule.evaluate({ timeout: candidateDevelopmentArtifactInitializationTimeoutMs })
  const artifact = Reflect.get(artifactModule.namespace, 'candidateDevelopmentArtifact') as unknown
  Object.defineProperty(context, '__candidateDevelopmentArtifact', {
    value: artifact,
    writable: false,
    configurable: false,
  })
  const definitionJson = vm.runInContext(
    `
      (() => {
        if (
          globalThis.__candidateDevelopmentArtifact === null ||
          typeof globalThis.__candidateDevelopmentArtifact !== 'object'
        ) {
          throw new TypeError('candidateDevelopmentArtifact export is missing')
        }
        if (typeof globalThis.__candidateDevelopmentArtifact.buildEvaluation !== 'function') {
          throw new TypeError('candidateDevelopmentArtifact.buildEvaluation is missing')
        }
        return JSON.stringify({
          schemaVersion: globalThis.__candidateDevelopmentArtifact.schemaVersion,
          input: globalThis.__candidateDevelopmentArtifact.input,
          strategyProtocol: globalThis.__candidateDevelopmentArtifact.strategyProtocol,
        })
      })()
    `,
    context,
    { timeout: candidateDevelopmentArtifactInitializationTimeoutMs },
  )
  if (typeof definitionJson !== 'string') throw new TypeError('candidate artifact definition is not JSON')
  return { context, definition: JSON.parse(definitionJson) as unknown }
}

const runCandidateDevelopmentArtifactWorkerTask = async (
  request: CandidateDevelopmentArtifactWorkerRequest,
): Promise<unknown> => {
  const loaded = await loadCandidateDevelopmentArtifactContext(request.moduleUrl, request.verifiedFiles)
  if (request.mode === 'definition') return loaded.definition
  if (request.verifiedSource === undefined) throw new TypeError('candidate artifact verified source is missing')
  return runCandidateDevelopmentArtifactEvaluation(loaded.context, request.verifiedSource)
}

class CandidateDevelopmentArtifactWorkerError extends Data.TaggedError('CandidateDevelopmentArtifactWorkerError')<{
  readonly cause: unknown
}> {}

const candidateDevelopmentArtifactWorkerCause = (cause: unknown): unknown =>
  cause instanceof CandidateDevelopmentArtifactWorkerError ? cause.cause : cause

const runCandidateDevelopmentArtifactWorker = <A>(
  request: CandidateDevelopmentArtifactWorkerRequest,
): Effect.Effect<A, CandidateDevelopmentArtifactWorkerError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<A>((resolveWorker, rejectWorker) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: request })
        let settled = false
        const cleanup = () => {
          signal.removeEventListener('abort', abort)
          worker.removeAllListeners()
        }
        const settle = async (response: CandidateDevelopmentArtifactWorkerResponse) => {
          if (settled) return
          settled = true
          cleanup()
          try {
            await worker.terminate()
            if (response.ok) resolveWorker(response.value as A)
            else rejectWorker(response.error)
          } catch (cause) {
            rejectWorker(cause)
          }
        }
        const abort = () => {
          void settle({ ok: false, error: signal.reason ?? new Error('candidate artifact worker aborted') })
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        worker.once('message', (response: CandidateDevelopmentArtifactWorkerResponse) => {
          void settle(response)
        })
        worker.once('error', (error) => {
          void settle({ ok: false, error })
        })
        worker.once('exit', (code) => {
          if (!settled) void settle({ ok: false, error: new Error(`candidate artifact worker exited ${code}`) })
        })
      }),
    catch: (cause) => new CandidateDevelopmentArtifactWorkerError({ cause }),
  })

export const evaluateCandidateDevelopmentArtifact: CandidateDevelopmentModuleImporter = (moduleUrl, verifiedFiles) =>
  Effect.gen(function* () {
    const moduleLoadFailure = (cause: unknown): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      modulePath: verifiedFiles.modulePath,
      cause: candidateDevelopmentArtifactWorkerCause(cause),
    })
    const definitionValue = yield* runCandidateDevelopmentArtifactWorker<unknown>({
      _tag: 'CandidateDevelopmentArtifactWorkerRequest',
      mode: 'definition',
      moduleUrl,
      verifiedFiles,
    }).pipe(Effect.mapError(moduleLoadFailure))
    const definition = recordOf(definitionValue)
    if (definition?.schemaVersion !== candidateDevelopmentArtifactSchemaVersion) {
      return yield* Effect.fail<CandidateDevelopmentCommandFailure>({
        _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
        modulePath: verifiedFiles.modulePath,
        cause: new TypeError('candidate artifact schema version is invalid'),
      })
    }
    const input = yield* Effect.fromResult(decodeCandidateDevelopmentPreflightInput(definition.input)).pipe(
      Effect.mapError(moduleLoadFailure),
    )
    const strategyProtocol = yield* Effect.fromResult(
      decodeCandidateDevelopmentStrategyProtocol(definition.strategyProtocol),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const verifiedSource = yield* Effect.fromResult(bindCandidateDevelopmentVerifiedSource(verifiedFiles, input)).pipe(
      Effect.mapError(moduleLoadFailure),
    )
    const expectedProtocolHash = yield* Effect.fromResult(canonicalHashV1Result(strategyProtocol)).pipe(
      Effect.mapError(moduleLoadFailure),
    )
    if (expectedProtocolHash !== input.expectedStrategyProtocolHash) {
      return yield* Effect.fail<CandidateDevelopmentCommandFailure>({
        _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
        modulePath: verifiedFiles.modulePath,
        cause: new TypeError('candidate artifact strategy protocol hash differs from preflight'),
      })
    }
    const evaluation = (): Effect.Effect<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> =>
      runCandidateDevelopmentArtifactWorker<unknown>({
        _tag: 'CandidateDevelopmentArtifactWorkerRequest',
        mode: 'evaluation',
        moduleUrl,
        verifiedFiles,
        verifiedSource,
      }).pipe(
        Effect.flatMap((value) => Effect.fromResult(validateCandidateDevelopmentCommandEvaluation(value))),
        Effect.mapError(
          (cause): CandidateDevelopmentCommandFailure => ({
            _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
            cause: candidateDevelopmentArtifactWorkerCause(cause),
          }),
        ),
      )
    const program: ExecutableProgram = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input,
      strategyProtocol: strategyProtocol as CandidateDevelopmentStrategyProtocol,
      effects: {
        preregisterCandidate: () => Effect.fromResult(preregisterCandidateDevelopmentAttempt(verifiedSource)),
        loadDevelopmentData: () => Effect.succeed(undefined),
        evaluateDevelopment: (_data, _preflight, observedVerifiedSource) =>
          pipe(
            Result.all({
              expected: canonicalHashV1Result(verifiedSource),
              observed: canonicalHashV1Result(observedVerifiedSource),
            }),
            Result.mapError(
              (cause): CandidateDevelopmentCommandFailure => ({
                _tag: 'CandidateDevelopmentCommandHashFailed',
                cause,
              }),
            ),
            Result.flatMap(({ expected, observed }) =>
              expected === observed
                ? Result.succeed(undefined)
                : Result.fail(sourceVerificationFailure('verify-program-binding', { expected, observed })),
            ),
            Effect.fromResult,
            Effect.flatMap(evaluation),
          ),
      },
    }
    return { candidateDevelopmentProgram: program }
  })

const importCandidateDevelopmentModule: CandidateDevelopmentModuleImporter = evaluateCandidateDevelopmentArtifact

export const loadCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  sourceManifestPath: string,
  importer: CandidateDevelopmentModuleImporter = importCandidateDevelopmentModule,
  sourceVerifier: CandidateDevelopmentSourceVerifier = verifyCandidateDevelopmentSourceFiles,
): Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.gen(function* () {
    const before = yield* sourceVerifier(modulePath, sourceManifestPath)
    const module = yield* importer(before.moduleUrl, before.files)
    const after = yield* sourceVerifier(modulePath, sourceManifestPath)
    const beforeHash = yield* Effect.fromResult(
      canonicalHashV1Result(before).pipe(
        Result.mapError((cause) => sourceVerificationFailure('verify-post-import', cause)),
      ),
    )
    const afterHash = yield* Effect.fromResult(
      canonicalHashV1Result(after).pipe(
        Result.mapError((cause) => sourceVerificationFailure('verify-post-import', cause)),
      ),
    )
    if (beforeHash !== afterHash) {
      return yield* Effect.fail(
        sourceVerificationFailure('verify-post-import', {
          expected: beforeHash,
          observed: afterHash,
        }),
      )
    }
    const program = yield* Effect.fromResult(
      validateCandidateDevelopmentExecutableProgram(recordOf(module)?.candidateDevelopmentProgram),
    )
    const verifiedSource = yield* Effect.fromResult(bindCandidateDevelopmentVerifiedSource(before.files, program.input))
    return { program, verifiedSource }
  })

if (!isMainThread && candidateDevelopmentArtifactWorkerRequest(workerData)) {
  void runCandidateDevelopmentArtifactWorkerTask(workerData).then(
    (value) => parentPort?.postMessage({ ok: true, value } satisfies CandidateDevelopmentArtifactWorkerResponse),
    (error) =>
      parentPort?.postMessage({
        ok: false,
        error: cloneableWorkerError(error),
      } satisfies CandidateDevelopmentArtifactWorkerResponse),
  )
}

const modulePath = process.argv.at(2)
const sourceManifestPath = process.argv.at(3)

const executeLoadedCandidateDevelopmentProgram = (
  loaded: CandidateDevelopmentLoadedExecutableProgram,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  runCandidateDevelopmentCommand(loaded.program, loaded.verifiedSource).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
        cause,
      }),
    ),
  )

const main = (
  modulePath === undefined
    ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandModulePathMissing' })
    : sourceManifestPath === undefined
      ? Effect.fail<CandidateDevelopmentCommandFailure>({
          _tag: 'CandidateDevelopmentCommandSourceManifestPathMissing',
        })
      : loadCandidateDevelopmentExecutableProgram(modulePath, sourceManifestPath).pipe(
          Effect.flatMap(executeLoadedCandidateDevelopmentProgram),
        )
).pipe(Effect.annotateLogs({ operation: 'candidate-development-command' }))

class CandidateDevelopmentCommandError extends Data.TaggedError('CandidateDevelopmentCommandError')<{
  readonly failure: CandidateDevelopmentCommandFailure
}> {}

if (import.meta.main && isMainThread) {
  NodeRuntime.runMain(main.pipe(Effect.mapError((failure) => new CandidateDevelopmentCommandError({ failure }))), {
    disableErrorReporting: false,
  })
}
