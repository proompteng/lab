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

  it('dispatches stale snapshots when no active run or cooldown exists', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'stale',
      activeRun: null,
      dispatchState: null,
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(true)
    expect(decision.attempted).toBe(true)
    expect(decision.dispatched).toBe(false)
    expect(decision.reason).toBe('stale_snapshot_refresh')
  })

  it('builds on-demand market-context AgentRuns as repository-bound batch tasks', async () => {
    const { buildMarketContextAgentRun } = await import('../torghut-market-context-dispatch')

    const agentRun = buildMarketContextAgentRun({
      symbol: 'NVDA',
      domain: 'news',
      snapshotState: 'stale',
      provider: 'codex-spark',
      requestId: 'market-context-news-nvda-request',
      now: new Date('2026-05-07T20:00:00.000Z'),
      settings: {
        providerChain: ['codex-spark', 'codex'],
        onDemandDispatchEnabled: true,
        onDemandDispatchCooldownSeconds: 900,
        onDemandDispatchActiveRunSeconds: 3600,
        onDemandDispatchNamespace: 'agents',
        onDemandDispatchServiceAccountName: 'agents-sa',
        onDemandDispatchPriorityClassName: 'torghut-market-context-low',
        onDemandDispatchCallbackUrl: 'http://jangar/api/torghut/market-context',
        onDemandDispatchTtlSeconds: 7200,
        batchTradingStatusUrl: 'http://torghut/trading/status',
        onDemandDispatchRepository: 'proompteng/lab',
        onDemandDispatchBaseBranch: 'main',
        onDemandDispatchHeadBranch: 'main',
        onDemandDispatchVcsRefName: 'github',
      },
    })

    expect(agentRun.spec.vcsRef).toEqual({ name: 'github' })
    expect(agentRun.spec.vcsPolicy).toEqual({ required: true, mode: 'read-only' })
    expect(agentRun.spec.parameters).toMatchObject({
      executionMode: 'batch_task',
      symbol: 'NVDA',
      domain: 'news',
      reason: 'on_demand_stale_snapshot_refresh',
      provider: 'codex-spark',
      callbackUrl: 'http://jangar/api/torghut/market-context',
      requestId: 'market-context-news-nvda-request',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'main',
    })
    expect(agentRun.spec.parameters).not.toHaveProperty('tradingStatusUrl')
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

  it('suppresses repeated dispatch inside the cooldown window', async () => {
    const { resolveMarketContextDispatchDecisionFromRows } = await import('../torghut-market-context-dispatch')

    const decision = resolveMarketContextDispatchDecisionFromRows({
      enabled: true,
      snapshotState: 'stale',
      activeRun: null,
      dispatchState: {
        lastDispatchedAt: new Date('2026-05-07T19:54:00.000Z'),
        lastRunName: 'torghut-market-context-fundamentals-nvda-abcde',
      },
      cooldownSeconds: 900,
      now: new Date('2026-05-07T20:00:00.000Z'),
    })

    expect(decision.shouldDispatch).toBe(false)
    expect(decision.attempted).toBe(true)
    expect(decision.reason).toBe('dispatch_cooldown')
    expect(decision.runName).toBe('torghut-market-context-fundamentals-nvda-abcde')
  })

  it('builds market-context AgentRuns with repository metadata for the provider runner', async () => {
    const { buildMarketContextAgentRun } = await import('../torghut-market-context-dispatch')

    const agentRun = buildMarketContextAgentRun({
      symbol: 'ORCL',
      domain: 'fundamentals',
      snapshotState: 'missing',
      provider: 'codex-spark',
      requestId: 'market-context-fundamentals-orcl-test',
      now: new Date('2026-05-08T00:15:50.336Z'),
      settings: {
        providerChain: ['codex-spark', 'codex'],
        onDemandDispatchEnabled: true,
        onDemandDispatchCooldownSeconds: 900,
        onDemandDispatchActiveRunSeconds: 3600,
        onDemandDispatchNamespace: 'agents',
        onDemandDispatchServiceAccountName: 'agents-sa',
        onDemandDispatchPriorityClassName: 'torghut-market-context-low',
        onDemandDispatchCallbackUrl: 'http://jangar.jangar.svc.cluster.local/api/torghut/market-context',
        onDemandDispatchTtlSeconds: 7200,
        batchTradingStatusUrl: 'http://torghut/trading/status',
        onDemandDispatchRepository: 'proompteng/lab',
        onDemandDispatchBaseBranch: 'main',
        onDemandDispatchHeadBranch: 'main',
        onDemandDispatchVcsRefName: 'github',
      },
    })

    expect(agentRun.spec.vcsRef).toEqual({ name: 'github' })
    expect(agentRun.spec.vcsPolicy).toEqual({ required: true, mode: 'read-only' })
    expect(agentRun.spec.parameters).toMatchObject({
      symbol: 'ORCL',
      domain: 'fundamentals',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'main',
    })
  })
})
