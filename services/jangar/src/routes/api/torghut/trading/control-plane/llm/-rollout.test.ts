import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('getLlmRolloutHandler', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    global.fetch = originalFetch
  })

  it('returns rollout and circuit payload from torghut status', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-20T12:00:00Z'))

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            llm: {
              enabled: true,
              rollout_stage: 'stage1',
              shadow_mode: true,
              effective_shadow_mode: true,
              fail_mode: 'pass_through',
              effective_fail_mode: 'pass_through',
              circuit: {
                open: true,
                open_until: '2026-02-20T12:03:00Z',
                cooldown_seconds: 600,
                window_seconds: 300,
                max_errors: 3,
                recent_error_count: 1,
              },
              guardrails: {
                allow_requests: true,
                governance_evidence_complete: false,
                reasons: ['llm_shadow_completion_missing'],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    const { getLlmRolloutHandler } = await import('./rollout')

    const response = await getLlmRolloutHandler()
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.llmRollout.rolloutStage).toBe('stage1')
    expect(body.llmRollout.configuredRolloutStage).toBe('stage1')
    expect(body.llmRollout.effectiveFailMode).toBe('pass_through')
    expect(body.llmRollout.governanceEvidenceComplete).toBe(false)
    expect(body.llmRollout.rolloutChecks).toEqual([])
    expect(body.llmRollout.allowRequests).toBe(true)
    expect(body.llmRollout.stageRiskProfile.maxRecentErrors).toBe(1)
    expect(body.llmCircuit.open).toBe(true)
    expect(body.llmCircuit.cooldownRemainingSeconds).toBe(180)
    expect(body.llmCircuit.openDurationSeconds).toBe(180)

    vi.useRealTimers()
  })

  it('blocks requests when staged rollout checks fail', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-20T12:00:00Z'))

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            llm: {
              enabled: true,
              rollout_stage: 'stage2',
              shadow_mode: true,
              effective_shadow_mode: true,
              fail_mode: 'strict',
              effective_fail_mode: 'strict',
              circuit: {
                open: true,
                open_until: '2026-02-20T12:03:00Z',
                cooldown_seconds: 600,
                window_seconds: 300,
                max_errors: 1,
                recent_error_count: 2,
              },
              guardrails: {
                allow_requests: true,
                governance_evidence_complete: false,
                reasons: ['llm_shadow_completion_missing'],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    const { getLlmRolloutHandler } = await import('./rollout')

    const response = await getLlmRolloutHandler()
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.llmRollout.rolloutStage).toBe('stage2')
    expect(body.llmRollout.allowRequests).toBe(false)
    expect(body.llmRollout.rolloutChecks).toEqual([
      'llm_rollout_evidence_missing',
      'llm_rollout_recent_error_threshold_exceeded',
      'llm_rollout_circuit_open_too_long',
    ])
    expect(body.llmRollout.stageRiskProfile.maxRecentErrors).toBe(1)
  })

  it('returns 503 when torghut status is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream failed', { status: 500 })))

    const { getLlmRolloutHandler } = await import('./rollout')

    const response = await getLlmRolloutHandler()
    expect(response.status).toBe(503)

    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('Torghut status request failed')
  })
})
