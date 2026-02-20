import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/torghut/trading/control-plane/llm/rollout')({
  server: {
    handlers: {
      GET: async () => getLlmRolloutHandler(),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const TORGHUT_STATUS_PATH = '/trading/status'

const resolveTorghutBaseUrl = () =>
  (process.env.TORGHUT_API_BASE_URL ?? 'http://torghut.torghut.svc.cluster.local').replace(/\/+$/, '')

const parseIsoEpochSeconds = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.floor(parsed / 1000)
}

export const getLlmRolloutHandler = async () => {
  const asOf = new Date().toISOString()
  const baseUrl = resolveTorghutBaseUrl()
  const url = `${baseUrl}${TORGHUT_STATUS_PATH}`

  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      const details = await response.text()
      return jsonResponse(
        { ok: false, message: `Torghut status request failed (${response.status})`, details: details.slice(0, 500) },
        503,
      )
    }

    const payload = (await response.json()) as { llm?: Record<string, unknown> }
    const llm = typeof payload?.llm === 'object' && payload.llm !== null ? payload.llm : {}
    const guardrails =
      typeof llm.guardrails === 'object' && llm.guardrails !== null ? (llm.guardrails as Record<string, unknown>) : {}
    const circuit =
      typeof llm.circuit === 'object' && llm.circuit !== null ? (llm.circuit as Record<string, unknown>) : {}

    const openUntilSeconds = parseIsoEpochSeconds(circuit.open_until)
    const cooldownSeconds = typeof circuit.cooldown_seconds === 'number' ? Math.max(0, circuit.cooldown_seconds) : 0
    const nowSeconds = Math.floor(Date.now() / 1000)
    const cooldownRemainingSeconds = openUntilSeconds ? Math.max(0, openUntilSeconds - nowSeconds) : 0
    const openDurationSeconds = openUntilSeconds
      ? Math.max(0, Math.min(cooldownSeconds, cooldownSeconds - cooldownRemainingSeconds))
      : 0

    return jsonResponse({
      ok: true,
      asOf,
      llmRollout: {
        enabled: Boolean(llm.enabled),
        rolloutStage: typeof llm.rollout_stage === 'string' ? llm.rollout_stage : null,
        configuredShadowMode: Boolean(llm.shadow_mode),
        effectiveShadowMode: Boolean(llm.effective_shadow_mode),
        configuredFailMode: typeof llm.fail_mode === 'string' ? llm.fail_mode : null,
        effectiveFailMode: typeof llm.effective_fail_mode === 'string' ? llm.effective_fail_mode : null,
        governanceEvidenceComplete: Boolean(guardrails.governance_evidence_complete),
        guardrailReasons: Array.isArray(guardrails.reasons) ? guardrails.reasons : [],
        allowRequests: Boolean(guardrails.allow_requests),
      },
      llmCircuit: {
        open: Boolean(circuit.open),
        recentErrorCount: typeof circuit.recent_error_count === 'number' ? circuit.recent_error_count : 0,
        maxErrors: typeof circuit.max_errors === 'number' ? circuit.max_errors : 0,
        windowSeconds: typeof circuit.window_seconds === 'number' ? circuit.window_seconds : 0,
        cooldownSeconds,
        cooldownRemainingSeconds,
        openDurationSeconds,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Torghut status request failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
