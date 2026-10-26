import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence } from './chart-evidence'
import { chartAssessments, makeChartDecisionsRequest } from './chart-questions'
import { decodeJevResponse } from './contract'
import { jevEntryEconomics } from './entry-economics'
import { EntrySetup, makeEntryProposals } from './entry-proposals'
import { makeEntryJudgmentRequest, selectSupportedEntryProposal } from './entry-questions'
import { defaultJevProtocolDocument } from './protocol'

const fixture = () => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      symbol: 'AAPL',
      windowEndAt: '2026-10-25T07:00:00.000Z',
      bars: [
        { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
        { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
        { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
        { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
      ],
    }),
  )
  const visual = Result.getOrThrow(makeChartDecisionsRequest(chart)).request
  const anchors: Readonly<Record<string, number>> = {
    support_anchor: 0,
    resistance_anchor: 2,
    base_first_bar: 0,
    base_last_bar: 1,
  }
  const assessments = Result.getOrThrow(
    chartAssessments(chart, {
      model: visual.model,
      answers: visual.questions.map((question) =>
        question.type === 'predicate'
          ? { type: 'predicate', name: question.name, probability: 0.8 }
          : {
              type: 'choice',
              name: question.name,
              choice: question.choices[anchors[question.name] ?? 0]?.value,
              confidence: 0.8,
              probabilities: question.choices.map((choice, index) => ({
                value: choice.value,
                probability: index === anchors[question.name] ? 1 : 0,
              })),
            },
      ),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        total_tokens: 100,
      },
    }),
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
      'support_recovery_confirmed',
      'support_recovery_stop_invalidates',
      'support_recovery_target_obstructed',
      'base_breakout_confirmed',
      'base_breakout_stop_invalidates',
      'base_breakout_target_obstructed',
    ])
    expect(prepared.request.state).toMatchObject({
      schemaVersion: 'bayn.jev-entry-state.v22',
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
        response: responseFor({ support_recovery_confirmed: 0.5, support_recovery_stop_invalidates: 0.5 }),
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
        response: responseFor({ base_breakout_confirmed: 0.1 }),
      }),
    )
    expect(result.selected?.proposal.source.setup).toBe(EntrySetup.SupportRecovery)
    expect(result.rejections[0]?.reason).toBe('SETUP_UNSUPPORTED')
  })

  test('returns no selection when the actual objective is obstructed or invalidation is unsupported', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      selectSupportedEntryProposal({
        proposals: input.proposals,
        response: responseFor({ support_recovery_target_obstructed: 0.9, base_breakout_stop_invalidates: 0.1 }),
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
    const { support_recovery_confirmed: _, ...answers } = response.answers
    expect(
      Result.isFailure(
        selectSupportedEntryProposal({ proposals: input.proposals, response: { ...response, answers } }),
      ),
    ).toBe(true)
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
