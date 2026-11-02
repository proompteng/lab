import { Effect, Option } from 'effect'

import type { EmbeddedBuildMetadata } from '../build'
import { loadConfig } from '../config/load'
import { type LoadedRuntimeConfig } from '../config/model'
import { loadOptionalHistoricalSignalConfig, type HistoricalSignalSnapshotConfig } from '../config/historical-signal'

export type ForwardPerformanceConfig = LoadedRuntimeConfig & {
  readonly historicalSignal?: HistoricalSignalSnapshotConfig
}

export const loadForwardPerformanceConfig = (embedded?: EmbeddedBuildMetadata) =>
  Effect.all({ config: loadConfig(embedded), historicalSignal: loadOptionalHistoricalSignalConfig }).pipe(
    Effect.map(
      ({ config, historicalSignal }): ForwardPerformanceConfig =>
        Option.match(historicalSignal, {
          onNone: () => config,
          onSome: (historicalSignal) => ({ ...config, historicalSignal }),
        }),
    ),
  )
