import { afterEach, describe, expect, it, vi } from 'vitest'

import { __private, listTorghutAutoresearchEpochs } from '../torghut-trading'

const rollingTrendInterval = {
  tz: 'America/New_York',
  startUtc: '2026-01-15T05:00:00.000Z',
  endUtc: '2026-01-16T05:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('torghut trading summary reason parsing', () => {
  it('splits semicolon-delimited risk reasons into individual tokens', () => {
    expect(__private.splitRiskReason('shorts_not_allowed;symbol_capacity_exhausted')).toEqual([
      'shorts_not_allowed',
      'symbol_capacity_exhausted',
    ])
  })

  it('keeps single reasons unchanged', () => {
    expect(__private.splitRiskReason('llm_error')).toEqual(['llm_error'])
  })

  it('classifies normalized broker and policy reasons from atomic tokens', () => {
    expect(
      __private.classifyRejectClass({
        id: '1',
        createdAt: '2026-01-15T14:45:00.000Z',
        alpacaAccountLabel: 'paper',
        symbol: 'AAPL',
        timeframe: '1m',
        status: 'rejected',
        rationale: null,
        riskReasons: [],
        rejectReasonAtomic: ['sell_inventory_unavailable'],
        rejectClass: null,
        rejectOrigin: 'broker_precheck',
        strategyId: '1',
        strategyName: 'test',
      }),
    ).toBe('broker_precheck')
    expect(
      __private.classifyRejectClass({
        id: '2',
        createdAt: '2026-01-15T14:45:00.000Z',
        alpacaAccountLabel: 'paper',
        symbol: 'AAPL',
        timeframe: '1m',
        status: 'rejected',
        rationale: null,
        riskReasons: [],
        rejectReasonAtomic: ['runtime_uncertainty_gate_fail_block_new_entries'],
        rejectClass: null,
        rejectOrigin: 'runtime_uncertainty_gate',
        strategyId: '1',
        strategyName: 'test',
      }),
    ).toBe('policy')
  })

  it('classifies market session by post-open and pre-open rules', () => {
    expect(__private.classifySessionByMarketTime('2026-01-15T13:45:00.000Z', rollingTrendInterval.tz)).toBe('pre-open')
    expect(__private.classifySessionByMarketTime('2026-01-15T14:30:00.000Z', rollingTrendInterval.tz)).toBe('post-open')
    expect(__private.classifySessionByMarketTime('2026-01-15T18:00:00.000Z', rollingTrendInterval.tz)).toBe('post-open')
  })

  it('builds a bounded 5-day rejection trend with per-day session split', () => {
    const trend = __private.buildRolling5DayRejectionTrend(
      [
        {
          id: '1',
          createdAt: '2026-01-11T14:10:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['shorts_not_allowed;llm_error'],
          rejectReasonAtomic: [],
          rejectClass: null,
          rejectOrigin: null,
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '2',
          createdAt: '2026-01-12T14:45:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['qty_below_min'],
          rejectReasonAtomic: [],
          rejectClass: null,
          rejectOrigin: null,
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '3',
          createdAt: '2026-01-10T14:40:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['llm_error'],
          rejectReasonAtomic: [],
          rejectClass: null,
          rejectOrigin: null,
          strategyId: '1',
          strategyName: 'test',
        },
      ],
      rollingTrendInterval,
    )

    expect(trend.byDay).toHaveLength(2)
    expect(trend.byDay[0]).toEqual({
      day: '2026-01-11',
      rejectedCount: 1,
      preOpenCount: 1,
      postOpenCount: 0,
      topReasons: [
        { reason: 'shorts_not_allowed', count: 1 },
        { reason: 'llm_error', count: 1 },
      ],
    })
    expect(trend.byDay[1]).toEqual({
      day: '2026-01-12',
      rejectedCount: 1,
      preOpenCount: 0,
      postOpenCount: 1,
      topReasons: [{ reason: 'qty_below_min', count: 1 }],
    })
  })

  it('summarizes decision lifecycle counts with blocked reasons and stale planned rows', () => {
    const lifecycle = __private.summarizeDecisionLifecycle(
      [
        {
          id: '1',
          createdAt: '2026-01-15T14:20:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'AAPL',
          timeframe: '1m',
          status: 'blocked',
          rationale: null,
          submissionBlockReason: 'capital_stage_shadow',
          submissionBlockAtomic: ['capital_stage_shadow'],
          submissionStage: 'blocked_capital_stage_shadow',
          executionAdapterSelected: false,
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '2',
          createdAt: '2026-01-15T14:21:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'MSFT',
          timeframe: '1m',
          status: 'planned',
          rationale: null,
          submissionBlockReason: null,
          submissionBlockAtomic: [],
          submissionStage: null,
          executionAdapterSelected: false,
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '3',
          createdAt: '2026-01-15T14:22:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'NVDA',
          timeframe: '1m',
          status: 'submitted',
          rationale: null,
          submissionBlockReason: null,
          submissionBlockAtomic: [],
          submissionStage: 'submitted',
          executionAdapterSelected: true,
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '4',
          createdAt: '2026-01-15T14:23:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'META',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          submissionBlockReason: null,
          submissionBlockAtomic: [],
          submissionStage: 'rejected_submit',
          executionAdapterSelected: true,
          strategyId: '1',
          strategyName: 'test',
        },
      ],
      '2026-01-15T14:24:30.000Z',
    )

    expect(lifecycle.plannedCount).toBe(1)
    expect(lifecycle.blockedCount).toBe(1)
    expect(lifecycle.stalePlannedCount).toBe(1)
    expect(lifecycle.executionSubmitAttempts).toBe(2)
    expect(lifecycle.topBlockedReasons).toEqual([{ reason: 'capital_stage_shadow', count: 1 }])
    expect(lifecycle.submissionFunnel).toEqual({
      generatedCount: 4,
      blockedCount: 1,
      submittedCount: 1,
      filledCount: 0,
      rejectedCount: 1,
    })
  })

  it('parses runtime profitability and control-plane summaries from Torghut payloads', () => {
    const profitability = __private.parseRuntimeProfitabilitySummary({
      schema_version: 'torghut.runtime-profitability.v1',
      window: {
        lookback_hours: 72,
        decision_count: 14,
        execution_count: 2,
        tca_sample_count: 2,
      },
      realized_pnl_summary: {
        realized_pnl_proxy_notional: '-3.5',
        avg_abs_slippage_bps: '7.2',
      },
      caveats: [{ code: 'evidence_only_no_profitability_certainty' }],
    })
    const controlPlane = __private.parseRuntimeControlPlaneSummary({
      build: {
        active_revision: 'torghut-00121',
      },
      shadow_first: {
        capital_stage: 'shadow',
        capital_stage_totals: {
          shadow: 3,
        },
        critical_toggle_parity: {
          status: 'aligned',
          mismatches: [],
        },
      },
    })

    expect(profitability).toEqual({
      available: true,
      schemaVersion: 'torghut.runtime-profitability.v1',
      lookbackHours: 72,
      decisionCount: 14,
      executionCount: 2,
      tcaSampleCount: 2,
      realizedPnlProxyNotional: -3.5,
      avgAbsSlippageBps: 7.2,
      caveatCodes: ['evidence_only_no_profitability_certainty'],
      error: null,
    })
    expect(controlPlane).toEqual({
      available: true,
      activeRevision: 'torghut-00121',
      capitalStage: 'shadow',
      capitalStageTotals: [{ stage: 'shadow', count: 3 }],
      criticalToggleParity: {
        status: 'aligned',
        mismatches: [],
      },
      error: null,
    })
  })

  it('proxies and normalizes Torghut autoresearch epoch summaries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          epochs: [
            {
              epoch_id: 'epoch-1',
              status: 'no_profit_target_candidate',
              target_net_pnl_per_day: '500',
              paper_count: 4,
              candidate_spec_count: 8,
              replayed_candidate_count: 3,
              portfolio_candidate_count: 1,
              best_portfolio_net_pnl_per_day: '-0.26',
              best_portfolio_active_day_ratio: '0.4',
              best_portfolio_positive_day_ratio: '0.2',
              blocked_promotion_reasons: ['active_day_ratio_below_oracle'],
              best_portfolio_sleeves: [{ candidate_id: 'cand-1' }],
              started_at: '2026-04-21T16:00:00Z',
              completed_at: '2026-04-21T16:10:00Z',
              failure_reason: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const payload = await listTorghutAutoresearchEpochs({ status: 'no_profit_target_candidate', limit: 5 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://torghut.torghut.svc.cluster.local/trading/autoresearch/epochs?limit=5&status=no_profit_target_candidate',
      { headers: { accept: 'application/json' } },
    )
    expect(payload).toEqual({
      available: true,
      count: 1,
      epochs: [
        {
          epochId: 'epoch-1',
          status: 'no_profit_target_candidate',
          targetNetPnlPerDay: '500',
          paperCount: 4,
          candidateSpecCount: 8,
          replayedCandidateCount: 3,
          portfolioCandidateCount: 1,
          bestPortfolioNetPnlPerDay: '-0.26',
          bestPortfolioActiveDayRatio: '0.4',
          bestPortfolioPositiveDayRatio: '0.2',
          blockedPromotionReasons: ['active_day_ratio_below_oracle'],
          bestPortfolioSleeves: [{ candidate_id: 'cand-1' }],
          startedAt: '2026-04-21T16:00:00Z',
          completedAt: '2026-04-21T16:10:00Z',
          failureReason: null,
        },
      ],
      error: null,
    })
  })
})
