import { Schema } from 'effect'

import { EvaluationBoundsSchema, FinalizedSnapshotProvenanceSchema, IsoDateSchema, Sha256Schema } from './contracts'
import { DigitsSchema as Micros, PositiveIntegerSchema as PositiveInteger, SymbolSchema as Symbol } from './schemas'

const InputManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.input-manifest.v3'),
  hash: Sha256Schema,
  database: Schema.Literal('signal'),
  bounds: EvaluationBoundsSchema,
  rowCount: PositiveInteger,
  sessionCount: PositiveInteger,
  firstSession: IsoDateSchema,
  lastSession: IsoDateSchema,
  symbols: Schema.Array(
    Schema.Struct({
      symbol: Symbol,
      rows: PositiveInteger,
      firstSession: IsoDateSchema,
      lastSession: IsoDateSchema,
    }),
  ).check(Schema.isMinLength(1)),
  tables: Schema.Struct({
    bars: Schema.Literal('adjusted_daily_bars_v2'),
    sessions: Schema.Literal('exchange_sessions_v1'),
    manifests: Schema.Literal('snapshot_manifests_v2'),
  }),
  finalizedSnapshot: FinalizedSnapshotProvenanceSchema,
})

const ReconciliationResultSchema = Schema.Struct({
  runId: Sha256Schema,
  accountCount: PositiveInteger,
  transferCount: PositiveInteger,
  exact: Schema.Literal(true),
})

const DecisionEventSchema = Schema.Struct({
  kind: Schema.Literal('decision'),
  id: Sha256Schema,
  signalDate: IsoDateSchema,
  executionDate: IsoDateSchema,
  targetWeights: Schema.Record(Schema.String, Schema.Finite),
  terminalClose: Schema.optional(Schema.Literal(true)),
})

const FillEventSchema = Schema.Struct({
  kind: Schema.Literal('fill'),
  id: Sha256Schema,
  orderId: Sha256Schema,
  decisionId: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  quantityAtoms: Micros,
  referencePriceMicros: Micros,
  priceMicros: Micros,
  notionalMicros: Micros,
  spreadCostMicros: Micros,
  slippageCostMicros: Micros,
  costBasisMicros: Micros,
})

const FeeEventSchema = Schema.Struct({
  kind: Schema.Literal('fee'),
  id: Sha256Schema,
  sessionDate: IsoDateSchema,
  commissionMicros: Micros,
  secMicros: Micros,
  tafMicros: Micros,
  catMicros: Micros,
  totalMicros: Micros,
})

const CashYieldEventSchema = Schema.Struct({
  kind: Schema.Literal('cash-yield'),
  id: Sha256Schema,
  sessionDate: IsoDateSchema,
  elapsedDays: PositiveInteger,
  annualYieldBps: Schema.Finite,
  amountMicros: Micros,
})

const EvaluationEventSchema = Schema.Union([DecisionEventSchema, FillEventSchema, FeeEventSchema, CashYieldEventSchema])

export type InputManifest = typeof InputManifestSchema.Type
export type SymbolCoverage = InputManifest['symbols'][number]
export type ReconciliationResult = typeof ReconciliationResultSchema.Type
export type EvaluationEvent = typeof EvaluationEventSchema.Type
export type FillEvent = Extract<EvaluationEvent, { readonly kind: 'fill' }>
export type FeeEvent = Extract<EvaluationEvent, { readonly kind: 'fee' }>
export type CashYieldEvent = Extract<EvaluationEvent, { readonly kind: 'cash-yield' }>
