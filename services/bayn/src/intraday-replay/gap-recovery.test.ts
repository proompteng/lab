import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'
import { canonicalHashV1 } from '../hash'
import {
  decideGapRecovery,
  decideGapRecoveryExit,
  GapEndpointKind,
  GapEndpointStatus,
  GapExitAction,
  GapExitReason,
  GapRecoveryDecision,
  gapRecoveryDefinition,
  observeGapRecoveryEndpoint,
  prepareGapRecoverySession,
} from './gap-recovery'
import { gapDecisionMs, gapFixture, gapOpenMs, gapSessionInput } from './gap-recovery.test-support'
import { SixBarResearchStatus } from './six-bar-features'

const run = (f = gapFixture()) =>
  Result.getOrThrow(
    decideGapRecovery(
      Result.getOrThrow(observeGapRecoveryEndpoint(f.previousCursor(), f.session, GapEndpointKind.PreviousClose)),
      Result.getOrThrow(observeGapRecoveryEndpoint(f.openingCursor(), f.session, GapEndpointKind.Opening)),
      f.decisionCursor(),
      f.session,
    ),
  )
const position = {
  symbol: 'AAPL',
  firstFilledAt: new Date(gapDecisionMs + 2_000).toISOString(),
  averageEntryPrice: 100,
  pendingExit: null,
}

describe('original-receipt gap recovery', () => {
  test('broker calendar handles daylight-saving transitions and rejects skipped endpoint roles', () => {
    const calendar = [
      { date: '2026-10-30', open: '09:30', close: '16:00' },
      { date: '2026-11-02', open: '09:30', close: '16:00' },
    ]
    const input = { ...gapSessionInput(), sessionDate: '2026-11-02', calendar, calendarHash: canonicalHashV1(calendar) }
    const session = Result.getOrThrow(prepareGapRecoverySession(input))
    expect(session.priorAtMs).toBe(Date.parse('2026-10-30T19:59:30Z'))
    expect(session.openingAtMs).toBe(Date.parse('2026-11-02T14:30:30Z'))
    expect(session.decisionAtMs).toBe(Date.parse('2026-11-02T15:00:30Z'))
    const duplicate = [...calendar, calendar[1]]
    expect(
      Result.isFailure(
        prepareGapRecoverySession({ ...input, calendar: duplicate, calendarHash: canonicalHashV1(duplicate) }),
      ),
    ).toBeTrue()
  })

  test('zero displayed endpoint size remains an exclusion rather than an entry', () => {
    const f = gapFixture({
      alter: (kind, inputs) =>
        kind === 'prior' ? inputs.map((x) => (x.symbol === 'AAPL' ? { ...x, bidSize: 0 } : x)) : inputs,
    })
    const r = run(f)
    expect(r.selectedSymbol).toBeNull()
    expect(r.status).toBe(GapRecoveryDecision.InputsUnavailable)
    expect(r.endpoints[0]?.quotes.find((x) => x.symbol === 'AAPL')?.status).toBe(GapEndpointStatus.NoSize)
  })

  test('never accepts a producer publication later than its claimed original observation', () => {
    const f = gapFixture({
      alter: (kind, inputs) =>
        kind === 'prior'
          ? inputs.map((x) => (x.symbol === 'AAPL' ? { ...x, ingestedAtMs: x.availableAtMs + 1 } : x))
          : inputs,
    })
    expect(
      Result.isFailure(observeGapRecoveryEndpoint(f.previousCursor(), f.session, GapEndpointKind.PreviousClose)),
    ).toBeTrue()
  })

  test('selects the actual recovery rule and retains a reproducible no-authority report', () => {
    const report = run()
    expect(report.status).toBe(GapRecoveryDecision.Selected)
    expect(report.selectedSymbol).toBe('AAPL')
    expect(report.inputComplete).toBeTrue()
    expect(report.candidates).toHaveLength(15)
    expect(report.capitalAuthority).toBe('NONE')
    expect(report.profitability).toBe('NOT_ESTABLISHED')
    expect(report.qualification).toBe('UNQUALIFIED')
    const { reportHash, ...material } = report
    expect(canonicalHashV1(material)).toBe(reportHash)
    expect(run().reportHash).toBe(reportHash)
    expect(report).not.toHaveProperty('orders')
  })

  test.each([
    [99.5, 99.75, 'AAPL'],
    [99.50000000001, 99.75, null],
    [99, 99.2475, 'AAPL'],
    [99, 99.24749999999, null],
    [99, 100, null],
  ] as const)('exact decimal boundary for opening %s and decision %s', (opening, decision, selected) => {
    expect(run(gapFixture({ prices: { AAPL: [100, opening, decision] } })).selectedSymbol).toBe(selected)
  })

  test('ranks by exact relative overnight gap then symbol, not recovery strength', () => {
    expect(run(gapFixture({ prices: { AAPL: [100, 99, 99.8], AMZN: [200, 197, 197.6] } })).selectedSymbol).toBe('AMZN')
    expect(run(gapFixture({ prices: { AAPL: [100, 99, 99.4], AMZN: [200, 198, 198.8] } })).selectedSymbol).toBe('AAPL')
  })

  test('requires positive benchmark opening return', () => {
    const r = run(gapFixture({ prices: { SPY: [200, 200, 200] } }))
    expect(r.status).toBe(GapRecoveryDecision.MarketFilter)
    expect(r.selectedSymbol).toBeNull()
  })

  test('missing required benchmark endpoints are unavailable rather than no signal', () => {
    const r = run(
      gapFixture({ alter: (kind, inputs) => (kind === 'prior' ? inputs.filter((x) => x.symbol !== 'SPY') : inputs) }),
    )
    expect(r.status).toBe(GapRecoveryDecision.BenchmarkUnavailable)
    expect(r.inputComplete).toBeFalse()
    expect(r.selectedSymbol).toBeNull()
  })

  test.each([200, 200.2])('wide benchmark pricing is unavailable even when its midpoint is %s', (price) => {
    const r = run(
      gapFixture({
        prices: { SPY: [200, 200, price] },
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs.map((x) =>
                x.symbol === 'SPY' && x.channel === 'quotes' && x.eventAtMs === gapDecisionMs - 5_000
                  ? { ...x, bid: price - 0.1, ask: price + 0.1 }
                  : x,
              )
            : inputs,
      }),
    )
    expect(r.inputComplete).toBeFalse()
    expect(r.status).toBe(GapRecoveryDecision.BenchmarkUnavailable)
    expect(r.selectedSymbol).toBeNull()
  })

  test('wide benchmark pricing remains unavailable when candidates are also excluded', () => {
    const r = run(
      gapFixture({
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs
                .filter((x) => !(x.symbol === 'WDC' && x.channel === 'bars'))
                .map((x) =>
                  x.channel === 'quotes' && x.eventAtMs === gapDecisionMs - 5_000 ? { ...x, bid: 99, ask: 101 } : x,
                )
            : inputs,
      }),
    )
    expect(r.candidates.every((c) => !c.eligible)).toBeTrue()
    expect(r.inputComplete).toBeFalse()
    expect(r.status).toBe(GapRecoveryDecision.BenchmarkUnavailable)
    expect(r.selectedSymbol).toBeNull()
  })

  test('a wide candidate quote remains a valid exclusion with a usable benchmark', () => {
    const r = run(
      gapFixture({
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs.map((x) =>
                x.symbol === 'AAPL' && x.channel === 'quotes' && x.eventAtMs === gapDecisionMs - 5_000
                  ? { ...x, bid: 99.2, ask: 99.4 }
                  : x,
              )
            : inputs,
      }),
    )
    expect(r.inputComplete).toBeTrue()
    expect(r.status).toBe(GapRecoveryDecision.NoSignal)
    expect(r.selectedSymbol).toBeNull()
  })

  test.each([20005, 20005.000001])('benchmark spread limit uses the native one-micro price boundary (%s)', (ask) => {
    const r = run(
      gapFixture({
        prices: { SPY: [20000, 19990, 20000] },
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs.map((x) =>
                x.symbol === 'SPY' && x.channel === 'quotes' && x.eventAtMs === gapDecisionMs - 5_000
                  ? { ...x, bid: 19995, ask }
                  : x,
              )
            : inputs,
      }),
    )
    expect(r.inputComplete).toBe(ask === 20005)
    expect(r.status).toBe(ask === 20005 ? GapRecoveryDecision.Selected : GapRecoveryDecision.BenchmarkUnavailable)
  })

  test('excludes a missing candidate while preserving a valid other candidate', () => {
    const r = run(
      gapFixture({
        prices: { AMZN: [100, 99, 99.3] },
        alter: (kind, inputs) => (kind === 'prior' ? inputs.filter((x) => x.symbol !== 'AAPL') : inputs),
      }),
    )
    expect(r.selectedSymbol).toBe('AMZN')
    expect(r.inputComplete).toBeFalse()
    expect(r.endpointExclusions).toContainEqual({ symbol: 'AAPL', endpoints: [GapEndpointKind.PreviousClose] })
  })

  test('does not turn an excluded possible recovery into an observed no-signal', () => {
    const r = run(
      gapFixture({ alter: (kind, inputs) => (kind === 'prior' ? inputs.filter((x) => x.symbol !== 'AAPL') : inputs) }),
    )
    expect(r.status).toBe(GapRecoveryDecision.InputsUnavailable)
    expect(r.selectedSymbol).toBeNull()
  })

  test('native six-bar gaps remain unavailable without borrowing older bars', () => {
    const r = run(
      gapFixture({
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs.filter(
                (x) => !(x.symbol === 'AAPL' && x.channel === 'bars' && x.eventAtMs === gapOpenMs + 25 * 60_000),
              )
            : inputs,
      }),
    )
    expect(r.status).toBe(GapRecoveryDecision.InputsUnavailable)
    expect(r.candidates.find((c) => c.symbol === 'AAPL')?.feature.status).toBe(SixBarResearchStatus.Unavailable)
  })

  test('opening endpoint freshness is inclusive and nanosecond precise', () => {
    for (const [ageNs, status] of [
      [10_000_000_000n, GapEndpointStatus.Available],
      [10_000_000_001n, GapEndpointStatus.Stale],
    ] as const) {
      const at = BigInt(gapOpenMs + 30_000) * 1_000_000n - ageNs
      const date = new Date(Number(at / 1_000_000n)).toISOString().slice(0, 19)
      const text = `${date}.${String(at % 1_000_000_000n).padStart(9, '0')}Z`
      const f = gapFixture({
        alter: (kind, inputs) =>
          kind === 'current'
            ? inputs.map((x) =>
                x.symbol === 'AAPL' && x.channel === 'quotes' && x.eventAtMs < gapDecisionMs - 5_000
                  ? { ...x, eventAtText: text }
                  : x,
              )
            : inputs,
      })
      const endpoint = Result.getOrThrow(
        observeGapRecoveryEndpoint(f.openingCursor(), f.session, GapEndpointKind.Opening),
      )
      expect(endpoint.quotes.find((q) => q.symbol === 'AAPL')?.status).toBe(status)
    }
  })

  test('rejects future cursors, substituted calendars, endpoint roles and source provenance', () => {
    const f = gapFixture()
    expect(
      Result.isFailure(observeGapRecoveryEndpoint(f.decisionCursor(), f.session, GapEndpointKind.Opening)),
    ).toBeTrue()
    expect(
      Result.isFailure(prepareGapRecoverySession({ ...gapSessionInput(), calendarHash: 'f'.repeat(64) })),
    ).toBeTrue()
    const previous = Result.getOrThrow(
      observeGapRecoveryEndpoint(f.previousCursor(), f.session, GapEndpointKind.PreviousClose),
    )
    expect(Result.isFailure(decideGapRecovery(previous, previous, f.decisionCursor(), f.session))).toBeTrue()
    const cursor = f.decisionCursor()
    const { source: _source, ...withoutSource } = cursor
    expect(Result.isFailure(observeGapRecoveryEndpoint(withoutSource, f.session, GapEndpointKind.Decision))).toBeTrue()
  })

  test('property: common positive price scaling leaves the recovery selection unchanged', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (scale) => {
        const report = run(
          gapFixture({
            prices: { AAPL: [100 * scale, 99 * scale, 99.3 * scale], SPY: [200 * scale, 200 * scale, 200.2 * scale] },
          }),
        )
        expect(report.selectedSymbol).toBe('AAPL')
      }),
      { seed: 20261005, numRuns: 20 },
    )
  })
})

describe('gap position lifecycle', () => {
  test.each([100, 99] as const)('rejects a malformed session record before a valid %s exit quote', (bid) => {
    const at = gapDecisionMs + 60_000
    const f = gapFixture({
      additional: [
        {
          availableAtMs: at - 2000,
          eventAtMs: at - 2000,
          channel: 'quotes',
          symbol: 'AAPL',
          bid: -1,
          ask: 100,
          bidSize: 100,
          askSize: 100,
        },
        {
          availableAtMs: at - 1000,
          eventAtMs: at - 1000,
          channel: 'quotes',
          symbol: 'AAPL',
          bid,
          ask: bid,
          bidSize: 100,
          askSize: 100,
        },
      ],
    })
    const cursor = f.cursorAt(at)
    expect([...cursor.projection.rejections.values()].flat().length).toBeGreaterThan(0)
    const result = decideGapRecoveryExit(cursor, f.session, new Date(at).toISOString(), position)
    expect(Result.isFailure(result)).toBeTrue()
    if (Result.isFailure(result)) expect(JSON.stringify(result.failure)).toContain('rejected records')
  })

  test('rejects discarded session rejection evidence before evaluating an otherwise valid exit', () => {
    const at = gapDecisionMs + 60_000
    const f = gapFixture({
      additional: [
        {
          availableAtMs: at - 1000,
          eventAtMs: at - 1000,
          channel: 'quotes',
          symbol: 'AAPL',
          bid: 100,
          ask: 100,
          bidSize: 100,
          askSize: 100,
        },
      ],
    })
    const cursor = f.cursorAt(at)
    const discarded = {
      ...cursor,
      projection: {
        ...cursor.projection,
        discardedRejectionsThroughMs: new Map([[`${gapRecoveryDefinition.sourceTopics.quotes}:0`, gapOpenMs + 60_000]]),
      },
    }
    const result = decideGapRecoveryExit(discarded, f.session, new Date(at).toISOString(), position)
    expect(Result.isFailure(result)).toBeTrue()
    if (Result.isFailure(result)) expect(JSON.stringify(result.failure)).toContain('discarded rejection evidence')
  })

  const observe = (at: number, bid: number, pendingExit: GapExitReason | null = null) => {
    const f = gapFixture({
      additional: [
        {
          availableAtMs: at - 1000,
          channel: 'quotes',
          symbol: 'AAPL',
          eventAtMs: at - 1000,
          bid,
          ask: bid,
          bidSize: 100,
          askSize: 100,
        },
      ],
    })
    return Result.getOrThrow(
      decideGapRecoveryExit(f.cursorAt(at), f.session, new Date(at).toISOString(), { ...position, pendingExit }),
    )
  }
  test('does not impose the abandoned fifteen-minute holding limit', () => {
    expect(observe(gapDecisionMs + 20 * 60_000, 100).action).toBe(GapExitAction.Hold)
  })
  test('stop boundary is inclusive and exits remain latched after price recovery', () => {
    expect(observe(gapDecisionMs + 60_000, 99.5).reason).toBe(GapExitReason.Stop)
    expect(observe(gapDecisionMs + 60_000, 99.50000000001).action).toBe(GapExitAction.Hold)
    expect(observe(gapDecisionMs + 60_000, 102, GapExitReason.Stop).reason).toBe(GapExitReason.Stop)
  })
  test('missing management pricing stays unknown; close still requests reducing exit without inventing pricing', () => {
    const f = gapFixture()
    const missingAt = gapDecisionMs + 60_000
    const missing = Result.getOrThrow(
      decideGapRecoveryExit(f.cursorAt(missingAt), f.session, new Date(missingAt).toISOString(), position),
    )
    expect(missing.action).toBe(GapExitAction.Unavailable)
    const closeAt = f.session.closeMs - gapRecoveryDefinition.flattenBeforeCloseMs
    const close = Result.getOrThrow(
      decideGapRecoveryExit(f.cursorAt(closeAt), f.session, new Date(closeAt).toISOString(), position),
    )
    expect(close.action).toBe(GapExitAction.Exit)
    expect(close.reason).toBe(GapExitReason.Close)
    expect(close.pricingAvailable).toBeFalse()
    const end = Result.getOrThrow(
      decideGapRecoveryExit(
        f.cursorAt(f.session.closeMs),
        f.session,
        new Date(f.session.closeMs).toISOString(),
        position,
      ),
    )
    expect(end.action).toBe(GapExitAction.DeadlinePassed)
  })
  test('half-day close follows supplied exchange calendar rather than hard-coded UTC hours', () => {
    const f = gapFixture({ close: '13:00' })
    expect(f.session.closeMs).toBe(Date.parse('2026-09-04T17:00:00.000Z'))
    const at = f.session.closeMs - 300_000
    expect(
      Result.getOrThrow(decideGapRecoveryExit(f.cursorAt(at), f.session, new Date(at).toISOString(), position)).reason,
    ).toBe(GapExitReason.Close)
  })
  test('rejects invalid position prices, symbols and reversed fill clocks', () => {
    const f = gapFixture()
    for (const p of [
      { ...position, averageEntryPrice: 0 },
      { ...position, symbol: 'SPY' },
      { ...position, firstFilledAt: new Date(gapOpenMs).toISOString() },
    ])
      expect(
        Result.isFailure(
          decideGapRecoveryExit(f.decisionCursor(), f.session, new Date(gapDecisionMs).toISOString(), p),
        ),
      ).toBeTrue()
  })
})
