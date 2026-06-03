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
  paper_route_probe_symbols: ['AAPL', 'AMZN'],
  paper_route_probe_next_session_max_notional: '25',
  dependency_quorum_decision: 'missing',
  continuity_ok: 'false',
  drift_ok: 'false',
  runtime_window_import_health_gate: {
    schema_version: 'torghut.runtime-window-import-health-gate.v1',
    dependency_quorum_decision: 'missing',
    continuity_ok: 'false',
    drift_ok: 'false',
    ready: false,
    blockers: [
      'runtime_window_import_dependency_quorum_missing',
      'runtime_window_import_continuity_missing',
      'runtime_window_import_drift_missing',
    ],
  },
}

const buildPaperRouteEvidence = (targets: Array<Record<string, unknown>>) => ({
  schema_version: 'torghut.paper-route-evidence.v1',
  next_paper_route_runtime_window_targets: {
    schema_version: 'torghut.next-paper-route-runtime-window-targets.v1',
    promotion_allowed: false,
    final_promotion_allowed: false,
    final_promotion_authorized: false,
    target_count: targets.length,
    runtime_window_import_health_gate: {
      schema_version: 'torghut.runtime-window-import-health-gate-summary.v1',
      target_count: targets.length,
      ready_target_count: 0,
      blocked_target_count: targets.length,
      blockers: [],
    },
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

  it('uses raw paper-route targets when source collection is the selected next plan', () => {
    const rawLivePlan = buildPaperRouteEvidence([paperRouteTarget]).next_paper_route_runtime_window_targets
    const rawSimPlan = buildPaperRouteEvidence([
      { ...paperRouteTarget, source_account_label: 'TORGHUT_SIM' },
    ]).next_paper_route_runtime_window_targets
    const selectedSourceCollectionPlan = {
      schema_version: 'torghut.runtime-ledger-paper-probation-import-plan.v1',
      source: 'paper_route_observed_strategy_source_collection',
      promotion_allowed: false,
      final_promotion_allowed: false,
      final_promotion_authorized: false,
      target_count: 1,
      targets: [
        {
          hypothesis_id: 'H-MICRO-01',
          candidate_id: 'candidate-source-collection',
          strategy_name: 'microbar-volume-continuation-long-top2-chip-v1',
          source_kind: 'runtime_ledger_source_collection_candidate',
        },
      ],
    }

    const result = validatePostDeployEvidence({
      readyzHttpStatus: '200',
      readyz: { status: 'ok' },
      revenueRepairDigest: { ...baseDigest, repair_queue: [] },
      tradingStatus: baseTradingStatus,
      paperRouteEvidence: {
        schema_version: 'torghut.paper-route-evidence.v1',
        next_paper_route_runtime_window_targets: selectedSourceCollectionPlan,
        raw_next_paper_route_runtime_window_targets: rawLivePlan,
      },
      simPaperRouteEvidence: {
        schema_version: 'torghut.paper-route-evidence.v1',
        next_paper_route_runtime_window_targets: selectedSourceCollectionPlan,
        raw_next_paper_route_runtime_window_targets: rawSimPlan,
      },
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

  it('rejects a sim paper-route plan with a broader symbol envelope than live', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
        simPaperRouteEvidence: buildPaperRouteEvidence([
          { ...paperRouteTarget, paper_route_probe_symbols: ['AMZN', 'AAPL', 'INTC'] },
        ]),
      }),
    ).toThrow('torghut-sim paper-route target symbols differ from live target')
  })

  it('accepts a sim paper-route plan scoped to a smaller strategy universe', () => {
    const result = validatePostDeployEvidence({
      readyzHttpStatus: '200',
      readyz: { status: 'ok' },
      revenueRepairDigest: { ...baseDigest, repair_queue: [] },
      tradingStatus: baseTradingStatus,
      paperRouteEvidence: buildPaperRouteEvidence([
        { ...paperRouteTarget, paper_route_probe_symbols: ['AAPL', 'AMZN', 'INTC', 'NVDA'] },
      ]),
      simPaperRouteEvidence: buildPaperRouteEvidence([
        {
          ...paperRouteTarget,
          paper_route_probe_symbols: ['AAPL', 'AMZN'],
          paper_route_probe_strategy_scope_applied: true,
          paper_route_probe_scope_authority: 'strategy_universe',
        },
      ]),
    })

    expect(result.summaryLines.join('\n')).toContain('Sim constrained target count: `1`')
  })

  it('rejects a narrower sim paper-route plan without explicit strategy-universe scope', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([
          { ...paperRouteTarget, paper_route_probe_symbols: ['AAPL', 'AMZN', 'INTC'] },
        ]),
        simPaperRouteEvidence: buildPaperRouteEvidence([
          { ...paperRouteTarget, paper_route_probe_symbols: ['AAPL', 'AMZN'] },
        ]),
      }),
    ).toThrow('torghut-sim paper-route target symbols differ from live target')
  })

  it('rejects a sim paper-route plan with a different notional envelope than live', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
        simPaperRouteEvidence: buildPaperRouteEvidence([
          { ...paperRouteTarget, paper_route_probe_next_session_max_notional: '50' },
        ]),
      }),
    ).toThrow('torghut-sim paper-route target notional differs from live target')
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

  it('rejects paper-route targets that omit runtime-window import health gates', () => {
    const target: Record<string, unknown> = { ...paperRouteTarget }
    delete target.runtime_window_import_health_gate
    delete target.dependency_quorum_decision
    delete target.continuity_ok
    delete target.drift_ok

    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([target]),
        simPaperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      }),
    ).toThrow('target 0 missing runtime-window import health gate fields')
  })

  it('rejects paper-route target plans that omit runtime-window health gate summary', () => {
    const paperRouteEvidence = buildPaperRouteEvidence([paperRouteTarget])
    delete (paperRouteEvidence.next_paper_route_runtime_window_targets as Record<string, unknown>)
      .runtime_window_import_health_gate

    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence,
        simPaperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      }),
    ).toThrow('target plan runtime_window_import_health_gate must be an object')
  })

  it('rejects paper-route targets with inconsistent runtime-window health gate envelopes', () => {
    expect(() =>
      validatePostDeployEvidence({
        readyzHttpStatus: '200',
        readyz: { status: 'ok' },
        revenueRepairDigest: { ...baseDigest, repair_queue: [] },
        tradingStatus: baseTradingStatus,
        paperRouteEvidence: buildPaperRouteEvidence([
          {
            ...paperRouteTarget,
            runtime_window_import_health_gate: {
              ...paperRouteTarget.runtime_window_import_health_gate,
              drift_ok: 'true',
            },
          },
        ]),
        simPaperRouteEvidence: buildPaperRouteEvidence([paperRouteTarget]),
      }),
    ).toThrow('target 0 runtime-window health gate drift_ok mismatch')
  })
})
