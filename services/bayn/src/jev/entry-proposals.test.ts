import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import { chartAssessments, makeChartDecisionsRequest } from './chart-questions'
import { jevEntryEconomics } from './entry-economics'
import { EntrySetup, makeEntryProposals, ProposalRejection } from './entry-proposals'
import { defaultJevProtocolDocument } from './protocol'

const source = {
  symbol: 'AAPL',
  windowEndAt: '2026-10-25T07:00:00.000Z',
  bars: [
    { minuteBeforeWindowEnd: 6, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 5, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 4, open: 100, high: 102, low: 99, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ],
}
const fixture = (input = source) => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(input))
  const request = Result.getOrThrow(makeChartDecisionsRequest(chart)).request
  const anchors: Readonly<Record<string, number>> = {
    support_anchor: 0,
    resistance_anchor: 4,
    base_first_bar: 0,
    base_last_bar: 3,
  }
  const assessments = Result.getOrThrow(
    chartAssessments(chart, {
      model: 'gpt-6-luna',
      answers: request.questions.map((question) =>
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
  if (economics === null) throw new Error('Expected funded test quantity')
  return { chart, assessments, economics, protocol: defaultJevProtocolDocument, bidMicros: 104_000_000n }
}

describe('source-anchored complete entry proposals', () => {
  test('constructs recovery and breakout plans from selected real anchors with conservative funding', () => {
    const input = fixture()
    const { proposals, rejections } = Result.getOrThrow(makeEntryProposals(input))
    expect(rejections).toEqual([])
    expect(proposals).toHaveLength(2)
    const recovery = proposals.find((proposal) => proposal.source.setup === EntrySetup.SupportRecovery)
    const breakout = proposals.find((proposal) => proposal.source.setup === EntrySetup.BaseBreakout)
    expect(recovery?.profitLimitPriceMicros).toBe('107990000')
    expect(breakout?.profitLimitPriceMicros).toBe('109000000')
    for (const proposal of proposals) {
      expect(proposal.stopPriceMicros).toBe('96990000')
      expect(proposal.maximumHoldingMinutes).toBe(15)
      expect(proposal.funding.maximumTargetWeight).toBe(input.economics.maximumTargetWeight)
      expect(BigInt(proposal.funding.estimatedStopNetMicros)).toBeLessThan(
        BigInt(proposal.funding.acquisitionCostMicros),
      )
      expect(BigInt(proposal.funding.estimatedTargetNetMicros)).toBeGreaterThan(
        BigInt(proposal.funding.acquisitionCostMicros),
      )
      const { proposalId, ...material } = proposal
      expect(proposalId).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
    }
    expect(breakout?.source.targetBasis).toBe('PROJECTED_MEASURED_BASE_RANGE')
    expect(recovery?.source.targetBasis).toBe('OBSERVED_RESISTANCE')
  })

  test('does not require a breakout judgment to construct a recovery proposal', () => {
    const input = fixture()
    const refused = { status: 'REFUSED' } as const
    const result = Result.getOrThrow(
      makeEntryProposals({
        ...input,
        assessments: { ...input.assessments, base: { presence: refused, first: refused, last: refused } },
      }),
    )
    expect(result.proposals.map((proposal) => proposal.source.setup)).toEqual([EntrySetup.SupportRecovery])
    expect(result.rejections).toEqual([{ setup: EntrySetup.BaseBreakout, reason: ProposalRejection.ChartRefused }])
  })

  test('does not require an observed overhead resistance to construct a breakout projection', () => {
    const input = fixture()
    const refused = { status: 'REFUSED' } as const
    const result = Result.getOrThrow(
      makeEntryProposals({
        ...input,
        assessments: { ...input.assessments, resistance: { presence: refused, anchor: refused } },
      }),
    )
    expect(result.proposals.map((proposal) => proposal.source.setup)).toEqual([EntrySetup.BaseBreakout])
  })

  test('rejects an incoherent consolidation and a quote that has not broken its high', () => {
    const input = fixture()
    const sameBar = { ...input.assessments, base: { ...input.assessments.base, last: input.assessments.base.first } }
    for (const changed of [
      { ...input, assessments: sameBar },
      { ...input, bidMicros: 103_000_000n },
    ]) {
      const result = Result.getOrThrow(makeEntryProposals(changed))
      expect(result.rejections).toContainEqual({
        setup: EntrySetup.BaseBreakout,
        reason: ProposalRejection.IncoherentStructure,
      })
      expect(result.proposals.some((proposal) => proposal.source.setup === EntrySetup.BaseBreakout)).toBe(false)
    }
  })

  test('rejects a crypto target that is above entry but fails after fees', () => {
    const input = fixture({
      ...source,
      symbol: 'ETH/USD',
      bars: source.bars.map((bar, index) => (index === 4 ? { ...bar, high: 104.5 } : bar)),
    })
    const result = Result.getOrThrow(makeEntryProposals(input))
    expect(result.proposals.some((proposal) => proposal.source.setup === EntrySetup.SupportRecovery)).toBe(false)
    expect(result.rejections).toContainEqual({ setup: EntrySetup.SupportRecovery, reason: ProposalRejection.Unfunded })
  })

  test('refuses foreign anchor identifiers and mismatched source hashes', () => {
    const input = fixture()
    for (const assessments of [
      { ...input.assessments, barsHash: 'f'.repeat(64) },
      {
        ...input.assessments,
        support: {
          ...input.assessments.support,
          anchor: { status: 'SOURCE_SINGLETON', barId: 'invented_bar' } as const,
        },
      },
    ])
      expect(Result.isFailure(makeEntryProposals({ ...input, assessments }))).toBe(true)
  })

  test('uses conservative source-price rounding without changing provider bar precision', () => {
    const input = fixture({
      ...source,
      bars: source.bars.map((bar, index) => (index === 0 ? { ...bar, low: 97.00000000000001 } : bar)),
    })
    const result = Result.getOrThrow(makeEntryProposals(input))
    expect(result.proposals[0]?.stopPriceMicros).toBe('96990000')
    expect(input.chart.bars[0]?.low).toBe(97.00000000000001)
  })
})
