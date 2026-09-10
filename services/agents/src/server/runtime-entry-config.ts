import { normalizeEnvValue, parsePositiveIntEnv, readAgentsEnv, type EnvSource } from './runtime-env'

export type AgentsListenConfig = {
  port: number
  hostname: string
  idleTimeoutSeconds: number
}

export const resolveAgentsHttpServerListenConfig = (env: EnvSource = process.env): AgentsListenConfig => ({
  port: parsePositiveIntEnv(env.PORT ?? readAgentsEnv(env, 'AGENTS_PORT'), 3000),
  hostname: normalizeEnvValue(env.HOST) ?? '0.0.0.0',
  idleTimeoutSeconds: parsePositiveIntEnv(readAgentsEnv(env, 'AGENTS_HTTP_IDLE_TIMEOUT_SECONDS'), 120),
})

export const validateRuntimeEntryConfig = (env: EnvSource = process.env) => {
  resolveAgentsHttpServerListenConfig(env)
}
