import { describe, expect, it } from 'bun:test'

import { validatePostDeployEvidence } from '../post-deploy-evidence'

const baseRouteBoard = {
  schema_version: 'torghut.route-reacquisition-board.v1',
  state: 'repair_only',
  capital_state: 'zero_notional',
  rows: [{ symbol: 'AAPL' }],
  summary: {
    row_count: 1,
    zero_notional_row_count: 1,
    capital_eligible_symbol_count: 0,
    expected_unblock_value: 2,
    state_counts: { probing: 1 },
    top_repair_symbols: ['AAPL'],
  },
}

const baseTradingStatus = {
  route_reacquisition_board: baseRouteBoard,
}

const paperRouteTarget = {
  hypothesis_id: 'H-PAIRS-01',
  candidate_id: 'candidate-paper-route',
  strategy_name: 'paper-route-candidate-v1',
  window_start: '2026-05-26T13:30:00+00:00',
  window_end: '2026-05-26T20:00:00+00:00',
}

const buildPaperRouteEvidence = (targets: Array<Record<string, unknown>>) => ({
  schema_version: 'torghut.paper-route-evidence.v1',
  next_paper_route_runtime_window_targets: {
    schema_version: 'torghut.next-paper-route-runtime-window-targets.v1',
    promotion_allowed: false,
    final_promotion_allowed: false,
    final_promotion_authorized: false,
    target_count: targets.length,
    targets,
  },
})

const baseDigest = {
  business_state: 'repair_only',
  revenue_ready: false,
  repair_queue: [{ code: 'repair_signal_freshness', reason: 'signal_lag_exceeded', dimension: 'signal_continuity' }],
  blockers: [{ reason: 'simple_submit_disabled' }],
  capital: {
    live_submission_allowed: false,
    capital_state: 'zero_notional',
    max_notional: '0',
  },
  health: {
    readyz_status: 'degraded',
    readyz_ok: false,
    dependency_failures: [
      { name: 'live_submission_gate', detail: 'simple_submit_disabled' },
      { name: 'profitability_proof_floor', detail: 'repair_only' },
    ],
  },
}

const baseReadyz = {
  status: 'degraded',
  scheduler: { ok: true, running: true },
  dependencies: {
    postgres: { ok: true },
    clickhouse: { ok: true },
    database: { ok: true },
    live_submission_gate: { ok: false, detail: 'simple_submit_disabled' },
    profitability_proof_floor: { ok: false, detail: 'repair_only', capital_state: 'zero_notional' },
  },
}

describe('validatePostDeployEvidence', () => {
  it('accepts normal 2xx readyz with route board evidence', () => {
    const result = validatePostDeployEvidence({
      readyzHttpStatus: '200',
      readyz: { status: 'ok' },
      revenueRepairDigest: { ...baseDigest, repair_queue: [] },
      tradingStatus: baseTradingStatus,
    })

    expect(result.readyzAcceptedReason).toBe('healthy_2xx')
  })

  it('accepts repair-only zero-notional readyz 503 without treating it as a rollout failure', () => {
    const result = validatePostDeployEvidence({
      readyzHttpStatus: '503',
      readyz: baseReadyz,
      revenueRepairDigest: baseDigest,
      tradingStatus: baseTradingStatus,
    })

    expect(result.readyzAcceptedReason).toBe('repair_only_zero_notional')
    expect(result.summaryLines.join('\n')).toContain('Readyz acceptance: `repair_only_zero_notional`')
  })

  it('rejects repair-only 503 when runtime dependencies are down', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '503',
        readyz: {
          ...baseReadyz,
          dependencies: {
            ...baseReadyz.dependencies,
            postgres: { ok: false, detail: 'down' },
          },
        },
        revenueRepairDigest: baseDigest,
        tradingStatus: baseTradingStatus,
      }),
    ).toThrow('readyz dependencies.postgres.ok must be true')
  })

  it('rejects repair-only 503 when capital is not clamped to zero', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '503',
        readyz: baseReadyz,
        revenueRepairDigest: {
          ...baseDigest,
          capital: {
            ...baseDigest.capital,
            max_notional: '100',
          },
        },
        tradingStatus: baseTradingStatus,
      }),
    ).toThrow('max_notional=0')
  })

  it('accepts matching live and sim paper-route target plans', () => {
    const result = validatePostDeployEvidence({
      readyzHttpStatus: '200',
      readyz: { status: 'ok' },
      revenueRepairDigest: { ...baseDigest, repair_queue: [] },
      tradingStatus: baseTradingStatus,
      paperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      simPaperRouteEvidence: buildPaperRouteEvidence([{ ...paperRouteTarget, source_account_label: 'TORGHUT_SIM' }]),
    })

    expect(result.summaryLines.join('\n')).toContain('Torghut Paper Route Target Mirror')
    expect(result.summaryLines.join('\n')).toContain('Live target count: `1`')
    expect(result.summaryLines.join('\n')).toContain('Sim target count: `1`')
  })

  it('rejects an empty sim paper-route plan when live torghut exposes a target', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
        simPaperRouteEvidence: buildPaperRouteEvidence([]),
      }),
    ).toThrow('torghut-sim paper-route target plan is empty while live torghut exposes targets')
  })

  it('rejects a sim paper-route plan missing the live target identity', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
        simPaperRouteEvidence: buildPaperRouteEvidence([{ ...paperRouteTarget, candidate_id: 'other-candidate' }]),
      }),
    ).toThrow('torghut-sim paper-route target plan missing live target')
  })

  it('rejects paper-route target plans that accidentally authorize promotion', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: {
          ...buildPaperRouteEvidence([paperRouteTarget]),
          next_paper_route_runtime_window_targets: {
            ...buildPaperRouteEvidence([paperRouteTarget]).next_paper_route_runtime_window_targets,
            final_promotion_authorized: true,
          },
        },
        simPaperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      }),
    ).toThrow('final_promotion_authorized must not be true')
  })

  it('rejects paper-route targets that accidentally authorize promotion', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([{ ...paperRouteTarget, promotion_allowed: true }]),
        simPaperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      }),
    ).toThrow('target 0 promotion_allowed must not be true')
  })
})
