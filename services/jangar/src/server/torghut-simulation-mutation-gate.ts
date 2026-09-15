type EnvSource = Record<string, string | undefined>

const MUTATION_DISABLED_RETRY_AFTER_SECONDS = 30

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export type TorghutSimulationMutationGate = {
  enabled: boolean
  reason: string
}

export const resolveTorghutSimulationMutationGate = (env: EnvSource = process.env): TorghutSimulationMutationGate => ({
  enabled: parseBoolean(env.JANGAR_TORGHUT_SIMULATION_MUTATIONS_ENABLED, true),
  reason:
    normalizeNonEmpty(env.JANGAR_TORGHUT_SIMULATION_MUTATIONS_DISABLED_REASON) ??
    'torghut_simulation_mutations_disabled',
})

export const requireTorghutSimulationMutationHttp = (env: EnvSource = process.env): Response | null => {
  const gate = resolveTorghutSimulationMutationGate(env)
  if (gate.enabled) return null

  const body = JSON.stringify({
    ok: false,
    error: 'Torghut simulation mutations are disabled for this Jangar service.',
    reason: gate.reason,
  })

  return new Response(body, {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
      'retry-after': String(MUTATION_DISABLED_RETRY_AFTER_SECONDS),
    },
  })
}
