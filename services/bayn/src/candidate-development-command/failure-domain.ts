import {
  type CandidateDevelopmentAttemptIssue,
  type CandidateDevelopmentComparisonSemanticsIssue,
  type CandidateDevelopmentDoubledCostIssue,
  type CandidateDevelopmentPreflightIssue,
} from '../candidate-development'
import type { QualificationStatisticsFailure } from '../qualification-statistics'
import { type SimulationDomainFailure } from '../simulation'
import { type SimulationReconciliationIssue } from '../simulation-reconciliation'
import {
  candidateDevelopmentCommandFailureObjectSupported,
  candidateDevelopmentCommandFailureProjectionMaxNodes,
  candidateDevelopmentCommandFailureProjectionMaxScalars,
  finishCandidateDevelopmentCommandFailureList,
  prepareCandidateDevelopmentCommandFailureListWindow,
  readCandidateDevelopmentCommandFailureProperty,
  rejectedCandidateDevelopmentCommandFailureDetail,
  safeCandidateDevelopmentCommandFailureScalar,
  safeCandidateDevelopmentCommandFailureToken,
  type CandidateDevelopmentCommandFailureProjectionBudget,
} from './failure-core'
import { projectCandidateDevelopmentCommandValidationScalar } from './failure-validation'
import { projectCandidateDevelopmentCommandBigintDecimal } from './failure-execution'
import { projectCandidateDevelopmentCommandFailureDetail } from './failure-dispatch'

export type CandidateDevelopmentCommandDomainFieldKind =
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

export type CandidateDevelopmentCommandTaggedDomainIssue =
  | CandidateDevelopmentAttemptIssue
  | CandidateDevelopmentDoubledCostIssue
  | CandidateDevelopmentPreflightIssue
  | CandidateDevelopmentComparisonSemanticsIssue
  | QualificationStatisticsFailure

export const candidateDevelopmentCommandSelectedBenchmarks = new Set([
  'buy-and-hold',
  'candidate',
  'cash',
  'direct-volatility-timing',
  'not-applicable',
  'selected-benchmark',
])

export const candidateDevelopmentCommandDoubledCostRuns = new Set(['baseline', 'stressed'])

export const projectCandidateDevelopmentCommandDomainNumber = (
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

export type CandidateDevelopmentCommandSimulationDomainFieldKind =
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

export const candidateDevelopmentCommandSimulationDomainFields = {
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

export const projectCandidateDevelopmentCommandSymbol = (
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

export const projectCandidateDevelopmentCommandNumberList = (
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

export const projectCandidateDevelopmentCommandSimulationDomainFields = (
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

export type CandidateDevelopmentCommandSimulationReconciliationProblem = Extract<
  SimulationReconciliationIssue,
  { readonly problem: unknown }
>['problem']

export type CandidateDevelopmentCommandSimulationReconciliationProblemFieldKind = 'failure' | 'scalar' | 'symbol-list'

export const candidateDevelopmentCommandSimulationReconciliationProblemFields = {
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

export type CandidateDevelopmentCommandSimulationReconciliationEvidence = Extract<
  SimulationReconciliationIssue,
  { readonly evidence: unknown }
>['evidence']

export type CandidateDevelopmentCommandSimulationReconciliationComputation = Extract<
  SimulationReconciliationIssue,
  { readonly _tag: 'ComputationFailed' }
>['computation']

export type CandidateDevelopmentCommandSimulationReconciliationIssueFieldKind =
  | 'computation'
  | 'evidence'
  | 'problem'
  | 'scalar'

export const candidateDevelopmentCommandSimulationReconciliationIssueFields = {
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

export const candidateDevelopmentCommandSimulationReconciliationComputationFields = {
  FillTerms: ['fillId', 'side', 'quantityMicros', 'referencePriceMicros', 'costMultiplierMicros'],
  FeeSchedule: ['feeId', 'fillCount', 'costMultiplierMicros'],
  CashYield: ['cashYieldId', 'cashMicros', 'elapsedDays', 'annualYieldBps'],
  PositionNotional: ['sessionDate', 'symbol', 'quantityMicros', 'priceMicros'],
} as const satisfies Readonly<
  Record<CandidateDevelopmentCommandSimulationReconciliationComputation['_tag'], readonly string[]>
>

export const projectCandidateDevelopmentCommandSymbolList = (
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

export const projectCandidateDevelopmentCommandSimulationReconciliationEvidence = (
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

export const projectCandidateDevelopmentCommandSimulationReconciliationComputation = (
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

export const projectCandidateDevelopmentCommandSimulationReconciliationProblem = (
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

export const projectCandidateDevelopmentCommandSimulationReconciliationIssueFields = (
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

export const projectCandidateDevelopmentCommandMarkedEquityCause = (
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

export const projectCandidateDevelopmentCommandHashList = (
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

export const projectCandidateDevelopmentCommandBoundary = (
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

export const projectCandidateDevelopmentCommandDomainValue = (
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
