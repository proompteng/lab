import { createFileRoute } from '@tanstack/react-router'

type RolloutStage = 'stage0' | 'stage1' | 'stage2' | 'stage3' | 'unknown'

type RolloutStageRiskProfile = {
  maxRecentErrors: number
  maxOpenDurationSeconds: number
  requireGovernanceEvidence: boolean
  requireProductionFailover: boolean
}

const ROLLOUT_STAGE_RISK_PROFILES: Record<'stage0' | 'stage1' | 'stage2' | 'stage3', RolloutStageRiskProfile> = {
  stage0: {
    maxRecentErrors: 0,
    maxOpenDurationSeconds: 3600,
    requireGovernanceEvidence: false,
    requireProductionFailover: false,
  },
  stage1: {
    maxRecentErrors: 1,
    maxOpenDurationSeconds: 120,
    requireGovernanceEvidence: false,
    requireProductionFailover: false,
  },
  stage2: {
    maxRecentErrors: 1,
    maxOpenDurationSeconds: 120,
    requireGovernanceEvidence: true,
    requireProductionFailover: false,
  },
  stage3: {
    maxRecentErrors: 0,
    maxOpenDurationSeconds: 0,
    requireGovernanceEvidence: true,
    requireProductionFailover: true,
  },
}

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

const normalizeRolloutStage = (value: unknown): RolloutStage => {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('stage0')) return 'stage0'
  if (normalized.startsWith('stage1')) return 'stage1'
  if (normalized.startsWith('stage2')) return 'stage2'
  if (normalized.startsWith('stage3')) return 'stage3'
  return 'unknown'
}

const toInteger = (value: unknown) => {
  if (typeof value !== 'number') return 0
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
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
    const rolloutStage = normalizeRolloutStage(llm.rollout_stage)
    const riskProfile = ROLLOUT_STAGE_RISK_PROFILES[rolloutStage === 'unknown' ? 'stage0' : rolloutStage]
    const guardrails =
      typeof llm.guardrails === 'object' && llm.guardrails !== null ? (llm.guardrails as Record<string, unknown>) : {}
    const circuit =
      typeof llm.circuit === 'object' && llm.circuit !== null ? (llm.circuit as Record<string, unknown>) : {}

    const openUntilSeconds = parseIsoEpochSeconds(circuit.open_until)
    const cooldownSeconds = toInteger(circuit.cooldown_seconds)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const cooldownRemainingSeconds = openUntilSeconds ? Math.max(0, openUntilSeconds - nowSeconds) : 0
    const openDurationSeconds = openUntilSeconds
      ? Math.max(0, Math.min(cooldownSeconds, cooldownSeconds - cooldownRemainingSeconds))
      : 0

    const configuredRolloutStage = typeof llm.rollout_stage === 'string' ? llm.rollout_stage : null
    const governanceEvidenceComplete = Boolean(guardrails.governance_evidence_complete)
    const configuredFailMode = typeof llm.effective_fail_mode === 'string' ? llm.effective_fail_mode : null
    const rolloutChecks: string[] = []
    const recentErrorCount = toInteger(circuit.recent_error_count)
    const maxErrors = toInteger(circuit.max_errors)

    if (rolloutStage === 'unknown') {
      rolloutChecks.push('llm_rollout_stage_unknown')
    }

    if (riskProfile.requireGovernanceEvidence && !governanceEvidenceComplete) {
      rolloutChecks.push('llm_rollout_evidence_missing')
    }

    if (recentErrorCount > riskProfile.maxRecentErrors) {
      rolloutChecks.push('llm_rollout_recent_error_threshold_exceeded')
    }

    if (openDurationSeconds > riskProfile.maxOpenDurationSeconds) {
      rolloutChecks.push('llm_rollout_circuit_open_too_long')
    }

    if (maxErrors > 0 && recentErrorCount > maxErrors) {
      rolloutChecks.push('llm_rollout_circuit_error_budget_exceeded')
    }

    if (riskProfile.requireProductionFailover && Boolean(llm.effective_shadow_mode)) {
      rolloutChecks.push('llm_rollout_stage3_must_not_shadow')
    }

    if (riskProfile.requireProductionFailover && configuredFailMode === 'pass_through') {
      rolloutChecks.push('llm_rollout_stage3_must_not_pass_through')
    }

    const allowRequests = Boolean(guardrails.allow_requests) && rolloutChecks.length === 0

    return jsonResponse({
      ok: true,
      asOf,
      llmRollout: {
        enabled: Boolean(llm.enabled),
        rolloutStage: rolloutStage === 'unknown' ? null : rolloutStage,
        configuredRolloutStage,
        configuredShadowMode: Boolean(llm.shadow_mode),
        effectiveShadowMode: Boolean(llm.effective_shadow_mode),
        configuredFailMode: typeof llm.fail_mode === 'string' ? llm.fail_mode : null,
        effectiveFailMode: configuredFailMode,
        governanceEvidenceComplete,
        guardrailReasons: Array.isArray(guardrails.reasons) ? guardrails.reasons : [],
        allowRequests,
        rolloutChecks,
        stageRiskProfile: riskProfile,
      },
      llmCircuit: {
        open: Boolean(circuit.open),
        recentErrorCount,
        maxErrors,
        windowSeconds: toInteger(circuit.window_seconds),
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
