import { Context, Data, Effect, Layer } from 'effect'

export type EnvSource = Record<string, string | undefined>

export class AgentsEnvConfigError extends Data.TaggedError('AgentsEnvConfigError')<{
  readonly name: string
  readonly value: string
  readonly reason: 'invalid-boolean' | 'invalid-positive-int'
}> {}

export type AgentsRuntimeEnvService = {
  read: (name: string) => Effect.Effect<string | null>
  readRaw: (name: string) => Effect.Effect<string | undefined>
}

export class AgentsRuntimeEnv extends Context.Tag('AgentsRuntimeEnv')<AgentsRuntimeEnv, AgentsRuntimeEnvService>() {}

export const normalizeEnvValue = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const makeAgentsRuntimeEnv = (env: EnvSource): AgentsRuntimeEnvService => ({
  read: (name) => Effect.sync(() => normalizeEnvValue(env[name])),
  readRaw: (name) => Effect.sync(() => env[name]),
})

export const AgentsRuntimeEnvLive = Layer.succeed(AgentsRuntimeEnv, makeAgentsRuntimeEnv(process.env))

export const readAgentsEnv = (env: EnvSource, name: string) => Effect.runSync(makeAgentsRuntimeEnv(env).read(name))

export const readAgentsRawEnv = (env: EnvSource, name: string) =>
  Effect.runSync(makeAgentsRuntimeEnv(env).readRaw(name))

export const parseBooleanEnv = (value: string | undefined | null, fallback: boolean) => {
  const normalized = normalizeEnvValue(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export const parsePositiveIntEnv = (
  value: string | undefined | null,
  fallback: number,
  options: { minimum?: number; maximum?: number } = {},
) => {
  const normalized = normalizeEnvValue(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < (options.minimum ?? 1)) return fallback
  const bounded = Math.floor(parsed)
  return options.maximum === undefined ? bounded : Math.min(bounded, options.maximum)
}
