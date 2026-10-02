import { Effect } from 'effect'

import type { EmbeddedBuildMetadata } from '../build'
import { loadConfig, type LoadedRuntimeConfig } from '../config'
import { loadHistoricalSignalConfig, type HistoricalSignalSnapshotConfig } from '../config/historical-signal'

export type ForwardPerformanceConfig = LoadedRuntimeConfig & {
  readonly historicalSignal: HistoricalSignalSnapshotConfig
}

export const loadForwardPerformanceConfig = (embedded?: EmbeddedBuildMetadata) =>
  Effect.all({ config: loadConfig(embedded), historicalSignal: loadHistoricalSignalConfig }).pipe(
    Effect.map(({ config, historicalSignal }): ForwardPerformanceConfig => ({ ...config, historicalSignal })),
  )
