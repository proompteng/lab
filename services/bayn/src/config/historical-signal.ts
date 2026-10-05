import { Config, Effect, Schema } from 'effect'

import { EvaluationBoundsSchema } from '../contracts'
import { operationalError, type OperationalError } from '../errors'
import {
  IsoDateSchema,
  Sha256Schema,
  TrimmedNonEmptyStringSchema as CalendarVersion,
  strictParseOptions,
} from '../schemas'

export const HistoricalSignalSnapshotConfigSchema = Schema.Struct({
  snapshotId: Sha256Schema,
  publicationAsOf: IsoDateSchema,
  calendarVersion: CalendarVersion,
  bounds: EvaluationBoundsSchema,
})

export type HistoricalSignalSnapshotConfig = typeof HistoricalSignalSnapshotConfigSchema.Type

export interface HistoricalMarketDataConfig {
  readonly historicalSignal: HistoricalSignalSnapshotConfig
  readonly operationTimeoutMs: number
}

const historicalSignalConfigSource = Config.all({
  snapshotId: Config.schema(Sha256Schema, 'BAYN_SIGNAL_SNAPSHOT_ID'),
  publicationAsOf: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_PUBLICATION_ASOF'),
  calendarVersion: Config.schema(CalendarVersion, 'BAYN_SIGNAL_CALENDAR_VERSION'),
  dataStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_DATA_START'),
  dataEnd: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_DATA_END'),
  lookbackStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_LOOKBACK_START'),
  evaluationStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_EVALUATION_START'),
  evaluationEnd: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_EVALUATION_END'),
}).pipe(
  Config.map(({ snapshotId, publicationAsOf, calendarVersion, ...bounds }) => ({
    snapshotId,
    publicationAsOf,
    calendarVersion,
    bounds: { schemaVersion: 'bayn.evaluation-bounds.v1' as const, ...bounds },
  })),
)

export const loadHistoricalSignalConfig: Effect.Effect<HistoricalSignalSnapshotConfig, OperationalError> =
  historicalSignalConfigSource.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HistoricalSignalSnapshotConfigSchema, strictParseOptions)),
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'historical-signal',
        message:
          'historical reporting requires all eight valid BAYN_SIGNAL_* snapshot settings and consistent evaluation bounds',
        cause,
      }),
    ),
  )
