import { Config, Effect, Option, Schema } from 'effect'

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

const historicalSignalSettings = {
  snapshotId: 'BAYN_SIGNAL_SNAPSHOT_ID',
  publicationAsOf: 'BAYN_SIGNAL_PUBLICATION_ASOF',
  calendarVersion: 'BAYN_SIGNAL_CALENDAR_VERSION',
  dataStart: 'BAYN_SIGNAL_DATA_START',
  dataEnd: 'BAYN_SIGNAL_DATA_END',
  lookbackStart: 'BAYN_SIGNAL_LOOKBACK_START',
  evaluationStart: 'BAYN_SIGNAL_EVALUATION_START',
  evaluationEnd: 'BAYN_SIGNAL_EVALUATION_END',
} as const

const historicalSignalConfigSource = Config.all({
  snapshotId: Config.schema(Sha256Schema, historicalSignalSettings.snapshotId),
  publicationAsOf: Config.schema(IsoDateSchema, historicalSignalSettings.publicationAsOf),
  calendarVersion: Config.schema(CalendarVersion, historicalSignalSettings.calendarVersion),
  dataStart: Config.schema(IsoDateSchema, historicalSignalSettings.dataStart),
  dataEnd: Config.schema(IsoDateSchema, historicalSignalSettings.dataEnd),
  lookbackStart: Config.schema(IsoDateSchema, historicalSignalSettings.lookbackStart),
  evaluationStart: Config.schema(IsoDateSchema, historicalSignalSettings.evaluationStart),
  evaluationEnd: Config.schema(IsoDateSchema, historicalSignalSettings.evaluationEnd),
}).pipe(
  Config.map(({ snapshotId, publicationAsOf, calendarVersion, ...bounds }) => ({
    snapshotId,
    publicationAsOf,
    calendarVersion,
    bounds: { schemaVersion: 'bayn.evaluation-bounds.v1' as const, ...bounds },
  })),
)

const historicalSignalConfigError = (cause: unknown) =>
  operationalError({
    component: 'config',
    operation: 'historical-signal',
    message:
      'historical reporting requires all eight valid BAYN_SIGNAL_* snapshot settings and consistent evaluation bounds',
    cause,
  })

export const loadHistoricalSignalConfig: Effect.Effect<HistoricalSignalSnapshotConfig, OperationalError> =
  historicalSignalConfigSource.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HistoricalSignalSnapshotConfigSchema, strictParseOptions)),
    Effect.mapError(historicalSignalConfigError),
  )

/** Only complete absence is optional. A partially supplied legacy snapshot must never become native evidence. */
export const loadOptionalHistoricalSignalConfig: Effect.Effect<
  Option.Option<HistoricalSignalSnapshotConfig>,
  OperationalError
> = Config.all(
  Object.values(historicalSignalSettings).map((name) => Config.option(Config.schema(Schema.String, name))),
).pipe(
  Effect.mapError(historicalSignalConfigError),
  Effect.flatMap((settings) =>
    settings.some(Option.isSome)
      ? loadHistoricalSignalConfig.pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none()),
  ),
)
