import { Schema } from 'effect'

import {
  CashChangesArtifactSchema,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  QualificationArtifactManifestSchema,
  ReconciliationResultSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  SimulatedOrdersArtifactSchema,
} from '../../evidence-contracts'
import { strictParseOptions } from '../../schemas'
import { Pipeable } from '../../pipeable'

const decodeEvaluationSummaryDataFirst = Schema.decodeUnknownResult(EvaluationSummarySchema, strictParseOptions)

export const decodeEvaluationSummary = Pipeable.dual(1, (input: unknown) => decodeEvaluationSummaryDataFirst(input))
const decodeReconciliationResultDataFirst = Schema.decodeUnknownResult(ReconciliationResultSchema, strictParseOptions)

export const decodeReconciliationResult = Pipeable.dual(1, (input: unknown) =>
  decodeReconciliationResultDataFirst(input),
)
const decodeMarkedEquityReconciliationDataFirst = Schema.decodeUnknownResult(
  MarkedEquityReconciliationSchema,
  strictParseOptions,
)

export const decodeMarkedEquityReconciliation = Pipeable.dual(1, (input: unknown) =>
  decodeMarkedEquityReconciliationDataFirst(input),
)
const decodeEquitySeriesArtifactDataFirst = Schema.decodeUnknownResult(EquitySeriesArtifactSchema, strictParseOptions)

export const decodeEquitySeriesArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeEquitySeriesArtifactDataFirst(input),
)
const decodeEvaluationEventsDataFirst = Schema.decodeUnknownResult(EvaluationEventsSchema, strictParseOptions)

export const decodeEvaluationEvents = Pipeable.dual(1, (input: unknown) => decodeEvaluationEventsDataFirst(input))
const decodeSimulatedOrdersArtifactDataFirst = Schema.decodeUnknownResult(
  SimulatedOrdersArtifactSchema,
  strictParseOptions,
)

export const decodeSimulatedOrdersArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeSimulatedOrdersArtifactDataFirst(input),
)
const decodeSignalDecisionsArtifactDataFirst = Schema.decodeUnknownResult(
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  strictParseOptions,
)

export const decodeSignalDecisionsArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeSignalDecisionsArtifactDataFirst(input),
)
const decodeDailyPerformanceSeriesArtifactDataFirst = Schema.decodeUnknownResult(
  DailyPerformanceSeriesArtifactSchema,
  strictParseOptions,
)

export const decodeDailyPerformanceSeriesArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeDailyPerformanceSeriesArtifactDataFirst(input),
)
const decodeQualificationArtifactManifestDataFirst = Schema.decodeUnknownResult(
  QualificationArtifactManifestSchema,
  strictParseOptions,
)

export const decodeQualificationArtifactManifest = Pipeable.dual(1, (input: unknown) =>
  decodeQualificationArtifactManifestDataFirst(input),
)
const decodeCashChangesArtifactDataFirst = Schema.decodeUnknownResult(CashChangesArtifactSchema, strictParseOptions)

export const decodeCashChangesArtifact = Pipeable.dual(1, (input: unknown) => decodeCashChangesArtifactDataFirst(input))
const decodeDailyPositionMarksArtifactDataFirst = Schema.decodeUnknownResult(
  DailyPositionMarksArtifactSchema,
  strictParseOptions,
)

export const decodeDailyPositionMarksArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeDailyPositionMarksArtifactDataFirst(input),
)
const decodeInputManifestArtifactDataFirst = Schema.decodeUnknownResult(InputManifestArtifactSchema, strictParseOptions)

export const decodeInputManifestArtifact = Pipeable.dual(1, (input: unknown) =>
  decodeInputManifestArtifactDataFirst(input),
)
