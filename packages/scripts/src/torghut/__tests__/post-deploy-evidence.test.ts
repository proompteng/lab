import { describe, expect, it } from 'bun:test'

import { validatePostDeployEvidence } from '../post-deploy-evidence'

type EvidenceInput = Parameters<typeof validatePostDeployEvidence>[0]

const build = {
  active_revision: 'torghut-00123',
  commit: '1234567890abcdef1234567890abcdef12345678',
  image_digest: `sha256:${'1'.repeat(64)}`,
}

const activeGate = {
  allowed: true,
  blocked_reasons: [],
  execution_route: {
    alpaca_regular_session_open: true,
    reason: 'alpaca_regular_session_open',
    route: 'alpaca',
  },
  reason: 'operational_submission_ready',
  schema_version: 'torghut.operational-submission-gate.v2',
}

const marketClosedGate = {
  ...activeGate,
  allowed: false,
  blocked_reasons: ['mainnet_route_unavailable'],
  execution_route: {
    alpaca_regular_session_open: false,
    reason: 'alpaca_regular_session_closed',
    route: 'closed',
  },
  reason: 'mainnet_route_unavailable',
}

const readyz = (gate: typeof activeGate | typeof marketClosedGate = activeGate) => ({
  build,
  dependencies: {
    alpaca: { ok: true },
    clickhouse: { ok: true },
    database: { ok: true },
    live_submission_gate: { ok: gate.allowed },
    postgres: { ok: true },
    readiness_cache: { cache_used: false },
    tigerbeetle: { ok: true },
    universe: { ok: true },
  },
  live_submission_gate: gate,
  status: gate.allowed ? 'ok' : 'degraded',
})

const tradingStatus = (gate: typeof activeGate | typeof marketClosedGate = activeGate) => ({
  build,
  capital_controls: {
    buying_power_reserve_bps: 1_000,
    daily_loss_limit: 0.01,
    drawdown_limit: 0.05,
    gross_limit: 4,
    net_limit: 0.5,
    symbol_limit: 0.5,
  },
  enabled: true,
  execution: {
    gate: {
      allowed: gate.allowed,
      blocked_reasons: gate.blocked_reasons,
      execution_route: gate.execution_route,
      reason: gate.reason,
    },
    route: gate.execution_route.route,
  },
  live_submission_gate: gate,
  mode: 'live',
  service: 'torghut',
  tigerbeetle_ledger: {
    blockers: [],
    ok: true,
    protocol_ok: true,
    reconciliation_ok: true,
    reconciliation_required: true,
    reconciliation_stale: false,
  },
})

const activeEvidence = (overrides: Partial<EvidenceInput> = {}): EvidenceInput => ({
  apiReadyz: containmentReadyz,
  apiReadyzHttpStatus: '200',
  schedulerReplicas: '1',
  schedulerReadyz: readyz(),
  schedulerReadyzHttpStatus: '200',
  tradingStatus: tradingStatus(),
  tradingStatusHttpStatus: '200',
  ...overrides,
})

const containmentReadyz = {
  process_role: 'api',
  reason_codes: [],
  runtime_owner: 'torghut-scheduler',
  scheduler: {
    availability: 'not_evaluated',
    owner: 'torghut-scheduler',
    ownership: 'external',
  },
  status: 'ok',
}

const containmentStatus = {
  detail: 'scheduler_runtime_unavailable',
  error_class: 'URLError',
  ok: false,
  owner: 'torghut-scheduler',
}

const containmentEvidence = (overrides: Partial<EvidenceInput> = {}): EvidenceInput => ({
  apiReadyz: containmentReadyz,
  apiReadyzHttpStatus: '200',
  schedulerReplicas: '0',
  tradingStatus: containmentStatus,
  tradingStatusHttpStatus: '503',
  ...overrides,
})

describe('Torghut post-deploy evidence', () => {
  it('accepts a healthy active-session runtime', () => {
    const result = validatePostDeployEvidence(activeEvidence())

    expect(result.readinessContract).toBe('active_session_ready')
    expect(result.apiReadyzStatusCode).toBe(200)
    expect(result.schedulerReadyzStatusCode).toBe(200)
    expect(result.summaryLines.join('\n')).toContain('4x gross')
  })

  it('accepts a healthy runtime whose only blocker is a closed regular session', () => {
    const result = validatePostDeployEvidence(
      activeEvidence({
        schedulerReadyz: readyz(marketClosedGate),
        schedulerReadyzHttpStatus: '503',
        tradingStatus: tradingStatus(marketClosedGate),
      }),
    )

    expect(result.readinessContract).toBe('market_closed')
  })

  it('rejects a degraded runtime with any blocker beyond market closure', () => {
    const gate = {
      ...marketClosedGate,
      blocked_reasons: ['mainnet_route_unavailable', 'broker_unavailable'],
    }

    expect(() =>
      validatePostDeployEvidence(
        activeEvidence({
          schedulerReadyz: readyz(gate),
          schedulerReadyzHttpStatus: '503',
          tradingStatus: tradingStatus(gate),
        }),
      ),
    ).toThrow('acceptable only when the regular market session is closed')
  })

  it('rejects disagreement between readiness and status submission authority', () => {
    expect(() =>
      validatePostDeployEvidence(
        activeEvidence({
          tradingStatus: tradingStatus(marketClosedGate),
        }),
      ),
    ).toThrow('contracts differ')
  })

  it('rejects stale ledger reconciliation', () => {
    const status = tradingStatus()
    status.tigerbeetle_ledger.reconciliation_stale = true

    expect(() => validatePostDeployEvidence(activeEvidence({ tradingStatus: status }))).toThrow(
      'ledger reconciliation is not current and healthy',
    )
  })

  it('accepts stale reconciliation diagnostics when periodic reconciliation is optional', () => {
    const status = tradingStatus()
    status.tigerbeetle_ledger.blockers = ['tigerbeetle_reconciliation_stale']
    status.tigerbeetle_ledger.reconciliation_ok = false
    status.tigerbeetle_ledger.reconciliation_required = false
    status.tigerbeetle_ledger.reconciliation_stale = true

    const result = validatePostDeployEvidence(activeEvidence({ tradingStatus: status }))

    expect(result.readinessContract).toBe('active_session_ready')
  })

  it('rejects broken synchronous ledger references when reconciliation is optional', () => {
    const status = tradingStatus()
    status.tigerbeetle_ledger.blockers = ['tigerbeetle_runtime_ledger_signed_refs_missing']
    status.tigerbeetle_ledger.reconciliation_ok = false
    status.tigerbeetle_ledger.reconciliation_required = false

    expect(() => validatePostDeployEvidence(activeEvidence({ tradingStatus: status }))).toThrow(
      'ledger has blockers: tigerbeetle_runtime_ledger_signed_refs_missing',
    )
  })

  it('rejects an unhealthy TigerBeetle protocol when reconciliation is optional', () => {
    const status = tradingStatus()
    status.tigerbeetle_ledger.ok = false
    status.tigerbeetle_ledger.protocol_ok = false
    status.tigerbeetle_ledger.reconciliation_required = false

    expect(() => validatePostDeployEvidence(activeEvidence({ tradingStatus: status }))).toThrow(
      'ledger protocol is not healthy',
    )
  })

  it('rejects a drifted capital limit', () => {
    const status = tradingStatus()
    status.capital_controls.gross_limit = 1

    expect(() => validatePostDeployEvidence(activeEvidence({ tradingStatus: status }))).toThrow(
      'capital_controls.gross_limit must be 4',
    )
  })

  it('rejects an unhealthy core dependency', () => {
    const payload = readyz()
    payload.dependencies.clickhouse.ok = false

    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReadyz: payload }))).toThrow(
      'clickhouse is not healthy',
    )
  })

  it('accepts the exact scheduler-zero API containment contract', () => {
    const result = validatePostDeployEvidence(containmentEvidence())

    expect(result.readinessContract).toBe('api_containment')
    expect(result.summaryLines.join('\n')).toContain('Scheduler replicas: `0`')
  })

  it('rejects a scheduler-zero trading status that is not HTTP 503', () => {
    expect(() => validatePostDeployEvidence(containmentEvidence({ tradingStatusHttpStatus: '200' }))).toThrow(
      'scheduler replicas=0 requires /trading/status HTTP 503, got 200',
    )
  })

  it('rejects a scheduler-zero trading status with the wrong detail', () => {
    expect(() =>
      validatePostDeployEvidence(
        containmentEvidence({
          tradingStatus: { ...containmentStatus, detail: 'scheduler_starting' },
        }),
      ),
    ).toThrow('must report the unavailable torghut-scheduler runtime')
  })

  it('rejects a scheduler-zero trading status with the wrong owner', () => {
    expect(() =>
      validatePostDeployEvidence(
        containmentEvidence({
          tradingStatus: { ...containmentStatus, owner: 'torghut-api' },
        }),
      ),
    ).toThrow('must report the unavailable torghut-scheduler runtime')
  })

  it('rejects a scheduler-zero trading status without the fail-closed marker', () => {
    expect(() =>
      validatePostDeployEvidence(
        containmentEvidence({
          tradingStatus: { ...containmentStatus, ok: true },
        }),
      ),
    ).toThrow('must report the unavailable torghut-scheduler runtime')
  })

  it('rejects non-2xx API readiness in scheduler-zero containment', () => {
    expect(() => validatePostDeployEvidence(containmentEvidence({ apiReadyzHttpStatus: '503' }))).toThrow(
      'stable API /readyz must return HTTP 2xx, got 503',
    )
  })

  it('rejects drift in the scheduler-zero external ownership contract', () => {
    expect(() =>
      validatePostDeployEvidence(
        containmentEvidence({
          apiReadyz: {
            ...containmentReadyz,
            scheduler: { ...containmentReadyz.scheduler, ownership: 'local' },
          },
        }),
      ),
    ).toThrow('scheduler ownership contract is invalid')
  })

  it('requires the exact stable API ownership contract when the scheduler is active', () => {
    expect(() =>
      validatePostDeployEvidence(
        activeEvidence({
          apiReadyz: {
            ...containmentReadyz,
            runtime_owner: 'torghut-api',
          },
        }),
      ),
    ).toThrow('must report the process-local API role and external scheduler owner')
  })

  it('rejects non-2xx stable API readiness when the scheduler is active', () => {
    expect(() => validatePostDeployEvidence(activeEvidence({ apiReadyzHttpStatus: '503' }))).toThrow(
      'stable API /readyz must return HTTP 2xx, got 503',
    )
  })

  it('requires scheduler-owned readiness evidence when the scheduler is active', () => {
    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReadyz: undefined }))).toThrow(
      'Torghut scheduler readyz payload must be an object',
    )
    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReadyzHttpStatus: undefined }))).toThrow(
      'TORGHUT_SCHEDULER_READYZ_HTTP_STATUS must be a three-digit status',
    )
  })

  it('rejects the API-local readiness payload as scheduler-owned evidence', () => {
    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReadyz: containmentReadyz }))).toThrow(
      'scheduler readyz.live_submission_gate must be an object',
    )
  })

  it('rejects an unsupported scheduler readiness HTTP status', () => {
    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReadyzHttpStatus: '500' }))).toThrow(
      'Torghut /readyz returned unsupported HTTP 500',
    )
  })

  it('rejects scheduler replica counts above the single-writer ceiling', () => {
    expect(() => validatePostDeployEvidence(activeEvidence({ schedulerReplicas: '2' }))).toThrow(
      'scheduler replicas must be exactly 0 or 1, got 2',
    )
  })

  it('rejects HTTP 503 trading status when the scheduler is active', () => {
    expect(() =>
      validatePostDeployEvidence(
        activeEvidence({
          tradingStatus: containmentStatus,
          tradingStatusHttpStatus: '503',
        }),
      ),
    ).toThrow('scheduler replicas=1 requires /trading/status HTTP 2xx, got 503')
  })
})
