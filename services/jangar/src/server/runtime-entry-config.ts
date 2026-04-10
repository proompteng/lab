type EnvSource = Record<string, string | undefined>

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export type ListenConfig = {
  port: number
  hostname: string
}

export type WorkerHealthConfig = {
  port: number
  checkIntervalMs: number
  checkTimeoutMs: number
  readyTtlMs: number
  liveTtlMs: number
}

export type WorkerRuntimeConfig = {
  temporalTaskQueue: string
  health: WorkerHealthConfig
}

export const resolveHttpServerListenConfig = (
  env: EnvSource = process.env,
  options?: { dev?: boolean },
): ListenConfig => ({
  port: parsePositiveInt(
    env.PORT ?? (options?.dev ? env.JANGAR_API_PORT : env.JANGAR_PORT),
    options?.dev ? 3001 : 3000,
  ),
  hostname: normalizeNonEmpty(env.HOST) ?? (options?.dev ? '127.0.0.1' : '0.0.0.0'),
})

export const resolveWorkerRuntimeConfig = (env: EnvSource = process.env): WorkerRuntimeConfig => {
  const checkIntervalMs = parsePositiveInt(env.JANGAR_WORKER_HEALTH_CHECK_INTERVAL_MS, 10_000)
  const requestedTimeoutMs = parsePositiveInt(env.JANGAR_WORKER_HEALTH_CHECK_TIMEOUT_MS, 2_000)

  return {
    temporalTaskQueue:
      normalizeNonEmpty(env.JANGAR_WORKER_TEMPORAL_TASK_QUEUE) ??
      normalizeNonEmpty(env.TEMPORAL_TASK_QUEUE) ??
      'jangar',
    health: {
      port: parsePositiveInt(env.JANGAR_WORKER_HEALTH_PORT, 3002),
      checkIntervalMs,
      checkTimeoutMs: Math.min(requestedTimeoutMs, Math.max(checkIntervalMs - 100, 1_000)),
      readyTtlMs: parsePositiveInt(env.JANGAR_WORKER_HEALTH_READY_TTL_MS, 30_000),
      liveTtlMs: parsePositiveInt(env.JANGAR_WORKER_HEALTH_LIVE_TTL_MS, 30_000),
    },
  }
}

export const validateRuntimeEntryConfig = (env: EnvSource = process.env) => {
  resolveHttpServerListenConfig(env)
  resolveHttpServerListenConfig(env, { dev: true })
  resolveWorkerRuntimeConfig(env)
}
