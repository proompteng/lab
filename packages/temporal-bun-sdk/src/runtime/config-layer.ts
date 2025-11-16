import { Effect } from 'effect'

import {
  applyTemporalConfigOverrides,
  type LoadTemporalConfigOptions,
  loadTemporalConfigEffect,
  resolveTemporalEnvironment,
  type TemporalConfig,
  type TemporalConfigError,
  type TemporalEnvironment,
  type TemporalTlsConfigurationError,
} from '../config'

const DEFAULT_WARN_ENV_KEYS = ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_TASK_QUEUE'] as const

const missingEnvKeys = (
  env: TemporalEnvironment,
  keys: readonly (keyof TemporalEnvironment)[],
): readonly (keyof TemporalEnvironment)[] => keys.filter((key) => env[key] === undefined)

export interface TemporalConfigLayerOptions extends LoadTemporalConfigOptions {
  warnOnMissingEnv?: readonly (keyof TemporalEnvironment)[]
  overrides?: Partial<TemporalConfig>
}

export const buildTemporalConfigEffect = (
  options: TemporalConfigLayerOptions = {},
): Effect.Effect<TemporalConfig, TemporalConfigError | TemporalTlsConfigurationError> => {
  const envSnapshot = resolveTemporalEnvironment(options.env)
  const warnKeys = options.warnOnMissingEnv ?? DEFAULT_WARN_ENV_KEYS
  const missing = missingEnvKeys(envSnapshot, warnKeys)
  const warnMissing: Effect.Effect<void, never, never> = missing.length
    ? Effect.logWarning('temporal config missing recommended env vars', { keys: missing })
    : Effect.void

  return loadTemporalConfigEffect(options).pipe(
    Effect.tap(() => warnMissing),
    Effect.flatMap((config) =>
      options.overrides ? applyTemporalConfigOverrides(config, options.overrides) : Effect.succeed(config),
    ),
  )
}

export const DEFAULT_TEMPORAL_CONFIG_WARN_KEYS = DEFAULT_WARN_ENV_KEYS
