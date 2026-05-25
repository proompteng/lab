import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/db', () => ({
  getDb: () => null,
}))

vi.mock('~/server/kysely-migrations', () => ({
  ensureMigrations: async () => undefined,
}))

describe('torghut market-context agent helpers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('opens provider circuit after consecutive failures inside cooldown window', async () => {
    const { resolveProviderCircuitStateFromRows } = await import('../torghut-market-context-agents')

    const now = new Date('2026-03-05T20:00:00.000Z')
    const state = resolveProviderCircuitStateFromRows({
      provider: 'codex-spark',
      threshold: 3,
      cooldownSeconds: 900,
      now,
      rows: [
        {
          status: 'failed',
          error: 'provider_turn_failed',
          updatedAt: new Date('2026-03-05T19:58:00.000Z'),
        },
        {
          status: 'cancelled',
          error: 'provider_attempt_timeout',
          updatedAt: new Date('2026-03-05T19:55:00.000Z'),
        },
        {
          status: 'failed',
          error: 'provider_bootstrap_failure',
          updatedAt: new Date('2026-03-05T19:50:00.000Z'),
        },
      ],
    })

    expect(state.cooldownOpen).toBe(true)
    expect(state.consecutiveFailures).toBe(3)
    expect(state.cooldownRemainingSeconds).toBe(780)
    expect(state.lastError).toBe('provider_turn_failed')
  })

  it('keeps provider circuit closed when a success breaks the failure chain', async () => {
    const { resolveProviderCircuitStateFromRows } = await import('../torghut-market-context-agents')

    const now = new Date('2026-03-05T20:00:00.000Z')
    const state = resolveProviderCircuitStateFromRows({
      provider: 'codex',
      threshold: 3,
      cooldownSeconds: 900,
      now,
      rows: [
        {
          status: 'failed',
          error: 'provider_turn_failed',
          updatedAt: new Date('2026-03-05T19:58:00.000Z'),
        },
        {
          status: 'succeeded',
          error: null,
          updatedAt: new Date('2026-03-05T19:56:00.000Z'),
        },
        {
          status: 'failed',
          error: 'provider_turn_failed',
          updatedAt: new Date('2026-03-05T19:52:00.000Z'),
        },
      ],
    })

    expect(state.cooldownOpen).toBe(false)
    expect(state.consecutiveFailures).toBe(1)
    expect(state.cooldownRemainingSeconds).toBe(0)
  })

  it('prefers structured failure category over free-form messages', async () => {
    const { resolveFailureSignal } = await import('../torghut-market-context-agents')

    const signal = resolveFailureSignal({
      metadata: {
        providerAttempts: [
          {
            provider: 'codex-spark',
            failureCategory: 'provider_bootstrap_failure',
            error: 'jangar auth failed',
          },
        ],
      },
      message: 'jangar auth failed',
    })

    expect(signal.category).toBe('provider_bootstrap_failure')
    expect(signal.error).toBe('provider_bootstrap_failure')
    expect(signal.message).toBe('jangar auth failed')
  })

  it('surfaces all-provider capacity exhaustion from fallback attempts', async () => {
    const { resolveFailureSignal } = await import('../torghut-market-context-agents')

    const signal = resolveFailureSignal({
      metadata: {
        failureCategory: 'attempt_budget_exhausted',
        providerAttempts: [
          {
            provider: 'codex',
            failureCategory: 'provider_fallback_eligible',
            error: "You've hit your usage limit. Try again later.",
          },
          {
            provider: 'codex-spark',
            failureCategory: 'provider_fallback_eligible',
            error: 'quota exceeded',
          },
        ],
      },
      message: 'all_provider_attempts_failed',
    })

    expect(signal.category).toBe('provider_capacity_exhausted')
    expect(signal.error).toBe('provider_capacity_exhausted')
    expect(signal.message).toBe('all_provider_attempts_failed')
  })

  it('keeps non-capacity provider attempt failures specific', async () => {
    const { resolveFailureSignal } = await import('../torghut-market-context-agents')

    const signal = resolveFailureSignal({
      metadata: {
        failureCategory: 'attempt_budget_exhausted',
        providerAttempts: [
          {
            provider: 'codex',
            failureCategory: 'provider_fallback_eligible',
            error: 'quota exceeded',
          },
          {
            provider: 'codex-spark',
            failureCategory: 'payload_validation_failure',
            error: 'missing analysis payload',
          },
        ],
      },
      message: 'all_provider_attempts_failed',
    })

    expect(signal.category).toBe('payload_validation_failure')
    expect(signal.error).toBe('payload_validation_failure')
    expect(signal.message).toBe('all_provider_attempts_failed')
  })

  it('does not dispatch per-symbol stale snapshots when no active run or cooldown exists', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'stale',
      activeRun: null,
      dispatchState: null,
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(false)
    expect(decision.attempted).toBe(true)
    expect(decision.dispatched).toBe(false)
    expect(decision.reason).toBe('per_symbol_market_context_dispatch_removed')
  })

  it('suppresses on-demand dispatch when a provider run is already active', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'missing',
      activeRun: {
        requestId: 'request-1',
        runName: 'torghut-market-context-news-aapl-abcde',
      },
      dispatchState: null,
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(false)
    expect(decision.attempted).toBe(true)
    expect(decision.reason).toBe('active_run_in_progress')
    expect(decision.runName).toBe('torghut-market-context-news-aapl-abcde')
  })

  it('suppresses on-demand dispatch while provider capacity cooldown is active', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'missing',
      activeRun: null,
      dispatchState: null,
      providerCapacityHold: {
        active: true,
        runName: 'torghut-market-context-news-amd-abcde',
        provider: 'codex-spark',
        until: new Date('2026-05-07T20:15:00.000Z'),
        error: 'provider_capacity_exhausted',
      },
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(false)
    expect(decision.attempted).toBe(true)
    expect(decision.reason).toBe('provider_capacity_cooldown')
    expect(decision.runName).toBe('torghut-market-context-news-amd-abcde')
    expect(decision.error).toBe('provider_capacity_exhausted')
  })

  it('opens provider capacity dispatch hold from recent quota failures', async () => {
    const { resolveProviderCapacityDispatchHoldFromRows } = await import('../torghut-market-context-dispatch')

    const hold = resolveProviderCapacityDispatchHoldFromRows({
      now: new Date('2026-05-07T20:00:00.000Z'),
      fallbackCooldownSeconds: 900,
      rows: [
        {
          requestId: 'request-1',
          runName: 'torghut-market-context-news-amd-abcde',
          provider: 'codex-spark',
          status: 'failed',
          error: 'all_provider_attempts_failed',
          metadata: {
            failureCategory: 'attempt_budget_exhausted',
            providerAttempts: [
              {
                provider: 'codex',
                failureCategory: 'provider_fallback_eligible',
                error: "You've hit your usage limit. Try again later.",
              },
              {
                provider: 'codex-spark',
                failureCategory: 'provider_fallback_eligible',
                error: 'quota exceeded',
              },
            ],
          },
          updatedAt: new Date('2026-05-07T19:55:00.000Z'),
        },
      ],
    })

    expect(hold).toMatchObject({
      active: true,
      runName: 'torghut-market-context-news-amd-abcde',
      provider: 'codex-spark',
      error: 'all_provider_attempts_failed',
    })
    expect(hold?.until.toISOString()).toBe('2026-05-07T20:10:00.000Z')
  })

  it('clears provider capacity dispatch hold after a newer successful run', async () => {
    const { resolveProviderCapacityDispatchHoldFromRows } = await import('../torghut-market-context-dispatch')

    const hold = resolveProviderCapacityDispatchHoldFromRows({
      now: new Date('2026-05-07T20:00:00.000Z'),
      fallbackCooldownSeconds: 900,
      rows: [
        {
          requestId: 'request-2',
          runName: 'torghut-market-context-news-nvda-ok',
          provider: 'codex-spark',
          status: 'succeeded',
          error: null,
          metadata: {},
          updatedAt: new Date('2026-05-07T19:58:00.000Z'),
        },
        {
          requestId: 'request-1',
          runName: 'torghut-market-context-news-amd-abcde',
          provider: 'codex-spark',
          status: 'failed',
          error: 'provider_capacity_exhausted',
          metadata: { failureCategory: 'provider_capacity_exhausted' },
          updatedAt: new Date('2026-05-07T19:55:00.000Z'),
        },
      ],
    })

    expect(hold).toBeNull()
  })

  it('suppresses repeated dispatch inside the cooldown window', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'stale',
      activeRun: null,
      dispatchState: {
        lastDispatchedAt: new Date('2026-05-07T19:54:00.000Z'),
        lastRunName: 'torghut-market-context-news-nvda-abcde',
      },
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(false)
    expect(decision.attempted).toBe(true)
    expect(decision.reason).toBe('dispatch_cooldown')
    expect(decision.runName).toBe('torghut-market-context-news-nvda-abcde')
  })
})
