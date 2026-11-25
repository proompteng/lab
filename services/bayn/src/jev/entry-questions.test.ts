import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { makeNativeChartEvidence } from './chart-evidence'
import { decodeJevResponse } from './contract'
import { jevEntryEconomics } from './entry-economics'
import { chartAssessmentsFixture } from './entry-inference.test-support'
import { EntrySetup, makeEntryProposals } from './entry-proposals'
import { evaluateSupportedEntryProposals, makeEntryJudgmentRequest } from './entry-questions'
import { selectJevEntryCandidatesFromSupported } from './decision'
import {
  defaultJevProtocolDocument,
  retainedJevProtocolV41Document,
  retainedJevProtocolV42Document,
  type JevProtocolMaterial,
} from './protocol'
import { WebullSession } from '../market-data/webull-contract'
import { webullEntryContextPolicy, type WebullEntryContext } from './webull-entry-context'

const fixture = (
  symbol: 'AAPL' | 'ETH/USD' = 'AAPL',
  latestClose = 104,
  structureHigh = 103,
  webullContext: WebullEntryContext = null,
  protocol: JevProtocolMaterial = defaultJevProtocolDocument,
  resistanceHigh = 113,
) => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      symbol,
      windowEndAt: '2026-10-25T07:00:00.000Z',
      bars: [
        { minuteBeforeWindowEnd: 4, open: 100, high: structureHigh, low: 97, close: 101, volume: 100 },
        { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
        { minuteBeforeWindowEnd: 2, open: 103, high: resistanceHigh, low: 102, close: 104, volume: 100 },
        {
          minuteBeforeWindowEnd: 1,
          open: 104,
          high: 105,
          low: Math.min(103, latestClose),
          close: latestClose,
          volume: 100,
        },
      ],
    }),
  )
  const chartSource = {
    chart,
    protocol,
    funding: {
      bidMicros: '104000000',
      askMicros: '104020000',
      capitalMicros: '100000000000',
      cryptoFeeTier: null,
    },
  }
  const assessments = chartAssessmentsFixture(chartSource)
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      feeAt: '2026-09-04T14:15:00.000Z',
      protocol,
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
      protocol,
      bidMicros: 104_000_000n,
    }),
  )
  const input = {
    chart,
    numericalState: {
      schemaVersion: 'bayn.jev-entry-state.v24',
      webullContext,
      candidate: { symbol: chart.symbol, bars1m: chart.bars },
      benchmark: { symbol: 'SPY' },
      relativeSignals: {},
    },
    assessments,
    proposals,
  }
  const prepared = Result.getOrThrow(
    makeEntryJudgmentRequest({
      ...input,
      includeEquityObstruction:
        protocol.schemaVersion === 'bayn.jev.protocol.v42' ||
        protocol.schemaVersion === 'bayn.jev.protocol.v43' ||
        protocol.schemaVersion === 'bayn.jev.protocol.v44',
    }),
  )
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

describe('proposal-specific Jev structural judgments', () => {
  test('the final Jev body retains independently labeled Webull decimals without changing IEX evidence or proposal terms', () => {
    const context = {
      ...webullEntryContextPolicy,
      symbol: 'AAPL',
      windowStartAt: '2026-10-25T06:59:00.000Z',
      windowEndAt: '2026-10-25T07:00:00.000Z',
      session: WebullSession.Regular,
      open: '103.0000',
      high: '105.0000',
      low: '102.0000',
      close: '104.000000000000000001',
      volume: '12345.00000001',
      receivedAt: '2026-10-25T07:00:01.123456789Z',
      availableAt: '2026-10-25T07:00:01.500Z',
      availabilityLagMs: 1500,
    }
    const actual = fixture('AAPL', 104, 103, context).prepared
    const baseline = fixture().prepared
    const State = Schema.Record(Schema.String, Schema.Json)
    const actualState = Schema.decodeUnknownSync(State)(actual.request.state)
    const baselineState = Schema.decodeUnknownSync(State)(baseline.request.state)
    expect(actualState['webullContext']).toEqual(context)
    expect(actualState['completedSourceBars']).toEqual(baselineState['completedSourceBars'])
    expect(actualState['proposals']).toEqual(baselineState['proposals'])
    expect(actual.requestHash).not.toBe(baseline.requestHash)
    expect(baselineState['webullContext']).toBeNull()
    for (const question of Object.values(actual.request.questions))
      expect(JSON.stringify(question.instructions)).toContain('Use available webullContext')
  })

  test('asks one typed judgment per question with each proposal stored once in shared evidence', () => {
    const { prepared } = fixture('AAPL', 104, 103, null, retainedJevProtocolV41Document, 108)
    expect(Object.keys(prepared.request.questions)).toEqual([
      'equity_support_recovery_confirmed',
      'equity_support_recovery_stop_invalidates',
      'equity_base_breakout_confirmed',
      'equity_base_breakout_stop_invalidates',
    ])
    expect(prepared.request.state).toMatchObject({
      schemaVersion: 'bayn.jev-proposal-evidence.v2',
      proposals: {
        SUPPORT_RECOVERY: { terms: { entryPriceUsd: 104.02, stopPriceUsd: 96.99, maximumHoldingMinutes: 15 } },
      },
    })
    for (const question of Object.values(prepared.request.questions)) {
      expect(question.type).toBe('noul')
      expect(question.instructions).toMatchObject({
        proposalEvidencePath: expect.stringMatching(/^proposals\.(SUPPORT_RECOVERY|BASE_BREAKOUT)$/),
      })
    }
  })

  test('computes breakout price and chronology facts from the selected source bars', () => {
    const { prepared } = fixture('AAPL', 104, 103, null, retainedJevProtocolV41Document, 108)
    expect(prepared.request.state).toMatchObject({
      proposals: {
        BASE_BREAKOUT: {
          calculatedFacts: {
            structureLowUsd: 97,
            structureHighUsd: 103,
            stopIsBelowStructureLow: true,
            entryIsAboveStructureHigh: true,
            completedBarsAfterStructure: 2,
            consecutiveNewestClosesAboveStructure: 2,
            stopTouchedInCompletedBarsAfterStructure: false,
            completedClosesAfterStructure: [
              { closeRelativeToStructure: 'ABOVE' },
              { closeRelativeToStructure: 'ABOVE' },
            ],
          },
        },
      },
    })
    expect(prepared.request.state).not.toHaveProperty('benchmark')
    expect(prepared.request.state).not.toHaveProperty('relativeSignals')
  })

  test('retains a failed completed break and a touched stop as observed facts', () => {
    const { prepared } = fixture('AAPL', 96, 103, null, retainedJevProtocolV41Document, 108)
    expect(prepared.request.state).toMatchObject({
      proposals: {
        BASE_BREAKOUT: {
          calculatedFacts: {
            consecutiveNewestClosesAboveStructure: 0,
            stopTouchedInCompletedBarsAfterStructure: true,
            completedClosesAfterStructure: [
              { closeRelativeToStructure: 'ABOVE' },
              { closeRelativeToStructure: 'BELOW' },
            ],
          },
        },
      },
    })
  })

  test('preserves a sub-micro completed close above the observed structure', () => {
    const { prepared } = fixture('AAPL', 103.0000001, 103, null, retainedJevProtocolV41Document, 108)
    expect(prepared.request.state).toMatchObject({
      proposals: {
        BASE_BREAKOUT: {
          calculatedFacts: {
            consecutiveNewestClosesAboveStructure: 2,
            completedClosesAfterStructure: [
              { closeRelativeToStructure: 'ABOVE' },
              { closeRelativeToStructure: 'ABOVE' },
            ],
          },
        },
      },
    })
  })

  test('does not round a sub-micro structure high below a completed close', () => {
    const { prepared } = fixture('AAPL', 103.0000005, 103.0000009, null, retainedJevProtocolV41Document, 108)
    expect(prepared.request.state).toMatchObject({
      proposals: {
        BASE_BREAKOUT: {
          calculatedFacts: {
            structureHighUsd: 103.0000009,
            consecutiveNewestClosesAboveStructure: 0,
            completedClosesAfterStructure: [
              { closeRelativeToStructure: 'ABOVE' },
              { closeRelativeToStructure: 'INSIDE' },
            ],
          },
        },
      },
    })
  })

  test('does not invoke Jev when there are no funded proposals', () => {
    const { input } = fixture()
    expect(Result.getOrThrow(makeEntryJudgmentRequest({ ...input, proposals: [] }))).toBeNull()
  })

  test('retains a supported breakout while unrelated recovery judgments remain uncertain', () => {
    const { input, responseFor } = fixture('AAPL', 104, 103, null, retainedJevProtocolV41Document, 108)
    const result = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_confirmed: 0.5,
          equity_support_recovery_stop_invalidates: 0.5,
        }),
      }),
    )
    expect(result.supported.map(({ proposal }) => proposal.source.setup)).toEqual([EntrySetup.BaseBreakout])
    expect(result.rejections).toHaveLength(1)
    expect(result.rejections[0]?.reason).toBe('JUDGMENT_UNCERTAIN')
  })

  test('retains supported recovery when breakout acceptance is rejected', () => {
    const { input, responseFor } = fixture('AAPL', 104, 103, null, retainedJevProtocolV41Document, 108)
    const result = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        response: responseFor({ equity_base_breakout_confirmed: 0.1 }),
      }),
    )
    expect(result.supported.map(({ proposal }) => proposal.source.setup)).toEqual([EntrySetup.SupportRecovery])
    expect(result.rejections[0]?.reason).toBe('SETUP_UNSUPPORTED')
  })

  test('retains the fee-funded crypto objective check and stop invalidation', () => {
    const { input, responseFor, prepared } = fixture('ETH/USD', 104, 103, null, retainedJevProtocolV41Document, 108)
    expect(Object.keys(prepared.request.questions)).toEqual([
      'crypto_support_recovery_confirmed',
      'crypto_support_recovery_stop_invalidates',
      'crypto_support_recovery_target_obstructed',
      'crypto_base_breakout_confirmed',
      'crypto_base_breakout_stop_invalidates',
      'crypto_base_breakout_target_obstructed',
    ])
    const result = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        response: responseFor({
          crypto_support_recovery_target_obstructed: 0.9,
          crypto_base_breakout_stop_invalidates: 0.1,
        }),
      }),
    )
    expect(result.supported).toEqual([])
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
        evaluateSupportedEntryProposals({ proposals: input.proposals, response: { ...response, answers } }),
      ),
    ).toBe(true)
  })

  test('funded equity setups do not require an overhead-resistance probability', () => {
    const { input, responseFor } = fixture('AAPL', 104, 103, null, retainedJevProtocolV41Document, 108)
    const result = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_confirmed: 0.8,
          equity_support_recovery_stop_invalidates: 0.75,
          equity_base_breakout_confirmed: 0.1,
        }),
      }),
    )
    expect(result.supported.map(({ proposal }) => proposal.source.setup)).toEqual([EntrySetup.SupportRecovery])
    expect(result.supported[0]?.structuralSupport).toBe(0.75)
  })

  test('v42 symmetric equity entries require overhead-resistance non-obstruction <= 0.30', () => {
    const { input, responseFor, prepared } = fixture('AAPL', 104, 103, null, retainedJevProtocolV42Document, 113)
    expect(Object.keys(prepared.request.questions)).toEqual([
      'equity_support_recovery_confirmed',
      'equity_support_recovery_stop_invalidates',
      'equity_support_recovery_target_obstructed',
    ])
    const admitted = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        protocol: retainedJevProtocolV42Document,
        response: responseFor({
          equity_support_recovery_confirmed: 0.9,
          equity_support_recovery_stop_invalidates: 0.85,
          equity_support_recovery_target_obstructed: 0.3,
        }),
      }),
    )
    expect(admitted.supported).toHaveLength(1)
    expect(admitted.supported[0]?.structuralSupport).toBeCloseTo(0.7, 9)

    const uncertain = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        protocol: retainedJevProtocolV42Document,
        response: responseFor({
          equity_support_recovery_confirmed: 0.9,
          equity_support_recovery_stop_invalidates: 0.85,
          equity_support_recovery_target_obstructed: 0.31,
        }),
      }),
    )
    expect(uncertain.supported).toEqual([])
    expect(uncertain.rejections[0]?.reason).toBe('JUDGMENT_UNCERTAIN')

    const obstructed = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        protocol: retainedJevProtocolV42Document,
        response: responseFor({
          equity_support_recovery_confirmed: 0.9,
          equity_support_recovery_stop_invalidates: 0.85,
          equity_support_recovery_target_obstructed: 0.7,
        }),
      }),
    )
    expect(obstructed.supported).toEqual([])
    expect(obstructed.rejections[0]?.reason).toBe('OBJECTIVE_OBSTRUCTED')
  })

  test('rejects equity setups with an unsupported stop despite removing the obstruction veto', () => {
    const { input, responseFor } = fixture()
    const result = Result.getOrThrow(
      evaluateSupportedEntryProposals({
        proposals: input.proposals,
        response: responseFor({
          equity_support_recovery_stop_invalidates: 0.1,
          equity_base_breakout_stop_invalidates: 0.1,
        }),
      }),
    )
    expect(result.supported).toEqual([])
    expect(result.rejections.every((rejection) => rejection.reason === 'INVALIDATION_UNSUPPORTED')).toBe(true)
  })

  test('retains every structurally supported proposal without ranking it as expected profit', () => {
    const { input, responseFor } = fixture()
    const first = Result.getOrThrow(
      evaluateSupportedEntryProposals({ proposals: input.proposals, response: responseFor() }),
    )
    const second = Result.getOrThrow(
      evaluateSupportedEntryProposals({ proposals: input.proposals.toReversed(), response: responseFor() }),
    )
    expect(first.supported.map(({ proposal }) => proposal.proposalId)).toEqual(
      second.supported.map(({ proposal }) => proposal.proposalId).toReversed(),
    )
    expect(first.supported.every(({ structuralSupport }) => structuralSupport === 0.9)).toBe(true)
  })

  test('v42 ranks supported candidates by exact BigInt modeled EV per risk rather than raw support alone', () => {
    const highSupportLowRr = {
      symbol: 'AAPL',
      proposalId: 'a'.repeat(64),
      structuralSupport: 0.9,
      modeledGainMicros: 100_000_000n,
      modeledLossMicros: 100_000_000n,
    }
    const higherEvPerRisk = {
      symbol: 'NVDA',
      proposalId: 'b'.repeat(64),
      structuralSupport: 0.75,
      modeledGainMicros: 300_000_000n,
      modeledLossMicros: 100_000_000n,
    }
    expect(
      selectJevEntryCandidatesFromSupported([highSupportLowRr, higherEvPerRisk], 1, false).map(
        (candidate) => candidate.symbol,
      ),
    ).toEqual(['AAPL'])
    expect(
      selectJevEntryCandidatesFromSupported([highSupportLowRr, higherEvPerRisk], 2, true).map(
        (candidate) => candidate.symbol,
      ),
    ).toEqual(['NVDA', 'AAPL'])
    expect(
      selectJevEntryCandidatesFromSupported(
        [
          { ...higherEvPerRisk, structuralSupport: 0.8 },
          { ...highSupportLowRr, structuralSupport: 0.8, modeledGainMicros: 200_000_000n },
        ],
        2,
        true,
      ).map((candidate) => candidate.symbol),
    ).toEqual(['NVDA', 'AAPL'])
  })
})
