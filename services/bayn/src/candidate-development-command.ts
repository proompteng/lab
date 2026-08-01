import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import * as vm from 'node:vm'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Data, Effect, pipe, Result, Schema, SchemaAST, SchemaIssue } from 'effect'
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'

import {
  candidateDevelopmentCalendarContract,
  candidateDevelopmentComparisonSemantics,
  candidateDevelopmentDoubledCostContract,
  expectedCandidateDevelopmentRebalanceSchedule,
  buildCandidateDevelopmentComparisonSemanticsEvidence,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  runCandidateDevelopment,
  validateCandidateDevelopmentComparisonSeriesBinding,
  type CandidateDevelopmentAttemptIssue,
  type CandidateDevelopmentComparisonSemanticsIssue,
  type CandidateDevelopmentDoubledCostIssue,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentEvaluation,
  type CandidateDevelopmentGeometryFail,
  type CandidateDevelopmentPreflightIssue,
  type CandidateDevelopmentPreflightPass,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  candidate20PrecommitInvalidation,
  deriveCandidateDevelopmentLegacyPriorTrialsHash,
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentTrialHistory,
  type CandidateDevelopmentTrialHistory,
} from './candidate-development-trial-history'
import {
  deriveCandidateDevelopmentDecision,
  type CandidateDevelopmentDecision as CandidateDevelopmentCommandDecision,
  type CandidateDevelopmentNextPreregistration,
} from './candidate-development-decision'
import {
  type DailyPerformancePoint,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  DecisionPlanSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
} from './evidence-contracts'
import { elapsedCalendarDays, MICROS, referencePriceMicros, type ExecutionModelFailure } from './execution-model'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { DIRECT_VOLATILITY_WINDOW, ExecutionModelSchema } from './protocol'
import type { QualificationStatisticsFailure } from './qualification-statistics'
import { prepareQualificationSeries } from './qualification-statistics'
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
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  strictParseOptions,
} from './schemas'
import { calculateExactPerformanceMetrics, buildVerdict } from './simulation/metrics'
import {
  alignBars,
  directVolatilityWeights,
  simulate,
  type AlignedSession,
  type SimulationDomainFailure,
  type SimulationTarget,
} from './simulation'
import { reconcileMarkedEquity, type SimulationReconciliationIssue } from './simulation-reconciliation'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type DecisionPlan,
  type EvaluationResult,
  type InputManifest,
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
  readonly strategyIdentityHash?: string
  readonly candidateDevelopmentProtocolHash?: string
  readonly calendarHash?: string
  readonly priorTrialsHash?: string
  readonly modulePath: string
  readonly moduleSha256?: string
  readonly moduleFormat: 'self-contained-esm-v1'
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
}

export interface CandidateDevelopmentArtifactStructuralBindings {
  readonly schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyIdentityHash: string
  readonly candidateDevelopmentProtocolHash: string
  readonly calendarHash: string
  readonly priorTrialsHash: string
  readonly modulePath: string
  readonly sourceManifestPath: string
}

export interface CandidateDevelopmentMomentumStrategyIdentity {
  readonly schemaVersion: 'bayn.candidate-development-strategy-identity.v1'
  readonly family: string
  readonly identifier: string
  readonly researchSources: readonly [string, string, string]
  readonly parameters: {
    readonly id: string
    readonly lookbackSessions: number
    readonly volatilityWindowSessions: number
    readonly annualizationSessions: number
    readonly riskAssets: readonly [string, string]
    readonly defensiveAsset: string
    readonly absoluteMomentumThreshold: number
    readonly selectedAssetWeight: number
    readonly relativeMomentumTieBreak: string
  }
  readonly input: string
  readonly relativeMomentum: string
  readonly absoluteMomentum: string
  readonly defensive: string
  readonly allocation: string
  readonly schedule: string
  readonly terminal: string
  readonly missingData: string
  readonly doubledCost: string
}

export interface CandidateDevelopmentInverseVolatilityStrategyIdentity {
  readonly schemaVersion: 'bayn.candidate-development-strategy-identity.v2'
  readonly family: 'inverse-volatility-risk-diversification'
  readonly identifier: string
  readonly researchSources: readonly [string, string, string]
  readonly parameters: {
    readonly id: string
    readonly lookbackSessions: number
    readonly annualizationSessions: number
    readonly riskAssets: readonly [string, string]
    readonly covarianceEstimator: 'sample'
    readonly targetAnnualizedVolatility: number
    readonly maximumGrossExposure: number
  }
  readonly input: string
  readonly weighting: string
  readonly riskScaling: string
  readonly allocation: string
  readonly schedule: string
  readonly terminal: string
  readonly missingData: string
  readonly doubledCost: string
}

export type CandidateDevelopmentStrategyIdentity =
  | CandidateDevelopmentMomentumStrategyIdentity
  | CandidateDevelopmentInverseVolatilityStrategyIdentity

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

export interface CandidateDevelopmentArtifactRuntimeInput extends CandidateDevelopmentVerifiedSource {
  readonly runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1'
  readonly preflightInput: CandidateDevelopmentPreflightInput
  readonly marketData: CandidateDevelopmentMarketDataWitness
}

export interface CandidateDevelopmentPlannedDecision extends DecisionPlan {
  readonly executionDate: IsoDate
}

export interface CandidateDevelopmentStrategyPlan {
  readonly schemaVersion: 'bayn.candidate-development-strategy-plan.v1'
  readonly decisions: readonly CandidateDevelopmentPlannedDecision[]
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
  readonly strategyIdentity?: CandidateDevelopmentStrategyIdentity
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
        | 'decode-preregistration'
        | 'decode-source-manifest'
        | 'verify-source-paths'
        | 'verify-head'
        | 'verify-module-blob'
        | 'verify-module-format'
        | 'verify-preregistration-blob'
        | 'verify-preregistration-lineage'
        | 'verify-preregistration-module-novelty'
        | 'verify-repository-integrity'
        | 'verify-source-manifest-blob'
        | 'verify-program-binding'
        | 'verify-runtime-market-data'
        | 'verify-attempt-authorization'
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

export const candidateDevelopmentCommandFailureOutputSchemaVersion =
  'bayn.candidate-development-command-failure.v1' as const
export const candidateDevelopmentCommandFailureOutputMaxBytes = 16 * 1024

const candidateDevelopmentCommandFailureProjectionMaxDepth = 6
const candidateDevelopmentCommandFailureProjectionMaxNodes = 24
const candidateDevelopmentCommandFailureProjectionMaxScalars = 48
const candidateDevelopmentCommandFailureProjectionListPrefixLength = 8
const candidateDevelopmentCommandFailureProjectionMaxObjectEntries = 8
const candidateDevelopmentCommandFailureProjectionMaxTokenLength = 96
const candidateDevelopmentCommandSchemaProjectionMaxDepth = 10

const candidateDevelopmentCommandFailureScalarFields = [
  'stage',
  'phase',
  'step',
  'operation',
  'reason',
  'series',
  'material',
  'field',
  'index',
  'status',
  'expectedStatus',
  'observedStatus',
  'actualType',
  'source',
  'target',
  'kind',
  'side',
  'metric',
  'gate',
  'disposition',
  'candidateOrdinal',
  'priorTrialCount',
  'expectedCandidateOrdinal',
  'foldIndex',
  'gateIndex',
  'observationIndex',
] as const

const candidateDevelopmentCommandFailureListFields = [
  'failedGateNames',
  'expectedGateNames',
  'observedGateNames',
] as const

const candidateDevelopmentCommandFailureNestedFields = ['cause', 'preflight', 'failure', 'issue'] as const

type CandidateDevelopmentCommandFailureProjectionRejection =
  | 'cycle'
  | 'depth-limit'
  | 'detail-limit'
  | 'invalid-mismatch'
  | 'invalid-preflight'
  | 'introspection-failed'
  | 'invalid-tag'
  | 'non-plain-object'
  | 'output-limit'
  | 'untyped-object'
  | 'unsupported-value'

interface CandidateDevelopmentCommandFailureProjectionBudget {
  nodes: number
  scalars: number
}

interface CandidateDevelopmentCommandFailureListWindow {
  readonly prefixLength: number
  readonly omittedCount: number
}

type CandidateDevelopmentCommandProjectedList<T> =
  | readonly T[]
  | {
      readonly items: readonly T[]
      readonly omittedCount: number
    }

type CandidateDevelopmentCommandFailureProperty =
  | { readonly _tag: 'Absent' }
  | { readonly _tag: 'Rejected' }
  | { readonly _tag: 'Value'; readonly value: unknown }

const candidateDevelopmentCommandSchemaTags = new Set([
  'SchemaError',
  'Filter',
  'Encoding',
  'Pointer',
  'Composite',
  'AnyOf',
  'InvalidType',
  'InvalidValue',
  'MissingKey',
  'UnexpectedKey',
  'Forbidden',
  'OneOf',
])

const candidateDevelopmentCommandIsSchemaError = (value: unknown): boolean => {
  try {
    return Schema.isSchemaError(value)
  } catch {
    return false
  }
}

const candidateDevelopmentCommandIsSchemaIssue = (value: unknown): value is SchemaIssue.Issue => {
  try {
    return SchemaIssue.isIssue(value)
  } catch {
    return false
  }
}

const candidateDevelopmentCommandIsSchemaAst = (value: unknown): value is SchemaAST.AST => {
  try {
    return SchemaAST.isAST(value)
  } catch {
    return false
  }
}

const rejectedCandidateDevelopmentCommandFailureDetail = (
  reason: CandidateDevelopmentCommandFailureProjectionRejection,
): Readonly<Record<string, unknown>> => ({
  _tag: 'CandidateDevelopmentCommandFailureDetailRejected',
  reason,
})

const readCandidateDevelopmentCommandFailureProperty = (
  value: object,
  key: string,
): CandidateDevelopmentCommandFailureProperty => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return { _tag: 'Absent' }
    return 'value' in descriptor ? { _tag: 'Value', value: descriptor.value } : { _tag: 'Rejected' }
  } catch {
    return { _tag: 'Rejected' }
  }
}

const safeCandidateDevelopmentCommandFailureToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

const safeCandidateDevelopmentCommandFailureFieldPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)|(?:\[(?:0|[1-9][0-9]{0,5})\]))*$/.test(value)

const safeCandidateDevelopmentCommandFailureScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): string | number | boolean | null | undefined => {
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) return undefined
  if (safeCandidateDevelopmentCommandFailureToken(value)) {
    budget.scalars += 1
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    budget.scalars += 1
    return value
  }
  if (typeof value === 'boolean' || value === null) {
    budget.scalars += 1
    return value
  }
  return undefined
}

const safeCandidateDevelopmentCommandFailureFieldPathScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): string | undefined => {
  if (
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars ||
    !safeCandidateDevelopmentCommandFailureFieldPath(value)
  ) {
    return undefined
  }
  budget.scalars += 1
  return value
}

const prepareCandidateDevelopmentCommandFailureListWindow = (
  length: number,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  scalarItems: boolean,
): CandidateDevelopmentCommandFailureListWindow | undefined => {
  if (!Number.isSafeInteger(length) || length < 0) return undefined
  let prefixLength = Math.min(length, candidateDevelopmentCommandFailureProjectionListPrefixLength)
  if (scalarItems && budget.scalars + prefixLength > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    prefixLength = Math.max(0, candidateDevelopmentCommandFailureProjectionMaxScalars - budget.scalars - 1)
  }
  const omittedCount = length - prefixLength
  if (omittedCount > 0) {
    if (
      budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
      budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
    ) {
      return undefined
    }
    budget.nodes += 1
    budget.scalars += 1
  }
  return { prefixLength, omittedCount }
}

const finishCandidateDevelopmentCommandFailureList = <T>(
  items: readonly T[],
  window: CandidateDevelopmentCommandFailureListWindow,
): CandidateDevelopmentCommandProjectedList<T> =>
  window.omittedCount === 0 ? items : { items, omittedCount: window.omittedCount }

const safeCandidateDevelopmentCommandFailureTokenList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): CandidateDevelopmentCommandProjectedList<string> | undefined => {
  let isArray = false
  try {
    isArray = Array.isArray(value)
  } catch {
    return undefined
  }
  if (!isArray) return undefined

  const array = value as readonly unknown[]
  let length: number
  try {
    length = array.length
  } catch {
    return undefined
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length, budget, true)
  if (window === undefined) return undefined

  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(array, String(index))
    if (item._tag !== 'Value' || !safeCandidateDevelopmentCommandFailureToken(item.value)) return undefined
    output.push(item.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const candidateDevelopmentCommandFailureObjectSupported = (value: object): boolean => {
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype || value instanceof Error
  } catch {
    return false
  }
}

const projectCandidateDevelopmentCommandSchemaPath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const path = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(path, 'length')
  if (length._tag !== 'Value' || typeof length.value !== 'number') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const segment = readCandidateDevelopmentCommandFailureProperty(path, String(index))
    if (segment._tag === 'Rejected') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      continue
    }
    if (segment._tag !== 'Value') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      continue
    }
    if (
      (typeof segment.value === 'string' &&
        safeCandidateDevelopmentCommandFailureToken(segment.value) &&
        !/(?:credential|password|secret|token|api[-_]?key)/i.test(segment.value)) ||
      (typeof segment.value === 'number' &&
        Number.isSafeInteger(segment.value) &&
        segment.value >= 0 &&
        segment.value <= 999_999)
    ) {
      budget.scalars += 1
      output.push(segment.value)
    } else {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
    }
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandSchemaLiteral = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'string') return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  if (typeof value === 'number') return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  if (typeof value === 'boolean') return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  if (typeof value === 'bigint') {
    const decimal = value.toString(10)
    if (!/^-?[0-9]{1,96}$/.test(decimal)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return decimal
  }
  return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
}

const projectCandidateDevelopmentCommandSchemaAst = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!candidateDevelopmentCommandIsSchemaAst(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: value._tag }
  if (value._tag === 'Literal') {
    output.literal = projectCandidateDevelopmentCommandSchemaLiteral(value.literal, budget)
  } else if (value._tag === 'Union') {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      output.mode = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      budget.scalars += 1
      output.mode = value.mode
    }
    const window = prepareCandidateDevelopmentCommandFailureListWindow(value.types.length, budget, false)
    if (window === undefined) {
      output.types = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      const nextAncestors = new Set(ancestors)
      nextAncestors.add(value)
      const types = value.types
        .slice(0, window.prefixLength)
        .map((ast) => projectCandidateDevelopmentCommandSchemaAst(ast, depth + 1, nextAncestors, budget))
      output.types = finishCandidateDevelopmentCommandFailureList(types, window)
    }
  } else if (value._tag === 'Enum') {
    const window = prepareCandidateDevelopmentCommandFailureListWindow(value.enums.length, budget, true)
    if (window === undefined) {
      output.values = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    } else {
      const values = value.enums
        .slice(0, window.prefixLength)
        .map(([, enumValue]) => projectCandidateDevelopmentCommandSchemaLiteral(enumValue, budget))
      output.values = finishCandidateDevelopmentCommandFailureList(values, window)
    }
  }
  return output
}

const projectCandidateDevelopmentCommandSchemaIssueList = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const issues = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(issues, 'length')
  if (length._tag !== 'Value' || typeof length.value !== 'number') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output = issues
    .slice(0, window.prefixLength)
    .map((issue) => projectCandidateDevelopmentCommandSchemaIssue(issue, depth, ancestors, budget))
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandSchemaIssue = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!candidateDevelopmentCommandIsSchemaIssue(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: value._tag }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  switch (value._tag) {
    case 'Pointer':
      output.path = projectCandidateDevelopmentCommandSchemaPath(value.path, budget)
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'Composite':
      output.issues = projectCandidateDevelopmentCommandSchemaIssueList(value.issues, depth + 1, nextAncestors, budget)
      break
    case 'AnyOf':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      output.issues = projectCandidateDevelopmentCommandSchemaIssueList(value.issues, depth + 1, nextAncestors, budget)
      break
    case 'Filter':
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'Encoding':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      output.issue = projectCandidateDevelopmentCommandSchemaIssue(value.issue, depth + 1, nextAncestors, budget)
      break
    case 'InvalidType':
    case 'UnexpectedKey':
    case 'OneOf':
      output.expected = projectCandidateDevelopmentCommandSchemaAst(value.ast, depth + 1, nextAncestors, budget)
      break
    case 'InvalidValue':
    case 'MissingKey':
    case 'Forbidden':
      break
  }
  return output
}

const projectCandidateDevelopmentCommandSchemaError = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || !candidateDevelopmentCommandIsSchemaError(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (depth > candidateDevelopmentCommandSchemaProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const issue = readCandidateDevelopmentCommandFailureProperty(value, 'issue')
  budget.nodes += 1
  budget.scalars += 1
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  return {
    _tag: 'SchemaError',
    issue:
      issue._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : issue._tag === 'Value'
          ? projectCandidateDevelopmentCommandSchemaIssue(issue.value, depth + 1, nextAncestors, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  }
}

const candidateDevelopmentCommandOperationalErrorCategories = new Map<string, string>([
  ['candidate development report output interrupted', 'report-output-interrupted'],
  ['candidate Git batch output ended unexpectedly', 'git-batch-output-ended'],
  ['candidate Git batch output is incomplete', 'git-batch-output-incomplete'],
  ['candidate Git batch header exceeds the configured bound', 'git-batch-header-limit'],
  ['candidate Git batch object delimiter is invalid', 'git-batch-object-delimiter-invalid'],
  ['candidate Git batch reader is closed', 'git-batch-reader-closed'],
  ['candidate artifact URL is not a base64 JavaScript data URL', 'artifact-url-invalid'],
  ['candidate artifact worker aborted', 'artifact-worker-aborted'],
  ['candidate artifact buildEvaluation must be synchronous', 'artifact-evaluation-async'],
  ['candidate artifact evaluation must be JSON serializable', 'artifact-evaluation-not-json-serializable'],
  ['candidate artifact evaluation did not return JSON', 'artifact-evaluation-not-json'],
  ['candidate artifact imports are prohibited', 'artifact-imports-prohibited'],
  ['candidateDevelopmentArtifact export is missing', 'artifact-export-missing'],
  ['candidateDevelopmentArtifact.buildEvaluation is missing', 'artifact-build-evaluation-missing'],
  ['candidate artifact definition is not JSON', 'artifact-definition-not-json'],
  ['candidate artifact verified source is missing', 'artifact-verified-source-missing'],
  ['candidate artifact schema version is invalid', 'artifact-schema-version-invalid'],
  ['candidate artifact strategy protocol hash differs from preflight', 'artifact-strategy-protocol-hash-mismatch'],
])

const candidateDevelopmentCommandOperationalErrorCategory = (message: string): string | undefined =>
  candidateDevelopmentCommandOperationalErrorCategories.get(message) ??
  (message.startsWith('candidate Git object OID is invalid: ')
    ? 'git-object-oid-invalid'
    : message.startsWith('candidate Git object is missing: ')
      ? 'git-object-missing'
      : message.startsWith('candidate Git batch header is invalid: ')
        ? 'git-batch-header-invalid'
        : message.startsWith('candidate Git batch object mismatch: ')
          ? 'git-batch-object-mismatch'
          : message.startsWith('candidate Git batch exited ')
            ? 'git-batch-exit'
            : /^candidate artifact worker exited [0-9]+$/.test(message)
              ? 'artifact-worker-exit'
              : undefined)

const candidateDevelopmentCommandOperationalErrorSyscalls = new Map<string, string>([
  ['lstat', 'lstat'],
  ['open', 'open'],
  ['read', 'read'],
  ['readlink', 'readlink'],
  ['realpath', 'realpath'],
  ['spawn git', 'spawn-git'],
  ['stat', 'stat'],
])

const projectCandidateDevelopmentCommandOperationalErrorCode = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value))
    )
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const projectCandidateDevelopmentCommandOperationalErrorSyscall = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  const projected =
    typeof value === 'string' ? candidateDevelopmentCommandOperationalErrorSyscalls.get(value) : undefined
  if (projected === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return projected
}

const projectCandidateDevelopmentCommandOperationalErrorSignal = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (value !== null && (typeof value !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(value))) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const candidateDevelopmentCommandOperationalErrorNames = new Set(['Error', 'RangeError', 'SyntaxError', 'TypeError'])

const readCandidateDevelopmentCommandSerializedOperationalError = (
  value: object,
): { readonly name: string; readonly message: string } | undefined => {
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) return undefined
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (
    keys.some((key) => typeof key !== 'string' || (key !== 'name' && key !== 'message' && key !== 'stack')) ||
    !keys.includes('name') ||
    !keys.includes('message')
  ) {
    return undefined
  }
  const name = readCandidateDevelopmentCommandFailureProperty(value, 'name')
  const message = readCandidateDevelopmentCommandFailureProperty(value, 'message')
  const stack = readCandidateDevelopmentCommandFailureProperty(value, 'stack')
  if (
    name._tag !== 'Value' ||
    typeof name.value !== 'string' ||
    !candidateDevelopmentCommandOperationalErrorNames.has(name.value) ||
    message._tag !== 'Value' ||
    typeof message.value !== 'string' ||
    stack._tag === 'Rejected' ||
    (stack._tag === 'Value' && stack.value !== undefined && typeof stack.value !== 'string')
  ) {
    return undefined
  }
  return { name: name.value, message: message.value }
}

const projectCandidateDevelopmentCommandOperationalError = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (tag._tag === 'Value') return undefined
  const serialized =
    value instanceof Error ? undefined : readCandidateDevelopmentCommandSerializedOperationalError(value)
  if (!(value instanceof Error) && serialized === undefined) return undefined
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  const name =
    serialized?.name ??
    (value instanceof TypeError
      ? 'TypeError'
      : value instanceof RangeError
        ? 'RangeError'
        : value instanceof SyntaxError
          ? 'SyntaxError'
          : 'Error')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { name }

  const message =
    serialized === undefined
      ? readCandidateDevelopmentCommandFailureProperty(value, 'message')
      : ({ _tag: 'Value', value: serialized.message } as const)
  if (message._tag === 'Rejected') {
    output.category = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  } else if (message._tag === 'Value' && typeof message.value === 'string') {
    const category = candidateDevelopmentCommandOperationalErrorCategory(message.value)
    if (category !== undefined) {
      output.category =
        safeCandidateDevelopmentCommandFailureScalar(category, budget) ??
        rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
  }

  for (const field of ['code', 'errno', 'syscall', 'signal', 'killed'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
      continue
    }
    output[field] =
      field === 'code' || field === 'errno'
        ? projectCandidateDevelopmentCommandOperationalErrorCode(property.value, budget)
        : field === 'syscall'
          ? projectCandidateDevelopmentCommandOperationalErrorSyscall(property.value, budget)
          : field === 'signal'
            ? projectCandidateDevelopmentCommandOperationalErrorSignal(property.value, budget)
            : typeof property.value === 'boolean'
              ? projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
              : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const candidateDevelopmentCommandFailureDetailIsUntagged = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent'

const candidateDevelopmentCommandFailureDetailIsKnownMismatch = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value'

const candidateDevelopmentGeometryFailIntegerFields = [
  'requiredObservations',
  'availableObservations',
  'availableFoldCount',
  'requiredFoldCount',
  'observationDeficit',
] as const satisfies readonly (keyof CandidateDevelopmentGeometryFail)[]

const projectCandidateDevelopmentGeometryFail = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const status = readCandidateDevelopmentCommandFailureProperty(value, 'status')
  const reason = readCandidateDevelopmentCommandFailureProperty(value, 'reason')
  if (status._tag === 'Rejected' || reason._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    status._tag !== 'Value' ||
    status.value !== 'FAIL' ||
    reason._tag !== 'Value' ||
    reason.value !== 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
  }

  const integers: Partial<Record<(typeof candidateDevelopmentGeometryFailIntegerFields)[number], number>> = {}
  for (const field of candidateDevelopmentGeometryFailIntegerFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    if (
      property._tag !== 'Value' ||
      typeof property.value !== 'number' ||
      !Number.isSafeInteger(property.value) ||
      property.value < 0
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
    }
    integers[field] = property.value
  }

  const requiredObservations = integers.requiredObservations
  const availableObservations = integers.availableObservations
  const availableFoldCount = integers.availableFoldCount
  const requiredFoldCount = integers.requiredFoldCount
  const observationDeficit = integers.observationDeficit
  if (
    requiredObservations === undefined ||
    availableObservations === undefined ||
    availableFoldCount === undefined ||
    requiredFoldCount === undefined ||
    observationDeficit === undefined ||
    requiredObservations <= availableObservations ||
    requiredFoldCount <= availableFoldCount ||
    observationDeficit !== requiredObservations - availableObservations
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-preflight')
  }
  if (budget.scalars + 7 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  budget.scalars += 7
  return {
    status: 'FAIL',
    reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
    requiredObservations,
    availableObservations,
    availableFoldCount,
    requiredFoldCount,
    observationDeficit,
  }
}

const candidateDevelopmentCommandKnownMismatchFields = new Set([
  'boundedContentHash',
  'calendarHash',
  'candidateDevelopmentProtocolHash',
  'candidateOrdinal',
  'finalizedSnapshotContentHash',
  'inputManifestHash',
  'immutableCommit',
  'immutableHistoryCommitCount',
  'immutableHistoryTreeCount',
  'immutableTreeEntry',
  'immutableTreeObjectOid',
  'moduleFormat',
  'modulePath',
  'moduleSha256',
  'priorTrialCount',
  'priorTrialsHash',
  'shallowRepository',
  'schemaVersion',
  'snapshotId',
  'strategyIdentityHash',
  'strategyProtocolHash',
  'replaceRefs',
  'replacementConfig',
  'grafts',
  'alternates',
  'httpAlternates',
])

const safeCandidateDevelopmentCommandMismatchField = (value: unknown): value is string =>
  safeCandidateDevelopmentCommandFailureToken(value) &&
  (candidateDevelopmentCommandKnownMismatchFields.has(value) ||
    value.startsWith('artifact.') ||
    value.startsWith('marketData.') ||
    value.startsWith('source.') ||
    value.startsWith('trialHistory.'))

const safeCandidateDevelopmentCommandMismatchString = (value: string): boolean =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ||
  /^<[1-9][0-9]{0,8}$/.test(value) ||
  /^bayn\.[a-z0-9.-]+\.v[0-9]+$/.test(value) ||
  /^services\/bayn\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value) ||
  value === 'PASS' ||
  value === 'FAIL' ||
  value === 'false' ||
  value === 'true' ||
  value === 'self-contained-esm-v1'

type CandidateDevelopmentCommandTrialHistoryEvidenceMode = 'latest-development' | 'latest-terminal'

const candidateDevelopmentCommandNextPreregistrationField = 'trialHistory.nextCandidatePreregistration' as const
const candidateDevelopmentCommandNextPreregistrationExpectation =
  'a separately reviewed preregistration after the latest terminal development attempt' as const

const projectCandidateDevelopmentCommandTrialHistoryEvidence = (
  value: unknown,
  mode: CandidateDevelopmentCommandTrialHistoryEvidenceMode,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  budget.nodes += 1
  const output: Record<string, unknown> = {}
  for (const field of ['candidateOrdinal', 'priorTrialCount'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag !== 'Value'
          ? rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
          : property.value === undefined && mode === 'latest-development'
            ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
            : typeof property.value === 'number' && Number.isSafeInteger(property.value) && property.value >= 0
              ? projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
              : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const qualificationAttemptConsumed = readCandidateDevelopmentCommandFailureProperty(
    value,
    'qualificationAttemptConsumed',
  )
  if (mode === 'latest-development' || qualificationAttemptConsumed._tag !== 'Absent') {
    output.qualificationAttemptConsumed =
      qualificationAttemptConsumed._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : qualificationAttemptConsumed._tag === 'Value' && typeof qualificationAttemptConsumed.value === 'boolean'
          ? projectCandidateDevelopmentCommandValidationScalar(qualificationAttemptConsumed.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const candidateDevelopmentCommandFailureDetailIsMissingPreregistrationCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const latestTerminalEvidence = readCandidateDevelopmentCommandFailureProperty(value, 'latestTerminalEvidence')
  return (
    tag._tag === 'Absent' &&
    field._tag === 'Value' &&
    field.value === candidateDevelopmentCommandNextPreregistrationField &&
    expected._tag === 'Value' &&
    expected.value === candidateDevelopmentCommandNextPreregistrationExpectation &&
    observed._tag === 'Value' &&
    observed.value === null &&
    latestTerminalEvidence._tag === 'Value'
  )
}

const projectCandidateDevelopmentCommandMissingPreregistrationCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const latestTerminalEvidence = readCandidateDevelopmentCommandFailureProperty(value, 'latestTerminalEvidence')
  if (latestTerminalEvidence._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (latestTerminalEvidence._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }
  if (budget.scalars + 3 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  budget.scalars += 3
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  return {
    field: candidateDevelopmentCommandNextPreregistrationField,
    expected: candidateDevelopmentCommandNextPreregistrationExpectation,
    observed: null,
    latestTerminalEvidence: projectCandidateDevelopmentCommandTrialHistoryEvidence(
      latestTerminalEvidence.value,
      'latest-terminal',
      nextAncestors,
      budget,
    ),
  }
}

const projectCandidateDevelopmentCommandImmutableGitOid = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const projectCandidateDevelopmentCommandImmutableGitOidList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const values = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(values, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(values, String(index))
    output.push(
      item._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : item._tag === 'Value'
          ? projectCandidateDevelopmentCommandImmutableGitOid(item.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    )
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandRedactedMetadataList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const values = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(values, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (window === undefined || budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  const output = Array.from({ length: window.prefixLength }, () =>
    rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  )
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandRepositoryRelativePath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    isAbsolute(value) ||
    value.includes('\\')
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const candidateDevelopmentCommandImmutableCommitExpectation =
  'raw commit with lowercase 40-character tree and parent OIDs' as const
const candidateDevelopmentCommandImmutableTreeEntryExpectation =
  'raw Git tree entry with mode, name, NUL, and 20-byte object ID' as const
const candidateDevelopmentCommandModuleNoveltyExpectation =
  'evaluated module blob created after preregistration' as const
const candidateDevelopmentCommandPreregistrationBindingExpectation =
  'lowercase Git revision/blob OID and repository-relative preregistration path' as const
const candidateDevelopmentCommandLineageExpectation = 'proper ancestor of evaluated source revision' as const
const candidateDevelopmentCommandLineageUnreachable = 'not reachable through raw commit parents' as const

const projectCandidateDevelopmentCommandExactText = (
  value: unknown,
  expected: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (value !== expected) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return expected
}

const candidateDevelopmentCommandFailureDetailIsImmutableGitCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  return (
    field._tag === 'Value' &&
    (field.value === 'immutableCommit' ||
      field.value === 'immutableTreeEntry' ||
      field.value === 'immutableTreeObjectOid')
  )
}

const candidateDevelopmentCommandFailureDetailIsModuleNoveltyCause = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'preregistrationRevision')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'history')._tag === 'Value'

const candidateDevelopmentCommandFailureDetailIsLineageCause = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag === 'Absent' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'expected')._tag === 'Value' &&
  readCandidateDevelopmentCommandFailureProperty(value, 'observed')._tag === 'Value'

const projectCandidateDevelopmentCommandLineageCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (expected._tag !== 'Value' || observed._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const sameRevision =
    expected.value === candidateDevelopmentCommandLineageExpectation &&
    typeof observed.value === 'string' &&
    /^[0-9a-f]{40}$/.test(observed.value)
  const unreachable =
    typeof expected.value === 'string' &&
    /^[0-9a-f]{40} to be a proper ancestor of [0-9a-f]{40}$/.test(expected.value) &&
    observed.value === candidateDevelopmentCommandLineageUnreachable
  if (!sameRevision && !unreachable) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 2
  return {
    expected: expected.value,
    observed: observed.value,
  }
}

const projectCandidateDevelopmentCommandModuleNoveltyCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    !candidateDevelopmentCommandFailureObjectSupported(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail(
      budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ? 'detail-limit' : 'non-plain-object',
    )
  }
  const preregistrationRevision = readCandidateDevelopmentCommandFailureProperty(value, 'preregistrationRevision')
  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const history = readCandidateDevelopmentCommandFailureProperty(value, 'history')
  if (
    preregistrationRevision._tag === 'Rejected' ||
    modulePath._tag === 'Rejected' ||
    expected._tag === 'Rejected' ||
    observed._tag === 'Rejected' ||
    history._tag === 'Rejected'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    preregistrationRevision._tag !== 'Value' ||
    modulePath._tag !== 'Value' ||
    expected._tag !== 'Value' ||
    observed._tag !== 'Value' ||
    history._tag !== 'Value'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  let historyIsArray: boolean
  try {
    historyIsArray = Array.isArray(history.value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!historyIsArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const historyLength = readCandidateDevelopmentCommandFailureProperty(history.value as object, 'length')
  if (historyLength._tag !== 'Value' || historyLength.value !== 1) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  budget.nodes += 1
  return {
    preregistrationRevision: projectCandidateDevelopmentCommandImmutableGitOid(preregistrationRevision.value, budget),
    modulePath: projectCandidateDevelopmentCommandRepositoryRelativePath(modulePath.value, budget),
    expected: projectCandidateDevelopmentCommandExactText(
      expected.value,
      candidateDevelopmentCommandModuleNoveltyExpectation,
      budget,
    ),
    observed: projectCandidateDevelopmentCommandImmutableGitOid(observed.value, budget),
    history: projectCandidateDevelopmentCommandImmutableGitOidList(history.value, budget),
  }
}

const projectCandidateDevelopmentCommandImmutableGitCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  if (
    field._tag !== 'Value' ||
    (field.value !== 'immutableCommit' &&
      field.value !== 'immutableTreeEntry' &&
      field.value !== 'immutableTreeObjectOid')
  ) {
    return undefined
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  budget.nodes += 1
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  const output: Record<string, unknown> = { field: field.value }
  if (field.value === 'immutableCommit') {
    const commitOid = readCandidateDevelopmentCommandFailureProperty(value, 'commitOid')
    const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
    const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
    if (commitOid._tag === 'Rejected' || expected._tag === 'Rejected' || observed._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    output.commitOid =
      commitOid._tag === 'Value'
        ? projectCandidateDevelopmentCommandImmutableGitOid(commitOid.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    output.expected =
      expected._tag === 'Value'
        ? projectCandidateDevelopmentCommandExactText(
            expected.value,
            candidateDevelopmentCommandImmutableCommitExpectation,
            budget,
          )
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    if (
      observed._tag !== 'Value' ||
      typeof observed.value !== 'object' ||
      observed.value === null ||
      !candidateDevelopmentCommandFailureObjectSupported(observed.value)
    ) {
      output.observed = rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
      return output
    }
    if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
      output.observed = rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
      return output
    }
    budget.nodes += 1
    const treeOid = readCandidateDevelopmentCommandFailureProperty(observed.value, 'treeOid')
    const parentOids = readCandidateDevelopmentCommandFailureProperty(observed.value, 'parentOids')
    output.observed = {
      treeOid:
        treeOid._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : treeOid._tag === 'Absent' || treeOid.value === undefined
            ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
            : projectCandidateDevelopmentCommandImmutableGitOid(treeOid.value, budget),
      parentOids:
        parentOids._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : parentOids._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOidList(parentOids.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    }
    return output
  }

  const treeOid = readCandidateDevelopmentCommandFailureProperty(value, 'treeOid')
  const offset = readCandidateDevelopmentCommandFailureProperty(value, 'offset')
  if (treeOid._tag === 'Rejected' || offset._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  output.treeOid =
    treeOid._tag === 'Value'
      ? projectCandidateDevelopmentCommandImmutableGitOid(treeOid.value, budget)
      : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  output.offset =
    offset._tag === 'Value' &&
    typeof offset.value === 'number' &&
    Number.isSafeInteger(offset.value) &&
    offset.value >= 0
      ? projectCandidateDevelopmentCommandDomainNumber(offset.value, budget)
      : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (field.value === 'immutableTreeEntry') {
    const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
    output.expected =
      expected._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : expected._tag === 'Value'
          ? projectCandidateDevelopmentCommandExactText(
              expected.value,
              candidateDevelopmentCommandImmutableTreeEntryExpectation,
              budget,
            )
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  } else {
    const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
    output.observed =
      observed._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : observed._tag === 'Value'
          ? projectCandidateDevelopmentCommandImmutableGitOid(observed.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const projectCandidateDevelopmentCommandMismatchValue = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'string' && safeCandidateDevelopmentCommandMismatchString(value)) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value === 'boolean' || value === null) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (tag._tag === 'Value') {
    return projectCandidateDevelopmentCommandFailureDetail(value, 1, ancestors, budget)
  }

  const status = readCandidateDevelopmentCommandFailureProperty(value, 'status')
  const reason = readCandidateDevelopmentCommandFailureProperty(value, 'reason')
  if (
    status._tag === 'Value' &&
    status.value === 'FAIL' &&
    reason._tag === 'Value' &&
    reason.value === 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  ) {
    return projectCandidateDevelopmentGeometryFail(value, ancestors, budget)
  }

  return projectCandidateDevelopmentCommandValidationValue(value, ancestors, budget)
}

const projectCandidateDevelopmentCommandKnownMismatch = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  mode: 'program-strategy-protocol-hash' | 'verified-program-binding',
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  const field = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected' || field._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (expected._tag !== 'Value' || observed._tag !== 'Value') {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }

  if (mode === 'program-strategy-protocol-hash') {
    if (
      typeof expected.value !== 'string' ||
      typeof observed.value !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expected.value) ||
      !/^[0-9a-f]{64}$/.test(observed.value) ||
      field._tag !== 'Absent' ||
      budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
    }
    budget.nodes += 1
    budget.scalars += 2
    return { expected: expected.value, observed: observed.value }
  }

  if (field._tag === 'Value' && !safeCandidateDevelopmentCommandMismatchField(field.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-mismatch')
  }
  if (field._tag === 'Value') {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
  }
  budget.nodes += 1
  const mismatchAncestors = new Set(ancestors)
  mismatchAncestors.add(value)
  const mismatchField = field._tag === 'Value' ? field.value : undefined
  const projectMismatchValue = (mismatchValue: unknown): unknown =>
    mismatchField === 'alternates' || mismatchField === 'httpAlternates'
      ? projectCandidateDevelopmentCommandRedactedMetadataList(mismatchValue, budget)
      : mismatchField === 'trialHistory.latestTerminalEvidence'
        ? projectCandidateDevelopmentCommandTrialHistoryEvidence(
            mismatchValue,
            'latest-terminal',
            mismatchAncestors,
            budget,
          )
        : mismatchField === 'trialHistory.latestDevelopmentEvidence'
          ? projectCandidateDevelopmentCommandTrialHistoryEvidence(
              mismatchValue,
              'latest-development',
              mismatchAncestors,
              budget,
            )
          : projectCandidateDevelopmentCommandMismatchValue(mismatchValue, mismatchAncestors, budget)
  return {
    ...(field._tag === 'Value' ? { field: field.value } : {}),
    expected: projectMismatchValue(expected.value),
    observed: projectMismatchValue(observed.value),
  }
}

const candidateDevelopmentCommandValidationObjectFields = [
  'accountingFirst',
  'actual',
  'adjustment',
  'costBasisMicros',
  'current',
  'differenceMicros',
  'document',
  'evaluation',
  'exact',
  'executionDate',
  'first',
  'kind',
  'last',
  'marketValueMicros',
  'name',
  'passed',
  'priceMicros',
  'previous',
  'publicationSchemaVersion',
  'quantityMicros',
  'required',
  'runId',
  'schemaVersion',
  'selectedFirst',
  'sessionDate',
  'signalDate',
  'source',
  'sourceFeed',
  'status',
  'symbol',
  'withinTolerance',
] as const

const projectCandidateDevelopmentCommandRepositoryModulePath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^services\/bayn\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const projectCandidateDevelopmentCommandRepositoryPath = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith('/') ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../') ||
    value.includes('\\') ||
    !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const candidateDevelopmentCommandFailureDetailIsMalformedPreregistrationCause = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (
    readCandidateDevelopmentCommandFailureProperty(value, '_tag')._tag !== 'Absent' ||
    readCandidateDevelopmentCommandFailureProperty(value, 'field')._tag !== 'Absent' ||
    expected._tag !== 'Value' ||
    expected.value !== candidateDevelopmentCommandPreregistrationBindingExpectation ||
    observed._tag !== 'Value' ||
    typeof observed.value !== 'object' ||
    observed.value === null
  ) {
    return false
  }
  return (
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'sourceRevision')._tag !== 'Absent' &&
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'blobOid')._tag !== 'Absent' &&
    readCandidateDevelopmentCommandFailureProperty(observed.value, 'path')._tag !== 'Absent'
  )
}

const projectCandidateDevelopmentCommandMalformedPreregistrationCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes + 1 >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const expected = readCandidateDevelopmentCommandFailureProperty(value, 'expected')
  const observed = readCandidateDevelopmentCommandFailureProperty(value, 'observed')
  if (expected._tag === 'Rejected' || observed._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    expected._tag !== 'Value' ||
    expected.value !== candidateDevelopmentCommandPreregistrationBindingExpectation ||
    observed._tag !== 'Value' ||
    typeof observed.value !== 'object' ||
    observed.value === null ||
    !candidateDevelopmentCommandFailureObjectSupported(observed.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 2
  budget.scalars += 1
  const sourceRevision = readCandidateDevelopmentCommandFailureProperty(observed.value, 'sourceRevision')
  const blobOid = readCandidateDevelopmentCommandFailureProperty(observed.value, 'blobOid')
  const path = readCandidateDevelopmentCommandFailureProperty(observed.value, 'path')
  return {
    expected: candidateDevelopmentCommandPreregistrationBindingExpectation,
    observed: {
      sourceRevision:
        sourceRevision._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : sourceRevision._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOid(sourceRevision.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      blobOid:
        blobOid._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : blobOid._tag === 'Value'
            ? projectCandidateDevelopmentCommandImmutableGitOid(blobOid.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      path:
        path._tag === 'Rejected'
          ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
          : path._tag === 'Value'
            ? projectCandidateDevelopmentCommandRepositoryPath(path.value, budget)
            : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    },
  }
}

const projectCandidateDevelopmentCommandModulePath = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (tag !== 'CandidateDevelopmentCommandModuleLoadFailed') return {}
  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  if (modulePath._tag === 'Rejected') {
    return { modulePath: rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed') }
  }
  if (modulePath._tag !== 'Value') {
    return { modulePath: rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value') }
  }
  return { modulePath: projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget) }
}

const safeCandidateDevelopmentCommandValidationText = (value: string): boolean =>
  value.length > 0 &&
  value.length <= candidateDevelopmentCommandFailureProjectionMaxTokenLength &&
  !isAbsolute(value) &&
  !/(?:credential|password|secret|token|api[-_]?key|\/workspace\/|\\|@|:)/i.test(value) &&
  /^[A-Za-z0-9 ._/%<>=+-]+$/.test(value)

const projectCandidateDevelopmentCommandValidationScalar = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value === 'number') return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  if (typeof value === 'boolean' || value === null) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (typeof value !== 'string' || !safeCandidateDevelopmentCommandValidationText(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const candidateDevelopmentCommandModuleImportKinds = new Set<Bun.ImportKind>([
  'import-statement',
  'require-call',
  'require-resolve',
  'dynamic-import',
  'import-rule',
  'url-token',
  'internal',
  'entry-point-run',
  'entry-point-build',
])

const projectCandidateDevelopmentCommandModuleSpecifier = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > candidateDevelopmentCommandFailureProjectionMaxTokenLength ||
    !/^(?:node:[A-Za-z0-9][A-Za-z0-9._/-]*|@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*|\.\.?\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(
      value,
    )
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const projectCandidateDevelopmentCommandModuleImports = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray || ancestors.has(value as object)) {
    return rejectedCandidateDevelopmentCommandFailureDetail(isArray ? 'cycle' : 'unsupported-value')
  }
  const imports = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(imports, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (
    window === undefined ||
    budget.nodes + window.prefixLength + 1 > candidateDevelopmentCommandFailureProjectionMaxNodes
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(imports, String(index))
    if (
      item._tag !== 'Value' ||
      typeof item.value !== 'object' ||
      item.value === null ||
      !candidateDevelopmentCommandFailureObjectSupported(item.value)
    ) {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      continue
    }
    const kind = readCandidateDevelopmentCommandFailureProperty(item.value, 'kind')
    const path = readCandidateDevelopmentCommandFailureProperty(item.value, 'path')
    if (kind._tag === 'Rejected' || path._tag === 'Rejected') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      continue
    }
    budget.nodes += 1
    output.push({
      kind:
        kind._tag === 'Value' &&
        typeof kind.value === 'string' &&
        candidateDevelopmentCommandModuleImportKinds.has(kind.value as Bun.ImportKind)
          ? projectCandidateDevelopmentCommandValidationScalar(kind.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      path:
        path._tag === 'Value'
          ? projectCandidateDevelopmentCommandModuleSpecifier(path.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    })
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandModuleIdentifiers = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const identifiers = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(identifiers, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const identifier = readCandidateDevelopmentCommandFailureProperty(identifiers, String(index))
    if (
      identifier._tag !== 'Value' ||
      typeof identifier.value !== 'string' ||
      (identifier.value !== 'template-literal' && !forbiddenCandidateArtifactIdentifiers.has(identifier.value))
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output.push(identifier.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandModuleFormatCause = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    !candidateDevelopmentCommandFailureObjectSupported(value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail(
      budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ? 'detail-limit' : 'non-plain-object',
    )
  }

  const modulePath = readCandidateDevelopmentCommandFailureProperty(value, 'modulePath')
  const imports = readCandidateDevelopmentCommandFailureProperty(value, 'imports')
  const identifiers = readCandidateDevelopmentCommandFailureProperty(value, 'identifiers')
  const cause = readCandidateDevelopmentCommandFailureProperty(value, 'cause')
  if (
    modulePath._tag === 'Rejected' ||
    imports._tag === 'Rejected' ||
    identifiers._tag === 'Rejected' ||
    cause._tag === 'Rejected'
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  budget.nodes += 1
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (imports._tag === 'Absent' && identifiers._tag === 'Absent' && cause._tag === 'Value') {
    return {
      modulePath:
        modulePath._tag === 'Value'
          ? projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
      cause:
        projectCandidateDevelopmentCommandOperationalError(cause.value, nextAncestors, budget) ??
        rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    }
  }
  return {
    modulePath:
      modulePath._tag === 'Value'
        ? projectCandidateDevelopmentCommandRepositoryModulePath(modulePath.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    imports:
      imports._tag === 'Value'
        ? projectCandidateDevelopmentCommandModuleImports(imports.value, nextAncestors, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    identifiers:
      identifiers._tag === 'Value'
        ? projectCandidateDevelopmentCommandModuleIdentifiers(identifiers.value, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
  }
}

const projectCandidateDevelopmentCommandValidationValue = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
  depth: number = 0,
): unknown => {
  if (value === null || typeof value !== 'object') {
    return projectCandidateDevelopmentCommandValidationScalar(value, budget)
  }
  if (depth >= 2) return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray && !candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  budget.nodes += 1

  if (isArray) {
    const length = readCandidateDevelopmentCommandFailureProperty(value, 'length')
    if (
      length._tag !== 'Value' ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0
    ) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
    if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    const output: unknown[] = []
    for (let index = 0; index < window.prefixLength; index += 1) {
      const item = readCandidateDevelopmentCommandFailureProperty(value, String(index))
      if (item._tag === 'Rejected') {
        output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      } else if (item._tag === 'Value') {
        output.push(projectCandidateDevelopmentCommandValidationValue(item.value, nextAncestors, budget, depth + 1))
      } else {
        output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      }
    }
    return finishCandidateDevelopmentCommandFailureList(output, window)
  }

  const output: Record<string, unknown> = {}
  for (const field of candidateDevelopmentCommandValidationObjectFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : projectCandidateDevelopmentCommandValidationValue(property.value, nextAncestors, budget, depth + 1)
  }
  return Object.keys(output).length > 0 ? output : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
}

const projectCandidateDevelopmentCommandTargetWeights = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    keys.length > candidateDevelopmentCommandFailureProjectionMaxObjectEntries ||
    keys.some((key) => typeof key !== 'string' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(key))
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }

  budget.nodes += 1
  const output: Record<string, unknown> = {}
  for (const symbol of (keys as readonly string[]).toSorted()) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, symbol)
    if (property._tag === 'Rejected') {
      return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
    }
    if (property._tag !== 'Value' || typeof property.value !== 'number' || !Number.isFinite(property.value)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output[symbol] = projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
  }
  return output
}

const projectCandidateDevelopmentCommandCashYieldOrder = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const index = readCandidateDevelopmentCommandFailureProperty(value, 'index')
  const kind = readCandidateDevelopmentCommandFailureProperty(value, 'kind')
  if (index._tag === 'Rejected' || kind._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    index._tag !== 'Value' ||
    typeof index.value !== 'number' ||
    !Number.isSafeInteger(index.value) ||
    index.value < 0 ||
    kind._tag !== 'Value' ||
    (kind.value !== 'fill' && kind.value !== 'fee') ||
    budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  budget.nodes += 1
  budget.scalars += 2
  return { index: index.value, kind: kind.value }
}

const projectCandidateDevelopmentCommandValidationMismatchFields = (
  value: object,
  tag: string,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (
    tag !== 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' &&
    tag !== 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
    tag !== 'CandidateDevelopmentCommandEconomicGateInvalid'
  ) {
    return {}
  }
  const mismatchField = readCandidateDevelopmentCommandFailureProperty(value, 'field')
  const output: Record<string, unknown> = {}
  for (const field of ['expected', 'observed'] as const) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag === 'Value'
          ? tag === 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
            field === 'observed' &&
            mismatchField._tag === 'Value' &&
            mismatchField.value === 'benchmarks.terminalDecision'
            ? projectCandidateDevelopmentCommandTargetWeights(property.value, ancestors, budget)
            : tag === 'CandidateDevelopmentCommandMarkedEquityInvalid' &&
                field === 'observed' &&
                mismatchField._tag === 'Value' &&
                (mismatchField.value === 'baseline.cashYield.order' ||
                  mismatchField.value === 'stressed.cashYield.order')
              ? projectCandidateDevelopmentCommandCashYieldOrder(property.value, ancestors, budget)
              : projectCandidateDevelopmentCommandValidationValue(property.value, ancestors, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const projectCandidateDevelopmentCommandCanonicalJsonPath = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (tag !== 'CanonicalJsonFailure') return {}
  const path = readCandidateDevelopmentCommandFailureProperty(value, 'path')
  if (path._tag === 'Rejected') {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed') }
  }
  if (
    path._tag !== 'Value' ||
    typeof path.value !== 'string' ||
    path.value.length === 0 ||
    path.value.length > 256 ||
    !/^\$(?:(?:\.[A-Za-z0-9_-]+)|(?:\[(?:0|[1-9][0-9]*)\]))*$/.test(path.value)
  ) {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value') }
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return { path: rejectedCandidateDevelopmentCommandFailureDetail('detail-limit') }
  }
  budget.scalars += 1
  return { path: path.value }
}

type CandidateDevelopmentCommandDomainFieldKind =
  | 'boundary'
  | 'calendar-mismatch-value'
  | 'date-text'
  | 'decimal'
  | 'doubled-cost-run'
  | 'finite-number'
  | 'hash'
  | 'hash-list'
  | 'internal-path'
  | 'invalid-hash-token'
  | 'integer'
  | 'iso-date'
  | 'optional-iso-date'
  | 'safe-domain-scalar'
  | 'schema-version'
  | 'selected-benchmark'

type CandidateDevelopmentCommandTaggedDomainIssue =
  | CandidateDevelopmentAttemptIssue
  | CandidateDevelopmentDoubledCostIssue
  | CandidateDevelopmentPreflightIssue
  | CandidateDevelopmentComparisonSemanticsIssue
  | QualificationStatisticsFailure

const candidateDevelopmentCommandSelectedBenchmarks = new Set([
  'buy-and-hold',
  'candidate',
  'cash',
  'direct-volatility-timing',
  'not-applicable',
  'selected-benchmark',
])

const candidateDevelopmentCommandDoubledCostRuns = new Set(['baseline', 'stressed'])

const projectCandidateDevelopmentCommandDomainNumber = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'number') return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  if (Object.is(value, -0)) return '-0'
  if (Number.isFinite(value)) return value
  if (Number.isNaN(value)) return 'NaN'
  return value > 0 ? 'Infinity' : '-Infinity'
}

type CandidateDevelopmentCommandSimulationDomainFieldKind =
  | 'bigint-decimal'
  | 'hash'
  | 'integer'
  | 'iso-date'
  | 'number'
  | 'number-list'
  | 'optional-integer'
  | 'optional-iso-date'
  | 'optional-number'
  | 'safe-text'
  | 'scalar'
  | 'symbol'
  | 'symbol-list'

const candidateDevelopmentCommandSimulationDomainFields = {
  InvalidMonetaryValue: [
    ['operation', 'scalar'],
    ['value', 'number'],
    ['reason', 'scalar'],
  ],
  InvalidMicrosString: [
    ['field', 'scalar'],
    ['value', 'safe-text'],
  ],
  ManifestRowCountMismatch: [
    ['expected', 'integer'],
    ['observed', 'integer'],
  ],
  UnexpectedBarSymbol: [
    ['symbol', 'symbol'],
    ['universe', 'symbol-list'],
  ],
  DuplicateBar: [
    ['symbol', 'symbol'],
    ['sessionDate', 'iso-date'],
  ],
  ManifestSessionCountMismatch: [
    ['expected', 'integer'],
    ['observed', 'integer'],
  ],
  IncompleteSession: [
    ['sessionDate', 'iso-date'],
    ['expectedSymbols', 'symbol-list'],
    ['observedSymbols', 'symbol-list'],
  ],
  ManifestSessionBoundsMismatch: [
    ['expectedFirst', 'iso-date'],
    ['observedFirst', 'optional-iso-date'],
    ['expectedLast', 'iso-date'],
    ['observedLast', 'optional-iso-date'],
  ],
  MissingSession: [
    ['operation', 'scalar'],
    ['index', 'integer'],
    ['sessionCount', 'integer'],
  ],
  MissingRecordValue: [
    ['operation', 'scalar'],
    ['key', 'safe-text'],
    ['context', 'safe-text'],
  ],
  RecordAccessFailed: [
    ['operation', 'scalar'],
    ['key', 'safe-text'],
    ['context', 'safe-text'],
    ['reason', 'scalar'],
  ],
  InvalidStatisticInput: [
    ['statistic', 'scalar'],
    ['reason', 'scalar'],
    ['values', 'number-list'],
  ],
  InvalidWeight: [
    ['operation', 'scalar'],
    ['value', 'number'],
    ['reason', 'scalar'],
  ],
  InvalidPerformanceInput: [
    ['reason', 'scalar'],
    ['index', 'optional-integer'],
    ['value', 'optional-number'],
  ],
  InvalidFillAdjustment: [
    ['modeledFilledQuantityMicros', 'bigint-decimal'],
    ['adjustedFilledQuantityMicros', 'bigint-decimal'],
  ],
  CandidateDecisionMissing: [
    ['signalIndex', 'integer'],
    ['executionIndex', 'integer'],
  ],
  InvalidSimulationRange: [
    ['startIndex', 'integer'],
    ['sessionCount', 'integer'],
  ],
  DuplicateExecutionTarget: [['executionIndex', 'integer']],
  DecisionTargetMismatch: [
    ['signalDate', 'iso-date'],
    ['executionDate', 'iso-date'],
    ['decisionWeightsHash', 'hash'],
    ['targetWeightsHash', 'hash'],
  ],
  NegativeSimulationCash: [
    ['sessionDate', 'iso-date'],
    ['cashMicros', 'bigint-decimal'],
  ],
  UnsupportedSimulationExecutionModel: [
    ['actual', 'safe-text'],
    ['required', 'safe-text'],
  ],
  CanonicalizationFailed: [['operation', 'scalar']],
  ContractConstructionFailed: [['operation', 'scalar']],
  RuntimeStrategyMismatch: [
    ['observed', 'safe-text'],
    ['expected', 'safe-text'],
  ],
  RuntimeParameterSchemaMismatch: [
    ['observed', 'safe-text'],
    ['expected', 'safe-text'],
  ],
  RuntimeParameterHashMismatch: [
    ['observed', 'hash'],
    ['expected', 'hash'],
  ],
  InputManifestHashMismatch: [
    ['observed', 'hash'],
    ['expected', 'hash'],
  ],
  QualificationCalendarMismatch: [
    ['expectedCount', 'integer'],
    ['observedCount', 'integer'],
    ['expectedFirst', 'iso-date'],
    ['observedFirst', 'optional-iso-date'],
    ['expectedLast', 'iso-date'],
    ['observedLast', 'optional-iso-date'],
  ],
  NoEligibleMonthEndSignal: [],
  InsufficientComparableObservations: [
    ['observed', 'integer'],
    ['required', 'integer'],
  ],
  InvalidWindowRequirement: [
    ['field', 'scalar'],
    ['value', 'number'],
  ],
} as const satisfies Readonly<
  Record<
    SimulationDomainFailure['_tag'],
    readonly (readonly [string, CandidateDevelopmentCommandSimulationDomainFieldKind])[]
  >
>

const projectCandidateDevelopmentCommandSymbol = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return value
}

const projectCandidateDevelopmentCommandNumberList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const values = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(values, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(values, String(index))
    output.push(
      item._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : item._tag === 'Value'
          ? projectCandidateDevelopmentCommandDomainNumber(item.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    )
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandSimulationDomainFields = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!Object.hasOwn(candidateDevelopmentCommandSimulationDomainFields, tag)) return {}
  const fields =
    candidateDevelopmentCommandSimulationDomainFields[
      tag as keyof typeof candidateDevelopmentCommandSimulationDomainFields
    ]
  const output: Record<string, unknown> = {}
  for (const [field, kind] of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
      continue
    }
    output[field] =
      kind === 'bigint-decimal'
        ? projectCandidateDevelopmentCommandBigintDecimal(property.value, budget)
        : kind === 'hash'
          ? projectCandidateDevelopmentCommandDomainValue(property.value, 'hash', new Set(), budget)
          : kind === 'integer'
            ? projectCandidateDevelopmentCommandDomainValue(property.value, 'integer', new Set(), budget)
            : kind === 'iso-date'
              ? projectCandidateDevelopmentCommandDomainValue(property.value, 'iso-date', new Set(), budget)
              : kind === 'number'
                ? projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
                : kind === 'number-list'
                  ? projectCandidateDevelopmentCommandNumberList(property.value, budget)
                  : kind === 'optional-integer'
                    ? property.value === null
                      ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
                      : projectCandidateDevelopmentCommandDomainValue(property.value, 'integer', new Set(), budget)
                    : kind === 'optional-iso-date'
                      ? property.value === null
                        ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
                        : projectCandidateDevelopmentCommandDomainValue(property.value, 'iso-date', new Set(), budget)
                      : kind === 'optional-number'
                        ? property.value === null
                          ? projectCandidateDevelopmentCommandValidationScalar(null, budget)
                          : projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
                        : kind === 'safe-text'
                          ? projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
                          : kind === 'symbol'
                            ? projectCandidateDevelopmentCommandSymbol(property.value, budget)
                            : kind === 'symbol-list'
                              ? projectCandidateDevelopmentCommandSymbolList(property.value, budget)
                              : (safeCandidateDevelopmentCommandFailureScalar(property.value, budget) ??
                                rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
  }
  return output
}

type CandidateDevelopmentCommandSimulationReconciliationProblem = Extract<
  SimulationReconciliationIssue,
  { readonly problem: unknown }
>['problem']

type CandidateDevelopmentCommandSimulationReconciliationProblemFieldKind = 'failure' | 'scalar' | 'symbol-list'

const candidateDevelopmentCommandSimulationReconciliationProblemFields = {
  InvalidFormat: [['expected', 'scalar']],
  HashMismatch: [['expected', 'scalar']],
  CanonicalizationFailed: [['cause', 'failure']],
  OrderDecision: [
    ['orderId', 'scalar'],
    ['decisionId', 'scalar'],
  ],
  FillOrder: [
    ['fillId', 'scalar'],
    ['orderId', 'scalar'],
  ],
  MonetaryEventCashChange: [
    ['eventId', 'scalar'],
    ['eventKind', 'scalar'],
  ],
  OrderExecutionSession: [
    ['orderId', 'scalar'],
    ['decisionId', 'scalar'],
    ['actualSessionDate', 'scalar'],
    ['expectedSessionDate', 'scalar'],
  ],
  FillBinding: [
    ['fillId', 'scalar'],
    ['orderId', 'scalar'],
    ['field', 'scalar'],
    ['actual', 'scalar'],
    ['expected', 'scalar'],
  ],
  FillQuantity: [
    ['fillId', 'scalar'],
    ['orderId', 'scalar'],
    ['actualQuantityMicros', 'scalar'],
    ['expectedQuantityMicros', 'scalar'],
  ],
  FillTerms: [
    ['fillId', 'scalar'],
    ['field', 'scalar'],
    ['actualMicros', 'scalar'],
    ['expectedMicros', 'scalar'],
  ],
  FeeComponents: [
    ['feeId', 'scalar'],
    ['actualTotalMicros', 'scalar'],
    ['expectedTotalMicros', 'scalar'],
  ],
  FeeSchedule: [
    ['feeId', 'scalar'],
    ['field', 'scalar'],
    ['actualMicros', 'scalar'],
    ['expectedMicros', 'scalar'],
  ],
  CashChange: [
    ['cashChangeId', 'scalar'],
    ['sourceId', 'scalar'],
    ['field', 'scalar'],
    ['actual', 'scalar'],
    ['expected', 'scalar'],
  ],
  CashYield: [
    ['cashYieldId', 'scalar'],
    ['field', 'scalar'],
    ['actual', 'scalar'],
    ['expected', 'scalar'],
  ],
  DailyMark: [
    ['sessionDate', 'scalar'],
    ['field', 'scalar'],
    ['actualMicros', 'scalar'],
    ['expectedMicros', 'scalar'],
  ],
  PositionMark: [
    ['sessionDate', 'scalar'],
    ['symbol', 'scalar'],
    ['field', 'scalar'],
    ['actualMicros', 'scalar'],
    ['expectedMicros', 'scalar'],
  ],
  DuplicateIdentity: [
    ['entity', 'scalar'],
    ['id', 'scalar'],
  ],
  DuplicateFillForOrder: [
    ['orderId', 'scalar'],
    ['secondFillId', 'scalar'],
  ],
  DuplicateCashChangeForEvent: [
    ['eventId', 'scalar'],
    ['secondCashChangeId', 'scalar'],
  ],
  InvalidOrder: [
    ['rule', 'scalar'],
    ['orderId', 'scalar'],
    ['status', 'scalar'],
    ['requestedQuantityMicros', 'scalar'],
    ['filledQuantityMicros', 'scalar'],
    ['rejectionReason', 'scalar'],
    ['unfilledRemainder', 'scalar'],
    ['fillPresent', 'scalar'],
  ],
  InvalidMarkOrder: [
    ['previousSessionDate', 'scalar'],
    ['sessionDate', 'scalar'],
  ],
  DuplicateMarkedPosition: [
    ['sessionDate', 'scalar'],
    ['symbols', 'symbol-list'],
  ],
  UnsortedMarkedPositions: [
    ['sessionDate', 'scalar'],
    ['symbols', 'symbol-list'],
  ],
  NegativeCash: [
    ['eventId', 'scalar'],
    ['actualMicros', 'scalar'],
    ['minimumMicros', 'scalar'],
  ],
  NegativeLongPosition: [
    ['fillId', 'scalar'],
    ['symbol', 'scalar'],
    ['actualQuantityMicros', 'scalar'],
  ],
  DailyOutsideTolerance: [
    ['measure', 'scalar'],
    ['sessionDate', 'scalar'],
    ['differenceMicros', 'scalar'],
    ['toleranceMicros', 'scalar'],
  ],
  FinalOutsideTolerance: [
    ['measure', 'scalar'],
    ['differenceMicros', 'scalar'],
    ['toleranceMicros', 'scalar'],
  ],
  NegativeTolerance: [['toleranceMicros', 'scalar']],
  UnsupportedSimulationSchema: [
    ['actual', 'scalar'],
    ['expected', 'scalar'],
  ],
  EmptyDailyMarks: [],
  CashChangeCountMismatch: [
    ['cashChangeCount', 'scalar'],
    ['monetaryEventCount', 'scalar'],
  ],
  MissingSessionMark: [
    ['eventId', 'scalar'],
    ['eventSessionDate', 'scalar'],
    ['nextMarkSessionDate', 'scalar'],
  ],
  MissingOpenPositionMark: [
    ['sessionDate', 'scalar'],
    ['symbol', 'scalar'],
    ['quantityMicros', 'scalar'],
  ],
  MonetaryEventsAfterFinalMark: [
    ['firstEventId', 'scalar'],
    ['firstEventSessionDate', 'scalar'],
  ],
} as const satisfies Readonly<
  Record<
    CandidateDevelopmentCommandSimulationReconciliationProblem['_tag'],
    readonly (readonly [string, CandidateDevelopmentCommandSimulationReconciliationProblemFieldKind])[]
  >
>

type CandidateDevelopmentCommandSimulationReconciliationEvidence = Extract<
  SimulationReconciliationIssue,
  { readonly evidence: unknown }
>['evidence']

type CandidateDevelopmentCommandSimulationReconciliationComputation = Extract<
  SimulationReconciliationIssue,
  { readonly _tag: 'ComputationFailed' }
>['computation']

type CandidateDevelopmentCommandSimulationReconciliationIssueFieldKind =
  | 'computation'
  | 'evidence'
  | 'problem'
  | 'scalar'

const candidateDevelopmentCommandSimulationReconciliationIssueFields = {
  InvalidInteger: [
    ['expected', 'scalar'],
    ['evidence', 'evidence'],
  ],
  InvalidIdentity: [
    ['evidence', 'evidence'],
    ['problem', 'problem'],
  ],
  MissingReference: [['problem', 'problem']],
  EvidenceMismatch: [['problem', 'problem']],
  InvalidEvidenceState: [['problem', 'problem']],
  IncompleteEvidence: [['problem', 'problem']],
  ComputationFailed: [['computation', 'computation']],
} as const satisfies Readonly<
  Record<
    SimulationReconciliationIssue['_tag'],
    readonly (readonly [string, CandidateDevelopmentCommandSimulationReconciliationIssueFieldKind])[]
  >
>

const candidateDevelopmentCommandSimulationReconciliationComputationFields = {
  FillTerms: ['fillId', 'side', 'quantityMicros', 'referencePriceMicros', 'costMultiplierMicros'],
  FeeSchedule: ['feeId', 'fillCount', 'costMultiplierMicros'],
  CashYield: ['cashYieldId', 'cashMicros', 'elapsedDays', 'annualYieldBps'],
  PositionNotional: ['sessionDate', 'symbol', 'quantityMicros', 'priceMicros'],
} as const satisfies Readonly<
  Record<CandidateDevelopmentCommandSimulationReconciliationComputation['_tag'], readonly string[]>
>

const projectCandidateDevelopmentCommandSymbolList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const array = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(array, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(array, String(index))
    if (item._tag !== 'Value' || typeof item.value !== 'string' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(item.value)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output.push(item.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandSimulationReconciliationEvidence = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const kind = readCandidateDevelopmentCommandFailureProperty(value, 'kind')
  if (kind._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  if (
    kind._tag !== 'Value' ||
    typeof kind.value !== 'string' ||
    !safeCandidateDevelopmentCommandFailureToken(kind.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }
  const id = readCandidateDevelopmentCommandFailureProperty(value, 'id')
  if (id._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')

  let fields: readonly string[]
  switch (kind.value as CandidateDevelopmentCommandSimulationReconciliationEvidence['kind']) {
    case 'input':
    case 'simulation':
      fields = ['field', 'value']
      break
    case 'run':
      fields = ['id']
      break
    case 'decision':
      fields = ['id', 'signalDate']
      break
    case 'order':
      fields = id._tag === 'Value' ? ['id', 'sessionDate'] : ['orderId', 'field', 'value']
      break
    case 'fill':
      fields = id._tag === 'Value' ? ['id', 'sessionDate'] : ['fillId', 'field', 'value']
      break
    case 'fee':
      fields = id._tag === 'Value' ? ['id', 'sessionDate'] : ['feeId', 'field', 'value']
      break
    case 'cash-yield':
      fields = id._tag === 'Value' ? ['id', 'sessionDate'] : ['cashYieldId', 'field', 'value']
      break
    case 'cash-change':
      fields = id._tag === 'Value' ? ['id', 'sourceId', 'sessionDate'] : ['cashChangeId', 'field', 'value']
      break
    case 'daily-mark':
      fields = ['sessionDate', 'field', 'value']
      break
    case 'position':
      fields = ['sessionDate', 'symbol', 'field', 'value']
      break
    default:
      return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }

  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { kind: kind.value }
  for (const field of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag === 'Value'
          ? projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const projectCandidateDevelopmentCommandSimulationReconciliationComputation = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  if (
    tag._tag !== 'Value' ||
    typeof tag.value !== 'string' ||
    !Object.hasOwn(candidateDevelopmentCommandSimulationReconciliationComputationFields, tag.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }

  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: tag.value }
  const fields =
    candidateDevelopmentCommandSimulationReconciliationComputationFields[
      tag.value as keyof typeof candidateDevelopmentCommandSimulationReconciliationComputationFields
    ]
  for (const field of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag === 'Value'
          ? projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
          : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  return output
}

const projectCandidateDevelopmentCommandSimulationReconciliationProblem = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  if (
    tag._tag !== 'Value' ||
    !safeCandidateDevelopmentCommandFailureToken(tag.value) ||
    !Object.hasOwn(candidateDevelopmentCommandSimulationReconciliationProblemFields, tag.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }

  budget.nodes += 1
  budget.scalars += 1
  const output: Record<string, unknown> = { _tag: tag.value }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  const fields =
    candidateDevelopmentCommandSimulationReconciliationProblemFields[
      tag.value as keyof typeof candidateDevelopmentCommandSimulationReconciliationProblemFields
    ]
  for (const [field, kind] of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Rejected') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
      continue
    }
    if (property._tag !== 'Value') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
      continue
    }
    output[field] =
      kind === 'failure'
        ? projectCandidateDevelopmentCommandFailureDetail(property.value, depth + 1, nextAncestors, budget)
        : kind === 'symbol-list'
          ? projectCandidateDevelopmentCommandSymbolList(property.value, budget)
          : projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
  }
  return output
}

const projectCandidateDevelopmentCommandSimulationReconciliationIssueFields = (
  value: object,
  tag: string,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!Object.hasOwn(candidateDevelopmentCommandSimulationReconciliationIssueFields, tag)) return {}
  const output: Record<string, unknown> = {}
  const fields =
    candidateDevelopmentCommandSimulationReconciliationIssueFields[
      tag as keyof typeof candidateDevelopmentCommandSimulationReconciliationIssueFields
    ]
  for (const [field, kind] of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : property._tag !== 'Value'
          ? rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
          : kind === 'evidence'
            ? projectCandidateDevelopmentCommandSimulationReconciliationEvidence(property.value, ancestors, budget)
            : kind === 'problem'
              ? projectCandidateDevelopmentCommandSimulationReconciliationProblem(
                  property.value,
                  depth,
                  ancestors,
                  budget,
                )
              : kind === 'computation'
                ? projectCandidateDevelopmentCommandSimulationReconciliationComputation(
                    property.value,
                    ancestors,
                    budget,
                  )
                : projectCandidateDevelopmentCommandValidationScalar(property.value, budget)
  }
  return output
}

const projectCandidateDevelopmentCommandMarkedEquityCause = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return projectCandidateDevelopmentCommandFailureDetail(value, depth, ancestors, budget)
  const array = value as readonly unknown[]
  if (ancestors.has(array)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const length = readCandidateDevelopmentCommandFailureProperty(array, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value <= 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, false)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')

  budget.nodes += 1
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(array)
  const output: unknown[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(array, String(index))
    if (item._tag === 'Rejected') {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed'))
      continue
    }
    if (item._tag !== 'Value' || typeof item.value !== 'object' || item.value === null) {
      output.push(rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
      continue
    }
    const tag = readCandidateDevelopmentCommandFailureProperty(item.value, '_tag')
    output.push(
      tag._tag === 'Value' &&
        typeof tag.value === 'string' &&
        Object.hasOwn(candidateDevelopmentCommandSimulationReconciliationIssueFields, tag.value)
        ? projectCandidateDevelopmentCommandFailureDetail(item.value, depth, nextAncestors, budget)
        : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'),
    )
  }
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandHashList = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (!isArray) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const array = value as readonly unknown[]
  const length = readCandidateDevelopmentCommandFailureProperty(array, 'length')
  if (
    length._tag !== 'Value' ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const window = prepareCandidateDevelopmentCommandFailureListWindow(length.value, budget, true)
  if (window === undefined) return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  const output: string[] = []
  for (let index = 0; index < window.prefixLength; index += 1) {
    const item = readCandidateDevelopmentCommandFailureProperty(array, String(index))
    if (item._tag !== 'Value' || typeof item.value !== 'string' || !/^[0-9a-f]{64}$/.test(item.value)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    output.push(item.value)
  }
  budget.scalars += output.length
  return finishCandidateDevelopmentCommandFailureList(output, window)
}

const projectCandidateDevelopmentCommandBoundary = (
  value: unknown,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (value === undefined) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }
  if (
    budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes ||
    budget.scalars + 2 > candidateDevelopmentCommandFailureProjectionMaxScalars
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const signalDate = readCandidateDevelopmentCommandFailureProperty(value, 'signalDate')
  const executionDate = readCandidateDevelopmentCommandFailureProperty(value, 'executionDate')
  if (signalDate._tag === 'Rejected' || executionDate._tag === 'Rejected') {
    return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  }
  if (
    signalDate._tag !== 'Value' ||
    executionDate._tag !== 'Value' ||
    typeof signalDate.value !== 'string' ||
    typeof executionDate.value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(signalDate.value) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(executionDate.value)
  ) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  budget.nodes += 1
  budget.scalars += 2
  return { signalDate: signalDate.value, executionDate: executionDate.value }
}

const projectCandidateDevelopmentCommandDomainValue = (
  value: unknown,
  kind: CandidateDevelopmentCommandDomainFieldKind,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (kind === 'boundary') return projectCandidateDevelopmentCommandBoundary(value, ancestors, budget)
  if (kind === 'finite-number') return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  if (kind === 'hash-list') return projectCandidateDevelopmentCommandHashList(value, budget)
  if (kind === 'calendar-mismatch-value') {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return projectCandidateDevelopmentCommandDomainNumber(value, budget)
    }
    if (typeof value !== 'string') return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !/^[0-9a-f]{64}$/.test(value)) {
      return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
    }
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (kind === 'integer') {
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? projectCandidateDevelopmentCommandDomainNumber(value, budget)
      : rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (kind === 'safe-domain-scalar' && typeof value === 'number' && Number.isSafeInteger(value)) {
    return projectCandidateDevelopmentCommandDomainNumber(value, budget)
  }
  if (kind === 'safe-domain-scalar' && (typeof value === 'boolean' || value === null)) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return value
  }
  if (kind === 'optional-iso-date' && value === undefined) {
    if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
      return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
    }
    budget.scalars += 1
    return null
  }
  if (typeof value !== 'string') return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  const accepted =
    (kind === 'hash' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) ||
    (kind === 'iso-date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
    (kind === 'optional-iso-date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
    (kind === 'date-text' && (/^[0-9-]{1,32}$/.test(value) || /^not-[a-z0-9-]{1,88}$/.test(value))) ||
    (kind === 'decimal' && /^-?[0-9]{1,96}$/.test(value)) ||
    (kind === 'doubled-cost-run' && candidateDevelopmentCommandDoubledCostRuns.has(value)) ||
    (kind === 'internal-path' && /^comparisonSemantics(?:\.[A-Za-z0-9_-]+)*$/.test(value)) ||
    (kind === 'invalid-hash-token' && (/^[0-9A-Fa-f-]{1,96}$/.test(value) || /^not-[a-z0-9-]{1,88}$/.test(value))) ||
    (kind === 'schema-version' && /^bayn\.[a-z0-9.-]+\.v[0-9]+$/.test(value)) ||
    (kind === 'selected-benchmark' && candidateDevelopmentCommandSelectedBenchmarks.has(value)) ||
    (kind === 'safe-domain-scalar' &&
      (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ||
        /^\d{4}-\d{2}-\d{2}$/.test(value) ||
        /^bayn\.[a-z0-9.-]+\.v[0-9]+$/.test(value) ||
        candidateDevelopmentCommandSelectedBenchmarks.has(value)))
  if (!accepted) return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  budget.scalars += 1
  return value
}

type CandidateDevelopmentCommandExecutionModelFieldKind =
  | 'bigint-decimal'
  | 'decimal-text'
  | 'field-path'
  | 'iso-date'
  | 'number'
  | 'scalar'

const candidateDevelopmentCommandExecutionModelFields = {
  InvalidUnsignedInteger: [
    ['field', 'field-path'],
    ['value', 'decimal-text'],
    ['minimum', 'bigint-decimal'],
  ],
  InvalidFixedPointNumber: [
    ['field', 'field-path'],
    ['value', 'number'],
    ['scale', 'number'],
    ['reason', 'scalar'],
  ],
  InvalidIntegerNumber: [
    ['field', 'field-path'],
    ['value', 'number'],
    ['minimum', 'number'],
    ['maximum', 'number'],
  ],
  InvalidCeilingDivision: [
    ['numerator', 'bigint-decimal'],
    ['denominator', 'bigint-decimal'],
    ['minimumNumerator', 'bigint-decimal'],
    ['minimumDenominator', 'bigint-decimal'],
  ],
  NegativeUnsignedRoundHalfUpNumerator: [
    ['numerator', 'bigint-decimal'],
    ['denominator', 'bigint-decimal'],
    ['minimumNumerator', 'bigint-decimal'],
  ],
  NonPositiveUnsignedRoundHalfUpDenominator: [
    ['numerator', 'bigint-decimal'],
    ['denominator', 'bigint-decimal'],
    ['minimumDenominator', 'bigint-decimal'],
  ],
  InvalidQuantization: [
    ['operation', 'scalar'],
    ['value', 'bigint-decimal'],
    ['increment', 'bigint-decimal'],
    ['minimumValue', 'bigint-decimal'],
    ['minimumIncrement', 'bigint-decimal'],
  ],
  InvalidReferencePrice: [
    ['price', 'number'],
    ['reason', 'scalar'],
  ],
  InvalidDesiredQuantity: [
    ['equityMicros', 'bigint-decimal'],
    ['weight', 'number'],
    ['priceMicros', 'bigint-decimal'],
    ['reason', 'scalar'],
  ],
  InvalidFillTerms: [
    ['side', 'scalar'],
    ['quantityMicros', 'bigint-decimal'],
    ['referencePriceMicros', 'bigint-decimal'],
    ['costMultiplierMicros', 'bigint-decimal'],
    ['reason', 'scalar'],
  ],
  OrderOutcomeCanonicalizationFailed: [],
  InvalidFeeCostMultiplier: [
    ['costMultiplierMicros', 'bigint-decimal'],
    ['minimum', 'bigint-decimal'],
  ],
  InvalidCashYield: [
    ['cashMicros', 'bigint-decimal'],
    ['elapsedDays', 'number'],
    ['reason', 'scalar'],
  ],
  InvalidCashAccrualPeriod: [
    ['from', 'iso-date'],
    ['to', 'iso-date'],
  ],
  InvalidSaleCostBasis: [
    ['positionCostBasisMicros', 'bigint-decimal'],
    ['soldQuantityMicros', 'bigint-decimal'],
    ['positionQuantityMicros', 'bigint-decimal'],
    ['reason', 'scalar'],
  ],
  InvalidQuantityScale: [
    ['quantityMicros', 'bigint-decimal'],
    ['scalePpm', 'bigint-decimal'],
    ['minimumScalePpm', 'bigint-decimal'],
    ['maximumScalePpm', 'bigint-decimal'],
  ],
} as const satisfies Readonly<
  Record<
    ExecutionModelFailure['_tag'],
    readonly (readonly [string, CandidateDevelopmentCommandExecutionModelFieldKind])[]
  >
>

const projectCandidateDevelopmentCommandBigintDecimal = (
  value: unknown,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): unknown => {
  if (typeof value !== 'bigint') return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  const decimal = value.toString(10)
  if (!/^-?[0-9]{1,96}$/.test(decimal)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (budget.scalars >= candidateDevelopmentCommandFailureProjectionMaxScalars) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  budget.scalars += 1
  return decimal
}

const projectCandidateDevelopmentCommandExecutionModelFields = (
  value: object,
  tag: string,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (!Object.hasOwn(candidateDevelopmentCommandExecutionModelFields, tag)) return {}
  const fields =
    candidateDevelopmentCommandExecutionModelFields[tag as keyof typeof candidateDevelopmentCommandExecutionModelFields]
  const output: Record<string, unknown> = {}
  for (const [field, kind] of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      output[field] = rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
      continue
    }
    output[field] =
      kind === 'bigint-decimal'
        ? projectCandidateDevelopmentCommandBigintDecimal(property.value, budget)
        : kind === 'number'
          ? projectCandidateDevelopmentCommandDomainNumber(property.value, budget)
          : kind === 'field-path'
            ? (safeCandidateDevelopmentCommandFailureFieldPathScalar(property.value, budget) ??
              rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
            : kind === 'iso-date'
              ? projectCandidateDevelopmentCommandDomainValue(property.value, 'iso-date', new Set(), budget)
              : kind === 'decimal-text'
                ? projectCandidateDevelopmentCommandDomainValue(property.value, 'decimal', new Set(), budget)
                : (safeCandidateDevelopmentCommandFailureScalar(property.value, budget) ??
                  rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
  }
  return output
}

const candidateDevelopmentCommandFailureScalarIsSpecialized = (tag: string, field: string): boolean => {
  const executionFields = Object.hasOwn(candidateDevelopmentCommandExecutionModelFields, tag)
    ? candidateDevelopmentCommandExecutionModelFields[
        tag as keyof typeof candidateDevelopmentCommandExecutionModelFields
      ]
    : undefined
  if (executionFields?.some(([specializedField]) => specializedField === field) === true) return true
  const simulationFields = Object.hasOwn(candidateDevelopmentCommandSimulationDomainFields, tag)
    ? candidateDevelopmentCommandSimulationDomainFields[
        tag as keyof typeof candidateDevelopmentCommandSimulationDomainFields
      ]
    : undefined
  return simulationFields?.some(([specializedField]) => specializedField === field) === true
}

const candidateDevelopmentCommandTaggedDomainFields = {
  CandidateDevelopmentCandidateOrdinalInvalid: [],
  CandidateDevelopmentPriorTrialCountInvalid: [],
  CandidateDevelopmentAttemptLineageMismatch: [],
  CandidateDevelopmentBootstrapTailInfeasible: [
    ['bootstrapSamples', 'integer'],
    ['adjustedOneSidedAlpha', 'finite-number'],
    ['tailSampleCount', 'integer'],
    ['minimumTailSamples', 'integer'],
    ['maximumCandidateOrdinal', 'integer'],
  ],
  CandidateDevelopmentDoubledCostMultiplierMismatch: [
    ['run', 'doubled-cost-run'],
    ['expected', 'decimal'],
    ['observed', 'decimal'],
  ],
  CandidateDevelopmentDoubledCostProtocolDeviation: [
    ['baselineHash', 'hash'],
    ['stressedHash', 'hash'],
  ],
  CandidateDevelopmentDoubledCostHashFailed: [],
  CandidateDevelopmentGeometryIntegerInvalid: [['value', 'finite-number']],
  CandidateDevelopmentGeometryPositiveIntegerRequired: [['value', 'finite-number']],
  CandidateDevelopmentExecutionOutsideCalendar: [
    ['firstExecutionIndex', 'integer'],
    ['availableSessions', 'integer'],
  ],
  CandidateDevelopmentGeometryOverflow: [],
  CandidateDevelopmentFoldBoundaryMissing: [],
  CandidateDevelopmentCalendarDateInvalid: [['value', 'date-text']],
  CandidateDevelopmentCalendarNotStrictlyOrdered: [
    ['previous', 'iso-date'],
    ['current', 'iso-date'],
  ],
  CandidateDevelopmentCalendarMismatch: [
    ['expected', 'calendar-mismatch-value'],
    ['observed', 'calendar-mismatch-value'],
  ],
  CandidateDevelopmentCalendarHashFailed: [],
  CandidateDevelopmentLookbackInvalid: [
    ['featureLookbackSessions', 'integer'],
    ['maximumFeatureLookbackSessions', 'integer'],
  ],
  CandidateDevelopmentSignalScheduleNotStrictlyOrdered: [
    ['previous', 'iso-date'],
    ['current', 'iso-date'],
  ],
  CandidateDevelopmentSignalScheduleEmpty: [],
  CandidateDevelopmentSignalOutsideCalendar: [['signalDate', 'iso-date']],
  CandidateDevelopmentSignalScheduleMismatch: [
    ['expected', 'optional-iso-date'],
    ['observed', 'optional-iso-date'],
    ['expectedCount', 'integer'],
    ['observedCount', 'integer'],
  ],
  CandidateDevelopmentEligibleExecutionMissing: [['featureLookbackSessions', 'integer']],
  CandidateDevelopmentProtocolHashFailed: [],
  CandidateDevelopmentStrategyProtocolHashInvalid: [['observed', 'invalid-hash-token']],
  CandidateDevelopmentComparisonSemanticsShapeInvalid: [
    ['path', 'internal-path'],
    ['observed', 'safe-domain-scalar'],
  ],
  CandidateDevelopmentComparisonSemanticsSchemaMismatch: [
    ['expected', 'schema-version'],
    ['observed', 'safe-domain-scalar'],
  ],
  CandidateDevelopmentComparisonDevelopmentProtocolMismatch: [
    ['expected', 'hash'],
    ['observed', 'safe-domain-scalar'],
  ],
  CandidateDevelopmentComparisonStrategyProtocolMismatch: [
    ['expected', 'hash'],
    ['observed', 'safe-domain-scalar'],
  ],
  CandidateDevelopmentComparisonAnalysisFailed: [],
  CandidateDevelopmentComparisonSeriesProjectionFailed: [],
  CandidateDevelopmentBaselineStrategyProtocolMismatch: [
    ['expected', 'hash'],
    ['observed', 'hash'],
  ],
  CandidateDevelopmentComparisonSeriesRunMismatch: [
    ['expected', 'hash'],
    ['observed', 'hash'],
  ],
  CandidateDevelopmentComparisonSeriesWindowMismatch: [
    ['expected', 'optional-iso-date'],
    ['observed', 'optional-iso-date'],
    ['expectedCount', 'integer'],
    ['observedCount', 'integer'],
  ],
  CandidateDevelopmentComparisonRebalanceScheduleMismatch: [
    ['expected', 'optional-iso-date'],
    ['observed', 'optional-iso-date'],
    ['expectedCount', 'integer'],
    ['observedCount', 'integer'],
  ],
  CandidateDevelopmentComparisonSignalExecutionMismatch: [
    ['expected', 'boundary'],
    ['observed', 'boundary'],
    ['expectedCount', 'integer'],
    ['observedCount', 'integer'],
  ],
  CandidateDevelopmentComparisonAnalysisSchemaMismatch: [
    ['expected', 'schema-version'],
    ['observed', 'schema-version'],
  ],
  CandidateDevelopmentComparisonSemanticsHashFailed: [],
  CandidateDevelopmentComparisonBaselineMismatch: [
    ['expected', 'selected-benchmark'],
    ['observed', 'safe-domain-scalar'],
  ],
  CandidateDevelopmentAnnualizedReturnComparisonMismatch: [
    ['expected', 'finite-number'],
    ['observed', 'finite-number'],
  ],
  CandidateDevelopmentSelectedBenchmarkComparisonMismatch: [
    ['expected', 'selected-benchmark'],
    ['observedBootstrap', 'selected-benchmark'],
    ['observedWalkForward', 'selected-benchmark'],
  ],
  CandidateDevelopmentComparisonEvidenceMismatch: [
    ['expectedHash', 'hash'],
    ['observedHash', 'hash'],
  ],
  QualificationStatisticsSchemaInvalid: [],
  QualificationStatisticsCanonicalizationFailed: [],
  QualificationStatisticNotFinite: [['value', 'finite-number']],
  QualificationDateOrderInvalid: [
    ['previous', 'iso-date'],
    ['current', 'iso-date'],
  ],
  QualificationSeriesAlignmentFailed: [
    ['sessionDate', 'optional-iso-date'],
    ['strategyCount', 'integer'],
    ['buyAndHoldCount', 'integer'],
    ['directVolatilityCount', 'integer'],
  ],
  QualificationLineageInvalid: [['priorTrialRunIds', 'hash-list']],
  QualificationRandomIndexInvalid: [['maximum', 'integer']],
  QualificationSamplingBlockMissing: [['blockCount', 'integer']],
  QualificationWalkForwardBoundaryMissing: [
    ['testStart', 'integer'],
    ['testSessions', 'integer'],
    ['observationCount', 'integer'],
  ],
} as const satisfies Readonly<
  Record<
    CandidateDevelopmentCommandTaggedDomainIssue['_tag'],
    readonly (readonly [string, CandidateDevelopmentCommandDomainFieldKind])[]
  >
>

const projectCandidateDevelopmentCommandTaggedDomainFields = (
  value: object,
  tag: string,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  const fields = Object.hasOwn(candidateDevelopmentCommandTaggedDomainFields, tag)
    ? candidateDevelopmentCommandTaggedDomainFields[tag as keyof typeof candidateDevelopmentCommandTaggedDomainFields]
    : undefined
  if (fields === undefined) return {}
  const output: Record<string, unknown> = {}
  for (const [field, kind] of fields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    output[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : projectCandidateDevelopmentCommandDomainValue(property.value, kind, ancestors, budget)
  }
  return output
}

const projectCandidateDevelopmentCommandFailureDetail = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (candidateDevelopmentCommandIsSchemaError(value)) {
    return projectCandidateDevelopmentCommandSchemaError(value, depth, ancestors, budget)
  }
  if (candidateDevelopmentCommandIsSchemaIssue(value)) {
    return projectCandidateDevelopmentCommandSchemaIssue(value, depth, ancestors, budget)
  }
  if (depth > candidateDevelopmentCommandFailureProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const operationalError = projectCandidateDevelopmentCommandOperationalError(value, ancestors, budget)
  if (operationalError !== undefined) return operationalError

  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  if (tag._tag === 'Absent') return rejectedCandidateDevelopmentCommandFailureDetail('untyped-object')
  if (!safeCandidateDevelopmentCommandFailureToken(tag.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }
  if (candidateDevelopmentCommandSchemaTags.has(tag.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }

  budget.nodes += 1
  budget.scalars += 1
  const projected: Record<string, unknown> = { _tag: tag.value }
  const rejectedFields: string[] = []

  for (const field of candidateDevelopmentCommandFailureScalarFields) {
    if (candidateDevelopmentCommandFailureScalarIsSpecialized(tag.value, field)) continue
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      rejectedFields.push(field)
      continue
    }
    const scalar =
      field === 'field'
        ? safeCandidateDevelopmentCommandFailureFieldPathScalar(property.value, budget)
        : safeCandidateDevelopmentCommandFailureScalar(property.value, budget)
    if (scalar === undefined) rejectedFields.push(field)
    else projected[field] = scalar
  }

  for (const field of candidateDevelopmentCommandFailureListFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      rejectedFields.push(field)
      continue
    }
    const list = safeCandidateDevelopmentCommandFailureTokenList(property.value, budget)
    if (list === undefined) rejectedFields.push(field)
    else projected[field] = list
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  Object.assign(
    projected,
    projectCandidateDevelopmentCommandExecutionModelFields(value, tag.value, budget),
    projectCandidateDevelopmentCommandSimulationDomainFields(value, tag.value, budget),
    projectCandidateDevelopmentCommandTaggedDomainFields(value, tag.value, nextAncestors, budget),
    projectCandidateDevelopmentCommandValidationMismatchFields(value, tag.value, nextAncestors, budget),
    projectCandidateDevelopmentCommandCanonicalJsonPath(value, tag.value, budget),
    projectCandidateDevelopmentCommandModulePath(value, tag.value, budget),
    projectCandidateDevelopmentCommandSimulationReconciliationIssueFields(
      value,
      tag.value,
      depth,
      nextAncestors,
      budget,
    ),
  )
  for (const field of candidateDevelopmentCommandFailureNestedFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    projected[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : field === 'preflight' && tag.value === 'CandidateDevelopmentPreflightFailed'
          ? projectCandidateDevelopmentGeometryFail(property.value, nextAncestors, budget)
          : field === 'cause' && tag.value === 'CandidateDevelopmentCommandMarkedEquityInvalid'
            ? projectCandidateDevelopmentCommandMarkedEquityCause(property.value, depth + 1, nextAncestors, budget)
            : field === 'cause' &&
                tag.value === 'CandidateDevelopmentCommandProgramInvalid' &&
                projected.reason === 'strategy-protocol-hash-mismatch' &&
                candidateDevelopmentCommandFailureDetailIsUntagged(property.value)
              ? projectCandidateDevelopmentCommandKnownMismatch(
                  property.value,
                  nextAncestors,
                  budget,
                  'program-strategy-protocol-hash',
                )
              : field === 'cause' &&
                  tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                  projected.operation === 'verify-module-format' &&
                  candidateDevelopmentCommandFailureDetailIsUntagged(property.value)
                ? projectCandidateDevelopmentCommandModuleFormatCause(property.value, nextAncestors, budget)
                : field === 'cause' &&
                    tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                    projected.operation === 'verify-preregistration-blob' &&
                    candidateDevelopmentCommandFailureDetailIsMalformedPreregistrationCause(property.value)
                  ? projectCandidateDevelopmentCommandMalformedPreregistrationCause(
                      property.value,
                      nextAncestors,
                      budget,
                    )
                  : field === 'cause' &&
                      tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                      projected.operation === 'verify-preregistration-lineage' &&
                      candidateDevelopmentCommandFailureDetailIsLineageCause(property.value)
                    ? projectCandidateDevelopmentCommandLineageCause(property.value, nextAncestors, budget)
                    : field === 'cause' &&
                        tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                        projected.operation === 'verify-preregistration-module-novelty' &&
                        candidateDevelopmentCommandFailureDetailIsModuleNoveltyCause(property.value)
                      ? projectCandidateDevelopmentCommandModuleNoveltyCause(property.value, nextAncestors, budget)
                      : field === 'cause' &&
                          tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                          candidateDevelopmentCommandFailureDetailIsImmutableGitCause(property.value)
                        ? (projectCandidateDevelopmentCommandImmutableGitCause(property.value, nextAncestors, budget) ??
                          rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
                        : field === 'cause' &&
                            tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                            projected.operation === 'verify-program-binding' &&
                            candidateDevelopmentCommandFailureDetailIsMissingPreregistrationCause(property.value)
                          ? projectCandidateDevelopmentCommandMissingPreregistrationCause(
                              property.value,
                              nextAncestors,
                              budget,
                            )
                          : field === 'cause' &&
                              tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                              candidateDevelopmentCommandFailureDetailIsKnownMismatch(property.value)
                            ? projectCandidateDevelopmentCommandKnownMismatch(
                                property.value,
                                nextAncestors,
                                budget,
                                'verified-program-binding',
                              )
                            : projectCandidateDevelopmentCommandFailureDetail(
                                property.value,
                                depth + 1,
                                nextAncestors,
                                budget,
                              )
  }

  if (rejectedFields.length > 0) projected.rejectedFields = rejectedFields
  return projected
}

export const renderCandidateDevelopmentCommandFailure = (failure: CandidateDevelopmentCommandFailure): string => {
  const projectedFailure = projectCandidateDevelopmentCommandFailureDetail(failure, 0, new Set(), {
    nodes: 0,
    scalars: 0,
  })
  const rendered = `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandError',
      failure: projectedFailure,
    },
  })}\n`
  if (Buffer.byteLength(rendered, 'utf8') <= candidateDevelopmentCommandFailureOutputMaxBytes) return rendered

  const topLevelTag = projectedFailure._tag
  return `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandError',
      failure: {
        ...(safeCandidateDevelopmentCommandFailureToken(topLevelTag) ? { _tag: topLevelTag } : {}),
        detail: rejectedCandidateDevelopmentCommandFailureDetail('output-limit'),
      },
    },
  })}\n`
}

const renderCandidateDevelopmentCommandDefect = (): string =>
  `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandDefect',
      reason: 'unhandled-defect',
    },
  })}\n`

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

interface CandidateDevelopmentPerformanceBaseline {
  readonly equityMicros: string
  readonly cumulativeTurnoverMicros: string
  readonly cumulativeFeesMicros: string
  readonly cumulativeSpreadCostMicros: string
  readonly cumulativeSlippageCostMicros: string
  readonly cumulativeCashYieldMicros: string
}

const performanceBaselineFromPoint = (
  point: Pick<DailyPerformancePoint, keyof CandidateDevelopmentPerformanceBaseline>,
): CandidateDevelopmentPerformanceBaseline => ({
  equityMicros: point.equityMicros,
  cumulativeTurnoverMicros: point.cumulativeTurnoverMicros,
  cumulativeFeesMicros: point.cumulativeFeesMicros,
  cumulativeSpreadCostMicros: point.cumulativeSpreadCostMicros,
  cumulativeSlippageCostMicros: point.cumulativeSlippageCostMicros,
  cumulativeCashYieldMicros: point.cumulativeCashYieldMicros,
})

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
  index: number | null,
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
  selectedWindowBaseline?: CandidateDevelopmentPerformanceBaseline,
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
  const performanceBaseline = selectedWindowBaseline ?? {
    equityMicros: initialCapitalMicros,
    cumulativeTurnoverMicros: '0',
    cumulativeFeesMicros: '0',
    cumulativeSpreadCostMicros: '0',
    cumulativeSlippageCostMicros: '0',
    cumulativeCashYieldMicros: '0',
  }
  const baselineEquity = /^(?:[1-9][0-9]*)$/.test(performanceBaseline.equityMicros)
    ? Result.succeed(BigInt(performanceBaseline.equityMicros))
    : Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'micros-invalid',
          null,
          'performanceBaseline.equityMicros',
          'positive micros',
          performanceBaseline.equityMicros,
        ),
      )
  if (Result.isFailure(baselineEquity)) return Result.fail(baselineEquity.failure)

  const baselineCumulative = Object.fromEntries(cumulativeMicrosFields.map(([, field]) => [field, 0n])) as Record<
    (typeof cumulativeMicrosFields)[number][1],
    bigint
  >
  for (const [, cumulativeField] of cumulativeMicrosFields) {
    const parsed = unsignedMicros(
      seriesName,
      null,
      `performanceBaseline.${cumulativeField}`,
      performanceBaseline[cumulativeField],
    )
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    baselineCumulative[cumulativeField] = parsed.success
  }

  const equityMicros: bigint[] = []
  const cumulative = { ...baselineCumulative }
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
    const previousEquity = index === 0 ? baselineEquity.success : equityMicros[index - 1]
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
      const expected = prior + daily.success
      if (observedCumulative.success !== expected) {
        return Result.fail(
          performanceEvidenceFailure(
            seriesName,
            'cumulative-mismatch',
            index,
            cumulativeField,
            expected.toString(),
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
      cumulative.cumulativeTurnoverMicros - baselineCumulative.cumulativeTurnoverMicros,
      cumulative.cumulativeFeesMicros - baselineCumulative.cumulativeFeesMicros,
      cumulative.cumulativeSpreadCostMicros - baselineCumulative.cumulativeSpreadCostMicros,
      cumulative.cumulativeSlippageCostMicros - baselineCumulative.cumulativeSlippageCostMicros,
      cumulative.cumulativeCashYieldMicros - baselineCumulative.cumulativeCashYieldMicros,
      baselineEquity.success,
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

const expectedCandidateDevelopmentOrdinals = (
  completedCandidateCount: number,
  developmentCandidateCount: number,
  invalidPrecommitOrdinal: number | null,
): readonly number[] => {
  const ordinals: number[] = []
  let candidateOrdinal = completedCandidateCount + 1
  for (let index = 0; index < developmentCandidateCount; index += 1) {
    if (candidateOrdinal === invalidPrecommitOrdinal) candidateOrdinal += 1
    ordinals.push(candidateOrdinal)
    candidateOrdinal += 1
  }
  return ordinals
}

export const validateCandidateDevelopmentTrialHistoryClosure = (
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const invalidPrecommit = history.latestInvalidPrecommit
  if (invalidPrecommit === null) return Result.succeed(undefined)

  const expectedInvalidationHash = canonicalHashV1Result(candidate20PrecommitInvalidation)
  if (Result.isFailure(expectedInvalidationHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: expectedInvalidationHash.failure })
  }
  const observedInvalidationHash = canonicalHashV1Result(invalidPrecommit)
  if (Result.isFailure(observedInvalidationHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: observedInvalidationHash.failure })
  }
  if (expectedInvalidationHash.success !== observedInvalidationHash.success) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestInvalidPrecommit',
        expected: expectedInvalidationHash.success,
        observed: observedInvalidationHash.success,
      }),
    )
  }
  const expectedDevelopmentOrdinals = expectedCandidateDevelopmentOrdinals(
    history.completedCandidateOrdinals.length,
    history.developmentCandidateOrdinals.length,
    invalidPrecommit.candidateOrdinal,
  )
  for (let index = 0; index < expectedDevelopmentOrdinals.length; index += 1) {
    if (history.developmentCandidateOrdinals[index] !== expectedDevelopmentOrdinals[index]) {
      return Result.fail(
        sourceVerificationFailure('verify-attempt-authorization', {
          field: 'trialHistory.developmentCandidateOrdinals',
          index,
          expected: expectedDevelopmentOrdinals[index],
          observed: history.developmentCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
  if (latestDevelopmentOrdinal === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.developmentCandidateOrdinals',
        expected: 'at least one completed development-only candidate',
        observed: history.developmentCandidateOrdinals,
      }),
    )
  }
  if (
    history.latestDevelopmentEvidence.candidateOrdinal !== latestDevelopmentOrdinal ||
    history.latestDevelopmentEvidence.priorTrialCount !== latestDevelopmentOrdinal - 1 ||
    history.latestDevelopmentEvidence.qualificationAttemptConsumed
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestDevelopmentEvidence',
        expected: {
          candidateOrdinal: latestDevelopmentOrdinal,
          priorTrialCount: latestDevelopmentOrdinal - 1,
          qualificationAttemptConsumed: false,
        },
        observed: history.latestDevelopmentEvidence,
      }),
    )
  }
  const reviewed = history.latestReviewedCandidatePreregistration
  const next = history.nextCandidatePreregistration
  const latestClosedOrdinal = Math.max(latestDevelopmentOrdinal, invalidPrecommit.candidateOrdinal)
  if (next === null) {
    if (latestClosedOrdinal !== invalidPrecommit.candidateOrdinal) {
      if (reviewed.candidateOrdinal !== latestClosedOrdinal || reviewed.priorTrialCount !== latestClosedOrdinal - 1) {
        return Result.fail(
          sourceVerificationFailure('verify-attempt-authorization', {
            field: 'trialHistory.latestReviewedCandidatePreregistration.lineage',
            expected: {
              candidateOrdinal: latestClosedOrdinal,
              priorTrialCount: latestClosedOrdinal - 1,
            },
            observed: {
              candidateOrdinal: reviewed.candidateOrdinal,
              priorTrialCount: reviewed.priorTrialCount,
            },
          }),
        )
      }
      return Result.succeed(undefined)
    }
    const bindings = [
      ['candidateOrdinal', invalidPrecommit.candidateOrdinal, reviewed.candidateOrdinal],
      ['priorTrialCount', invalidPrecommit.priorTrialCount, reviewed.priorTrialCount],
      ['modulePath', invalidPrecommit.invalidatedModule.path, reviewed.modulePath],
      ['moduleSha256', invalidPrecommit.invalidatedModule.sha256, reviewed.moduleSha256],
      [
        'preregistration.sourceRevision',
        invalidPrecommit.preregistration.sourceRevision,
        reviewed.preregistration.sourceRevision,
      ],
      ['preregistration.path', invalidPrecommit.preregistration.path, reviewed.preregistration.path],
      ['preregistration.blobOid', invalidPrecommit.preregistration.blobOid, reviewed.preregistration.blobOid],
    ] as const
    for (const [field, expected, observed] of bindings) {
      if (expected !== observed) {
        return Result.fail(
          sourceVerificationFailure('verify-attempt-authorization', {
            field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
            expected,
            observed,
          }),
        )
      }
    }
    return Result.succeed(undefined)
  }
  const expectedNextOrdinal = latestClosedOrdinal + 1
  if (next.candidateOrdinal !== expectedNextOrdinal || next.priorTrialCount !== latestClosedOrdinal) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.nextCandidatePreregistration.lineage',
        expected: {
          candidateOrdinal: expectedNextOrdinal,
          priorTrialCount: latestClosedOrdinal,
        },
        observed: {
          candidateOrdinal: next.candidateOrdinal,
          priorTrialCount: next.priorTrialCount,
        },
      }),
    )
  }
  const reviewedHash = canonicalHashV1Result(reviewed)
  if (Result.isFailure(reviewedHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: reviewedHash.failure,
    })
  }
  const nextHash = canonicalHashV1Result(next)
  if (Result.isFailure(nextHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: nextHash.failure })
  }
  if (reviewedHash.success !== nextHash.success) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestReviewedCandidatePreregistration',
        expected: nextHash.success,
        observed: reviewedHash.success,
      }),
    )
  }
  return Result.succeed(undefined)
}

export const authorizeCandidateDevelopmentAttempt = (
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentNextPreregistration, CandidateDevelopmentCommandFailure> => {
  const closure = validateCandidateDevelopmentTrialHistoryClosure(history)
  if (Result.isFailure(closure)) return Result.fail(closure.failure)
  if (history.nextCandidatePreregistration === null) {
    const invalid = history.latestInvalidPrecommit
    const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
    if (
      invalid === null ||
      latestDevelopmentOrdinal === undefined ||
      latestDevelopmentOrdinal > invalid.candidateOrdinal
    ) {
      return Result.fail(
        sourceVerificationFailure('verify-attempt-authorization', {
          field: 'trialHistory.nextCandidatePreregistration',
          expected: 'a separately reviewed valid preregistration',
          observed: null,
          latestDevelopmentEvidence: history.latestDevelopmentEvidence,
        }),
      )
    }
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        candidateOrdinal: invalid.candidateOrdinal,
        status: invalid.status,
        attemptStatus: invalid.attemptStatus,
        metricBearingAttemptsConsumed: invalid.metricBearingAttemptsConsumed,
        qualificationAttemptConsumed: invalid.qualificationAttemptConsumed,
        nextCandidatePreregistration: null,
      }),
    )
  }
  return Result.succeed(history.nextCandidatePreregistration)
}

export const validateCandidateDevelopmentPreregisteredMarketData = (
  expected: CandidateDevelopmentSourceManifest['marketData'],
  observed: CandidateDevelopmentSourceManifest['marketData'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const bindings = [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['snapshotId', expected.snapshotId, observed.snapshotId],
    ['finalizedSnapshotContentHash', expected.finalizedSnapshotContentHash, observed.finalizedSnapshotContentHash],
    ['inputManifestHash', expected.inputManifestHash, observed.inputManifestHash],
    ['boundedContentHash', expected.boundedContentHash, observed.boundedContentHash],
  ] as const
  for (const [field, expectedValue, observedValue] of bindings) {
    if (expectedValue !== observedValue) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.nextCandidatePreregistration.marketData.${field}`,
          expected: expectedValue,
          observed: observedValue,
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const bindCandidateDevelopmentVerifiedSource = (
  files: CandidateDevelopmentVerifiedSourceFiles,
  input: CandidateDevelopmentPreflightInput,
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentVerifiedSource, CandidateDevelopmentCommandFailure> => {
  const completedCandidateOrdinals = history.completedCandidateOrdinals
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
  const latestTerminalEvidence = history.latestTerminalEvidence
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
  const developmentCandidateOrdinals = history.developmentCandidateOrdinals
  const expectedDevelopmentOrdinals = expectedCandidateDevelopmentOrdinals(
    completedCandidateOrdinals.length,
    developmentCandidateOrdinals.length,
    history.latestInvalidPrecommit?.candidateOrdinal ?? null,
  )
  for (let index = 0; index < developmentCandidateOrdinals.length; index += 1) {
    const expected = expectedDevelopmentOrdinals[index]
    if (developmentCandidateOrdinals[index] !== expected) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'trialHistory.developmentCandidateOrdinals',
          expected,
          observed: developmentCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestDevelopmentEvidence = history.latestDevelopmentEvidence
  const latestDevelopmentOrdinal = developmentCandidateOrdinals.at(-1)
  if (
    latestDevelopmentOrdinal === undefined ||
    latestDevelopmentEvidence.candidateOrdinal !== latestDevelopmentOrdinal ||
    latestDevelopmentEvidence.priorTrialCount !== latestDevelopmentOrdinal - 1 ||
    latestDevelopmentEvidence.qualificationAttemptConsumed !== false
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.latestDevelopmentEvidence',
        expected: {
          candidateOrdinal: latestDevelopmentOrdinal,
          priorTrialCount: latestDevelopmentOrdinal === undefined ? undefined : latestDevelopmentOrdinal - 1,
          qualificationAttemptConsumed: false,
        },
        observed: latestDevelopmentEvidence,
      }),
    )
  }
  const closure = validateCandidateDevelopmentTrialHistoryClosure(history)
  if (Result.isFailure(closure)) return Result.fail(closure.failure)
  const candidatePreregistration = history.latestReviewedCandidatePreregistration
  const priorTrialsHash =
    candidatePreregistration.candidateOrdinal >= 19
      ? deriveCandidateDevelopmentPriorTrialsHash(history.latestReviewedCandidatePriorTrials)
      : deriveCandidateDevelopmentLegacyPriorTrialsHash(history.latestReviewedCandidateLegacyPriorTrials)
  if (Result.isFailure(priorTrialsHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: priorTrialsHash.failure,
    })
  }
  const expectedReviewedCandidateOrdinal =
    history.nextCandidatePreregistration?.candidateOrdinal ??
    (history.latestInvalidPrecommit === null
      ? latestDevelopmentOrdinal + 1
      : Math.max(latestDevelopmentOrdinal, history.latestInvalidPrecommit.candidateOrdinal))
  const expectedPriorTrialCount = expectedReviewedCandidateOrdinal - 1
  const reviewedBindings = [
    ['candidateOrdinal', expectedReviewedCandidateOrdinal, candidatePreregistration.candidateOrdinal],
    ['priorTrialCount', expectedPriorTrialCount, candidatePreregistration.priorTrialCount],
    ['input.candidateOrdinal', candidatePreregistration.candidateOrdinal, input.candidateOrdinal],
    ['input.priorTrialCount', candidatePreregistration.priorTrialCount, input.priorTrialCount],
    ['strategyProtocolHash', candidatePreregistration.strategyProtocolHash, input.expectedStrategyProtocolHash],
    ['priorTrialsHash', priorTrialsHash.success, candidatePreregistration.priorTrialsHash],
    ['modulePath', candidatePreregistration.modulePath, files.modulePath],
    ['moduleSha256', candidatePreregistration.moduleSha256, files.moduleSha256],
  ] as const
  for (const [field, expected, observed] of reviewedBindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  const marketDataBinding = validateCandidateDevelopmentPreregisteredMarketData(
    candidatePreregistration.marketData,
    files.sourceManifest.marketData,
  )
  if (Result.isFailure(marketDataBinding)) return Result.fail(marketDataBinding.failure)
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
    ['strategyIdentityHash', candidatePreregistration.strategyIdentityHash, manifest.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      candidatePreregistration.candidateDevelopmentProtocolHash,
      manifest.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', candidatePreregistration.calendarHash, manifest.calendarHash],
    ['priorTrialsHash', candidatePreregistration.priorTrialsHash, manifest.priorTrialsHash],
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

export const preregisterCandidateDevelopmentAttempt = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const authorization = authorizeCandidateDevelopmentAttempt(history)
  if (Result.isFailure(authorization)) return Result.fail(authorization.failure)
  const nextCandidatePreregistration = authorization.success
  const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
  if (latestDevelopmentOrdinal === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.developmentCandidateOrdinals',
        expected: 'at least one completed development-only candidate after qualification ordinal 16',
        observed: history.developmentCandidateOrdinals,
      }),
    )
  }
  const priorTrialsHash = deriveCandidateDevelopmentPriorTrialsHash(history.latestReviewedCandidatePriorTrials)
  if (Result.isFailure(priorTrialsHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: priorTrialsHash.failure,
    })
  }
  const sourceManifest = verifiedSource.sourceManifest
  const expectedCandidateOrdinal =
    Math.max(latestDevelopmentOrdinal, history.latestInvalidPrecommit?.candidateOrdinal ?? latestDevelopmentOrdinal) + 1
  const bindings = [
    ['candidateOrdinal', expectedCandidateOrdinal, nextCandidatePreregistration.candidateOrdinal],
    ['priorTrialCount', expectedCandidateOrdinal - 1, nextCandidatePreregistration.priorTrialCount],
    ['priorTrialsHash', priorTrialsHash.success, nextCandidatePreregistration.priorTrialsHash],
    ['source.candidateOrdinal', nextCandidatePreregistration.candidateOrdinal, sourceManifest.candidateOrdinal],
    ['source.priorTrialCount', nextCandidatePreregistration.priorTrialCount, sourceManifest.priorTrialCount],
    [
      'source.strategyProtocolHash',
      nextCandidatePreregistration.strategyProtocolHash,
      sourceManifest.strategyProtocolHash,
    ],
    [
      'source.strategyIdentityHash',
      nextCandidatePreregistration.strategyIdentityHash,
      sourceManifest.strategyIdentityHash,
    ],
    [
      'source.candidateDevelopmentProtocolHash',
      nextCandidatePreregistration.candidateDevelopmentProtocolHash,
      sourceManifest.candidateDevelopmentProtocolHash,
    ],
    ['source.calendarHash', nextCandidatePreregistration.calendarHash, sourceManifest.calendarHash],
    ['source.priorTrialsHash', nextCandidatePreregistration.priorTrialsHash, sourceManifest.priorTrialsHash],
    ['source.modulePath', nextCandidatePreregistration.modulePath, verifiedSource.modulePath],
    ['source.moduleSha256', nextCandidatePreregistration.moduleSha256, verifiedSource.moduleSha256],
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
  const marketDataBinding = validateCandidateDevelopmentPreregisteredMarketData(
    nextCandidatePreregistration.marketData,
    sourceManifest.marketData,
  )
  if (Result.isFailure(marketDataBinding)) return Result.fail(marketDataBinding.failure)
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

const compareCodeUnitStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareMarketBars = (left: DailyBar, right: DailyBar): number =>
  left.sessionDate === right.sessionDate
    ? compareCodeUnitStrings(left.symbol, right.symbol)
    : compareCodeUnitStrings(left.sessionDate, right.sessionDate)

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

const validateRunIndependentDecisionPlans = (
  field: string,
  expected: EvaluationResult['signalDecisions'],
  observed: EvaluationResult['signalDecisions'],
): Result.Result<void, CandidateDevelopmentCommandFailure> =>
  requireCanonicalEvidenceEqual(
    field,
    expected.map(({ decisionId: _, ...decision }) => decision),
    observed.map(({ decisionId: _, ...decision }) => decision),
  )

const signalDecisionsInSimulationWindow = (
  signalDecisions: EvaluationResult['signalDecisions'],
  simulation: EvaluationResult['simulation'],
): EvaluationResult['signalDecisions'] => {
  const first = simulation.dailyMarks.at(0)?.sessionDate
  const last = simulation.dailyMarks.at(-1)?.sessionDate
  return first === undefined || last === undefined
    ? []
    : signalDecisions.filter(({ executionDate }) => executionDate >= first && executionDate <= last)
}

const decisionEventsInSimulationWindow = (
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): EvaluationResult['events'] => {
  const first = simulation.dailyMarks.at(0)?.sessionDate
  const last = simulation.dailyMarks.at(-1)?.sessionDate
  return first === undefined || last === undefined
    ? []
    : events.filter((event) => event.kind === 'decision' && event.executionDate >= first && event.executionDate <= last)
}

const bindRunIndependentDecisionPlansToEvents = (
  field: 'baseline' | 'stressed',
  plans: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
): Result.Result<EvaluationResult['signalDecisions'], CandidateDevelopmentCommandFailure> => {
  const decisionEvents = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'decision' }> =>
      event.kind === 'decision',
  )
  if (decisionEvents.length !== plans.length) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, `${field}.decisionCount`, plans.length, decisionEvents.length),
    )
  }
  const bound = plans.map((plan, index) => ({ ...plan, decisionId: decisionEvents[index]!.id }))
  return pipe(
    validateDecisionEventBinding(field, bound, events),
    Result.map(() => bound),
  )
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

const selectedTracePerformanceBaseline = (
  field: 'baselineSimulation' | 'stressedSimulation',
  full: EvaluationResult['simulation'],
  selected: EvaluationResult['simulation'],
  events: EvaluationResult['events'],
): Result.Result<CandidateDevelopmentPerformanceBaseline, CandidateDevelopmentCommandFailure> => {
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
          ? dateField === 'executionDate' && observed < predecessor.sessionDate
          : observed < predecessor.sessionDate
      if (isEconomicBeforeWindow) {
        return Result.fail(
          markedEquityFailure(
            'selected-trace-mismatch',
            index,
            `${field}.events.${dateField}`,
            `>=${predecessor.sessionDate}`,
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
    if (observed < predecessor.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.orders.sessionDate`,
          `>=${predecessor.sessionDate}`,
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
    if (observed < predecessor.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.cashChanges.sessionDate`,
          `>=${predecessor.sessionDate}`,
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
  return Result.succeed(performanceBaselineFromPoint(predecessor))
}

interface CandidateDevelopmentAccountingValidation {
  readonly strategyPerformanceBaseline: CandidateDevelopmentPerformanceBaseline
  readonly stressedPerformanceBaseline: CandidateDevelopmentPerformanceBaseline
}

interface CandidateDevelopmentRebuiltBenchmark {
  readonly series: readonly DailyPerformancePoint[]
  readonly performanceBaseline: CandidateDevelopmentPerformanceBaseline
}

interface CandidateDevelopmentRebuiltBenchmarks {
  readonly buyAndHold: CandidateDevelopmentRebuiltBenchmark
  readonly directVolTiming: CandidateDevelopmentRebuiltBenchmark
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
  name: 'buy-and-hold' | 'direct-volatility-timing',
): Result.Result<CandidateDevelopmentRebuiltBenchmark, CandidateDevelopmentCommandFailure> => {
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
  const firstIndex = series.findIndex((point) => point.sessionDate === first.sessionDate)
  if (firstIndex !== 1) {
    return Result.fail(performanceEvidenceFailure(name, 'session-mismatch', null, 'predecessorCount', 1, firstIndex))
  }
  const predecessor = series[0]
  const normalizedReturn = Number(first.equityMicros) / Number(predecessor.equityMicros) - 1
  if (!Number.isFinite(normalizedReturn)) {
    return Result.fail(
      performanceEvidenceFailure(name, 'return-mismatch', 0, 'netReturn', 'finite normalized return', normalizedReturn),
    )
  }
  return Result.succeed({
    series: [{ ...first, netReturn: normalizedReturn }, ...complete.slice(1)],
    performanceBaseline: performanceBaselineFromPoint(predecessor),
  })
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
  const selectedFirstMark = baseline.simulation.dailyMarks.at(0)
  const selectedStartIndex =
    selectedFirstMark === undefined ? undefined : marketData.sessionIndexByDate.get(selectedFirstMark.sessionDate)
  const endIndex = marketData.sessionIndexByDate.get(lastMark.sessionDate)
  if (
    startIndex === undefined ||
    selectedStartIndex === undefined ||
    endIndex === undefined ||
    selectedStartIndex !== startIndex + 1 ||
    endIndex < selectedStartIndex
  ) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.window',
        'one accounting predecessor followed by the selected benchmark window',
        {
          accountingFirst: firstMark.sessionDate,
          selectedFirst: selectedFirstMark?.sessionDate ?? null,
          last: lastMark.sessionDate,
        },
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
        signalIndex: startIndex,
        executionIndex: selectedStartIndex,
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
    buyAndHold: selectRebuiltBenchmarkSeries(buyAndHold.success.dailyPerformance, selectedSessions, 'buy-and-hold'),
    directVolTiming: selectRebuiltBenchmarkSeries(
      directVolTiming.success.dailyPerformance,
      selectedSessions,
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
    ['evaluatorEndingEquityMicros', baseline.strategy.endingEquityMicros, accounting.evaluatorEndingEquityMicros],
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
    strategyPerformanceBaseline: selectedTracePerformanceBaseline(
      'baselineSimulation',
      accounting.baselineSimulation,
      baseline.simulation,
      accounting.events,
    ),
    stressedPerformanceBaseline: selectedTracePerformanceBaseline(
      'stressedSimulation',
      accounting.stressedSimulation,
      report.doubledCost.stressed.simulation,
      accounting.stressedEvents,
    ),
  })
  if (Result.isFailure(selectedTraceBindings)) return Result.fail(selectedTraceBindings.failure)
  const selectedBaselinePlans = signalDecisionsInSimulationWindow(accounting.signalDecisions, baseline.simulation)
  const selectedBaselineEvents = decisionEventsInSimulationWindow(accounting.events, baseline.simulation)
  const baselineDecisionBindings = Result.all({
    universe: validateAccountingUniverse(
      'baseline',
      strategyProtocol.universe,
      accounting.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
    ),
    selectedPlans: requireCanonicalEvidenceEqual(
      'baseline.signalDecisions',
      baseline.signalDecisions,
      selectedBaselinePlans,
    ),
    fullEvents: validateDecisionEventBinding('baseline', accounting.signalDecisions, accounting.events),
    selectedEvents: validateDecisionEventBinding('baseline', baseline.signalDecisions, selectedBaselineEvents),
  })
  if (Result.isFailure(baselineDecisionBindings)) return Result.fail(baselineDecisionBindings.failure)
  const stressedAccountingPlans = bindRunIndependentDecisionPlansToEvents(
    'stressed',
    accounting.signalDecisions,
    accounting.stressedEvents,
  )
  if (Result.isFailure(stressedAccountingPlans)) return Result.fail(stressedAccountingPlans.failure)
  const selectedStressedPlans = signalDecisionsInSimulationWindow(
    stressedAccountingPlans.success,
    report.doubledCost.stressed.simulation,
  )
  const selectedStressedEvents = decisionEventsInSimulationWindow(
    accounting.stressedEvents,
    report.doubledCost.stressed.simulation,
  )
  const domainBindings = Result.all({
    baselineCalendar: validateAccountingCalendar('baseline', officialSessions, accounting.baselineSimulation),
    stressedCalendar: validateAccountingCalendar('stressed', officialSessions, accounting.stressedSimulation),
    stressedUniverse: validateAccountingUniverse(
      'stressed',
      strategyProtocol.universe,
      stressedAccountingPlans.success,
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
      accounting.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
      marketData,
      strategyProtocol,
    ),
    stressedReplay: validateCandidateDevelopmentAccountingReplay(
      'stressed',
      accounting.stressedRunId,
      stressedAccountingPlans.success,
      accounting.stressedEvents,
      accounting.stressedSimulation,
      marketData,
      strategyProtocol,
    ),
  })
  if (Result.isFailure(domainBindings)) return Result.fail(domainBindings.failure)
  const decisionBindings = Result.all({
    stressedPlans: validateRunIndependentDecisionPlans(
      'stressed.signalDecisions',
      report.doubledCost.stressed.signalDecisions,
      selectedStressedPlans,
    ),
    stressedFull: validateDecisionEventBinding('stressed', stressedAccountingPlans.success, accounting.stressedEvents),
    stressedSelected: validateDecisionEventBinding(
      'stressed',
      report.doubledCost.stressed.signalDecisions,
      selectedStressedEvents,
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

const projectDailyPerformanceSeries = (
  marks: EvaluationResult['simulation']['dailyMarks'],
): readonly DailyPerformancePoint[] =>
  marks.map(({ cashMicros: _cashMicros, positions: _positions, ...performance }) => performance)

const recomputeCandidateDevelopmentMetrics = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  accounting: CandidateDevelopmentAccountingValidation,
  benchmarks: CandidateDevelopmentRebuiltBenchmarks,
): Result.Result<CandidateDevelopmentRecomputedMetrics, CandidateDevelopmentCommandFailure> => {
  const { baseline } = evaluation
  const strategyPoints = baseline.simulation.dailyMarks
  const stressedPoints = report.doubledCost.stressed.simulation.dailyMarks
  const stressedPerformance = projectDailyPerformanceSeries(stressedPoints)
  return pipe(
    Result.all({
      buyBinding: requireCanonicalEvidenceEqual(
        'benchmarks.buyAndHold',
        benchmarks.buyAndHold.series,
        baseline.benchmarkSeries.buyAndHold,
      ),
      directVolBinding: requireCanonicalEvidenceEqual(
        'benchmarks.directVolatilityTiming',
        benchmarks.directVolTiming.series,
        baseline.benchmarkSeries.directVolTiming,
      ),
      doubleCostBinding: requireCanonicalEvidenceEqual(
        'double-cost-series.replay',
        stressedPerformance,
        baseline.benchmarkSeries.doubleCostStrategy,
      ),
      buySessions: validateSeriesSessions(strategyPoints, benchmarks.buyAndHold.series, 'buy-and-hold'),
      volSessions: validateSeriesSessions(
        strategyPoints,
        benchmarks.directVolTiming.series,
        'direct-volatility-timing',
      ),
      doubleSessions: validateSeriesSessions(
        stressedPerformance,
        baseline.benchmarkSeries.doubleCostStrategy,
        'double-cost-series',
      ),
      stressedSessions: validateSeriesSessions(strategyPoints, stressedPoints, 'double-cost-stressed'),
      strategy: recomputePerformanceMetrics(
        'strategy',
        strategyPoints,
        baseline.initialCapitalMicros,
        accounting.strategyPerformanceBaseline,
      ),
      buyAndHold: recomputePerformanceMetrics(
        'buy-and-hold',
        benchmarks.buyAndHold.series,
        baseline.initialCapitalMicros,
        benchmarks.buyAndHold.performanceBaseline,
      ),
      directVolTiming: recomputePerformanceMetrics(
        'direct-volatility-timing',
        benchmarks.directVolTiming.series,
        baseline.initialCapitalMicros,
        benchmarks.directVolTiming.performanceBaseline,
      ),
      doubleCostSeries: recomputePerformanceMetrics(
        'double-cost-series',
        baseline.benchmarkSeries.doubleCostStrategy,
        baseline.initialCapitalMicros,
        accounting.stressedPerformanceBaseline,
      ),
      doubleCostStressed: recomputePerformanceMetrics(
        'double-cost-stressed',
        stressedPoints,
        baseline.initialCapitalMicros,
        accounting.stressedPerformanceBaseline,
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
): CandidateDevelopmentCommandDecision =>
  deriveCandidateDevelopmentDecision({
    comparison: report.comparisonSemantics.analysis,
    doubledCostAnnualizedReturn,
    economicPass,
    baselineTerminalCash: terminalCash(baseline.simulation.dailyMarks),
    stressedTerminalCash: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
  })

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

const validateCandidateDevelopmentPreregisteredProtocol = (
  program: CandidateDevelopmentExecutableProgram<unknown, unknown, unknown, unknown>,
  preflight: CandidateDevelopmentPreflightPass,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  if (program.strategyProtocol.strategyIdentity === undefined) return Result.succeed(undefined)
  const preregistration = frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
  const priorTrialsHash = pipe(
    deriveCandidateDevelopmentPriorTrialsHash(
      frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePriorTrials,
    ),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  const strategyIdentityHash = pipe(
    canonicalHashV1Result(program.strategyProtocol.strategyIdentity),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  const calendarHash = pipe(
    canonicalHashV1Result(candidateDevelopmentCalendarContract),
    Result.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandHashFailed',
        cause,
      }),
    ),
  )
  return pipe(
    Result.all({ strategyIdentityHash, calendarHash, priorTrialsHash }),
    Result.flatMap(
      ({
        strategyIdentityHash: observedStrategyIdentityHash,
        calendarHash: observedCalendarHash,
        priorTrialsHash: observedPriorTrialsHash,
      }) => {
        const bindings = [
          ['strategyIdentityHash', preregistration.strategyIdentityHash, observedStrategyIdentityHash],
          [
            'candidateDevelopmentProtocolHash',
            preregistration.candidateDevelopmentProtocolHash,
            preflight.protocolIdentity.candidateDevelopmentProtocolHash,
          ],
          ['calendarHash', preregistration.calendarHash, observedCalendarHash],
          ['priorTrialsHash', preregistration.priorTrialsHash, observedPriorTrialsHash],
          [
            'source.strategyIdentityHash',
            preregistration.strategyIdentityHash,
            verifiedSource.sourceManifest.strategyIdentityHash,
          ],
          [
            'source.candidateDevelopmentProtocolHash',
            preregistration.candidateDevelopmentProtocolHash,
            verifiedSource.sourceManifest.candidateDevelopmentProtocolHash,
          ],
          ['source.calendarHash', preregistration.calendarHash, verifiedSource.sourceManifest.calendarHash],
          ['source.priorTrialsHash', preregistration.priorTrialsHash, verifiedSource.sourceManifest.priorTrialsHash],
        ] as const
        for (const [field, expected, observed] of bindings) {
          if (expected !== observed) {
            return Result.fail(
              sourceVerificationFailure('verify-program-binding', {
                field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
                expected,
                observed,
              }),
            )
          }
        }
        return Result.succeed(undefined)
      },
    ),
  )
}

export const executeCandidateDevelopmentProgram = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> => {
  let evaluation: CandidateDevelopmentCommandEvaluation | undefined
  const effects: CandidateDevelopmentEffects<
    Registration,
    DevelopmentData,
    CandidateDevelopmentCommandFailure | Error,
    Requirements
  > = {
    ...program.effects,
    preregisterCandidate: (preflight) =>
      Effect.fromResult(
        validateCandidateDevelopmentPreregisteredProtocol(
          program as CandidateDevelopmentExecutableProgram<unknown, unknown, unknown, unknown>,
          preflight,
          verifiedSource,
        ),
      ).pipe(Effect.flatMap(() => program.effects.preregisterCandidate(preflight))),
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

export const CandidateDevelopmentPreflightInputSchema = Schema.Struct({
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

const CandidateDevelopmentPlannedDecisionSchema = Schema.Struct({
  ...DecisionPlanSchema.fields,
  executionDate: IsoDateSchema,
})

const CandidateDevelopmentStrategyPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-plan.v1'),
  decisions: Schema.Array(CandidateDevelopmentPlannedDecisionSchema).check(Schema.isMinLength(1)),
})

const CandidateDevelopmentMomentumStrategyIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-identity.v1'),
  family: Schema.String.check(Schema.isMinLength(1)),
  identifier: Schema.String.check(Schema.isMinLength(1)),
  researchSources: Schema.Tuple([StrictNonEmptyStringSchema, StrictNonEmptyStringSchema, StrictNonEmptyStringSchema]),
  parameters: Schema.Struct({
    id: StrictNonEmptyStringSchema,
    lookbackSessions: PositiveIntegerSchema,
    volatilityWindowSessions: PositiveIntegerSchema,
    annualizationSessions: PositiveIntegerSchema,
    riskAssets: Schema.Tuple([SymbolSchema, SymbolSchema]),
    defensiveAsset: SymbolSchema,
    absoluteMomentumThreshold: Schema.Finite,
    selectedAssetWeight: UnitIntervalSchema,
    relativeMomentumTieBreak: SymbolSchema,
  }),
  input: StrictNonEmptyStringSchema,
  relativeMomentum: StrictNonEmptyStringSchema,
  absoluteMomentum: StrictNonEmptyStringSchema,
  defensive: StrictNonEmptyStringSchema,
  allocation: StrictNonEmptyStringSchema,
  schedule: StrictNonEmptyStringSchema,
  terminal: StrictNonEmptyStringSchema,
  missingData: StrictNonEmptyStringSchema,
  doubledCost: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentInverseVolatilityStrategyIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-identity.v2'),
  family: Schema.Literal('inverse-volatility-risk-diversification'),
  identifier: StrictNonEmptyStringSchema,
  researchSources: Schema.Tuple([StrictNonEmptyStringSchema, StrictNonEmptyStringSchema, StrictNonEmptyStringSchema]),
  parameters: Schema.Struct({
    id: StrictNonEmptyStringSchema,
    lookbackSessions: PositiveIntegerSchema,
    annualizationSessions: PositiveIntegerSchema,
    riskAssets: Schema.Tuple([SymbolSchema, SymbolSchema]),
    covarianceEstimator: Schema.Literal('sample'),
    targetAnnualizedVolatility: PositiveFiniteSchema,
    maximumGrossExposure: UnitIntervalSchema,
  }),
  input: StrictNonEmptyStringSchema,
  weighting: StrictNonEmptyStringSchema,
  riskScaling: StrictNonEmptyStringSchema,
  allocation: StrictNonEmptyStringSchema,
  schedule: StrictNonEmptyStringSchema,
  terminal: StrictNonEmptyStringSchema,
  missingData: StrictNonEmptyStringSchema,
  doubledCost: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentStrategyIdentitySchema = Schema.Union([
  CandidateDevelopmentMomentumStrategyIdentitySchema,
  CandidateDevelopmentInverseVolatilityStrategyIdentitySchema,
])

export const CandidateDevelopmentStrategyProtocolSchema = Schema.Struct({
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
  strategyIdentity: Schema.optionalKey(CandidateDevelopmentStrategyIdentitySchema),
})

export const CandidateDevelopmentSourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-source-manifest.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: Schema.String.check(Schema.isMinLength(1)),
  moduleSha256: Schema.optionalKey(Sha256Schema),
  moduleFormat: Schema.Literal('self-contained-esm-v1'),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

export const CandidateDevelopmentArtifactStructuralBindingsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-artifact-structural-bindings.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Sha256Schema,
  candidateDevelopmentProtocolHash: Sha256Schema,
  calendarHash: Sha256Schema,
  priorTrialsHash: Sha256Schema,
  modulePath: StrictNonEmptyStringSchema,
  sourceManifestPath: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentPreregistrationDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-next-preregistration.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: Schema.String,
  moduleSha256: Sha256Schema,
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

export const CandidateDevelopmentEvaluationSchema = Schema.Struct({
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

const decodeCandidateDevelopmentMarketDataWitness = Schema.decodeUnknownResult(
  CandidateDevelopmentMarketDataWitnessSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentStrategyPlan = Schema.decodeUnknownResult(
  CandidateDevelopmentStrategyPlanSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentInputManifest = Schema.decodeUnknownResult(
  InputManifestArtifactSchema,
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

const decodeCandidateDevelopmentArtifactStructuralBindings = Schema.decodeUnknownResult(
  CandidateDevelopmentArtifactStructuralBindingsSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentPreregistrationDocument = Schema.decodeUnknownResult(
  CandidateDevelopmentPreregistrationDocumentSchema,
  strictParseOptions,
)

export const validateCandidateDevelopmentRuntimeMarketData = (
  value: unknown,
  verifiedSource: CandidateDevelopmentVerifiedSource,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflightInput: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentMarketDataWitness, CandidateDevelopmentCommandFailure> => {
  const expectedBarCount = preflightInput.officialSessions.length * strategyProtocol.universe.length
  if (!Number.isSafeInteger(expectedBarCount) || expectedBarCount <= 0) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.expectedBarCount',
        expected: 'a positive safe integer derived from official sessions and the governed universe',
        observed: expectedBarCount,
      }),
    )
  }
  const rawBars =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { readonly bars?: unknown }).bars
      : undefined
  if (Array.isArray(rawBars) && rawBars.length !== expectedBarCount) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.bars.length',
        expected: expectedBarCount,
        observed: rawBars.length,
      }),
    )
  }
  const decoded = decodeCandidateDevelopmentMarketDataWitness(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('verify-runtime-market-data', decoded.failure))
  }
  const witness = decoded.success as CandidateDevelopmentMarketDataWitness
  const { contentHash: observedContentHash, ...content } = witness
  const recomputedContentHash = canonicalHashV1Result(content)
  if (Result.isFailure(recomputedContentHash)) {
    return Result.fail(sourceVerificationFailure('verify-runtime-market-data', recomputedContentHash.failure))
  }
  const committed = verifiedSource.sourceManifest.marketData
  const bindings = [
    ['contentHash', committed.boundedContentHash, observedContentHash],
    ['recomputedContentHash', recomputedContentHash.success, observedContentHash],
    ['strategyProtocol.contentHash', strategyProtocol.marketData.contentHash, observedContentHash],
    ['snapshotId', committed.snapshotId, witness.snapshotId],
    ['strategyProtocol.snapshotId', strategyProtocol.marketData.snapshotId, witness.snapshotId],
    ['inputManifestHash', committed.inputManifestHash, witness.inputManifestHash],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  if (witness.bars.length !== expectedBarCount) {
    return Result.fail(
      sourceVerificationFailure('verify-runtime-market-data', {
        field: 'runtimeMarketData.bars.length',
        expected: expectedBarCount,
        observed: witness.bars.length,
      }),
    )
  }
  const firstBar = witness.bars[0]
  const expectedProvenance =
    firstBar === undefined
      ? undefined
      : {
          source: firstBar.source,
          sourceFeed: firstBar.sourceFeed,
          adjustment: firstBar.adjustment,
          publicationSchemaVersion: firstBar.publicationSchemaVersion,
        }
  for (let index = 0; index < witness.bars.length; index += 1) {
    const bar = witness.bars[index]
    if (bar === undefined) continue
    const sessionIndex = Math.floor(index / strategyProtocol.universe.length)
    const symbolIndex = index % strategyProtocol.universe.length
    const expectedSessionDate = preflightInput.officialSessions[sessionIndex]
    const expectedSymbol = strategyProtocol.universe[symbolIndex]
    if (bar.sessionDate !== expectedSessionDate) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].sessionDate`,
          expected: expectedSessionDate,
          observed: bar.sessionDate,
        }),
      )
    }
    if (bar.symbol !== expectedSymbol) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].symbol`,
          expected: expectedSymbol,
          observed: bar.symbol,
        }),
      )
    }
    if (index > 0) {
      const previous = witness.bars[index - 1]
      if (previous !== undefined && compareMarketBars(previous, bar) >= 0) {
        return Result.fail(
          sourceVerificationFailure('verify-runtime-market-data', {
            field: `runtimeMarketData.bars[${index}].order`,
            expected: 'strict session-date/symbol order',
            observed: {
              previous: [previous.sessionDate, previous.symbol],
              current: [bar.sessionDate, bar.symbol],
            },
          }),
        )
      }
    }
    const observedProvenance = {
      source: bar.source,
      sourceFeed: bar.sourceFeed,
      adjustment: bar.adjustment,
      publicationSchemaVersion: bar.publicationSchemaVersion,
    }
    if (
      expectedProvenance === undefined ||
      expectedProvenance.source !== observedProvenance.source ||
      expectedProvenance.sourceFeed !== observedProvenance.sourceFeed ||
      expectedProvenance.adjustment !== observedProvenance.adjustment ||
      expectedProvenance.publicationSchemaVersion !== observedProvenance.publicationSchemaVersion
    ) {
      return Result.fail(
        sourceVerificationFailure('verify-runtime-market-data', {
          field: `runtimeMarketData.bars[${index}].provenance`,
          expected: expectedProvenance,
          observed: observedProvenance,
        }),
      )
    }
  }
  return Result.succeed(witness)
}

const deriveCandidateDevelopmentArtifactPreflightInput = (
  declaredInput: unknown,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentPreflightInput, CandidateDevelopmentCommandFailure> => {
  const declared = declaredInput === undefined ? undefined : decodeCandidateDevelopmentPreflightInput(declaredInput)
  if (declared !== undefined && Result.isFailure(declared)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: declared.failure,
    })
  }
  if (verifiedFiles.sourceManifest.candidateOrdinal < 19) {
    return declared === undefined
      ? Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
      : Result.succeed(declared.success)
  }
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.strategyProtocol.strategyIdentity',
        expected: 'strategy identity with a causal lookback',
        observed: undefined,
      }),
    )
  }
  const officialSessions = frozenCandidateDevelopmentSessions()
  const derived = decodeCandidateDevelopmentPreflightInput({
    candidateOrdinal: verifiedFiles.sourceManifest.candidateOrdinal,
    priorTrialCount: verifiedFiles.sourceManifest.priorTrialCount,
    expectedStrategyProtocolHash: verifiedFiles.sourceManifest.strategyProtocolHash,
    officialSessions,
    signalSessionDates: officialMonthEndSignalDates(officialSessions),
    featureLookbackSessions: strategyIdentity.parameters.lookbackSessions,
  })
  if (Result.isFailure(derived)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: derived.failure,
    })
  }
  if (declared !== undefined) {
    const hashes = Result.all({
      expected: canonicalHashV1Result(derived.success),
      observed: canonicalHashV1Result(declared.success),
    })
    if (Result.isFailure(hashes)) {
      return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: hashes.failure })
    }
    if (hashes.success.expected !== hashes.success.observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'artifact.input',
          expected: hashes.success.expected,
          observed: hashes.success.observed,
        }),
      )
    }
  }
  return Result.succeed(derived.success)
}

export const validateCandidateDevelopmentPreregistrationDocument = (
  expected: CandidateDevelopmentNextPreregistration,
  value: unknown,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentPreregistrationDocument(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('decode-preregistration', decoded.failure))
  }
  const observed = decoded.success
  const bindings = [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['candidateOrdinal', expected.candidateOrdinal, observed.candidateOrdinal],
    ['priorTrialCount', expected.priorTrialCount, observed.priorTrialCount],
    ['strategyProtocolHash', expected.strategyProtocolHash, observed.strategyProtocolHash],
    ['strategyIdentityHash', expected.strategyIdentityHash, observed.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      expected.candidateDevelopmentProtocolHash,
      observed.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', expected.calendarHash, observed.calendarHash],
    ['priorTrialsHash', expected.priorTrialsHash, observed.priorTrialsHash],
    ['modulePath', expected.modulePath, observed.modulePath],
    ['moduleSha256', expected.moduleSha256, observed.moduleSha256],
    ['marketData.schemaVersion', expected.marketData.schemaVersion, observed.marketData.schemaVersion],
    ['marketData.snapshotId', expected.marketData.snapshotId, observed.marketData.snapshotId],
    [
      'marketData.finalizedSnapshotContentHash',
      expected.marketData.finalizedSnapshotContentHash,
      observed.marketData.finalizedSnapshotContentHash,
    ],
    ['marketData.inputManifestHash', expected.marketData.inputManifestHash, observed.marketData.inputManifestHash],
    ['marketData.boundedContentHash', expected.marketData.boundedContentHash, observed.marketData.boundedContentHash],
  ] as const
  for (const [field, expectedValue, observedValue] of bindings) {
    if (expectedValue !== observedValue) {
      return Result.fail(
        sourceVerificationFailure('verify-preregistration-blob', {
          field,
          expected: expectedValue,
          observed: observedValue,
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const validateCandidateDevelopmentArtifactStructure = (
  value: unknown,
  input: CandidateDevelopmentPreflightInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<CandidateDevelopmentArtifactStructuralBindings | undefined, CandidateDevelopmentCommandFailure> => {
  if (input.candidateOrdinal < 19 && value === undefined) return Result.succeed(undefined)
  const decoded = decodeCandidateDevelopmentArtifactStructuralBindings(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(sourceVerificationFailure('verify-program-binding', decoded.failure))
  }
  const bindings = decoded.success
  const preregistration = frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
  const preflight = preflightCandidateDevelopment(input)
  if (Result.isFailure(preflight) || preflight.success.status !== 'PASS') {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.preflight',
        expected: 'PASS',
        observed: Result.isFailure(preflight) ? preflight.failure : preflight.success,
      }),
    )
  }
  if (strategyProtocol.strategyIdentity === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'artifact.strategyProtocol.strategyIdentity',
        expected: 'immutable strategy identity',
        observed: undefined,
      }),
    )
  }
  const hashes = Result.all({
    strategyProtocolHash: canonicalHashV1Result(strategyProtocol),
    strategyIdentityHash: canonicalHashV1Result(strategyProtocol.strategyIdentity),
    calendarHash: canonicalHashV1Result(candidateDevelopmentCalendarContract),
    priorTrialsHash: deriveCandidateDevelopmentPriorTrialsHash(
      frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePriorTrials,
    ),
  })
  if (Result.isFailure(hashes)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: hashes.failure })
  }
  const manifest = verifiedSource.sourceManifest
  const expectedBindings = [
    ['candidateOrdinal', input.candidateOrdinal, bindings.candidateOrdinal],
    ['priorTrialCount', input.priorTrialCount, bindings.priorTrialCount],
    ['strategyProtocolHash', hashes.success.strategyProtocolHash, bindings.strategyProtocolHash],
    ['strategyIdentityHash', hashes.success.strategyIdentityHash, bindings.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      preflight.success.protocolIdentity.candidateDevelopmentProtocolHash,
      bindings.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', hashes.success.calendarHash, bindings.calendarHash],
    ['priorTrialsHash', hashes.success.priorTrialsHash, bindings.priorTrialsHash],
    ['modulePath', verifiedSource.modulePath, bindings.modulePath],
    ['sourceManifestPath', verifiedSource.sourceManifestPath, bindings.sourceManifestPath],
    ['preregistration.candidateOrdinal', preregistration.candidateOrdinal, bindings.candidateOrdinal],
    ['preregistration.priorTrialCount', preregistration.priorTrialCount, bindings.priorTrialCount],
    ['preregistration.strategyProtocolHash', preregistration.strategyProtocolHash, bindings.strategyProtocolHash],
    ['preregistration.strategyIdentityHash', preregistration.strategyIdentityHash, bindings.strategyIdentityHash],
    [
      'preregistration.candidateDevelopmentProtocolHash',
      preregistration.candidateDevelopmentProtocolHash,
      bindings.candidateDevelopmentProtocolHash,
    ],
    ['preregistration.calendarHash', preregistration.calendarHash, bindings.calendarHash],
    ['preregistration.priorTrialsHash', preregistration.priorTrialsHash, bindings.priorTrialsHash],
    ['preregistration.modulePath', preregistration.modulePath, bindings.modulePath],
    ['preregistration.moduleSha256', preregistration.moduleSha256, verifiedSource.moduleSha256],
    ['manifest.candidateOrdinal', bindings.candidateOrdinal, manifest.candidateOrdinal],
    ['manifest.priorTrialCount', bindings.priorTrialCount, manifest.priorTrialCount],
    ['manifest.strategyProtocolHash', bindings.strategyProtocolHash, manifest.strategyProtocolHash],
    ['manifest.strategyIdentityHash', bindings.strategyIdentityHash, manifest.strategyIdentityHash],
    [
      'manifest.candidateDevelopmentProtocolHash',
      bindings.candidateDevelopmentProtocolHash,
      manifest.candidateDevelopmentProtocolHash,
    ],
    ['manifest.calendarHash', bindings.calendarHash, manifest.calendarHash],
    ['manifest.priorTrialsHash', bindings.priorTrialsHash, manifest.priorTrialsHash],
    ['manifest.modulePath', bindings.modulePath, manifest.modulePath],
    ['manifest.moduleSha256', verifiedSource.moduleSha256, manifest.moduleSha256],
  ] as const
  for (const [field, expected, observed] of expectedBindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `artifact.structuralBindings.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  return Result.succeed(bindings)
}

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
  runtimeMarketDataLoader?: CandidateDevelopmentRuntimeMarketDataLoader,
) => Effect.Effect<unknown, CandidateDevelopmentCommandFailure>

export type CandidateDevelopmentRuntimeMarketDataLoader = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflightInput: CandidateDevelopmentPreflightInput,
) => Effect.Effect<CandidateDevelopmentMarketDataWitness, CandidateDevelopmentCommandFailure>

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

const candidateDevelopmentGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const gitText = (repositoryRoot: string, args: readonly string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'utf8',
        env: candidateDevelopmentGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
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
      {
        encoding: 'buffer',
        env: candidateDevelopmentGitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout)
        else rejectGit(error)
      },
    )
  })

export interface CandidateDevelopmentSourceGit {
  readonly text: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<string>
  readonly bytes: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<Buffer>
  readonly openObjectReader?: (
    repositoryRoot: string,
    signal: AbortSignal,
  ) => Promise<CandidateDevelopmentGitObjectReader>
}

type CandidateDevelopmentGitObjectType = 'blob' | 'commit' | 'tag' | 'tree'

export interface CandidateDevelopmentGitObjectReader {
  readonly read: (oid: string, expectedType: CandidateDevelopmentGitObjectType) => Promise<Buffer>
  readonly close: () => Promise<void>
}

const candidateDevelopmentMaximumGitObjectBytes = 64 * 1024 * 1024
const candidateDevelopmentMaximumGitBatchHeaderBytes = 512
const candidateDevelopmentMaximumGitStderrBytes = 1024 * 1024

class CandidateDevelopmentGitBatchOutput {
  private readonly chunks: Buffer<ArrayBufferLike>[] = []
  private bufferedBytes = 0
  private ended = false
  private failure: unknown
  private waiter: (() => void) | undefined

  constructor(private readonly stream: Readable) {
    stream.pause()
    stream.on('readable', () => this.wake())
    stream.on('end', () => {
      this.ended = true
      this.wake()
    })
    stream.on('error', (cause) => {
      this.failure = cause
      this.wake()
    })
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  fail(cause: unknown): void {
    if (this.failure === undefined) this.failure = cause
    this.wake()
  }

  private async waitForData(): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    if (this.ended) throw new Error('candidate Git batch output ended unexpectedly')
    await new Promise<void>((resolveWait) => {
      this.waiter = resolveWait
    })
    if (this.failure !== undefined) throw this.failure
  }

  private pullAvailable(): void {
    const chunk = this.stream.read() as Buffer | string | null
    if (chunk === null) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.chunks.push(bytes)
    this.bufferedBytes += bytes.length
  }

  private indexOf(value: number): number {
    let offset = 0
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(value)
      if (index >= 0) return offset + index
      offset += chunk.length
    }
    return -1
  }

  private consume(size: number): Buffer {
    if (size === 0) return Buffer.alloc(0)
    const value = Buffer.allocUnsafe(size)
    let written = 0
    while (written < size) {
      const chunk = this.chunks[0]
      if (chunk === undefined) throw new Error('candidate Git batch output is incomplete')
      const remaining = size - written
      const consumed = Math.min(remaining, chunk.length)
      chunk.copy(value, written, 0, consumed)
      written += consumed
      this.bufferedBytes -= consumed
      if (consumed === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(consumed)
    }
    return value
  }

  async readLine(): Promise<string> {
    while (true) {
      this.pullAvailable()
      const newline = this.indexOf(0x0a)
      if (newline >= 0) {
        const line = this.consume(newline).toString('utf8')
        this.consume(1)
        return line
      }
      if (this.bufferedBytes > candidateDevelopmentMaximumGitBatchHeaderBytes) {
        throw new Error('candidate Git batch header exceeds the configured bound')
      }
      await this.waitForData()
    }
  }

  async readBytes(size: number): Promise<Buffer> {
    while (this.bufferedBytes < size) {
      this.pullAvailable()
      if (this.bufferedBytes >= size) break
      await this.waitForData()
    }
    return this.consume(size)
  }
}

const terminateCandidateDevelopmentGitBatch = async (
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit.catch(() => undefined)
    return
  }
  child.stdin.end()
  const completed = await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ])
  if (!completed && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exit.catch(() => undefined)
  }
}

export const openCandidateDevelopmentGitBatchObjectReader = async (
  repositoryRoot: string,
  signal: AbortSignal,
  maximumObjectBytes = candidateDevelopmentMaximumGitObjectBytes,
): Promise<CandidateDevelopmentGitObjectReader> => {
  const child = spawn('git', ['--no-replace-objects', '-C', repositoryRoot, 'cat-file', '--batch'], {
    env: candidateDevelopmentGitEnvironment(),
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = new CandidateDevelopmentGitBatchOutput(child.stdout)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (stderr.length >= candidateDevelopmentMaximumGitStderrBytes) return
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    if (stderr.length > candidateDevelopmentMaximumGitStderrBytes) {
      stderr = stderr.slice(0, candidateDevelopmentMaximumGitStderrBytes)
    }
  })
  const exit = new Promise<void>((resolveExit) => {
    child.once('error', (cause) => {
      output.fail(cause)
      resolveExit()
    })
    child.once('exit', (code, exitSignal) => {
      if (code !== 0 && !(signal.aborted && exitSignal !== null)) {
        output.fail(new Error(`candidate Git batch exited ${code ?? exitSignal}: ${stderr}`))
      }
      resolveExit()
    })
  })
  let closed = false
  const failAndTerminate = (cause: Error): never => {
    output.fail(cause)
    child.stdin.destroy()
    child.stdout.destroy()
    child.kill('SIGKILL')
    throw cause
  }
  return {
    read: async (oid, expectedType) => {
      if (closed) throw new Error('candidate Git batch reader is closed')
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new TypeError(`candidate Git object OID is invalid: ${oid}`)
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(`${oid}\n`, (cause) => {
          if (cause === null || cause === undefined) resolveWrite()
          else rejectWrite(cause)
        })
      })
      const header = await output.readLine()
      if (header === `${oid} missing`) failAndTerminate(new Error(`candidate Git object is missing: ${oid}`))
      const parsed = /^([0-9a-f]{40}) (blob|commit|tag|tree) ([0-9]+)$/.exec(header)
      const match =
        parsed === null ? failAndTerminate(new Error(`candidate Git batch header is invalid: ${header}`)) : parsed
      const [, observedOid, observedType, encodedSize] = match
      const size = Number(encodedSize)
      if (
        observedOid !== oid ||
        observedType !== expectedType ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > maximumObjectBytes
      ) {
        failAndTerminate(
          new Error(
            `candidate Git batch object mismatch: ${JSON.stringify({ oid, expectedType, observedOid, observedType, size, maximumObjectBytes })}`,
          ),
        )
      }
      const content = await output.readBytes(size)
      const delimiter = await output.readBytes(1)
      if (delimiter[0] !== 0x0a) failAndTerminate(new Error('candidate Git batch object delimiter is invalid'))
      return content
    },
    close: async () => {
      if (closed) return
      closed = true
      await terminateCandidateDevelopmentGitBatch(child, exit)
    },
  }
}

const candidateDevelopmentSourceGit: CandidateDevelopmentSourceGit = {
  text: gitText,
  bytes: gitBytes,
  openObjectReader: openCandidateDevelopmentGitBatchObjectReader,
}

const activeGitMetadataLines = (value: string, commentsAllowed: boolean): readonly string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (!commentsAllowed || !line.startsWith('#')))

const readOptionalGitMetadata = async (path: string, signal: AbortSignal): Promise<string> => {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return ''
    throw cause
  }
}

const verifyCandidateDevelopmentRepositoryIntegrityPromise = async (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  const shallow = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['rev-parse', '--is-shallow-repository'], signal),
  )
  if (shallow !== 'false') {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'shallowRepository',
      expected: 'false',
      observed: shallow,
    })
  }

  const replaceRefs = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['for-each-ref', '--format=%(refname)', 'refs/replace'], signal),
  )
  if (replaceRefs.length > 0) {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'replaceRefs',
      expected: [],
      observed: replaceRefs.split('\n'),
    })
  }

  const replacementConfig = await sourceStep('verify-repository-integrity', () =>
    sourceGit.text(repositoryRoot, ['config', '--list'], signal),
  )
  const replacementConfigKeys = replacementConfig
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => key.startsWith('replace.'))
  if (replacementConfigKeys.length > 0) {
    throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
      field: 'replacementConfig',
      expected: [],
      observed: replacementConfigKeys,
    })
  }

  for (const metadata of [
    { field: 'grafts', path: 'info/grafts', commentsAllowed: true },
    { field: 'alternates', path: 'objects/info/alternates', commentsAllowed: false },
    { field: 'httpAlternates', path: 'objects/info/http-alternates', commentsAllowed: false },
  ] as const) {
    const gitPath = await sourceStep('verify-repository-integrity', () =>
      sourceGit.text(repositoryRoot, ['rev-parse', '--git-path', metadata.path], signal),
    )
    const absolutePath = resolve(repositoryRoot, gitPath)
    const contents = await sourceStep('verify-repository-integrity', () =>
      readOptionalGitMetadata(absolutePath, signal),
    )
    const activeLines = activeGitMetadataLines(contents, metadata.commentsAllowed)
    if (activeLines.length > 0) {
      throw new CandidateDevelopmentSourceVerificationError('verify-repository-integrity', {
        field: metadata.field,
        path: absolutePath,
        expected: [],
        observed: activeLines,
      })
    }
  }
}

export const verifyCandidateDevelopmentRepositoryIntegrity = (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) => verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-repository-integrity', cause),
  })

const candidateDevelopmentMaximumHistoryCommits = 50_000
const candidateDevelopmentMaximumHistoryTrees = 500_000

interface CandidateDevelopmentImmutableCommit {
  readonly treeOid: string
  readonly parentOids: readonly string[]
}

interface CandidateDevelopmentImmutableTreeEntry {
  readonly objectType: 'blob' | 'commit' | 'tree'
  readonly objectOid: string
}

const openCandidateDevelopmentGitObjectReader = async (
  repositoryRoot: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<CandidateDevelopmentGitObjectReader> =>
  sourceGit.openObjectReader?.(repositoryRoot, signal) ??
  Promise.resolve({
    read: async (oid, expectedType) =>
      expectedType === 'commit'
        ? Buffer.from(await sourceGit.text(repositoryRoot, ['cat-file', 'commit', oid], signal), 'utf8')
        : sourceGit.bytes(repositoryRoot, ['cat-file', 'tree', oid], signal),
    close: async () => undefined,
  })

const decodeCandidateDevelopmentImmutableCommit = (
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  commitOid: string,
  content: string,
): CandidateDevelopmentImmutableCommit => {
  const header = content.includes('\n\n') ? content.slice(0, content.indexOf('\n\n')) : content
  const lines = header.split('\n')
  const treeLine = lines.find((line) => line.startsWith('tree '))
  const treeOid = treeLine?.slice('tree '.length)
  const parentOids = lines.filter((line) => line.startsWith('parent ')).map((line) => line.slice('parent '.length))
  if (
    treeOid === undefined ||
    !/^[0-9a-f]{40}$/.test(treeOid) ||
    parentOids.some((parentOid) => !/^[0-9a-f]{40}$/.test(parentOid))
  ) {
    throw new CandidateDevelopmentSourceVerificationError(operation, {
      field: 'immutableCommit',
      commitOid,
      expected: 'raw commit with lowercase 40-character tree and parent OIDs',
      observed: { treeOid, parentOids },
    })
  }
  return { treeOid, parentOids }
}

const decodeCandidateDevelopmentImmutableTree = (
  treeOid: string,
  content: Buffer,
): readonly CandidateDevelopmentImmutableTreeEntry[] => {
  const entries: CandidateDevelopmentImmutableTreeEntry[] = []
  let offset = 0
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset)
    const nul = space < 0 ? -1 : content.indexOf(0x00, space + 1)
    if (space <= offset || nul <= space + 1 || nul + 21 > content.length) {
      throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
        field: 'immutableTreeEntry',
        treeOid,
        offset,
        expected: 'raw Git tree entry with mode, name, NUL, and 20-byte object ID',
      })
    }
    const mode = content.subarray(offset, space).toString('ascii')
    const objectOid = content.subarray(nul + 1, nul + 21).toString('hex')
    const objectType: CandidateDevelopmentImmutableTreeEntry['objectType'] =
      mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
    if (!/^[0-9a-f]{40}$/.test(objectOid)) {
      throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
        field: 'immutableTreeObjectOid',
        treeOid,
        offset,
        observed: objectOid,
      })
    }
    entries.push({ objectType, objectOid })
    offset = nul + 21
  }
  return entries
}

const walkCandidateDevelopmentImmutableHistory = async (
  startRevision: string,
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  objectReader: CandidateDevelopmentGitObjectReader,
  visit: (commitOid: string, commit: CandidateDevelopmentImmutableCommit) => Promise<boolean>,
): Promise<boolean> => {
  const pending = [startRevision]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const commitOid = pending.pop()
    if (commitOid === undefined || visited.has(commitOid)) continue
    if (visited.size >= candidateDevelopmentMaximumHistoryCommits) {
      throw new CandidateDevelopmentSourceVerificationError(operation, {
        field: 'immutableHistoryCommitCount',
        expected: `<${candidateDevelopmentMaximumHistoryCommits}`,
        observed: visited.size,
      })
    }
    const content = await sourceStep(operation, () => objectReader.read(commitOid, 'commit'))
    const commit = decodeCandidateDevelopmentImmutableCommit(operation, commitOid, content.toString('utf8'))
    visited.add(commitOid)
    if (await visit(commitOid, commit)) return true
    pending.push(...commit.parentOids)
  }
  return false
}

const verifyCandidateDevelopmentPreregistrationLineagePromise = async (
  repositoryRoot: string,
  preregistrationRevision: string,
  sourceRevision: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
  if (preregistrationRevision === sourceRevision) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-lineage', {
      expected: 'proper ancestor of evaluated source revision',
      observed: preregistrationRevision,
    })
  }
  const objectReader = await sourceStep('verify-preregistration-lineage', () =>
    openCandidateDevelopmentGitObjectReader(repositoryRoot, sourceGit, signal),
  )
  let found: boolean
  try {
    found = await walkCandidateDevelopmentImmutableHistory(
      sourceRevision,
      'verify-preregistration-lineage',
      objectReader,
      async (commitOid) => commitOid === preregistrationRevision,
    )
  } finally {
    await objectReader.close()
  }
  if (!found) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-lineage', {
      expected: `${preregistrationRevision} to be a proper ancestor of ${sourceRevision}`,
      observed: 'not reachable through raw commit parents',
    })
  }
}

export const verifyCandidateDevelopmentPreregistrationLineage = (
  repositoryRoot: string,
  preregistrationRevision: string,
  sourceRevision: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      verifyCandidateDevelopmentPreregistrationLineagePromise(
        repositoryRoot,
        preregistrationRevision,
        sourceRevision,
        sourceGit,
        signal,
      ),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-preregistration-lineage', cause),
  })

const verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise = async (
  repositoryRoot: string,
  preregistrationRevision: string,
  modulePath: string,
  moduleBlobOid: string,
  sourceGit: CandidateDevelopmentSourceGit,
  signal: AbortSignal,
): Promise<void> => {
  await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
  const objectReader = await sourceStep('verify-preregistration-module-novelty', () =>
    openCandidateDevelopmentGitObjectReader(repositoryRoot, sourceGit, signal),
  )
  const searchedTrees = new Set<string>()
  let matchingCommitOid: string | undefined
  const treeContainsModuleBlob = async (rootTreeOid: string): Promise<boolean> => {
    const pendingTrees = [rootTreeOid]
    while (pendingTrees.length > 0) {
      const treeOid = pendingTrees.pop()
      if (treeOid === undefined || searchedTrees.has(treeOid)) continue
      if (searchedTrees.size >= candidateDevelopmentMaximumHistoryTrees) {
        throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
          field: 'immutableHistoryTreeCount',
          expected: `<${candidateDevelopmentMaximumHistoryTrees}`,
          observed: searchedTrees.size,
        })
      }
      const contents = await sourceStep('verify-preregistration-module-novelty', () =>
        objectReader.read(treeOid, 'tree'),
      )
      searchedTrees.add(treeOid)
      for (const { objectType, objectOid } of decodeCandidateDevelopmentImmutableTree(treeOid, contents)) {
        if (objectType === 'blob' && objectOid === moduleBlobOid) return true
        if (objectType === 'tree') pendingTrees.push(objectOid)
      }
    }
    return false
  }
  try {
    await walkCandidateDevelopmentImmutableHistory(
      preregistrationRevision,
      'verify-preregistration-module-novelty',
      objectReader,
      async (commitOid, commit) => {
        const found = await treeContainsModuleBlob(commit.treeOid)
        if (found) matchingCommitOid = commitOid
        return found
      },
    )
  } finally {
    await objectReader.close()
  }
  if (matchingCommitOid !== undefined) {
    throw new CandidateDevelopmentSourceVerificationError('verify-preregistration-module-novelty', {
      preregistrationRevision,
      modulePath,
      expected: 'evaluated module blob created after preregistration',
      observed: moduleBlobOid,
      history: [matchingCommitOid],
    })
  }
}

export const verifyCandidateDevelopmentPreregistrationModuleNovelty = (
  repositoryRoot: string,
  preregistrationRevision: string,
  modulePath: string,
  moduleBlobOid: string,
  sourceGit: CandidateDevelopmentSourceGit = candidateDevelopmentSourceGit,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise(
        repositoryRoot,
        preregistrationRevision,
        modulePath,
        moduleBlobOid,
        sourceGit,
        signal,
      ),
    catch: (cause): CandidateDevelopmentCommandFailure =>
      cause instanceof CandidateDevelopmentSourceVerificationError
        ? sourceVerificationFailure(cause.operation, cause.sourceCause)
        : sourceVerificationFailure('verify-preregistration-module-novelty', cause),
  })

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

const candidateArtifactDowncompiledHelpers = [
  '__assign',
  '__awaiter',
  '__extends',
  '__generator',
  '__read',
  '__spreadArray',
  '__values',
] as const

const candidateMarketPayloadField = (name: string): string | undefined => {
  const normalized = name.replaceAll(/[-_\s]/gu, '').toLowerCase()
  if (normalized === 'sessiondate' || normalized === 'sessiondates' || normalized === 'date' || normalized === 'dates')
    return 'sessionDate'
  if (normalized === 'open' || normalized === 'opens') return 'open'
  if (normalized === 'high' || normalized === 'highs') return 'high'
  if (normalized === 'low' || normalized === 'lows') return 'low'
  if (normalized === 'close' || normalized === 'closes') return 'close'
  if (normalized === 'volume' || normalized === 'volumes') return 'volume'
  return undefined
}

interface CandidateDevelopmentSourceToken {
  readonly kind: SyntaxKind
  readonly text: string
  readonly value: string
}

interface CandidateDevelopmentSourceScan {
  readonly tokens: readonly CandidateDevelopmentSourceToken[]
  readonly comments: readonly string[]
}

const candidateRegexLiteralKeywordPreceders = new Set([
  SyntaxKind.AwaitKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
])

const candidateRegexLiteralPunctuationPreceders = new Set([
  SyntaxKind.ColonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.SemicolonToken,
])

const candidateRegexLiteralControlFlowHeaders = new Set([
  SyntaxKind.CatchKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.WithKeyword,
])

const candidateRegexLiteralControlFlowHeaderBeforeOpenParen = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): boolean => {
  const previousToken = tokens.at(-1)
  const precedingToken = tokens.at(-2)
  const propertyAccess =
    precedingToken?.kind === SyntaxKind.DotToken || precedingToken?.kind === SyntaxKind.QuestionDotToken
  if (candidateRegexLiteralControlFlowHeaders.has(previousToken?.kind ?? SyntaxKind.Unknown)) return !propertyAccess
  return (
    previousToken?.kind === SyntaxKind.AwaitKeyword &&
    precedingToken?.kind === SyntaxKind.ForKeyword &&
    tokens.at(-3)?.kind !== SyntaxKind.DotToken &&
    tokens.at(-3)?.kind !== SyntaxKind.QuestionDotToken
  )
}

const candidateRegexLiteralCanStartAfter = (kind: SyntaxKind | undefined): boolean =>
  kind === undefined ||
  candidateRegexLiteralKeywordPreceders.has(kind) ||
  candidateRegexLiteralPunctuationPreceders.has(kind) ||
  (kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment) ||
  (kind >= SyntaxKind.FirstBinaryOperator &&
    kind <= SyntaxKind.QuestionQuestionToken &&
    kind !== SyntaxKind.PlusPlusToken &&
    kind !== SyntaxKind.MinusMinusToken)

const candidateCommentBody = (kind: SyntaxKind, text: string): string =>
  kind === SyntaxKind.SingleLineCommentTrivia ? text.slice(2) : text.slice(2, -2)

const scanCandidateDevelopmentSource = (source: string): CandidateDevelopmentSourceScan => {
  const scanner = createScanner(false, LanguageVariant.Standard, source)
  const tokens: CandidateDevelopmentSourceToken[] = []
  const comments: string[] = []
  const templateSubstitutionBraceDepths: number[] = []
  const controlFlowHeaderParens: boolean[] = []
  let controlFlowHeaderClosed = false
  let previousKind: SyntaxKind | undefined
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
      comments.push(candidateCommentBody(kind, scanner.getTokenText()))
      continue
    }
    if (
      kind === SyntaxKind.WhitespaceTrivia ||
      kind === SyntaxKind.NewLineTrivia ||
      kind === SyntaxKind.NonTextFileMarkerTrivia ||
      kind === SyntaxKind.ConflictMarkerTrivia
    )
      continue
    const regexCanStartAfterControlFlowHeader = controlFlowHeaderClosed
    controlFlowHeaderClosed = false
    if (
      kind === SyntaxKind.SlashToken &&
      (candidateRegexLiteralCanStartAfter(previousKind) || regexCanStartAfterControlFlowHeader)
    ) {
      kind = scanner.reScanSlashToken()
    }
    const templateBraceDepth = templateSubstitutionBraceDepths.at(-1)
    if (kind === SyntaxKind.CloseBraceToken && templateBraceDepth === 0) {
      kind = scanner.reScanTemplateToken(false)
      if (kind === SyntaxKind.TemplateTail) templateSubstitutionBraceDepths.pop()
    } else {
      if (templateBraceDepth !== undefined) {
        if (kind === SyntaxKind.OpenBraceToken) {
          templateSubstitutionBraceDepths[templateSubstitutionBraceDepths.length - 1] = templateBraceDepth + 1
        } else if (kind === SyntaxKind.CloseBraceToken) {
          templateSubstitutionBraceDepths[templateSubstitutionBraceDepths.length - 1] = templateBraceDepth - 1
        }
      }
      if (kind === SyntaxKind.TemplateHead) templateSubstitutionBraceDepths.push(0)
    }
    if (kind === SyntaxKind.OpenParenToken) {
      controlFlowHeaderParens.push(candidateRegexLiteralControlFlowHeaderBeforeOpenParen(tokens))
    } else if (kind === SyntaxKind.CloseParenToken) {
      controlFlowHeaderClosed = controlFlowHeaderParens.pop() === true
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() })
    previousKind = kind
  }
  return { tokens, comments }
}

const candidateDevelopmentParserRegularExpressions = (source: string): readonly string[] => {
  let normalized: string
  try {
    normalized = new Bun.Transpiler({ loader: 'js' }).transformSync(source)
  } catch {
    return []
  }
  const scanner = createScanner(false, LanguageVariant.Standard, normalized)
  const expressions: string[] = []
  let previousKind: SyntaxKind | undefined
  let lineStart = true
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.NewLineTrivia) {
      lineStart = true
      continue
    }
    if (
      kind === SyntaxKind.WhitespaceTrivia ||
      kind === SyntaxKind.SingleLineCommentTrivia ||
      kind === SyntaxKind.MultiLineCommentTrivia ||
      kind === SyntaxKind.NonTextFileMarkerTrivia ||
      kind === SyntaxKind.ConflictMarkerTrivia
    ) {
      if (scanner.getTokenText().includes('\n')) lineStart = true
      continue
    }
    if (kind === SyntaxKind.SlashToken && (lineStart || candidateRegexLiteralCanStartAfter(previousKind))) {
      kind = scanner.reScanSlashToken()
    }
    if (kind === SyntaxKind.RegularExpressionLiteral) {
      expressions.push(candidateRegularExpressionBody(scanner.getTokenText()))
    }
    lineStart = false
    previousKind = kind
  }
  return expressions
}

const candidateIdentifierNameToken = (token: CandidateDevelopmentSourceToken | undefined): string | undefined =>
  token !== undefined &&
  (token.kind === SyntaxKind.Identifier ||
    (token.kind >= SyntaxKind.FirstKeyword && token.kind <= SyntaxKind.LastKeyword))
    ? token.value
    : undefined

const candidateTokenName = (token: CandidateDevelopmentSourceToken | undefined): string | undefined =>
  token?.kind === SyntaxKind.StringLiteral ? token.value : candidateIdentifierNameToken(token)

const candidatePropertyNameAt = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
): { readonly name: string; readonly end: number } | undefined => {
  const direct = candidateTokenName(tokens[index])
  if (direct !== undefined) return { name: direct, end: index }
  if (
    tokens[index]?.kind === SyntaxKind.OpenBracketToken &&
    tokens[index + 1]?.kind === SyntaxKind.StringLiteral &&
    tokens[index + 2]?.kind === SyntaxKind.CloseBracketToken
  )
    return { name: tokens[index + 1]?.value ?? '', end: index + 2 }
  return undefined
}

const candidatePropertyNameBefore = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  separatorIndex: number,
): string | undefined => {
  const direct = candidateTokenName(tokens[separatorIndex - 1])
  if (direct !== undefined) return direct
  if (
    tokens[separatorIndex - 1]?.kind === SyntaxKind.CloseBracketToken &&
    tokens[separatorIndex - 2]?.kind === SyntaxKind.StringLiteral &&
    tokens[separatorIndex - 3]?.kind === SyntaxKind.OpenBracketToken
  )
    return tokens[separatorIndex - 2]?.value
  return undefined
}

const candidateRegularExpressionBody = (text: string): string => {
  let escaped = false
  let characterClass = false
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') characterClass = true
    else if (character === ']') characterClass = false
    else if (character === '/' && !characterClass) return text.slice(1, index)
  }
  return text
}

const candidateExecutableStringToken = (token: CandidateDevelopmentSourceToken): string | undefined => {
  if (
    token.kind === SyntaxKind.StringLiteral ||
    token.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    token.kind === SyntaxKind.TemplateHead ||
    token.kind === SyntaxKind.TemplateMiddle ||
    token.kind === SyntaxKind.TemplateTail
  )
    return token.value
  if (token.kind === SyntaxKind.RegularExpressionLiteral) return candidateRegularExpressionBody(token.text)
  return undefined
}

const candidateScalarToken = (token: CandidateDevelopmentSourceToken): string | undefined => {
  const executableString = candidateExecutableStringToken(token)
  if (executableString !== undefined) return executableString
  if (token.kind === SyntaxKind.NumericLiteral || token.kind === SyntaxKind.BigIntLiteral) return token.value
  if (token.kind === SyntaxKind.TrueKeyword) return 'true'
  if (token.kind === SyntaxKind.FalseKeyword) return 'false'
  if (token.kind === SyntaxKind.NullKeyword) return 'null'
  return undefined
}

const candidateExecutableIdentifierToken = (token: CandidateDevelopmentSourceToken): string | undefined =>
  token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.PrivateIdentifier ? token.value : undefined

const candidateExecutableKeywordPropertyToken = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
): string | undefined => {
  const token = tokens[index]
  if (token === undefined || token.kind < SyntaxKind.FirstKeyword || token.kind > SyntaxKind.LastKeyword)
    return undefined
  const previousKind = tokens[index - 1]?.kind
  const nextKind = tokens[index + 1]?.kind
  if (
    nextKind === SyntaxKind.ColonToken ||
    nextKind === SyntaxKind.OpenParenToken ||
    nextKind === SyntaxKind.EqualsToken ||
    previousKind === SyntaxKind.DotToken ||
    previousKind === SyntaxKind.QuestionDotToken ||
    ((previousKind === SyntaxKind.OpenBraceToken ||
      previousKind === SyntaxKind.CommaToken ||
      previousKind === SyntaxKind.SemicolonToken) &&
      (nextKind === SyntaxKind.CommaToken ||
        nextKind === SyntaxKind.CloseBraceToken ||
        nextKind === SyntaxKind.SemicolonToken))
  )
    return token.value
  return undefined
}

interface CandidateDevelopmentTokenRange {
  readonly name: 'strategyProtocol' | 'structuralBindings'
  readonly start: number
  readonly end: number
}

interface CandidateDevelopmentGovernedScalar {
  readonly metadata: CandidateDevelopmentTokenRange['name']
  readonly path: readonly string[]
}

const candidateDevelopmentGovernedMetadataRanges = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): readonly CandidateDevelopmentTokenRange[] => {
  const artifactName = tokens.findIndex(
    (token, index) =>
      candidateTokenName(token) === 'candidateDevelopmentArtifact' &&
      tokens[index + 1]?.kind === SyntaxKind.EqualsToken &&
      tokens[index + 2]?.kind === SyntaxKind.OpenBraceToken,
  )
  if (artifactName < 0) return []
  const objectStart = artifactName + 2
  const ranges: CandidateDevelopmentTokenRange[] = []
  let curlyDepth = 1
  let squareDepth = 0
  let parenDepth = 0
  for (let index = objectStart + 1; index < tokens.length && curlyDepth > 0; index += 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (curlyDepth === 1 && squareDepth === 0 && parenDepth === 0) {
      const property = candidatePropertyNameAt(tokens, index)
      const name = property?.name
      if (
        (name === 'strategyProtocol' || name === 'structuralBindings') &&
        tokens[(property?.end ?? index) + 1]?.kind === SyntaxKind.ColonToken
      ) {
        const valueStart = (property?.end ?? index) + 2
        let valueCurly = 0
        let valueSquare = 0
        let valueParen = 0
        let valueEnd = valueStart
        for (; valueEnd < tokens.length; valueEnd += 1) {
          const valueToken = tokens[valueEnd]
          if (valueToken === undefined) break
          if (
            valueCurly === 0 &&
            valueSquare === 0 &&
            valueParen === 0 &&
            (valueToken.kind === SyntaxKind.CommaToken || valueToken.kind === SyntaxKind.CloseBraceToken)
          )
            break
          if (valueToken.kind === SyntaxKind.OpenBraceToken) valueCurly += 1
          else if (valueToken.kind === SyntaxKind.CloseBraceToken) valueCurly -= 1
          else if (valueToken.kind === SyntaxKind.OpenBracketToken) valueSquare += 1
          else if (valueToken.kind === SyntaxKind.CloseBracketToken) valueSquare -= 1
          else if (valueToken.kind === SyntaxKind.OpenParenToken) valueParen += 1
          else if (valueToken.kind === SyntaxKind.CloseParenToken) valueParen -= 1
        }
        ranges.push({ name, start: valueStart, end: valueEnd })
        index = valueEnd - 1
        continue
      }
    }
    if (token.kind === SyntaxKind.OpenBraceToken) curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) squareDepth += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) squareDepth -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) parenDepth += 1
    else if (token.kind === SyntaxKind.CloseParenToken) parenDepth -= 1
  }
  return ranges
}

const candidateDevelopmentGovernedScalars = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  ranges: readonly CandidateDevelopmentTokenRange[],
): ReadonlyMap<number, CandidateDevelopmentGovernedScalar> => {
  const scalars = new Map<number, CandidateDevelopmentGovernedScalar>()
  const parseValue = (
    initialIndex: number,
    end: number,
    metadata: CandidateDevelopmentTokenRange['name'],
    path: readonly string[],
  ): number => {
    let index = initialIndex
    if (tokens[index]?.kind === SyntaxKind.PlusToken || tokens[index]?.kind === SyntaxKind.MinusToken) index += 1
    const token = tokens[index]
    if (token === undefined || index >= end) return initialIndex + 1
    if (token.kind === SyntaxKind.OpenBraceToken) {
      let cursor = index + 1
      while (cursor < end && tokens[cursor]?.kind !== SyntaxKind.CloseBraceToken) {
        const property = candidatePropertyNameAt(tokens, cursor)
        const separator = property === undefined ? undefined : tokens[property.end + 1]
        if (property !== undefined && separator?.kind === SyntaxKind.ColonToken) {
          cursor = parseValue(property.end + 2, end, metadata, [...path, property.name])
        } else cursor += 1
        if (tokens[cursor]?.kind === SyntaxKind.CommaToken) cursor += 1
      }
      return tokens[cursor]?.kind === SyntaxKind.CloseBraceToken ? cursor + 1 : cursor
    }
    if (token.kind === SyntaxKind.OpenBracketToken) {
      let cursor = index + 1
      while (cursor < end && tokens[cursor]?.kind !== SyntaxKind.CloseBracketToken) {
        cursor = parseValue(cursor, end, metadata, [...path, '[]'])
        if (tokens[cursor]?.kind === SyntaxKind.CommaToken) cursor += 1
      }
      return tokens[cursor]?.kind === SyntaxKind.CloseBracketToken ? cursor + 1 : cursor
    }
    if (candidateScalarToken(token) !== undefined) {
      scalars.set(index, { metadata, path })
      return index + 1
    }
    return initialIndex + 1
  }

  for (const range of ranges) parseValue(range.start, range.end, range.name, [range.name])
  return scalars
}

const candidateDevelopmentImmutableStructuralBindingPaths = new Set([
  'structuralBindings.schemaVersion',
  'structuralBindings.candidateOrdinal',
  'structuralBindings.priorTrialCount',
  'structuralBindings.strategyProtocolHash',
  'structuralBindings.strategyIdentityHash',
  'structuralBindings.candidateDevelopmentProtocolHash',
  'structuralBindings.calendarHash',
  'structuralBindings.priorTrialsHash',
  'structuralBindings.modulePath',
  'structuralBindings.sourceManifestPath',
])

const candidateDevelopmentImmutableStrategyProtocolPaths = new Set([
  'strategyProtocol.schemaVersion',
  'strategyProtocol.universe.[]',
  'strategyProtocol.directVolatilityTarget',
  'strategyProtocol.initialCapitalMicros',
  'strategyProtocol.executionModel.schemaVersion',
  'strategyProtocol.executionModel.venue',
  'strategyProtocol.executionModel.assetClass',
  'strategyProtocol.executionModel.precision.quantityIncrementMicros',
  'strategyProtocol.executionModel.precision.priceIncrementMicros',
  'strategyProtocol.executionModel.precision.minimumBuyNotionalMicros',
  'strategyProtocol.executionModel.priceImpact.halfSpreadBps',
  'strategyProtocol.executionModel.priceImpact.slippageBps',
  'strategyProtocol.executionModel.fees.scheduleVersion',
  'strategyProtocol.executionModel.fees.commissionBps',
  'strategyProtocol.executionModel.fees.secSellBps',
  'strategyProtocol.executionModel.fees.tafSellPerShareMicros',
  'strategyProtocol.executionModel.fees.tafMaximumPerOrderMicros',
  'strategyProtocol.executionModel.fees.catPerShareMicros',
  'strategyProtocol.executionModel.fees.aggregation',
  'strategyProtocol.executionModel.fees.roundingIncrementMicros',
  'strategyProtocol.executionModel.cash.annualYieldBps',
  'strategyProtocol.executionModel.cash.dayCount',
  'strategyProtocol.executionModel.cash.accrual',
  'strategyProtocol.executionModel.partialFills.policy',
  'strategyProtocol.executionModel.partialFills.probabilityPpm',
  'strategyProtocol.executionModel.partialFills.filledFractionPpm',
  'strategyProtocol.executionModel.partialFills.remainder',
  'strategyProtocol.executionModel.doubleCostMultiplier',
  'strategyProtocol.executionModel.order.type',
  'strategyProtocol.executionModel.order.timeInForce',
  'strategyProtocol.executionModel.order.extendedHours',
  'strategyProtocol.executionModel.order.submitAfter',
  'strategyProtocol.executionModel.order.submitBefore',
  'strategyProtocol.executionModel.order.priceReference',
  'strategyProtocol.executionModel.order.planAfter',
  'strategyProtocol.executionModel.order.planningPriceReference',
  'strategyProtocol.executionModel.order.planningBrokerStateReference',
  'strategyProtocol.executionModel.order.fillPriceReference',
  'strategyProtocol.executionModel.order.buyingPowerPolicy',
  'strategyProtocol.executionModel.order.submissionCutoffLeadMinutes',
  'strategyProtocol.thresholds.minimumObservations',
  'strategyProtocol.thresholds.minimumAnnualizedReturn',
  'strategyProtocol.thresholds.minimumSharpeImprovement',
  'strategyProtocol.thresholds.maximumDrawdown',
  'strategyProtocol.thresholds.maximumAnnualTurnover',
  'strategyProtocol.thresholds.requirePositiveDoubleCostReturn',
  'strategyProtocol.marketData.schemaVersion',
  'strategyProtocol.marketData.snapshotId',
  'strategyProtocol.marketData.contentHash',
  'strategyProtocol.benchmarks.schemaVersion',
  'strategyProtocol.benchmarks.symbol',
  'strategyProtocol.benchmarks.directVolatilityWindow',
  'strategyProtocol.benchmarks.terminalPolicy',
  'strategyProtocol.strategyIdentity.schemaVersion',
  'strategyProtocol.strategyIdentity.parameters.lookbackSessions',
  'strategyProtocol.strategyIdentity.parameters.volatilityWindowSessions',
  'strategyProtocol.strategyIdentity.parameters.annualizationSessions',
  'strategyProtocol.strategyIdentity.parameters.riskAssets.[]',
  'strategyProtocol.strategyIdentity.parameters.defensiveAsset',
  'strategyProtocol.strategyIdentity.parameters.absoluteMomentumThreshold',
  'strategyProtocol.strategyIdentity.parameters.selectedAssetWeight',
  'strategyProtocol.strategyIdentity.parameters.relativeMomentumTieBreak',
  'strategyProtocol.strategyIdentity.parameters.covarianceEstimator',
  'strategyProtocol.strategyIdentity.parameters.targetAnnualizedVolatility',
  'strategyProtocol.strategyIdentity.parameters.maximumGrossExposure',
])

const candidateDevelopmentPayloadBearingStrategyProtocolPaths = new Set([
  'strategyProtocol.strategyIdentity.family',
  'strategyProtocol.strategyIdentity.identifier',
  'strategyProtocol.strategyIdentity.researchSources.[]',
  'strategyProtocol.strategyIdentity.parameters.id',
  'strategyProtocol.strategyIdentity.input',
  'strategyProtocol.strategyIdentity.relativeMomentum',
  'strategyProtocol.strategyIdentity.absoluteMomentum',
  'strategyProtocol.strategyIdentity.defensive',
  'strategyProtocol.strategyIdentity.weighting',
  'strategyProtocol.strategyIdentity.riskScaling',
  'strategyProtocol.strategyIdentity.allocation',
  'strategyProtocol.strategyIdentity.schedule',
  'strategyProtocol.strategyIdentity.terminal',
  'strategyProtocol.strategyIdentity.missingData',
  'strategyProtocol.strategyIdentity.doubledCost',
])

const candidateDevelopmentGovernedScalarPath = (scalar: CandidateDevelopmentGovernedScalar): string =>
  scalar.path.join('.')

const candidateDevelopmentImmutableGovernedScalar = (scalar: CandidateDevelopmentGovernedScalar): boolean => {
  const path = candidateDevelopmentGovernedScalarPath(scalar)
  return scalar.metadata === 'structuralBindings'
    ? candidateDevelopmentImmutableStructuralBindingPaths.has(path)
    : candidateDevelopmentImmutableStrategyProtocolPaths.has(path)
}

const candidateDevelopmentPayloadBearingGovernedString = (scalar: CandidateDevelopmentGovernedScalar): boolean =>
  scalar.metadata === 'strategyProtocol' &&
  candidateDevelopmentPayloadBearingStrategyProtocolPaths.has(candidateDevelopmentGovernedScalarPath(scalar))

const candidateDevelopmentJavaScriptKeywordOperators = new Set([
  SyntaxKind.AwaitKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
])

interface CandidateDevelopmentExecutableSyntaxInspection {
  readonly executablePunctuationCount: number
  readonly executablePunctuationBytes: number
  readonly executableKeywordOperatorCount: number
  readonly executableKeywordOperatorBytes: number
}

const candidatePunctuationIsImmutableGovernedScalarSign = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  index: number,
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): boolean => {
  const token = tokens[index]
  if (token?.kind !== SyntaxKind.PlusToken && token?.kind !== SyntaxKind.MinusToken) return false
  const scalarToken = tokens[index + 1]
  const scalar = governedScalars.get(index + 1)
  return (
    scalarToken !== undefined &&
    (scalarToken.kind === SyntaxKind.NumericLiteral || scalarToken.kind === SyntaxKind.BigIntLiteral) &&
    scalar !== undefined &&
    candidateDevelopmentImmutableGovernedScalar(scalar)
  )
}

const inspectCandidateDevelopmentExecutableSyntax = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): CandidateDevelopmentExecutableSyntaxInspection => {
  let executablePunctuationCount = 0
  let executablePunctuationBytes = 0
  let executableKeywordOperatorCount = 0
  let executableKeywordOperatorBytes = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (
      token.kind >= SyntaxKind.FirstPunctuation &&
      token.kind <= SyntaxKind.LastPunctuation &&
      !candidatePunctuationIsImmutableGovernedScalarSign(tokens, index, governedScalars)
    ) {
      executablePunctuationCount += 1
      executablePunctuationBytes += Buffer.byteLength(token.text, 'utf8')
    }
    if (
      candidateDevelopmentJavaScriptKeywordOperators.has(token.kind) &&
      candidateExecutableKeywordPropertyToken(tokens, index) === undefined
    ) {
      executableKeywordOperatorCount += 1
      executableKeywordOperatorBytes += Buffer.byteLength(token.text, 'utf8')
    }
  }
  return {
    executablePunctuationCount,
    executablePunctuationBytes,
    executableKeywordOperatorCount,
    executableKeywordOperatorBytes,
  }
}

interface CandidateDevelopmentExecutableArrayInspection {
  readonly executableArrayCount: number
  readonly largestExecutableArray: number
}

interface CandidateDevelopmentExecutableArrayFrame {
  readonly openIndex: number
  readonly literalCandidate: boolean
  elementStart: number
  curlyDepth: number
  parenDepth: number
  executableElementCount: number
}

const candidateArrayElementIsImmutableGovernedScalar = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  start: number,
  end: number,
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): boolean => {
  if (end - start !== 1) return false
  const token = tokens[start]
  const scalar = governedScalars.get(start)
  return (
    token !== undefined &&
    candidateScalarToken(token) !== undefined &&
    scalar !== undefined &&
    candidateDevelopmentImmutableGovernedScalar(scalar)
  )
}

const inspectCandidateDevelopmentExecutableArrays = (
  tokens: readonly CandidateDevelopmentSourceToken[],
  governedScalars: ReadonlyMap<number, CandidateDevelopmentGovernedScalar>,
): CandidateDevelopmentExecutableArrayInspection => {
  const frames: CandidateDevelopmentExecutableArrayFrame[] = []
  let executableArrayCount = 0
  let largestExecutableArray = 0
  const countElement = (frame: CandidateDevelopmentExecutableArrayFrame, end: number, commaTerminated: boolean) => {
    if (frame.elementStart === end) {
      if (commaTerminated) frame.executableElementCount += 1
      return
    }
    if (!candidateArrayElementIsImmutableGovernedScalar(tokens, frame.elementStart, end, governedScalars))
      frame.executableElementCount += 1
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token.kind === SyntaxKind.OpenBracketToken) {
      frames.push({
        openIndex: index,
        literalCandidate: candidateRegexLiteralCanStartAfter(tokens[index - 1]?.kind),
        elementStart: index + 1,
        curlyDepth: 0,
        parenDepth: 0,
        executableElementCount: 0,
      })
      continue
    }
    if (token.kind === SyntaxKind.CloseBracketToken) {
      const frame = frames.pop()
      if (frame === undefined) continue
      const computedProperty =
        tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
        (tokens[frame.openIndex - 1]?.kind === SyntaxKind.OpenBraceToken ||
          tokens[frame.openIndex - 1]?.kind === SyntaxKind.CommaToken)
      if (frame.literalCandidate && !computedProperty) {
        countElement(frame, index, false)
        if (frame.executableElementCount > 0) {
          executableArrayCount += 1
          largestExecutableArray = Math.max(largestExecutableArray, frame.executableElementCount)
        }
      }
      continue
    }
    const frame = frames.at(-1)
    if (frame === undefined) continue
    if (token.kind === SyntaxKind.OpenBraceToken) frame.curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) frame.curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenParenToken) frame.parenDepth += 1
    else if (token.kind === SyntaxKind.CloseParenToken) frame.parenDepth -= 1
    else if (token.kind === SyntaxKind.CommaToken && frame.curlyDepth === 0 && frame.parenDepth === 0) {
      countElement(frame, index, true)
      frame.elementStart = index + 1
    }
  }
  return { executableArrayCount, largestExecutableArray }
}

interface CandidateDevelopmentParenthesizedArgumentInspection {
  readonly parenthesizedArgumentListCount: number
  readonly parenthesizedArgumentCount: number
  readonly largestParenthesizedArgumentList: number
}

interface CandidateDevelopmentParenthesizedArgumentFrame {
  readonly argumentListCandidate: boolean
  argumentStart: number
  curlyDepth: number
  squareDepth: number
  argumentCount: number
}

const candidateParenthesizedArgumentListCanStartAfter = (
  token: CandidateDevelopmentSourceToken | undefined,
): boolean => {
  if (token === undefined) return false
  if (
    token.kind === SyntaxKind.Identifier ||
    token.kind === SyntaxKind.PrivateIdentifier ||
    token.kind === SyntaxKind.CloseParenToken ||
    token.kind === SyntaxKind.CloseBracketToken ||
    token.kind === SyntaxKind.CloseBraceToken ||
    token.kind === SyntaxKind.QuestionDotToken ||
    token.kind === SyntaxKind.ThisKeyword ||
    token.kind === SyntaxKind.SuperKeyword ||
    token.kind === SyntaxKind.ImportKeyword ||
    token.kind === SyntaxKind.NewKeyword ||
    token.kind === SyntaxKind.StringLiteral ||
    token.kind === SyntaxKind.NumericLiteral ||
    token.kind === SyntaxKind.BigIntLiteral ||
    token.kind === SyntaxKind.TrueKeyword ||
    token.kind === SyntaxKind.FalseKeyword ||
    token.kind === SyntaxKind.NullKeyword ||
    token.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    token.kind === SyntaxKind.TemplateTail ||
    token.kind === SyntaxKind.RegularExpressionLiteral
  )
    return true
  return false
}

const inspectCandidateDevelopmentParenthesizedArguments = (
  tokens: readonly CandidateDevelopmentSourceToken[],
): CandidateDevelopmentParenthesizedArgumentInspection => {
  const frames: CandidateDevelopmentParenthesizedArgumentFrame[] = []
  let parenthesizedArgumentListCount = 0
  let parenthesizedArgumentCount = 0
  let largestParenthesizedArgumentList = 0
  const countArgument = (frame: CandidateDevelopmentParenthesizedArgumentFrame, end: number) => {
    if (frame.argumentStart < end) frame.argumentCount += 1
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token.kind === SyntaxKind.OpenParenToken) {
      frames.push({
        argumentListCandidate: candidateParenthesizedArgumentListCanStartAfter(tokens[index - 1]),
        argumentStart: index + 1,
        curlyDepth: 0,
        squareDepth: 0,
        argumentCount: 0,
      })
      continue
    }
    if (token.kind === SyntaxKind.CloseParenToken) {
      const frame = frames.pop()
      if (frame === undefined) continue
      const declarationOrArrow =
        tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken ||
        tokens[index + 1]?.kind === SyntaxKind.EqualsGreaterThanToken
      if (frame.argumentListCandidate && !declarationOrArrow) {
        countArgument(frame, index)
        parenthesizedArgumentListCount += 1
        parenthesizedArgumentCount += frame.argumentCount
        largestParenthesizedArgumentList = Math.max(largestParenthesizedArgumentList, frame.argumentCount)
      }
      continue
    }
    const frame = frames.at(-1)
    if (frame === undefined) continue
    if (token.kind === SyntaxKind.OpenBraceToken) frame.curlyDepth += 1
    else if (token.kind === SyntaxKind.CloseBraceToken) frame.curlyDepth -= 1
    else if (token.kind === SyntaxKind.OpenBracketToken) frame.squareDepth += 1
    else if (token.kind === SyntaxKind.CloseBracketToken) frame.squareDepth -= 1
    else if (token.kind === SyntaxKind.CommaToken && frame.curlyDepth === 0 && frame.squareDepth === 0) {
      countArgument(frame, index)
      frame.argumentStart = index + 1
    }
  }
  return {
    parenthesizedArgumentListCount,
    parenthesizedArgumentCount,
    largestParenthesizedArgumentList,
  }
}

interface CandidateDevelopmentLiteralPayloadInspection {
  readonly frozenDateLiterals: readonly string[]
  readonly governedPayloadDateLiterals: readonly string[]
  readonly regularExpressionLiteralLengths: readonly number[]
  readonly interpolatedTemplateSegmentLengths: readonly number[]
  readonly commentLengths: readonly number[]
  readonly executableCommentCount: number
  readonly executableCommentBytes: number
  readonly longIdentifierLengths: readonly number[]
  readonly encodedIdentifierLengths: readonly number[]
  readonly executableIdentifierCount: number
  readonly executableIdentifierBytes: number
  readonly keywordPropertyNameCount: number
  readonly keywordPropertyNameBytes: number
  readonly executablePunctuationCount: number
  readonly executablePunctuationBytes: number
  readonly executableKeywordOperatorCount: number
  readonly executableKeywordOperatorBytes: number
  readonly executableArrayCount: number
  readonly largestExecutableArray: number
  readonly parenthesizedArgumentListCount: number
  readonly parenthesizedArgumentCount: number
  readonly largestParenthesizedArgumentList: number
  readonly marketObjectFields: readonly (readonly string[])[]
  readonly parallelMarketFields: readonly string[]
  readonly literalArrayCount: number
  readonly largestLiteralArray: number
  readonly largestLiteralObject: number
  readonly longStringLiteralLengths: readonly number[]
  readonly encodedNumericStringLengths: readonly number[]
  readonly encodedBinaryStringLengths: readonly number[]
  readonly outOfRangeImmutableDecimalScalars: readonly {
    readonly path: string
    readonly length: number
    readonly maximumLength: number
    readonly exceedsMaximumValue: boolean
  }[]
  readonly governedPayloadStringCount: number
  readonly governedPayloadStringBytes: number
  readonly executableLiteralCount: number
  readonly executableLiteralBytes: number
}

const candidateDevelopmentMaximumImmutableDecimal = '340282366920938463463374607431768211455'

const inspectCandidateDevelopmentLiteralPayload = (
  source: string,
  _modulePath: string,
): CandidateDevelopmentLiteralPayloadInspection => {
  const { comments, tokens } = scanCandidateDevelopmentSource(source)
  const rawRegularExpressionCounts = new Map<string, number>()
  for (const token of tokens) {
    if (token.kind !== SyntaxKind.RegularExpressionLiteral) continue
    const body = candidateRegularExpressionBody(token.text)
    rawRegularExpressionCounts.set(body, (rawRegularExpressionCounts.get(body) ?? 0) + 1)
  }
  const parserOnlyRegularExpressions: string[] = []
  for (const body of candidateDevelopmentParserRegularExpressions(source)) {
    const rawCount = rawRegularExpressionCounts.get(body) ?? 0
    if (rawCount > 0) rawRegularExpressionCounts.set(body, rawCount - 1)
    else parserOnlyRegularExpressions.push(body)
  }
  const governedRanges = candidateDevelopmentGovernedMetadataRanges(tokens)
  const governedScalars = candidateDevelopmentGovernedScalars(tokens, governedRanges)
  const executableSyntax = inspectCandidateDevelopmentExecutableSyntax(tokens, governedScalars)
  const executableArrays = inspectCandidateDevelopmentExecutableArrays(tokens, governedScalars)
  const parenthesizedArguments = inspectCandidateDevelopmentParenthesizedArguments(tokens)
  const frozenDateLiterals: string[] = []
  const governedPayloadDateLiterals: string[] = []
  const regularExpressionLiteralLengths: number[] = []
  const interpolatedTemplateSegmentLengths: number[] = []
  const commentLengths: number[] = []
  const longIdentifierLengths: number[] = []
  const encodedIdentifierLengths: number[] = []
  const marketObjectFields: string[][] = []
  const parallelMarketFields = new Set<string>()
  const longStringLiteralLengths: number[] = []
  const encodedNumericStringLengths: number[] = []
  const encodedBinaryStringLengths: number[] = []
  const outOfRangeImmutableDecimalScalars: {
    readonly path: string
    readonly length: number
    readonly maximumLength: number
    readonly exceedsMaximumValue: boolean
  }[] = []
  let literalArrayCount = 0
  let largestLiteralArray = 0
  let largestLiteralObject = 0
  let governedPayloadStringCount = 0
  let governedPayloadStringBytes = 0
  let executableCommentCount = 0
  let executableCommentBytes = 0
  let executableIdentifierCount = 0
  let executableIdentifierBytes = 0
  let keywordPropertyNameCount = 0
  let keywordPropertyNameBytes = 0
  let executableLiteralCount = 0
  let executableLiteralBytes = 0
  const objects: { readonly fields: Set<string>; numericLiteralCount: number }[] = []
  const arrays: { literalCount: number }[] = []
  const governedRangeAt = (index: number): CandidateDevelopmentTokenRange | undefined =>
    governedRanges.find((range) => index >= range.start && index < range.end)

  for (const comment of comments) {
    const commentBytes = Buffer.byteLength(comment, 'utf8')
    commentLengths.push(comment.length)
    executableCommentCount += 1
    executableCommentBytes += commentBytes
    executableLiteralCount += 1
    executableLiteralBytes += commentBytes
    frozenDateLiterals.push(...(comment.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []))
    if (comment.length > 128) longStringLiteralLengths.push(comment.length)
    const numericTokens = comment.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
    const delimiters = comment.match(/[,|;\t\n]/gu) ?? []
    if (comment.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
      encodedNumericStringLengths.push(comment.length)
    if (
      comment.length >= 96 &&
      (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(comment) ||
        /^[a-f0-9]+$/u.test(comment))
    )
      encodedBinaryStringLengths.push(comment.length)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    const governedRange = governedRangeAt(index)
    const governedScalar = governedScalars.get(index)
    const regularExpressionLiteral = token.kind === SyntaxKind.RegularExpressionLiteral
    const interpolatedTemplateSegment =
      token.kind === SyntaxKind.TemplateHead ||
      token.kind === SyntaxKind.TemplateMiddle ||
      token.kind === SyntaxKind.TemplateTail
    const dynamicExecutableString = regularExpressionLiteral || interpolatedTemplateSegment
    const immutableGovernedScalar =
      !dynamicExecutableString &&
      governedScalar !== undefined &&
      candidateDevelopmentImmutableGovernedScalar(governedScalar)
    const payloadBearingGovernedString =
      governedScalar !== undefined && candidateDevelopmentPayloadBearingGovernedString(governedScalar)
    const executableString = candidateExecutableStringToken(token)

    const keywordPropertyName = candidateExecutableKeywordPropertyToken(tokens, index)
    const executableIdentifier = candidateExecutableIdentifierToken(token) ?? keywordPropertyName
    if (executableIdentifier !== undefined) {
      const identifier = executableIdentifier
      const identifierBytes = Buffer.byteLength(identifier, 'utf8')
      if (keywordPropertyName !== undefined) {
        keywordPropertyNameCount += 1
        keywordPropertyNameBytes += identifierBytes
      }
      if (identifier.length > 128) longIdentifierLengths.push(identifier.length)
      if (identifier.length >= 96) encodedIdentifierLengths.push(identifier.length)
      executableIdentifierCount += 1
      executableIdentifierBytes += identifierBytes
      executableLiteralCount += 1
      executableLiteralBytes += identifierBytes
    }

    if (
      executableString !== undefined &&
      (dynamicExecutableString || governedRange === undefined || governedScalar !== undefined)
    ) {
      const value = executableString
      if (
        immutableGovernedScalar &&
        governedScalar !== undefined &&
        /^\d+$/u.test(value) &&
        (value.length > candidateDevelopmentMaximumImmutableDecimal.length ||
          (value.length === candidateDevelopmentMaximumImmutableDecimal.length &&
            value > candidateDevelopmentMaximumImmutableDecimal))
      ) {
        outOfRangeImmutableDecimalScalars.push({
          path: candidateDevelopmentGovernedScalarPath(governedScalar),
          length: value.length,
          maximumLength: candidateDevelopmentMaximumImmutableDecimal.length,
          exceedsMaximumValue: true,
        })
      }
      if (regularExpressionLiteral) regularExpressionLiteralLengths.push(value.length)
      if (interpolatedTemplateSegment) interpolatedTemplateSegmentLengths.push(value.length)
      if (payloadBearingGovernedString) {
        const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
        governedPayloadDateLiterals.push(...dates)
        governedPayloadStringCount += 1
        governedPayloadStringBytes += Buffer.byteLength(value, 'utf8')
      } else if (!immutableGovernedScalar) {
        const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
        frozenDateLiterals.push(...dates)
      }
      if (!immutableGovernedScalar) {
        if (value.length > 128) longStringLiteralLengths.push(value.length)
        const numericTokens = value.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
        const delimiters = value.match(/[,|;\t\n]/gu) ?? []
        if (value.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
          encodedNumericStringLengths.push(value.length)
        if (
          value.length >= 96 &&
          (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) ||
            /^[a-f0-9]+$/u.test(value))
        )
          encodedBinaryStringLengths.push(value.length)
      }
      if (
        dynamicExecutableString ||
        governedRange === undefined ||
        (!immutableGovernedScalar && !payloadBearingGovernedString)
      ) {
        executableLiteralCount += 1
        executableLiteralBytes += Buffer.byteLength(value, 'utf8')
      }
    } else if (executableString === undefined && (governedRange === undefined || !immutableGovernedScalar)) {
      const literal = candidateScalarToken(token)
      if (literal !== undefined) {
        executableLiteralCount += 1
        executableLiteralBytes += Buffer.byteLength(literal, 'utf8')
      }
    }

    if (token.kind === SyntaxKind.OpenBraceToken) objects.push({ fields: new Set(), numericLiteralCount: 0 })
    else if (token.kind === SyntaxKind.CloseBraceToken) {
      const object = objects.pop()
      if (object !== undefined) {
        const priceFieldCount = ['open', 'high', 'low', 'close', 'volume'].filter((field) =>
          object.fields.has(field),
        ).length
        if ((object.fields.has('sessionDate') && priceFieldCount >= 3) || priceFieldCount === 5)
          marketObjectFields.push([...object.fields].sort())
        largestLiteralObject = Math.max(largestLiteralObject, object.numericLiteralCount)
      }
    }

    const property = candidatePropertyNameAt(tokens, index)
    if (property !== undefined && tokens[property.end + 1]?.kind === SyntaxKind.ColonToken) {
      const field = candidateMarketPayloadField(property.name)
      if (field !== undefined) objects.at(-1)?.fields.add(field)
    }
    if (token.kind === SyntaxKind.ColonToken || token.kind === SyntaxKind.EqualsToken) {
      const name = candidatePropertyNameBefore(tokens, index)
      const field = name === undefined ? undefined : candidateMarketPayloadField(name)
      if (field !== undefined) parallelMarketFields.add(field)
    }
    if (
      (token.kind === SyntaxKind.NumericLiteral || token.kind === SyntaxKind.BigIntLiteral) &&
      tokens[index + 1]?.kind !== SyntaxKind.ColonToken &&
      !immutableGovernedScalar
    ) {
      const object = objects.at(-1)
      if (object !== undefined) object.numericLiteralCount += 1
    }

    if (token.kind === SyntaxKind.OpenBracketToken) {
      arrays.push({ literalCount: 0 })
    } else if (token.kind === SyntaxKind.CloseBracketToken) {
      const array = arrays.pop()
      if (array !== undefined && array.literalCount > 0) {
        literalArrayCount += 1
        largestLiteralArray = Math.max(largestLiteralArray, array.literalCount)
      }
    } else if (
      arrays.length > 0 &&
      candidateScalarToken(token) !== undefined &&
      (governedRange === undefined || governedScalar !== undefined) &&
      !immutableGovernedScalar
    ) {
      const array = arrays.at(-1)
      if (array !== undefined) array.literalCount += 1
    }
  }

  for (const value of parserOnlyRegularExpressions) {
    regularExpressionLiteralLengths.push(value.length)
    frozenDateLiterals.push(...(value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []))
    if (value.length > 128) longStringLiteralLengths.push(value.length)
    const numericTokens = value.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []
    const delimiters = value.match(/[,|;\t\n]/gu) ?? []
    if (value.length >= 24 && numericTokens.length >= 6 && delimiters.length >= 5)
      encodedNumericStringLengths.push(value.length)
    if (
      value.length >= 96 &&
      (/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) || /^[a-f0-9]+$/u.test(value))
    )
      encodedBinaryStringLengths.push(value.length)
    executableLiteralCount += 1
    executableLiteralBytes += Buffer.byteLength(value, 'utf8')
  }

  return {
    frozenDateLiterals,
    governedPayloadDateLiterals,
    regularExpressionLiteralLengths,
    interpolatedTemplateSegmentLengths,
    commentLengths,
    executableCommentCount,
    executableCommentBytes,
    longIdentifierLengths,
    encodedIdentifierLengths,
    executableIdentifierCount,
    executableIdentifierBytes,
    keywordPropertyNameCount,
    keywordPropertyNameBytes,
    executablePunctuationCount: executableSyntax.executablePunctuationCount,
    executablePunctuationBytes: executableSyntax.executablePunctuationBytes,
    executableKeywordOperatorCount: executableSyntax.executableKeywordOperatorCount,
    executableKeywordOperatorBytes: executableSyntax.executableKeywordOperatorBytes,
    executableArrayCount: executableArrays.executableArrayCount,
    largestExecutableArray: executableArrays.largestExecutableArray,
    parenthesizedArgumentListCount: parenthesizedArguments.parenthesizedArgumentListCount,
    parenthesizedArgumentCount: parenthesizedArguments.parenthesizedArgumentCount,
    largestParenthesizedArgumentList: parenthesizedArguments.largestParenthesizedArgumentList,
    marketObjectFields,
    parallelMarketFields: [...parallelMarketFields].sort(),
    literalArrayCount,
    largestLiteralArray,
    largestLiteralObject,
    longStringLiteralLengths,
    encodedNumericStringLengths,
    encodedBinaryStringLengths,
    outOfRangeImmutableDecimalScalars,
    governedPayloadStringCount,
    governedPayloadStringBytes,
    executableLiteralCount,
    executableLiteralBytes,
  }
}

export const validateCandidateDevelopmentModuleSource = (
  source: string,
  modulePath: string,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const byteCount = Buffer.byteLength(source, 'utf8')
  const lineCount = source.length === 0 ? 0 : source.split('\n').length
  const generatedHelpers = candidateArtifactDowncompiledHelpers.filter((helper) =>
    new RegExp(`(?:\\b(?:const|function|let|var)\\s+${helper}\\b|\\b${helper}\\s*=)`, 'u').test(source),
  )
  const literalPayload = inspectCandidateDevelopmentLiteralPayload(source, modulePath)
  const parallelPriceFieldCount = ['open', 'high', 'low', 'close', 'volume'].filter((field) =>
    literalPayload.parallelMarketFields.includes(field),
  ).length
  const issues = {
    typeCheckDisabled: /^\s*\/\/\s*@ts-nocheck\b/mu.test(source),
    oversized: byteCount > 262_144 || lineCount > 4_096,
    generatedHelpers,
    embeddedFrozenSessions: literalPayload.frozenDateLiterals.length > 0,
    embeddedMarketBars:
      literalPayload.marketObjectFields.length > 0 ||
      (literalPayload.parallelMarketFields.includes('sessionDate') && parallelPriceFieldCount >= 3) ||
      parallelPriceFieldCount === 5 ||
      literalPayload.literalArrayCount >= 3 ||
      literalPayload.largestLiteralArray >= 4 ||
      literalPayload.executableArrayCount >= 3 ||
      literalPayload.largestExecutableArray >= 4 ||
      literalPayload.largestLiteralObject >= 5 ||
      literalPayload.longStringLiteralLengths.length > 0 ||
      literalPayload.longIdentifierLengths.length > 0 ||
      literalPayload.encodedIdentifierLengths.length > 0 ||
      literalPayload.executablePunctuationCount > 512 ||
      literalPayload.executablePunctuationBytes > 1_024 ||
      literalPayload.executableKeywordOperatorCount > 32 ||
      literalPayload.executableKeywordOperatorBytes > 192 ||
      literalPayload.parenthesizedArgumentCount > 64 ||
      literalPayload.largestParenthesizedArgumentList > 32 ||
      literalPayload.encodedNumericStringLengths.length > 0 ||
      literalPayload.encodedBinaryStringLengths.length > 0 ||
      literalPayload.outOfRangeImmutableDecimalScalars.length > 0 ||
      literalPayload.governedPayloadDateLiterals.length >= 4 ||
      literalPayload.governedPayloadStringBytes > 1_024 ||
      literalPayload.executableLiteralCount > 64 ||
      literalPayload.executableLiteralBytes > 1_024,
  }
  return !issues.typeCheckDisabled &&
    !issues.oversized &&
    issues.generatedHelpers.length === 0 &&
    !issues.embeddedFrozenSessions &&
    !issues.embeddedMarketBars
    ? Result.succeed(undefined)
    : Result.fail(
        sourceVerificationFailure('verify-module-format', {
          modulePath,
          byteCount,
          lineCount,
          maximumByteCount: 262_144,
          maximumLineCount: 4_096,
          literalPayload,
          ...issues,
        }),
      )
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
      await verifyCandidateDevelopmentRepositoryIntegrityPromise(repositoryRoot, sourceGit, signal)
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
      const reviewedCandidatePreregistration =
        frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration
      {
        const preregistration = reviewedCandidatePreregistration.preregistration
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
        const [preregistrationBytes, preregistrationBlobOid] = await runCandidateDevelopmentSourcePair(
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
        const preregistrationJson = await sourceStep(
          'decode-preregistration',
          async () => JSON.parse(preregistrationBytes.toString('utf8')) as unknown,
        )
        const preregistrationDocument = validateCandidateDevelopmentPreregistrationDocument(
          reviewedCandidatePreregistration,
          preregistrationJson,
        )
        if (Result.isFailure(preregistrationDocument)) {
          const failure = preregistrationDocument.failure
          throw new CandidateDevelopmentSourceVerificationError(
            failure._tag === 'CandidateDevelopmentCommandSourceVerificationFailed'
              ? failure.operation
              : 'verify-preregistration-blob',
            failure._tag === 'CandidateDevelopmentCommandSourceVerificationFailed' ? failure.cause : failure,
          )
        }
        await verifyCandidateDevelopmentPreregistrationLineagePromise(
          repositoryRoot,
          preregistration.sourceRevision,
          sourceRevision,
          sourceGit,
          signal,
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
      const moduleSource = moduleGitBytes.toString('utf8')
      const moduleFormat = verifySelfContainedEsm(moduleSource, moduleRepositoryPath.success)
      if (Result.isFailure(moduleFormat)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-module-format', moduleFormat.failure)
      }
      const moduleSourcePolicy = validateCandidateDevelopmentModuleSource(moduleSource, moduleRepositoryPath.success)
      if (Result.isFailure(moduleSourcePolicy)) {
        throw new CandidateDevelopmentSourceVerificationError('verify-module-format', moduleSourcePolicy.failure)
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
      {
        await verifyCandidateDevelopmentPreregistrationModuleNoveltyPromise(
          repositoryRoot,
          reviewedCandidatePreregistration.preregistration.sourceRevision,
          moduleRepositoryPath.success,
          moduleBlobOid,
          sourceGit,
          signal,
        )
      }
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
const candidateDevelopmentPlanArtifactSchemaVersion = 'bayn.candidate-development-plan-artifact.v1' as const
const candidateDevelopmentArtifactEvaluationTimeoutMs = 120_000
const candidateDevelopmentArtifactInitializationTimeoutMs = 10_000

const candidateDevelopmentPlanFailure = (field: string, cause: unknown): CandidateDevelopmentCommandFailure =>
  sourceVerificationFailure('verify-program-binding', { field, cause })

const exactStringSet = (expected: readonly string[], observed: readonly string[]): boolean => {
  if (expected.length !== observed.length) return false
  const expectedSorted = [...expected].sort()
  const observedSorted = [...observed].sort()
  return expectedSorted.every((value, index) => value === observedSorted[index])
}

const quantizeCandidateDevelopmentPlanNumber = (value: number): number =>
  Math.round(value * 1_000_000_000_000) / 1_000_000_000_000

const candidateDevelopmentSampleVariance = (values: readonly number[]): number | undefined => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return undefined
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Number.isFinite(variance) ? variance : undefined
}

const candidateDevelopmentSampleCovariance = (
  first: readonly number[],
  second: readonly number[],
): number | undefined => {
  if (first.length !== second.length || first.length < 2) return undefined
  const firstMean = first.reduce((sum, value) => sum + value, 0) / first.length
  const secondMean = second.reduce((sum, value) => sum + value, 0) / second.length
  const covariance =
    first.reduce((sum, value, index) => sum + (value - firstMean) * ((second[index] as number) - secondMean), 0) /
    (first.length - 1)
  return Number.isFinite(covariance) ? covariance : undefined
}

interface CandidateDevelopmentInverseVolatilityFeature {
  readonly totalReturns: Readonly<Record<string, number>>
  readonly dailyReturns: Readonly<Record<string, readonly number[]>>
  readonly annualizedVolatilities: Readonly<Record<string, number>>
  readonly targetWeights: Readonly<Record<string, number>>
  readonly exposureScale: number
  readonly estimatedAnnualizedPortfolioVolatility: number
}

const deriveCandidateDevelopmentInverseVolatilityFeature = (
  alignedSessions: readonly AlignedSession[],
  signalSessionIndex: number,
  universe: readonly string[],
  strategyIdentity: CandidateDevelopmentInverseVolatilityStrategyIdentity,
  terminal: boolean,
  field: string,
): Result.Result<CandidateDevelopmentInverseVolatilityFeature, CandidateDevelopmentCommandFailure> => {
  const parameters = strategyIdentity.parameters
  const [firstRiskAsset, secondRiskAsset] = parameters.riskAssets
  if (firstRiskAsset === secondRiskAsset || !universe.includes(firstRiskAsset) || !universe.includes(secondRiskAsset)) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskAssets`, {
        expected: 'two distinct members of the governed universe',
        observed: parameters.riskAssets,
      }),
    )
  }
  const firstPriceSessionIndex = signalSessionIndex - parameters.lookbackSessions
  if (firstPriceSessionIndex < 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.window`, {
        expected: parameters.lookbackSessions + 1,
        observed: signalSessionIndex + 1,
      }),
    )
  }
  const totalReturns: Record<string, number> = {}
  const dailyReturns: Record<string, readonly number[]> = {}
  const annualizedVolatilities: Record<string, number> = {}
  for (const symbol of universe) {
    const returns: number[] = []
    for (let sessionIndex = firstPriceSessionIndex + 1; sessionIndex <= signalSessionIndex; sessionIndex += 1) {
      const previousClose = alignedSessions[sessionIndex - 1]?.bars[symbol]?.close
      const currentClose = alignedSessions[sessionIndex]?.bars[symbol]?.close
      if (
        previousClose === undefined ||
        currentClose === undefined ||
        !Number.isFinite(previousClose) ||
        !Number.isFinite(currentClose) ||
        previousClose <= 0 ||
        currentClose <= 0
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`${field}.marketData.${symbol}`, {
            expected: 'strictly positive finite adjusted closes across the complete lookback',
            observed: { previousClose, currentClose },
          }),
        )
      }
      const dailyReturn = currentClose / previousClose - 1
      if (!Number.isFinite(dailyReturn)) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`${field}.dailyReturns.${symbol}`, {
            expected: 'finite daily returns',
            observed: dailyReturn,
          }),
        )
      }
      returns.push(dailyReturn)
    }
    const variance = candidateDevelopmentSampleVariance(returns)
    const annualizedVolatility =
      variance === undefined
        ? undefined
        : quantizeCandidateDevelopmentPlanNumber(Math.sqrt(variance * parameters.annualizationSessions))
    if (annualizedVolatility === undefined || !Number.isFinite(annualizedVolatility) || annualizedVolatility <= 0) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`${field}.annualizedVolatility.${symbol}`, {
          expected: 'strictly positive finite sample annualized volatility',
          observed: annualizedVolatility,
        }),
      )
    }
    const firstClose = alignedSessions[firstPriceSessionIndex]?.bars[symbol]?.close
    const signalClose = alignedSessions[signalSessionIndex]?.bars[symbol]?.close
    if (firstClose === undefined || signalClose === undefined || firstClose <= 0 || !Number.isFinite(signalClose)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`${field}.totalReturn.${symbol}`, {
          expected: 'complete finite lookback prices',
          observed: { firstClose, signalClose },
        }),
      )
    }
    totalReturns[symbol] = quantizeCandidateDevelopmentPlanNumber(signalClose / firstClose - 1)
    dailyReturns[symbol] = returns
    annualizedVolatilities[symbol] = annualizedVolatility
  }
  const firstRiskVolatility = annualizedVolatilities[firstRiskAsset]
  const secondRiskVolatility = annualizedVolatilities[secondRiskAsset]
  const firstRiskReturns = dailyReturns[firstRiskAsset]
  const secondRiskReturns = dailyReturns[secondRiskAsset]
  if (
    firstRiskVolatility === undefined ||
    secondRiskVolatility === undefined ||
    firstRiskReturns === undefined ||
    secondRiskReturns === undefined
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskAssets`, {
        expected: parameters.riskAssets,
        observed: Object.keys(annualizedVolatilities),
      }),
    )
  }
  const firstInverseVolatility = 1 / firstRiskVolatility
  const secondInverseVolatility = 1 / secondRiskVolatility
  const inverseVolatilityDenominator = firstInverseVolatility + secondInverseVolatility
  const covariance = candidateDevelopmentSampleCovariance(firstRiskReturns, secondRiskReturns)
  if (covariance === undefined || !Number.isFinite(inverseVolatilityDenominator) || inverseVolatilityDenominator <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskGeometry`, {
        expected: 'finite sample covariance and inverse-volatility denominator',
        observed: { covariance, inverseVolatilityDenominator },
      }),
    )
  }
  const normalizedFirstWeight = firstInverseVolatility / inverseVolatilityDenominator
  const normalizedSecondWeight = secondInverseVolatility / inverseVolatilityDenominator
  const unscaledPortfolioVariance =
    normalizedFirstWeight ** 2 * firstRiskVolatility ** 2 +
    normalizedSecondWeight ** 2 * secondRiskVolatility ** 2 +
    2 * normalizedFirstWeight * normalizedSecondWeight * covariance * parameters.annualizationSessions
  if (!Number.isFinite(unscaledPortfolioVariance) || unscaledPortfolioVariance <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.portfolioVariance`, {
        expected: 'strictly positive finite sample portfolio variance',
        observed: unscaledPortfolioVariance,
      }),
    )
  }
  const unscaledAnnualizedPortfolioVolatility = Math.sqrt(unscaledPortfolioVariance)
  const riskScale = quantizeCandidateDevelopmentPlanNumber(
    Math.min(
      parameters.maximumGrossExposure,
      parameters.targetAnnualizedVolatility / unscaledAnnualizedPortfolioVolatility,
    ),
  )
  if (!Number.isFinite(riskScale) || riskScale <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskScale`, {
        expected: 'strictly positive finite bounded risk scale',
        observed: riskScale,
      }),
    )
  }
  const targetWeights = Object.fromEntries(
    universe.map((symbol) => [
      symbol,
      terminal
        ? 0
        : symbol === firstRiskAsset
          ? quantizeCandidateDevelopmentPlanNumber(normalizedFirstWeight * riskScale)
          : symbol === secondRiskAsset
            ? quantizeCandidateDevelopmentPlanNumber(normalizedSecondWeight * riskScale)
            : 0,
    ]),
  )
  const exposureScale = quantizeCandidateDevelopmentPlanNumber(
    Object.values(targetWeights).reduce((sum, weight) => sum + weight, 0),
  )
  const portfolioReturns = Array.from({ length: parameters.lookbackSessions }, (_, returnIndex) =>
    universe.reduce(
      (sum, symbol) => sum + (dailyReturns[symbol]?.[returnIndex] ?? Number.NaN) * (targetWeights[symbol] ?? 0),
      0,
    ),
  )
  const portfolioVariance = candidateDevelopmentSampleVariance(portfolioReturns)
  if (portfolioVariance === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.estimatedAnnualizedPortfolioVolatility`, {
        expected: 'finite sample portfolio return variance',
        observed: portfolioReturns,
      }),
    )
  }
  return Result.succeed({
    totalReturns,
    dailyReturns,
    annualizedVolatilities,
    targetWeights,
    exposureScale,
    estimatedAnnualizedPortfolioVolatility: quantizeCandidateDevelopmentPlanNumber(
      Math.sqrt(portfolioVariance * parameters.annualizationSessions),
    ),
  })
}

const candidateDevelopmentMaximumGrossExposure = (strategyProtocol: CandidateDevelopmentStrategyProtocol): number => {
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity?.schemaVersion === 'bayn.candidate-development-strategy-identity.v2') {
    return strategyIdentity.parameters.maximumGrossExposure
  }
  if (strategyIdentity?.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
    return strategyIdentity.parameters.selectedAssetWeight
  }
  return 1
}

const validateCandidateDevelopmentStrategyPlan = (
  value: unknown,
  preflight: CandidateDevelopmentPreflightPass,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  alignedSessions: readonly AlignedSession[],
): Result.Result<CandidateDevelopmentStrategyPlan, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentStrategyPlan(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan', decoded.failure))
  }
  const plan = decoded.success as CandidateDevelopmentStrategyPlan
  const officialSessionIndexByDate = new Map(officialSessions.map((session, index) => [session, index] as const))
  const selectedStartIndex = officialSessionIndexByDate.get(preflight.selectedObservationStart)
  const accountingStart = selectedStartIndex === undefined ? undefined : officialSessions[selectedStartIndex - 1]
  if (accountingStart === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.openingDecision', {
        expected: 'an official accounting predecessor for the selected observation window',
        observed: { selectedStartIndex, selectedObservationStart: preflight.selectedObservationStart },
      }),
    )
  }
  const expectedSchedule = expectedCandidateDevelopmentRebalanceSchedule(
    officialSessions,
    signalSessionDates,
    accountingStart,
    preflight.selectedObservationEnd,
  )
  const openingDecision = expectedSchedule[0]
  const selectedSchedule = expectedSchedule.slice(1)
  if (
    openingDecision?.executionDate !== accountingStart ||
    selectedSchedule.length !== preflight.expectedRebalanceSchedule.length ||
    selectedSchedule.some(
      (boundary, index) =>
        boundary.signalDate !== preflight.expectedRebalanceSchedule[index]?.signalDate ||
        boundary.executionDate !== preflight.expectedRebalanceSchedule[index]?.executionDate,
    )
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.openingDecision', {
        expected: {
          executionDate: accountingStart,
          selectedSchedule: preflight.expectedRebalanceSchedule,
        },
        observed: { openingDecision, selectedSchedule },
      }),
    )
  }
  if (plan.decisions.length !== expectedSchedule.length) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.decisions.length', {
        expected: expectedSchedule.length,
        observed: plan.decisions.length,
      }),
    )
  }
  const universe = strategyProtocol.universe
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.strategyProtocol.strategyIdentity', {
        expected: 'immutable allocation semantics',
        observed: undefined,
      }),
    )
  }
  const maximumGrossExposure = candidateDevelopmentMaximumGrossExposure(strategyProtocol)
  const lookbackSessions = strategyIdentity.parameters.lookbackSessions
  const governedAssets = new Set(
    strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v2'
      ? strategyIdentity.parameters.riskAssets
      : [...strategyIdentity.parameters.riskAssets, strategyIdentity.parameters.defensiveAsset],
  )
  if (
    alignedSessions.length !== officialSessions.length ||
    alignedSessions.some((session, index) => session.date !== officialSessions[index])
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.marketDataSessions', {
        expected: officialSessions,
        observed: alignedSessions.map(({ date }) => date),
      }),
    )
  }
  const normalizedDecisions: CandidateDevelopmentPlannedDecision[] = []
  for (let index = 0; index < plan.decisions.length; index += 1) {
    const decision = plan.decisions[index]
    const expected = expectedSchedule[index]
    if (decision.signalDate !== expected?.signalDate || decision.executionDate !== expected?.executionDate) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].schedule`, {
          expected,
          observed: { signalDate: decision.signalDate, executionDate: decision.executionDate },
        }),
      )
    }
    const signalSessionIndex = officialSessionIndexByDate.get(decision.signalDate)
    const covarianceWindowStartIndex = signalSessionIndex === undefined ? -1 : signalSessionIndex - lookbackSessions + 1
    const covarianceReturnSessions =
      covarianceWindowStartIndex < 0 || signalSessionIndex === undefined
        ? []
        : officialSessions.slice(covarianceWindowStartIndex, signalSessionIndex + 1)
    const covariancePriceSessions =
      covarianceWindowStartIndex < 1 || signalSessionIndex === undefined
        ? []
        : officialSessions.slice(covarianceWindowStartIndex - 1, signalSessionIndex + 1)
    const expectedFirstSession = covarianceReturnSessions[0]
    if (
      covarianceReturnSessions.length !== lookbackSessions ||
      covariancePriceSessions.length !== lookbackSessions + 1 ||
      expectedFirstSession === undefined ||
      decision.covarianceWindow.returnCount !== lookbackSessions ||
      decision.covarianceWindow.firstSession !== expectedFirstSession ||
      decision.covarianceWindow.lastSession !== decision.signalDate
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].covarianceWindow`, {
          expected: {
            returnCount: lookbackSessions,
            firstSession: expectedFirstSession ?? null,
            lastSession: decision.signalDate,
          },
          observed: decision.covarianceWindow,
        }),
      )
    }
    const covarianceWindowHash = canonicalHashV1Result({
      schemaVersion: 'bayn.candidate-development-plan-window.v1',
      sessions: covariancePriceSessions,
    })
    if (Result.isFailure(covarianceWindowHash)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(
          `artifact.plan.decisions[${index}].covarianceWindow.sessionsHash`,
          covarianceWindowHash.failure,
        ),
      )
    }
    const allocationTolerance = 1e-12 + Number.EPSILON
    let inverseVolatilityFeature: CandidateDevelopmentInverseVolatilityFeature | undefined
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v2') {
      const derived = deriveCandidateDevelopmentInverseVolatilityFeature(
        alignedSessions,
        signalSessionIndex ?? -1,
        universe,
        strategyIdentity,
        index === plan.decisions.length - 1,
        `artifact.plan.decisions[${index}].inverseVolatility`,
      )
      if (Result.isFailure(derived)) return Result.fail(derived.failure)
      inverseVolatilityFeature = derived.success
      if (
        universe.some((symbol) => {
          const expectedWeight = inverseVolatilityFeature?.targetWeights[symbol]
          const observedWeight = decision.targetWeights[symbol]
          return (
            expectedWeight === undefined ||
            observedWeight === undefined ||
            Math.abs(observedWeight - expectedWeight) > allocationTolerance
          )
        })
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].inverseVolatility.allocation`, {
            expected: inverseVolatilityFeature.targetWeights,
            observed: decision.targetWeights,
          }),
        )
      }
      if (
        Math.abs(decision.exposureScale - inverseVolatilityFeature.exposureScale) > allocationTolerance ||
        Math.abs(
          decision.estimatedAnnualizedPortfolioVolatility -
            inverseVolatilityFeature.estimatedAnnualizedPortfolioVolatility,
        ) > allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].inverseVolatility.riskScale`, {
            expected: {
              exposureScale: inverseVolatilityFeature.exposureScale,
              estimatedAnnualizedPortfolioVolatility: inverseVolatilityFeature.estimatedAnnualizedPortfolioVolatility,
            },
            observed: {
              exposureScale: decision.exposureScale,
              estimatedAnnualizedPortfolioVolatility: decision.estimatedAnnualizedPortfolioVolatility,
            },
          }),
        )
      }
    }
    let momentumFeature:
      | {
          readonly totalReturns: Readonly<Record<string, number>>
          readonly selectedSymbol: string | null
          readonly estimatedAnnualizedPortfolioVolatility: number
        }
      | undefined
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
      const parameters = strategyIdentity.parameters
      const [firstRiskAsset, secondRiskAsset] = parameters.riskAssets
      if (
        parameters.relativeMomentumTieBreak !== firstRiskAsset &&
        parameters.relativeMomentumTieBreak !== secondRiskAsset
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(
            'artifact.strategyProtocol.strategyIdentity.parameters.relativeMomentumTieBreak',
            {
              expected: parameters.riskAssets,
              observed: parameters.relativeMomentumTieBreak,
            },
          ),
        )
      }
      const firstFeatureSession =
        signalSessionIndex === undefined ? undefined : alignedSessions[signalSessionIndex - lookbackSessions]
      const signalSession = signalSessionIndex === undefined ? undefined : alignedSessions[signalSessionIndex]
      if (firstFeatureSession === undefined || signalSession === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumWindow`, {
            expected: { lookbackSessions, signalDate: decision.signalDate },
            observed: null,
          }),
        )
      }
      const totalReturns: Record<string, number> = {}
      for (const symbol of universe) {
        const firstBar = firstFeatureSession.bars[symbol]
        const signalBar = signalSession.bars[symbol]
        if (firstBar === undefined || signalBar === undefined) {
          return Result.fail(
            candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumWindow.${symbol}`, {
              expected: [firstFeatureSession.date, signalSession.date],
              observed: null,
            }),
          )
        }
        totalReturns[symbol] =
          Math.round((signalBar.close / firstBar.close - 1) * 1_000_000_000_000) / 1_000_000_000_000
      }
      const firstRiskReturn = totalReturns[firstRiskAsset]
      const secondRiskReturn = totalReturns[secondRiskAsset]
      const defensiveReturn = totalReturns[parameters.defensiveAsset]
      if (firstRiskReturn === undefined || secondRiskReturn === undefined || defensiveReturn === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumUniverse`, {
            expected: [...parameters.riskAssets, parameters.defensiveAsset],
            observed: Object.keys(totalReturns),
          }),
        )
      }
      const relativeWinner =
        firstRiskReturn === secondRiskReturn
          ? parameters.relativeMomentumTieBreak
          : firstRiskReturn > secondRiskReturn
            ? firstRiskAsset
            : secondRiskAsset
      const relativeWinnerReturn = totalReturns[relativeWinner]
      const selectedSymbol =
        relativeWinnerReturn !== undefined && relativeWinnerReturn > parameters.absoluteMomentumThreshold
          ? relativeWinner
          : defensiveReturn > parameters.absoluteMomentumThreshold
            ? parameters.defensiveAsset
            : null
      const terminal = index === plan.decisions.length - 1
      const expectedWeights = Object.fromEntries(
        universe.map((symbol) => [symbol, !terminal && selectedSymbol === symbol ? parameters.selectedAssetWeight : 0]),
      )
      if (
        universe.some((symbol) => {
          const observedWeight = decision.targetWeights[symbol]
          const expectedWeight = expectedWeights[symbol]
          return (
            observedWeight === undefined ||
            expectedWeight === undefined ||
            Math.abs(observedWeight - expectedWeight) > 1e-12 + Number.EPSILON
          )
        })
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumSelection`, {
            expected: { selectedSymbol, targetWeights: expectedWeights },
            observed: decision.targetWeights,
          }),
        )
      }
      const volatilityWindowStartIndex =
        signalSessionIndex === undefined ? -1 : signalSessionIndex - parameters.volatilityWindowSessions + 1
      if (volatilityWindowStartIndex < 1 || signalSessionIndex === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility.window`, {
            expected: parameters.volatilityWindowSessions,
            observed: signalSessionIndex === undefined ? 0 : signalSessionIndex,
          }),
        )
      }
      const portfolioReturns: number[] = []
      for (let sessionIndex = volatilityWindowStartIndex; sessionIndex <= signalSessionIndex; sessionIndex += 1) {
        let portfolioReturn = 0
        for (const symbol of universe) {
          const weight = expectedWeights[symbol]
          if (weight === undefined || weight === 0) continue
          const previousClose = alignedSessions[sessionIndex - 1]?.bars[symbol]?.close
          const currentClose = alignedSessions[sessionIndex]?.bars[symbol]?.close
          if (
            previousClose === undefined ||
            currentClose === undefined ||
            !Number.isFinite(previousClose) ||
            !Number.isFinite(currentClose) ||
            previousClose <= 0 ||
            currentClose <= 0
          ) {
            return Result.fail(
              candidateDevelopmentPlanFailure(
                `artifact.plan.decisions[${index}].momentumVolatility.marketData.${symbol}`,
                {
                  expected: 'strictly positive finite adjusted closes across the complete volatility window',
                  observed: { previousClose, currentClose },
                },
              ),
            )
          }
          portfolioReturn += (currentClose / previousClose - 1) * weight
        }
        portfolioReturns.push(portfolioReturn)
      }
      const portfolioVariance = candidateDevelopmentSampleVariance(portfolioReturns)
      if (portfolioVariance === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility`, {
            expected: 'finite sample portfolio return variance',
            observed: portfolioReturns,
          }),
        )
      }
      const estimatedAnnualizedPortfolioVolatility = quantizeCandidateDevelopmentPlanNumber(
        Math.sqrt(portfolioVariance * parameters.annualizationSessions),
      )
      if (
        Math.abs(decision.estimatedAnnualizedPortfolioVolatility - estimatedAnnualizedPortfolioVolatility) >
        allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility`, {
            expected: estimatedAnnualizedPortfolioVolatility,
            observed: decision.estimatedAnnualizedPortfolioVolatility,
          }),
        )
      }
      momentumFeature = { totalReturns, selectedSymbol, estimatedAnnualizedPortfolioVolatility }
    }
    const weightSymbols = Object.keys(decision.targetWeights)
    const signalSymbols = decision.signals.map(({ symbol }) => symbol)
    if (!exactStringSet(universe, weightSymbols) || !exactStringSet(universe, signalSymbols)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].universe`, {
          expected: universe,
          observed: { weightSymbols, signalSymbols },
        }),
      )
    }
    const grossExposure = Object.values(decision.targetWeights).reduce((sum, weight) => sum + weight, 0)
    const uncappedGrossExposure = decision.signals.reduce((sum, signal) => sum + signal.uncappedWeight, 0)
    const cappedGrossExposure = decision.signals.reduce((sum, signal) => sum + signal.cappedWeight, 0)
    const grossTolerance = allocationTolerance * Math.max(1, decision.signals.length)
    if (!Number.isFinite(grossExposure) || grossExposure < 0 || grossExposure > maximumGrossExposure + grossTolerance) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].grossExposure`, {
          expected: `finite within 0..${maximumGrossExposure}`,
          observed: grossExposure,
        }),
      )
    }
    if (
      !Number.isFinite(uncappedGrossExposure) ||
      uncappedGrossExposure < 0 ||
      Math.abs(uncappedGrossExposure - grossExposure) > grossTolerance
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].uncappedGrossExposure`, {
          expected: 'the bounded final gross exposure',
          observed: uncappedGrossExposure,
        }),
      )
    }
    if (
      !Number.isFinite(cappedGrossExposure) ||
      cappedGrossExposure < 0 ||
      cappedGrossExposure > maximumGrossExposure + grossTolerance ||
      Math.abs(cappedGrossExposure - grossExposure) > grossTolerance
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].cappedGrossExposure`, {
          expected: 'the bounded final gross exposure',
          observed: cappedGrossExposure,
        }),
      )
    }
    if (Math.abs(decision.exposureScale - grossExposure) > grossTolerance) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].exposureScale`, {
          expected: grossExposure,
          observed: decision.exposureScale,
        }),
      )
    }
    for (let signalIndex = 0; signalIndex < decision.signals.length; signalIndex += 1) {
      const signal = decision.signals[signalIndex]
      const targetWeight = decision.targetWeights[signal.symbol]
      if (
        !governedAssets.has(signal.symbol) &&
        (signal.eligible || signal.targetWeight !== 0 || signal.uncappedWeight !== 0 || signal.cappedWeight !== 0)
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].governedAsset`, {
            expected: { governedAssets: [...governedAssets], eligible: false, weight: 0 },
            observed: signal,
          }),
        )
      }
      if (signal.horizons.length !== 1 || signal.horizons[0]?.horizonSessions !== lookbackSessions) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].horizons`, {
            expected: [{ horizonSessions: lookbackSessions }],
            observed: signal.horizons,
          }),
        )
      }
      if (momentumFeature !== undefined) {
        const expectedReturn = momentumFeature.totalReturns[signal.symbol]
        const horizon = signal.horizons[0]
        if (
          expectedReturn === undefined ||
          horizon === undefined ||
          Math.abs(horizon.return - expectedReturn) > allocationTolerance ||
          Math.abs(horizon.normalizedTrend - expectedReturn) > allocationTolerance ||
          Math.abs(signal.dailyVolatility) > allocationTolerance ||
          Math.abs(
            signal.annualizedVolatility -
              (momentumFeature.selectedSymbol === signal.symbol
                ? momentumFeature.estimatedAnnualizedPortfolioVolatility
                : 0),
          ) > allocationTolerance ||
          Math.abs(signal.compositeScore - expectedReturn) > allocationTolerance ||
          Math.abs(signal.positiveScore - Math.max(0, expectedReturn)) > allocationTolerance ||
          signal.eligible !== (momentumFeature.selectedSymbol === signal.symbol)
        ) {
          return Result.fail(
            candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].momentum`, {
              expected: {
                return: expectedReturn,
                normalizedTrend: expectedReturn,
                dailyVolatility: 0,
                annualizedVolatility:
                  momentumFeature.selectedSymbol === signal.symbol
                    ? momentumFeature.estimatedAnnualizedPortfolioVolatility
                    : 0,
                compositeScore: expectedReturn,
                positiveScore: expectedReturn === undefined ? undefined : Math.max(0, expectedReturn),
                eligible: momentumFeature.selectedSymbol === signal.symbol,
              },
              observed: signal,
            }),
          )
        }
      }
      if (inverseVolatilityFeature !== undefined) {
        const parameters = strategyIdentity.parameters
        const expectedReturn = inverseVolatilityFeature.totalReturns[signal.symbol]
        const expectedAnnualizedVolatility = inverseVolatilityFeature.annualizedVolatilities[signal.symbol]
        const expectedEligible = parameters.riskAssets.includes(signal.symbol)
        const expectedScore =
          expectedEligible && expectedAnnualizedVolatility !== undefined ? 1 / expectedAnnualizedVolatility : 0
        const horizon = signal.horizons[0]
        if (
          expectedReturn === undefined ||
          expectedAnnualizedVolatility === undefined ||
          horizon === undefined ||
          Math.abs(horizon.return - expectedReturn) > allocationTolerance ||
          Math.abs(horizon.normalizedTrend - expectedReturn) > allocationTolerance ||
          Math.abs(
            signal.dailyVolatility - expectedAnnualizedVolatility / Math.sqrt(parameters.annualizationSessions),
          ) > allocationTolerance ||
          Math.abs(signal.annualizedVolatility - expectedAnnualizedVolatility) > allocationTolerance ||
          Math.abs(signal.compositeScore - expectedScore) > allocationTolerance ||
          Math.abs(signal.positiveScore - expectedScore) > allocationTolerance ||
          signal.eligible !== expectedEligible
        ) {
          return Result.fail(
            candidateDevelopmentPlanFailure(
              `artifact.plan.decisions[${index}].signals[${signalIndex}].inverseVolatility`,
              {
                expected: {
                  return: expectedReturn,
                  normalizedTrend: expectedReturn,
                  dailyVolatility: expectedAnnualizedVolatility / Math.sqrt(parameters.annualizationSessions),
                  annualizedVolatility: expectedAnnualizedVolatility,
                  compositeScore: expectedScore,
                  positiveScore: expectedScore,
                  eligible: expectedEligible,
                },
                observed: signal,
              },
            ),
          )
        }
      }
      if (
        targetWeight === undefined ||
        !Object.is(signal.targetWeight, targetWeight) ||
        Math.abs(signal.cappedWeight - signal.targetWeight) > allocationTolerance ||
        Math.abs(signal.uncappedWeight - signal.targetWeight) > allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}]`, {
            expected: {
              targetWeight,
              cappedWeight: targetWeight,
              uncappedWeight: targetWeight,
            },
            observed: {
              targetWeight: signal.targetWeight,
              cappedWeight: signal.cappedWeight,
              uncappedWeight: signal.uncappedWeight,
            },
          }),
        )
      }
    }
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
      const allocatedWeights = Object.values(decision.targetWeights).filter((weight) => weight > allocationTolerance)
      if (
        allocatedWeights.length > 1 ||
        (allocatedWeights[0] !== undefined &&
          Math.abs(allocatedWeights[0] - strategyIdentity.parameters.selectedAssetWeight) > allocationTolerance)
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].allocation`, {
            expected: `all cash or one governed asset at ${strategyIdentity.parameters.selectedAssetWeight}`,
            observed: decision.targetWeights,
          }),
        )
      }
    }
    normalizedDecisions.push({
      ...decision,
      covarianceWindow: { ...decision.covarianceWindow, sessionsHash: covarianceWindowHash.success },
    })
  }
  const terminal = plan.decisions.at(-1)
  if (terminal === undefined || Object.values(terminal.targetWeights).some((weight) => weight !== 0)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.terminalDecision', {
        expected: 'all-cash target weights',
        observed: terminal?.targetWeights ?? null,
      }),
    )
  }
  return Result.succeed({ ...plan, decisions: normalizedDecisions })
}

const validateCandidateDevelopmentPlanInputManifest = (
  value: unknown,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<InputManifest, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentInputManifest(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.inputManifest', decoded.failure))
  }
  const manifest = decoded.success as InputManifest
  const { hash: declaredManifestHash, ...manifestMaterial } = manifest
  const recomputedManifestHash = canonicalHashV1Result(manifestMaterial)
  if (Result.isFailure(recomputedManifestHash)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.inputManifest.hash', recomputedManifestHash.failure))
  }
  if (recomputedManifestHash.success !== declaredManifestHash) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.inputManifest.hash', {
        expected: recomputedManifestHash.success,
        observed: declaredManifestHash,
      }),
    )
  }
  const committedMarketData = runtimeInput.sourceManifest.marketData
  const bindings = [
    ['hash', runtimeInput.marketData.inputManifestHash, manifest.hash],
    ['committedInputManifestHash', committedMarketData.inputManifestHash, manifest.hash],
    ['snapshotId', runtimeInput.marketData.snapshotId, manifest.finalizedSnapshot.snapshotId],
    [
      'finalizedSnapshotContentHash',
      committedMarketData.finalizedSnapshotContentHash,
      manifest.finalizedSnapshot.contentHash,
    ],
    ['sessionCount', runtimeInput.preflightInput.officialSessions.length, manifest.sessionCount],
    ['rowCount', runtimeInput.marketData.bars.length, manifest.rowCount],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(candidateDevelopmentPlanFailure(`artifact.inputManifest.${field}`, { expected, observed }))
    }
  }
  const manifestSessions = [manifest.firstSession, manifest.lastSession]
  const expectedSessions = [
    runtimeInput.preflightInput.officialSessions[0],
    runtimeInput.preflightInput.officialSessions.at(-1),
  ]
  const manifestUniverse = manifest.symbols.map(({ symbol }) => symbol)
  if (
    manifestSessions[0] !== expectedSessions[0] ||
    manifestSessions[1] !== expectedSessions[1] ||
    !exactStringSet(strategyProtocol.universe, manifestUniverse)
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.inputManifest.coverage', {
        expected: { sessions: expectedSessions, universe: strategyProtocol.universe },
        observed: { sessions: manifestSessions, universe: manifestUniverse },
      }),
    )
  }
  const expectedBounds = {
    dataStart: expectedSessions[0],
    dataEnd: expectedSessions[1],
    lookbackStart: expectedSessions[0],
    evaluationStart: preflight.selectedObservationStart,
    evaluationEnd: preflight.selectedObservationEnd,
  } as const
  for (const field of ['dataStart', 'dataEnd', 'lookbackStart', 'evaluationStart', 'evaluationEnd'] as const) {
    if (manifest.bounds[field] !== expectedBounds[field]) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.inputManifest.bounds.${field}`, {
          expected: expectedBounds[field],
          observed: manifest.bounds[field],
        }),
      )
    }
  }
  return Result.succeed(manifest)
}

const selectedCandidateDevelopmentTrace = (
  simulation: EvaluationResult['simulation'],
  selectedSessions: readonly IsoDate[],
): Result.Result<EvaluationResult['simulation'], CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(simulation.dailyMarks.map((mark) => [mark.sessionDate, mark] as const))
  const dailyMarks = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = dailyMarks.findIndex((mark) => mark === undefined)
  if (missing >= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.selectedTrace', {
        index: missing,
        expected: selectedSessions[missing],
        observed: null,
      }),
    )
  }
  return Result.succeed({ ...simulation, dailyMarks: dailyMarks as EvaluationResult['simulation']['dailyMarks'] })
}

const selectedCandidateDevelopmentPerformance = (
  series: readonly DailyPerformancePoint[],
  selectedSessions: readonly IsoDate[],
  field: string,
): Result.Result<readonly DailyPerformancePoint[], CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(series.map((point) => [point.sessionDate, point] as const))
  const selected = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = selected.findIndex((point) => point === undefined)
  return missing < 0
    ? Result.succeed(selected as readonly DailyPerformancePoint[])
    : Result.fail(
        candidateDevelopmentPlanFailure(field, {
          index: missing,
          expected: selectedSessions[missing],
          observed: null,
        }),
      )
}

export const buildCandidateDevelopmentPlanEvaluation = (
  planValue: unknown,
  inputManifestValue: unknown,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> => {
  const preflight = preflightCandidateDevelopment(runtimeInput.preflightInput)
  if (Result.isFailure(preflight) || preflight.success.status !== 'PASS') {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.preflight', {
        expected: 'PASS',
        observed: Result.isFailure(preflight) ? preflight.failure : preflight.success,
      }),
    )
  }
  const manifest = validateCandidateDevelopmentPlanInputManifest(
    inputManifestValue,
    runtimeInput,
    strategyProtocol,
    preflight.success,
  )
  if (Result.isFailure(manifest)) return Result.fail(manifest.failure)
  const aligned = alignBars(runtimeInput.marketData.bars, strategyProtocol.universe, manifest.success)
  if (Result.isFailure(aligned)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.marketData', aligned.failure))
  }
  const plan = validateCandidateDevelopmentStrategyPlan(
    planValue,
    preflight.success,
    strategyProtocol,
    runtimeInput.preflightInput.officialSessions,
    runtimeInput.preflightInput.signalSessionDates,
    aligned.success,
  )
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  const sessions = aligned.success
  const sessionIndexByDate = new Map(sessions.map((session, index) => [session.date, index] as const))
  const selectedStartIndex = sessionIndexByDate.get(preflight.success.selectedObservationStart)
  const selectedEndIndex = sessionIndexByDate.get(preflight.success.selectedObservationEnd)
  if (
    selectedStartIndex === undefined ||
    selectedStartIndex < 1 ||
    selectedEndIndex === undefined ||
    selectedEndIndex < selectedStartIndex
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.evaluationWindow', {
        selectedStart: preflight.success.selectedObservationStart,
        selectedEnd: preflight.success.selectedObservationEnd,
      }),
    )
  }
  const targets: SimulationTarget[] = []
  for (let index = 0; index < plan.success.decisions.length; index += 1) {
    const planned = plan.success.decisions[index]
    const signalIndex = sessionIndexByDate.get(planned.signalDate)
    const executionIndex = sessionIndexByDate.get(planned.executionDate)
    if (signalIndex === undefined || executionIndex === undefined || executionIndex !== signalIndex + 1) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].indices`, {
          expected: 'adjacent governed sessions',
          observed: { signalIndex, executionIndex },
        }),
      )
    }
    const { executionDate: _, ...decision } = planned
    targets.push({ signalIndex, executionIndex, weights: planned.targetWeights, decision })
  }
  const accountingStartIndex = selectedStartIndex - 1
  const evaluationSessions = sessions.slice(0, selectedEndIndex + 1)
  const baselineSimulation = simulate(
    evaluationSessions,
    targets,
    accountingStartIndex,
    strategyProtocol,
    MICROS,
    runtimeInput.baselineRunId,
    true,
  )
  if (Result.isFailure(baselineSimulation) || baselineSimulation.success.simulation === null) {
    return Result.fail(
      candidateDevelopmentPlanFailure(
        'artifact.plan.baselineSimulation',
        Result.isFailure(baselineSimulation) ? baselineSimulation.failure : 'missing trace',
      ),
    )
  }
  const stressedSimulation = simulate(
    evaluationSessions,
    targets,
    accountingStartIndex,
    strategyProtocol,
    MICROS * 2n,
    runtimeInput.stressedRunId,
    true,
  )
  if (Result.isFailure(stressedSimulation) || stressedSimulation.success.simulation === null) {
    return Result.fail(
      candidateDevelopmentPlanFailure(
        'artifact.plan.stressedSimulation',
        Result.isFailure(stressedSimulation) ? stressedSimulation.failure : 'missing trace',
      ),
    )
  }
  const selectedSessions = preflight.success.selectedObservationSessions
  const baselineTrace = selectedCandidateDevelopmentTrace(baselineSimulation.success.simulation, selectedSessions)
  const stressedTrace = selectedCandidateDevelopmentTrace(stressedSimulation.success.simulation, selectedSessions)
  const strategySeries = selectedCandidateDevelopmentPerformance(
    baselineSimulation.success.dailyPerformance,
    selectedSessions,
    'artifact.plan.strategySeries',
  )
  const stressedSeries = selectedCandidateDevelopmentPerformance(
    stressedSimulation.success.dailyPerformance,
    selectedSessions,
    'artifact.plan.stressedSeries',
  )
  if (Result.isFailure(baselineTrace)) return Result.fail(baselineTrace.failure)
  if (Result.isFailure(stressedTrace)) return Result.fail(stressedTrace.failure)
  if (Result.isFailure(strategySeries)) return Result.fail(strategySeries.failure)
  if (Result.isFailure(stressedSeries)) return Result.fail(stressedSeries.failure)
  const initialCapitalMicros = strategyProtocol.initialCapitalMicros
  const baselinePredecessor = baselineSimulation.success.simulation.dailyMarks[0]
  const stressedPredecessor = stressedSimulation.success.simulation.dailyMarks[0]
  if (baselinePredecessor === undefined || stressedPredecessor === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.accountingPredecessor', 'missing'))
  }
  const strategyMetrics = recomputePerformanceMetrics(
    'strategy',
    strategySeries.success,
    initialCapitalMicros,
    performanceBaselineFromPoint(baselinePredecessor),
  )
  const stressedMetrics = recomputePerformanceMetrics(
    'double-cost-stressed',
    stressedSeries.success,
    initialCapitalMicros,
    performanceBaselineFromPoint(stressedPredecessor),
  )
  if (Result.isFailure(strategyMetrics)) return Result.fail(strategyMetrics.failure)
  if (Result.isFailure(stressedMetrics)) return Result.fail(stressedMetrics.failure)
  const terminalTarget = targets.at(-1)
  if (terminalTarget === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.terminalTarget', 'missing'))
  }
  const benchmarkSymbol = strategyProtocol.benchmarks.symbol
  const benchmarkProtocol: SimulationProtocol = { ...strategyProtocol, universe: [benchmarkSymbol] }
  const directTargets: SimulationTarget[] = []
  for (let index = 0; index < targets.length - 1; index += 1) {
    const target = targets[index]
    const weights = directVolatilityWeights(sessions, target.signalIndex, benchmarkProtocol)
    if (Result.isFailure(weights)) {
      return Result.fail(candidateDevelopmentPlanFailure(`artifact.plan.directVolatility[${index}]`, weights.failure))
    }
    directTargets.push({
      signalIndex: target.signalIndex,
      executionIndex: target.executionIndex,
      weights: weights.success,
    })
  }
  const benchmarkRunId = canonicalEvidenceHash('benchmarks.runId', {
    schemaVersion: 'bayn.candidate-development-benchmark-run.v1',
    candidateRunId: runtimeInput.baselineRunId,
    marketDataContentHash: runtimeInput.marketData.contentHash,
    policy: strategyProtocol.benchmarks,
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const buyAndHoldSimulation = simulate(
    evaluationSessions,
    [
      {
        signalIndex: accountingStartIndex,
        executionIndex: selectedStartIndex,
        weights: { [benchmarkSymbol]: 1 },
      },
      {
        signalIndex: terminalTarget.signalIndex,
        executionIndex: terminalTarget.executionIndex,
        weights: { [benchmarkSymbol]: 0 },
      },
    ],
    accountingStartIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  const directVolatilitySimulation = simulate(
    evaluationSessions,
    [
      ...directTargets,
      {
        signalIndex: terminalTarget.signalIndex,
        executionIndex: terminalTarget.executionIndex,
        weights: { [benchmarkSymbol]: 0 },
      },
    ],
    accountingStartIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(buyAndHoldSimulation)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.buyAndHold', buyAndHoldSimulation.failure))
  }
  if (Result.isFailure(directVolatilitySimulation)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.directVolatility', directVolatilitySimulation.failure),
    )
  }
  const buyAndHoldSeries = selectRebuiltBenchmarkSeries(
    buyAndHoldSimulation.success.dailyPerformance,
    selectedSessions,
    'buy-and-hold',
  )
  const directVolatilitySeries = selectRebuiltBenchmarkSeries(
    directVolatilitySimulation.success.dailyPerformance,
    selectedSessions,
    'direct-volatility-timing',
  )
  if (Result.isFailure(buyAndHoldSeries)) return Result.fail(buyAndHoldSeries.failure)
  if (Result.isFailure(directVolatilitySeries)) return Result.fail(directVolatilitySeries.failure)
  const buyAndHoldMetrics = recomputePerformanceMetrics(
    'buy-and-hold',
    buyAndHoldSeries.success.series,
    initialCapitalMicros,
    buyAndHoldSeries.success.performanceBaseline,
  )
  const directVolatilityMetrics = recomputePerformanceMetrics(
    'direct-volatility-timing',
    directVolatilitySeries.success.series,
    initialCapitalMicros,
    directVolatilitySeries.success.performanceBaseline,
  )
  if (Result.isFailure(buyAndHoldMetrics)) return Result.fail(buyAndHoldMetrics.failure)
  if (Result.isFailure(directVolatilityMetrics)) return Result.fail(directVolatilityMetrics.failure)
  const baselineAccountingTerminal = baselineSimulation.success.simulation.dailyMarks.at(-1)
  const stressedAccountingTerminal = stressedSimulation.success.simulation.dailyMarks.at(-1)
  if (baselineAccountingTerminal === undefined || stressedAccountingTerminal === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.accountingTerminal', 'missing'))
  }
  const baselineProof = reconcileMarkedEquity({
    runId: runtimeInput.baselineRunId,
    initialCapitalMicros,
    evaluatorTotalFeesMicros: baselineAccountingTerminal.cumulativeFeesMicros,
    evaluatorEndingEquityMicros: strategyMetrics.success.endingEquityMicros,
    events: baselineSimulation.success.events,
    simulation: baselineSimulation.success.simulation,
  })
  const stressedProof = reconcileMarkedEquity({
    runId: runtimeInput.stressedRunId,
    initialCapitalMicros,
    evaluatorTotalFeesMicros: stressedAccountingTerminal.cumulativeFeesMicros,
    evaluatorEndingEquityMicros: stressedMetrics.success.endingEquityMicros,
    events: stressedSimulation.success.events,
    simulation: stressedSimulation.success.simulation,
  })
  if (Result.isFailure(baselineProof)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.baselineReconciliation', baselineProof.failure))
  }
  if (Result.isFailure(stressedProof)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.stressedReconciliation', stressedProof.failure))
  }
  const selectedObservationStart = preflight.success.selectedObservationStart
  const selectedObservationEnd = preflight.success.selectedObservationEnd
  const selectedBaselineSignalDecisions = baselineSimulation.success.signalDecisions.filter(
    ({ executionDate }) => executionDate >= selectedObservationStart && executionDate <= selectedObservationEnd,
  )
  const selectedStressedSignalDecisions = stressedSimulation.success.signalDecisions.filter(
    ({ executionDate }) => executionDate >= selectedObservationStart && executionDate <= selectedObservationEnd,
  )
  const protocolHash = canonicalEvidenceHash('strategyProtocol', strategyProtocol)
  if (Result.isFailure(protocolHash)) return Result.fail(protocolHash.failure)
  const baseline: EvaluationResult = {
    schemaVersion: 'bayn.evaluation.v6',
    runId: runtimeInput.baselineRunId,
    codeRevision: runtimeInput.sourceRevision,
    protocolHash: protocolHash.success,
    initialCapitalMicros,
    inputManifest: manifest.success,
    strategy: strategyMetrics.success,
    buyAndHold: buyAndHoldMetrics.success,
    directVolTiming: directVolatilityMetrics.success,
    doubleCostStrategy: stressedMetrics.success,
    verdict: buildVerdict(
      strategyMetrics.success,
      buyAndHoldMetrics.success,
      directVolatilityMetrics.success,
      stressedMetrics.success,
      strategyProtocol,
    ),
    events: baselineSimulation.success.events,
    signalDecisions: selectedBaselineSignalDecisions,
    simulation: baselineTrace.success,
    benchmarkSeries: {
      buyAndHold: buyAndHoldSeries.success.series,
      directVolTiming: directVolatilitySeries.success.series,
      doubleCostStrategy: stressedSeries.success,
    },
    equitySeries: baselineProof.success.equitySeries,
    markedEquityReconciliation: baselineProof.success.reconciliation,
  }
  const comparisonSeries = prepareQualificationSeries(baseline)
  if (Result.isFailure(comparisonSeries)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.comparisonSeries', comparisonSeries.failure))
  }
  const boundComparisonSeries = validateCandidateDevelopmentComparisonSeriesBinding(
    preflight.success,
    baseline,
    comparisonSeries.success,
  )
  if (Result.isFailure(boundComparisonSeries)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.comparisonSeries', boundComparisonSeries.failure))
  }
  const comparisonSemantics = buildCandidateDevelopmentComparisonSemanticsEvidence(
    preflight.success,
    boundComparisonSeries.success,
  )
  if (Result.isFailure(comparisonSemantics)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.comparisonSemantics', comparisonSemantics.failure),
    )
  }
  return Result.succeed({
    baseline,
    comparisonSemantics: comparisonSemantics.success,
    stressed: {
      signalDecisions: selectedStressedSignalDecisions,
      simulation: stressedTrace.success,
    },
    accounting: {
      schemaVersion: 'bayn.candidate-development-accounting-evidence.v2',
      runId: runtimeInput.baselineRunId,
      initialCapitalMicros,
      evaluatorTotalFeesMicros: baselineAccountingTerminal.cumulativeFeesMicros,
      evaluatorEndingEquityMicros: strategyMetrics.success.endingEquityMicros,
      events: baselineSimulation.success.events,
      baselineSimulation: baselineSimulation.success.simulation,
      equitySeries: baselineProof.success.equitySeries,
      markedEquityReconciliation: baselineProof.success.reconciliation,
      signalDecisions: baselineSimulation.success.signalDecisions,
      stressedRunId: runtimeInput.stressedRunId,
      stressedEvaluatorTotalFeesMicros: stressedAccountingTerminal.cumulativeFeesMicros,
      stressedEvaluatorEndingEquityMicros: stressedMetrics.success.endingEquityMicros,
      stressedEvents: stressedSimulation.success.events,
      stressedSimulation: stressedSimulation.success.simulation,
      stressedEquitySeries: stressedProof.success.equitySeries,
      stressedMarkedEquityReconciliation: stressedProof.success.reconciliation,
    },
    marketData: runtimeInput.marketData,
  })
}

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
      Object.defineProperty(Function.prototype, 'toString', {
        value: function () {
          return 'function () { [source unavailable] }'
        },
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

const runCandidateDevelopmentArtifactComputation = (
  context: vm.Context,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
): unknown => {
  const runtimeInputJson = JSON.stringify(runtimeInput)
  Object.defineProperty(context, '__candidateDevelopmentRuntimeInputJson', {
    value: runtimeInputJson,
    writable: false,
    configurable: true,
  })
  try {
    const output = vm.runInContext(
      `
        (() => {
          const deepFreeze = (value) => {
            if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
            for (const key of Object.keys(value)) deepFreeze(value[key])
            return Object.freeze(value)
          }
          const runtimeInput = deepFreeze(JSON.parse(globalThis.__candidateDevelopmentRuntimeInputJson))
          const builderName =
            globalThis.__candidateDevelopmentArtifact.schemaVersion === '${candidateDevelopmentPlanArtifactSchemaVersion}'
              ? 'buildPlan'
              : 'buildEvaluation'
          const evaluation = globalThis.__candidateDevelopmentArtifact[builderName](runtimeInput)
          if (
            evaluation !== null &&
            (typeof evaluation === 'object' || typeof evaluation === 'function') &&
            typeof evaluation.then === 'function'
          ) {
            throw new TypeError('candidate artifact ' + builderName + ' must be synchronous')
          }
          const encoded = JSON.stringify(evaluation)
          if (typeof encoded !== 'string') {
            throw new TypeError('candidate artifact output must be JSON serializable')
          }
          if (builderName === 'buildPlan') {
            const repeated = globalThis.__candidateDevelopmentArtifact[builderName](runtimeInput)
            if (
              repeated !== null &&
              (typeof repeated === 'object' || typeof repeated === 'function') &&
              typeof repeated.then === 'function'
            ) {
              throw new TypeError('candidate artifact buildPlan must be synchronous')
            }
            const repeatedEncoded = JSON.stringify(repeated)
            if (repeatedEncoded !== encoded) {
              throw new TypeError('candidate artifact buildPlan must be deterministic')
            }
          }
          return encoded
        })()
      `,
      context,
      { timeout: candidateDevelopmentArtifactEvaluationTimeoutMs },
    )
    if (typeof output !== 'string') throw new TypeError('candidate artifact output did not return JSON')
    return JSON.parse(output) as unknown
  } finally {
    Reflect.deleteProperty(context, '__candidateDevelopmentRuntimeInputJson')
  }
}

interface CandidateDevelopmentArtifactWorkerRequest {
  readonly _tag: 'CandidateDevelopmentArtifactWorkerRequest'
  readonly mode: 'definition' | 'evaluation'
  readonly moduleUrl: string
  readonly verifiedFiles: CandidateDevelopmentVerifiedSourceFiles
  readonly runtimeInput?: CandidateDevelopmentArtifactRuntimeInput
}

interface CandidateDevelopmentArtifactRuntimeEnvelope {
  readonly schemaVersion: unknown
  readonly inputManifest: unknown
  readonly output: unknown
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
        const builderName =
          globalThis.__candidateDevelopmentArtifact.schemaVersion === '${candidateDevelopmentPlanArtifactSchemaVersion}'
            ? 'buildPlan'
            : 'buildEvaluation'
        if (typeof globalThis.__candidateDevelopmentArtifact[builderName] !== 'function') {
          throw new TypeError('candidateDevelopmentArtifact.' + builderName + ' is missing')
        }
        return JSON.stringify({
          schemaVersion: globalThis.__candidateDevelopmentArtifact.schemaVersion,
          input: globalThis.__candidateDevelopmentArtifact.input,
          strategyProtocol: globalThis.__candidateDevelopmentArtifact.strategyProtocol,
          structuralBindings: globalThis.__candidateDevelopmentArtifact.structuralBindings,
          inputManifest: globalThis.__candidateDevelopmentArtifact.inputManifest,
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
  if (request.runtimeInput === undefined) throw new TypeError('candidate artifact runtime input is missing')
  const definition = recordOf(loaded.definition)
  const output = runCandidateDevelopmentArtifactComputation(loaded.context, request.runtimeInput)
  if (definition?.schemaVersion === candidateDevelopmentArtifactSchemaVersion) {
    const decoded = validateCandidateDevelopmentCommandEvaluation(output)
    if (Result.isFailure(decoded)) throw decoded.failure
    const sourceBinding = validateCandidateDevelopmentVerifiedSource(decoded.success, request.runtimeInput)
    if (Result.isFailure(sourceBinding)) throw sourceBinding.failure
  }
  return {
    schemaVersion: definition?.schemaVersion,
    inputManifest: definition?.inputManifest,
    output,
  } satisfies CandidateDevelopmentArtifactRuntimeEnvelope
}

class CandidateDevelopmentArtifactWorkerError extends Data.TaggedError('CandidateDevelopmentArtifactWorkerError')<{
  readonly cause: unknown
}> {}

const candidateDevelopmentArtifactWorkerCause = (cause: unknown): unknown =>
  cause instanceof CandidateDevelopmentArtifactWorkerError ? cause.cause : cause

const missingCandidateDevelopmentRuntimeMarketData: CandidateDevelopmentRuntimeMarketDataLoader = () =>
  Effect.fail(
    sourceVerificationFailure('verify-runtime-market-data', {
      field: 'runtimeMarketData',
      expected: 'a typed content-verified runtime market-data witness',
      observed: null,
    }),
  )

export const loadCandidateDevelopmentRuntimeMarketDataFile =
  (marketDataPath: string): CandidateDevelopmentRuntimeMarketDataLoader =>
  (verifiedSource, strategyProtocol, preflightInput) =>
    Effect.tryPromise({
      try: async (signal) => JSON.parse(await readFile(marketDataPath, { encoding: 'utf8', signal })) as unknown,
      catch: (cause) => sourceVerificationFailure('verify-runtime-market-data', cause),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.fromResult(
          validateCandidateDevelopmentRuntimeMarketData(value, verifiedSource, strategyProtocol, preflightInput),
        ),
      ),
    )

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

export const executeCandidateDevelopmentArtifactRuntime = (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
): Effect.Effect<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> => {
  const { marketData: unverifiedMarketData, ...runtimeContext } = runtimeInput
  return Effect.fromResult(
    validateCandidateDevelopmentRuntimeMarketData(
      unverifiedMarketData,
      runtimeContext,
      strategyProtocol,
      runtimeContext.preflightInput,
    ),
  ).pipe(
    Effect.flatMap((marketData) =>
      pipe({ ...runtimeContext, marketData }, (verifiedRuntimeInput) =>
        runCandidateDevelopmentArtifactWorker<CandidateDevelopmentArtifactRuntimeEnvelope>({
          _tag: 'CandidateDevelopmentArtifactWorkerRequest',
          mode: 'evaluation',
          moduleUrl,
          verifiedFiles,
          runtimeInput: verifiedRuntimeInput,
        }).pipe(Effect.map((envelope) => ({ envelope, runtimeInput: verifiedRuntimeInput }))),
      ),
    ),
    Effect.flatMap(({ envelope, runtimeInput: verifiedRuntimeInput }) => {
      const evaluation =
        envelope.schemaVersion === candidateDevelopmentArtifactSchemaVersion
          ? validateCandidateDevelopmentCommandEvaluation(envelope.output)
          : envelope.schemaVersion === candidateDevelopmentPlanArtifactSchemaVersion
            ? buildCandidateDevelopmentPlanEvaluation(
                envelope.output,
                envelope.inputManifest,
                verifiedRuntimeInput,
                strategyProtocol,
              )
            : Result.fail<CandidateDevelopmentCommandFailure>({
                _tag: 'CandidateDevelopmentCommandProgramInvalid',
                reason: 'schema-version-mismatch',
              })
      return Effect.fromResult(
        pipe(
          evaluation,
          Result.flatMap((decoded) =>
            pipe(
              validateCandidateDevelopmentVerifiedSource(decoded, verifiedRuntimeInput),
              Result.map(() => decoded),
            ),
          ),
        ),
      )
    }),
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure =>
        cause instanceof CandidateDevelopmentArtifactWorkerError
          ? {
              _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
              cause: candidateDevelopmentArtifactWorkerCause(cause),
            }
          : cause,
    ),
  )
}

export const evaluateCandidateDevelopmentArtifact: CandidateDevelopmentModuleImporter = (
  moduleUrl,
  verifiedFiles,
  runtimeMarketDataLoader = missingCandidateDevelopmentRuntimeMarketData,
) =>
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
    if (
      definition?.schemaVersion !== candidateDevelopmentArtifactSchemaVersion &&
      definition?.schemaVersion !== candidateDevelopmentPlanArtifactSchemaVersion
    ) {
      return yield* Effect.fail<CandidateDevelopmentCommandFailure>({
        _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
        modulePath: verifiedFiles.modulePath,
        cause: new TypeError('candidate artifact schema version is invalid'),
      })
    }
    if (definition.schemaVersion === candidateDevelopmentPlanArtifactSchemaVersion) {
      yield* Effect.fromResult(
        pipe(
          decodeCandidateDevelopmentInputManifest(definition.inputManifest),
          Result.mapError((cause) => moduleLoadFailure(cause)),
        ),
      )
    }
    const strategyProtocol = yield* Effect.fromResult(
      decodeCandidateDevelopmentStrategyProtocol(definition.strategyProtocol),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const input = yield* Effect.fromResult(
      deriveCandidateDevelopmentArtifactPreflightInput(
        definition.input,
        verifiedFiles,
        strategyProtocol as CandidateDevelopmentStrategyProtocol,
      ),
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
    yield* Effect.fromResult(
      validateCandidateDevelopmentArtifactStructure(
        definition.structuralBindings,
        input,
        strategyProtocol as CandidateDevelopmentStrategyProtocol,
        verifiedSource,
      ),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const typedStrategyProtocol = strategyProtocol as CandidateDevelopmentStrategyProtocol
    const loadRuntimeMarketData = (): Effect.Effect<
      CandidateDevelopmentMarketDataWitness,
      CandidateDevelopmentCommandFailure
    > =>
      runtimeMarketDataLoader(verifiedSource, typedStrategyProtocol, input).pipe(
        Effect.flatMap((value) =>
          Effect.fromResult(
            validateCandidateDevelopmentRuntimeMarketData(value, verifiedSource, typedStrategyProtocol, input),
          ),
        ),
      )
    const evaluation = (
      marketData: CandidateDevelopmentMarketDataWitness,
      observedVerifiedSource: CandidateDevelopmentVerifiedSource,
    ): Effect.Effect<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> =>
      executeCandidateDevelopmentArtifactRuntime(moduleUrl, verifiedFiles, typedStrategyProtocol, {
        ...observedVerifiedSource,
        runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1',
        preflightInput: input,
        marketData,
      })
    const program: ExecutableProgram = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input,
      strategyProtocol: typedStrategyProtocol,
      effects: {
        preregisterCandidate: () => Effect.fromResult(preregisterCandidateDevelopmentAttempt(verifiedSource)),
        loadDevelopmentData: loadRuntimeMarketData,
        evaluateDevelopment: (data, _preflight, observedVerifiedSource) =>
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
            Effect.flatMap(() =>
              Effect.fromResult(
                validateCandidateDevelopmentRuntimeMarketData(
                  data,
                  observedVerifiedSource,
                  typedStrategyProtocol,
                  input,
                ),
              ),
            ),
            Effect.flatMap((marketData) => evaluation(marketData, observedVerifiedSource)),
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
  runtimeMarketDataLoader: CandidateDevelopmentRuntimeMarketDataLoader = missingCandidateDevelopmentRuntimeMarketData,
): Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.gen(function* () {
    const before = yield* sourceVerifier(modulePath, sourceManifestPath)
    const module = yield* importer(before.moduleUrl, before.files, runtimeMarketDataLoader)
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

type CandidateDevelopmentProgramLoader = (
  modulePath: string,
  sourceManifestPath: string,
) => Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure>

export const loadAuthorizedCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  sourceManifestPath: string,
  loader: CandidateDevelopmentProgramLoader = loadCandidateDevelopmentExecutableProgram,
): Effect.Effect<CandidateDevelopmentLoadedExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.fromResult(authorizeCandidateDevelopmentAttempt()).pipe(
    Effect.flatMap(() => loader(modulePath, sourceManifestPath)),
  )

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
const runtimeMarketDataPath = process.argv.at(4)

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
      : runtimeMarketDataPath === undefined
        ? Effect.fail<CandidateDevelopmentCommandFailure>(
            sourceVerificationFailure('verify-runtime-market-data', {
              field: 'runtimeMarketDataPath',
              expected: 'path to a typed content-verified runtime market-data witness',
              observed: null,
            }),
          )
        : loadAuthorizedCandidateDevelopmentExecutableProgram(modulePath, sourceManifestPath, (module, manifest) =>
            loadCandidateDevelopmentExecutableProgram(
              module,
              manifest,
              importCandidateDevelopmentModule,
              verifyCandidateDevelopmentSourceFiles,
              loadCandidateDevelopmentRuntimeMarketDataFile(runtimeMarketDataPath),
            ),
          ).pipe(Effect.flatMap(executeLoadedCandidateDevelopmentProgram))
).pipe(Effect.annotateLogs({ operation: 'candidate-development-command' }))

export class CandidateDevelopmentCommandError extends Data.TaggedError('CandidateDevelopmentCommandError')<{
  readonly failure: CandidateDevelopmentCommandFailure
}> {}

export type CandidateDevelopmentCommandFailureWriter = (renderedFailure: string) => Effect.Effect<void, never>

const writeCandidateDevelopmentCommandFailureToStderr: CandidateDevelopmentCommandFailureWriter = (renderedFailure) =>
  Effect.sync(() => {
    writeSync(process.stderr.fd, renderedFailure)
  })

export const writeCandidateDevelopmentCommandFailure = (
  failure: CandidateDevelopmentCommandFailure,
  writer: CandidateDevelopmentCommandFailureWriter = writeCandidateDevelopmentCommandFailureToStderr,
): Effect.Effect<void, never> => Effect.suspend(() => writer(renderCandidateDevelopmentCommandFailure(failure)))

const renderCandidateDevelopmentCommandCause = (
  cause: Cause.Cause<CandidateDevelopmentCommandFailure>,
): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const [reason] = cause.reasons
  return cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason)
    ? renderCandidateDevelopmentCommandFailure(reason.error)
    : renderCandidateDevelopmentCommandDefect()
}

const reportCandidateDevelopmentCommandCause = (
  cause: Cause.Cause<CandidateDevelopmentCommandFailure>,
  writer: CandidateDevelopmentCommandFailureWriter,
): Effect.Effect<void, never> => {
  const rendered = renderCandidateDevelopmentCommandCause(cause)
  if (rendered === undefined) return Effect.void
  return Effect.suspend(() => writer(rendered)).pipe(
    Effect.catchCause(() =>
      writeCandidateDevelopmentCommandFailureToStderr(renderCandidateDevelopmentCommandDefect()).pipe(
        Effect.catchCause(() => Effect.void),
      ),
    ),
  )
}

export const runCandidateDevelopmentCommandMain = <A>(
  command: Effect.Effect<A, CandidateDevelopmentCommandFailure>,
  writer: CandidateDevelopmentCommandFailureWriter = writeCandidateDevelopmentCommandFailureToStderr,
): void =>
  NodeRuntime.runMain(
    command.pipe(
      Effect.tapCause((cause) => reportCandidateDevelopmentCommandCause(cause, writer)),
      Effect.mapError((failure) => new CandidateDevelopmentCommandError({ failure })),
    ),
    { disableErrorReporting: true },
  )

if (import.meta.main && isMainThread) {
  runCandidateDevelopmentCommandMain(main)
}
