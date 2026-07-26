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

export const decodeEvaluationSummary = Schema.decodeUnknownResult(EvaluationSummarySchema, strictParseOptions)
export const decodeReconciliationResult = Schema.decodeUnknownResult(ReconciliationResultSchema, strictParseOptions)
export const decodeMarkedEquityReconciliation = Schema.decodeUnknownResult(
  MarkedEquityReconciliationSchema,
  strictParseOptions,
)
export const decodeEquitySeriesArtifact = Schema.decodeUnknownResult(EquitySeriesArtifactSchema, strictParseOptions)
export const decodeEvaluationEvents = Schema.decodeUnknownResult(EvaluationEventsSchema, strictParseOptions)
export const decodeSimulatedOrdersArtifact = Schema.decodeUnknownResult(
  SimulatedOrdersArtifactSchema,
  strictParseOptions,
)
export const decodeSignalDecisionsArtifact = Schema.decodeUnknownResult(
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  strictParseOptions,
)
export const decodeDailyPerformanceSeriesArtifact = Schema.decodeUnknownResult(
  DailyPerformanceSeriesArtifactSchema,
  strictParseOptions,
)
export const decodeQualificationArtifactManifest = Schema.decodeUnknownResult(
  QualificationArtifactManifestSchema,
  strictParseOptions,
)
export const decodeCashChangesArtifact = Schema.decodeUnknownResult(CashChangesArtifactSchema, strictParseOptions)
export const decodeDailyPositionMarksArtifact = Schema.decodeUnknownResult(
  DailyPositionMarksArtifactSchema,
  strictParseOptions,
)
export const decodeInputManifestArtifact = Schema.decodeUnknownResult(InputManifestArtifactSchema, strictParseOptions)
