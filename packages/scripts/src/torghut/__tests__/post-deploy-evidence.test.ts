import { describe, expect, it } from 'bun:test'

import { validatePostDeployEvidence } from '../post-deploy-evidence'

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
    reconciliation_ok: true,
    reconciliation_stale: false,
  },
})

describe('Torghut post-deploy evidence', () => {
  it('accepts a healthy active-session runtime', () => {
    const result = validatePostDeployEvidence({
      readyz: readyz(),
      readyzHttpStatus: '200',
      tradingStatus: tradingStatus(),
    })

    expect(result.readinessContract).toBe('active_session_ready')
    expect(result.summaryLines.join('\n')).toContain('4x gross')
  })

  it('accepts a healthy runtime whose only blocker is a closed regular session', () => {
    const result = validatePostDeployEvidence({
      readyz: readyz(marketClosedGate),
      readyzHttpStatus: '503',
      tradingStatus: tradingStatus(marketClosedGate),
    })

    expect(result.readinessContract).toBe('market_closed')
  })

  it('rejects a degraded runtime with any blocker beyond market closure', () => {
    const gate = {
      ...marketClosedGate,
      blocked_reasons: ['mainnet_route_unavailable', 'broker_unavailable'],
    }

    expect(() =>
      validatePostDeployEvidence({
        readyz: readyz(gate),
        readyzHttpStatus: '503',
        tradingStatus: tradingStatus(gate),
      }),
    ).toThrow('acceptable only when the regular market session is closed')
  })

  it('rejects disagreement between readiness and status submission authority', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyz: readyz(),
        readyzHttpStatus: '200',
        tradingStatus: tradingStatus(marketClosedGate),
      }),
    ).toThrow('contracts differ')
  })

  it('rejects stale ledger reconciliation', () => {
    const status = tradingStatus()
    status.tigerbeetle_ledger.reconciliation_stale = true

    expect(() =>
      validatePostDeployEvidence({ readyz: readyz(), readyzHttpStatus: '200', tradingStatus: status }),
    ).toThrow('ledger reconciliation is not current and healthy')
  })

  it('rejects a drifted capital limit', () => {
    const status = tradingStatus()
    status.capital_controls.gross_limit = 1

    expect(() =>
      validatePostDeployEvidence({ readyz: readyz(), readyzHttpStatus: '200', tradingStatus: status }),
    ).toThrow('capital_controls.gross_limit must be 4')
  })

  it('rejects an unhealthy core dependency', () => {
    const payload = readyz()
    payload.dependencies.clickhouse.ok = false

    expect(() =>
      validatePostDeployEvidence({ readyz: payload, readyzHttpStatus: '200', tradingStatus: tradingStatus() }),
    ).toThrow('clickhouse is not healthy')
  })
})
