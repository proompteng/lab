import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence } from './chart-evidence'
import { chartAssessments, makeChartDecisionsRequest } from './chart-questions'
import { decodeJevResponse } from './contract'
import { jevEntryEconomics } from './entry-economics'
import { nativeChartInference } from './entry-inference.test-support'
import { EntrySetup, makeEntryProposals } from './entry-proposals'
import { makeEntryJudgmentRequest, selectSupportedEntryProposal } from './entry-questions'
import { defaultJevProtocolDocument } from './protocol'

const fixture = (symbol: 'AAPL' | 'ETH/USD' = 'AAPL') => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      symbol,
      windowEndAt: '2026-10-25T07:00:00.000Z',
      bars: [
        { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
        { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
        { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
        { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
      ],
    }),
  )
  const chartSource = {
    chart,
    protocol: defaultJevProtocolDocument,
    funding: {
      bidMicros: '104000000',
      askMicros: '104020000',
      capitalMicros: '100000000000',
      cryptoFeeTier: null,
    },
  }
  const visual = Result.getOrThrow(makeChartDecisionsRequest(chartSource)).request
  const assessments = Result.getOrThrow(
    chartAssessments(chartSource, nativeChartInference(visual, chart.windowEndAt).response),
  )
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol: defaultJevProtocolDocument,
      symbol: chart.symbol,
      bidMicros: 104_000_000n,
      askMicros: 104_020_000n,
      capitalMicros: '100000000000',
      cryptoFeeTier: null,
    }),
  )
  if (economics === null) throw new Error('Expected test quantity')
  const { proposals } = Result.getOrThrow(
    makeEntryProposals({
      chart,
      assessments,
      economics,
      protocol: defaultJevProtocolDocument,
      bidMicros: 104_000_000n,
    }),
  )
  const input = {
    chart,
    numericalState: {
      candidate: { symbol: chart.symbol, bars1m: chart.bars },
      benchmark: { symbol: 'SPY' },
      relativeSignals: {},
    },
    assessments,
    proposals,
  }
  const prepared = Result.getOrThrow(makeEntryJudgmentRequest(input))
  if (prepared === null) throw new Error('Expected proposal questions')
  const responseFor = (overrides: Readonly<Record<string, number>> = {}) =>
    Result.getOrThrow(
      decodeJevResponse(prepared.request, {
        model: prepared.request.model,
        answers: Object.fromEntries(
          Object.keys(prepared.request.questions).map((name) => [
            name,
            { type: 'noul', noul: overrides[name] ?? (name.endsWith('_target_obstructed') ? 0.1 : 0.9) },
          ]),
        ),
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
    )
  return { input, prepared, responseFor }
}

describe('proposal-specific Jev judgments and code-owned selection', () => {
  test('asks one typed judgment per question with the actual proposal in its instructions', () => {
    const { prepared } = fixture()
    expect(Object.keys(prepared.request.questions)).toEqual([
      'equity_support_recovery_confirmed',
      'equity_support_recovery_stop_invalidates',
      'equity_base_breakout_confirmed',
      'equity_base_breakout_stop_invalidates',
    ])
    expect(prepared.request.state).toMatchObject({
      schemaVersion: 'bayn.jev-entry-state.v23',
    })
    for (const question of Object.values(prepared.request.questions)) {
      expect(question.type).toBe('noul')
      expect(question.instructions).toMatchObject({
        proposal: { entryPriceUsd: 104.22, stopPriceUsd: 96.99, maximumHoldingMinutes: 15 },
      })
    }
  })

  test('does not invoke Jev when there are no funded proposals', () => {
    const { input } = fixture()
    expect(Result.getOrThrow(makeEntryJudgmentRequest({ ...input, proposals: [] }))).toBeNull()
  })

  test('selects a supported breakout while unrelated recovery judgments remain uncertain', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_confirmed: 0.5,
          equity_support_recovery_stop_invalidates: 0.5,
        }),
      }),
    )
    expect(result.selected?.proposal.source.setup).toBe(EntrySetup.BaseBreakout)
    expect(result.rejections).toHaveLength(1)
    expect(result.rejections[0]?.reason).toBe('JUDGMENT_UNCERTAIN')
  })

  test('retains supported recovery when breakout acceptance is rejected', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({ equity_base_breakout_confirmed: 0.1 }),
      }),
    )
    expect(result.selected?.proposal.source.setup).toBe(EntrySetup.SupportRecovery)
    expect(result.rejections[0]?.reason).toBe('SETUP_UNSUPPORTED')
  })

  test('retains the fee-funded crypto objective check and stop invalidation', () => {
    const { input, responseFor, prepared } = fixture('ETH/USD')
    expect(Object.keys(prepared.request.questions)).toEqual([
      'crypto_support_recovery_confirmed',
      'crypto_support_recovery_stop_invalidates',
      'crypto_support_recovery_target_obstructed',
      'crypto_base_breakout_confirmed',
      'crypto_base_breakout_stop_invalidates',
      'crypto_base_breakout_target_obstructed',
    ])
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({
          crypto_support_recovery_target_obstructed: 0.9,
          crypto_base_breakout_stop_invalidates: 0.1,
        }),
      }),
    )
    expect(result.selected).toBeNull()
    expect(result.rejections.map((rejection) => rejection.reason)).toEqual([
      'OBJECTIVE_OBSTRUCTED',
      'INVALIDATION_UNSUPPORTED',
    ])
  })

  test('does not interpret a missing typed answer as a wait or a positive judgment', () => {
    const { input, responseFor } = fixture()
    const response = responseFor()
    const { equity_support_recovery_confirmed: _, ...answers } = response.answers
    expect(
      Result.isFailure(
        selectSupportedEntryProposal({ proposals: input.proposals, response: { ...response, answers } }),
      ),
    ).toBe(true)
  })

  test('funded equity setups do not require an overhead-resistance probability', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_confirmed: 0.8,
          equity_support_recovery_stop_invalidates: 0.75,
          equity_base_breakout_confirmed: 0.1,
        }),
      }),
    )
    expect(result.selected?.proposal.source.setup).toBe(EntrySetup.SupportRecovery)
    expect(result.selected?.judgmentSupport).toBe(0.75)
  })

  test('rejects equity setups with an unsupported stop despite removing the obstruction veto', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_stop_invalidates: 0.1,
          equity_base_breakout_stop_invalidates: 0.1,
        }),
      }),
    )
    expect(result.selected).toBeNull()
    expect(result.rejections.every((rejection) => rejection.reason === 'INVALIDATION_UNSUPPORTED')).toBe(true)
  })

  test('uses deterministic tie-breaking without treating judgment support as profit probability', () => {
    const { input, responseFor } = fixture()
    const first = Result.getOrThrow(
      selectSupportedEntryProposal({ proposals: input.proposals, response: responseFor() }),
    )
    const second = Result.getOrThrow(
      selectSupportedEntryProposal({ proposals: input.proposals.toReversed(), response: responseFor() }),
    )
    expect(first.selected?.proposal.proposalId).toBe(second.selected?.proposal.proposalId)
    expect(first.selected?.judgmentSupport).toBe(0.9)
  })
})
