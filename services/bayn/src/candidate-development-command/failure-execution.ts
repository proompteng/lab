import type { ExecutionModelFailure } from '../execution-model'
import {
  candidateDevelopmentCommandFailureProjectionMaxScalars,
  readCandidateDevelopmentCommandFailureProperty,
  rejectedCandidateDevelopmentCommandFailureDetail,
  safeCandidateDevelopmentCommandFailureFieldPathScalar,
  safeCandidateDevelopmentCommandFailureScalar,
  type CandidateDevelopmentCommandFailureProjectionBudget,
} from './failure-core'
import {
  candidateDevelopmentCommandSimulationDomainFields,
  projectCandidateDevelopmentCommandDomainNumber,
  projectCandidateDevelopmentCommandDomainValue,
  type CandidateDevelopmentCommandDomainFieldKind,
  type CandidateDevelopmentCommandTaggedDomainIssue,
} from './failure-domain'

export type CandidateDevelopmentCommandExecutionModelFieldKind =
  | 'bigint-decimal'
  | 'decimal-text'
  | 'field-path'
  | 'iso-date'
  | 'number'
  | 'scalar'

export const candidateDevelopmentCommandExecutionModelFields = {
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

export const projectCandidateDevelopmentCommandBigintDecimal = (
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

export const projectCandidateDevelopmentCommandExecutionModelFields = (
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

export const candidateDevelopmentCommandFailureScalarIsSpecialized = (tag: string, field: string): boolean => {
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

export const candidateDevelopmentCommandTaggedDomainFields = {
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

export const projectCandidateDevelopmentCommandTaggedDomainFields = (
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
