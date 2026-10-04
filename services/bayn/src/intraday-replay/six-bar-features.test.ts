import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { defaultJevProtocolDocument } from '../jev/protocol'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import { selectStreamingInputs } from '../market-data/streaming/inputs'
import { checkProperty } from '../testing/property-test-support'
import { extractSixBarResearchObservation, SixBarResearchStatus, SixBarUnavailableReason } from './six-bar-features'
import {
  replaySixBarFixture,
  sixBarEndMs,
  sixBarFixture,
  sixBarFixtureInputs,
  sixBarObservedMs,
  sixBarOpenMs,
  type SixBarFixtureInput,
} from './six-bar-features.test-support'

const expected = [0.009615384615384616, 0.04, 0.01, 0.021821702364157987, 1.9047619047619047, 0.5, 0.01547008547008547]
const observe = (inputs = sixBarFixtureInputs(), at = sixBarObservedMs, close = '16:00') => {
  const fixture = sixBarFixture(inputs, close)
  return extractSixBarResearchObservation(replaySixBarFixture(fixture, at), {
    ...fixture.query,
    observedAt: new Date(at).toISOString(),
  })
}
const available = (inputs = sixBarFixtureInputs(), at = sixBarObservedMs, close = '16:00') => {
  const observation = Result.getOrThrow(observe(inputs, at, close))
  expect(observation.status).toBe(SixBarResearchStatus.Available)
  if (observation.status !== SixBarResearchStatus.Available) throw new Error('Expected available six-bar observation')
  return observation
}
const change = (predicate: (input: SixBarFixtureInput) => boolean, update: Partial<SixBarFixtureInput>) =>
  sixBarFixtureInputs().map((input) => (predicate(input) ? { ...input, ...update } : input))
const quote = (symbol: string) => (input: SixBarFixtureInput) => input.channel === 'quotes' && input.symbol === symbol
const trade = (symbol: string) => (input: SixBarFixtureInput) => input.channel === 'trades' && input.symbol === symbol

describe('six-bar research observation', () => {
  test('derives seven literal features at the first causal observation without a rolling feature', () => {
    const observation = available()
    observation.values.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 10))
    expect(observation).toMatchObject({
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      candidateSymbol: 'AAPL',
    })
    expect(observation.receipts).toHaveLength(16)
    expect(observation.receipts.filter((receipt) => receipt.eventAt < '2026-09-04T13:36:00')).toHaveLength(12)
    expect(observation.receipts.every((receipt) => receipt.availableAtMs <= sixBarObservedMs)).toBe(true)
    expect(observation.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test.each(['AAPL', 'SPY'])('missing interior %s minute remains unavailable without imputation', (symbol) => {
    const inputs = sixBarFixtureInputs().filter(
      (input) => !(input.channel === 'bars' && input.symbol === symbol && input.eventAtMs === sixBarOpenMs + 120_000),
    )
    inputs.push({
      channel: 'bars',
      symbol,
      eventAtMs: sixBarOpenMs - 60_000,
      availableAtMs: sixBarOpenMs + 1_000,
      close: 100,
    })
    expect(Result.getOrThrow(observe(inputs))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'six-contiguous-bars-unavailable',
      symbol,
      missingBarInstants: ['2026-09-04T13:32:00.000Z'],
    })
  })

  test('five bars and absent SPY are explicit unavailable observations', () => {
    const five = sixBarFixtureInputs().filter(
      (input) => input.channel !== 'bars' || input.eventAtMs !== sixBarEndMs - 60_000,
    )
    expect(Result.getOrThrow(observe(five))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Bars,
      missingBarInstants: ['2026-09-04T13:35:00.000Z'],
    })
    expect(Result.getOrThrow(observe(sixBarFixtureInputs().filter((input) => input.symbol !== 'SPY')))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Bars,
      symbol: 'SPY',
    })
  })

  test('a late sixth receipt cannot be backdated into the observation', () => {
    const inputs = change(
      (input) => input.channel === 'bars' && input.symbol === 'AAPL' && input.eventAtMs === sixBarEndMs - 60_000,
      { availableAtMs: sixBarObservedMs + 1 },
    )
    expect(Result.getOrThrow(observe(inputs))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Bars,
      symbol: 'AAPL',
    })
    expect(available(inputs, sixBarObservedMs + 1).values.slice(0, 6)).toEqual(available().values.slice(0, 6))
  })

  test('a completed bar cannot claim original availability before its producer publication', () => {
    const inputs = change(
      (input) => input.channel === 'bars' && input.symbol === 'AAPL' && input.eventAtMs === sixBarEndMs - 60_000,
      { availableAtMs: sixBarEndMs - 1, ingestedAtMs: sixBarEndMs },
    )
    expect(observe(inputs)).toMatchObject({
      _tag: 'Failure',
      failure: {
        cause: { message: 'Selected record precedes its producer publication under the zero-skew research contract' },
      },
    })
  })

  test('the watermark boundary rejects one millisecond early', () => {
    expect(observe(undefined, sixBarObservedMs - 1)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SixBarResearchFailure', cause: { reason: 'request' } },
    })
    expect(available().query.observedAt).toBe('2026-09-04T13:36:02.000Z')
  })

  test('an observed changed correction changes features only after its original receipt', () => {
    const inputs = [
      ...sixBarFixtureInputs(),
      {
        channel: 'updatedBars' as const,
        symbol: 'AAPL',
        eventAtMs: sixBarEndMs - 60_000,
        availableAtMs: sixBarObservedMs + 1_000,
        close: 110,
      },
    ]
    expect(available(inputs).values).toEqual(available().values)
    const later = available(inputs, sixBarObservedMs + 1_000)
    expect(later.values[0]).toBeCloseTo(0.057692307692307696, 12)
    expect(later.values[1]).toBeCloseTo(0.09, 12)
    expect(later.receipts.find((receipt) => receipt.projectionSequence === 17)?.availableAtMs).toBe(
      sixBarObservedMs + 1_000,
    )
  })

  test('a late identical revision retains the original timely publication witness', () => {
    const at = sixBarEndMs + 30_000
    const inputs = sixBarFixtureInputs().map((input) =>
      input.channel === 'quotes' || input.channel === 'trades' ? { ...input, eventAtMs: at, availableAtMs: at } : input,
    )
    inputs.push({ channel: 'bars', symbol: 'AAPL', eventAtMs: sixBarEndMs - 60_000, availableAtMs: at, close: 105 })
    const observation = available(inputs, at)
    expect(observation.values.slice(0, 6)).toEqual(available().values.slice(0, 6))
    expect(
      observation.receipts
        .filter((receipt) => receipt.symbol === 'AAPL' && receipt.eventAt === '2026-09-04T13:35:00.000000000Z')
        .map((receipt) => receipt.availableAtMs),
    ).toEqual([at, sixBarEndMs + 1_000])
    expect(
      Result.getOrThrow(
        observe(
          inputs.filter(
            (input) =>
              !(
                input.channel === 'bars' &&
                input.symbol === 'AAPL' &&
                input.eventAtMs === sixBarEndMs - 60_000 &&
                input.availableAtMs < at
              ),
          ),
          at,
        ),
      ),
    ).toMatchObject({ status: 'UNAVAILABLE', reason: SixBarUnavailableReason.Freshness })
  })

  test.each(['AAPL', 'SPY'])('%s missing quote or trade remains unavailable', (symbol) => {
    expect(Result.getOrThrow(observe(sixBarFixtureInputs().filter((input) => !quote(symbol)(input))))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Quote,
      symbol,
    })
    expect(Result.getOrThrow(observe(sixBarFixtureInputs().filter((input) => !trade(symbol)(input))))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Trade,
      symbol,
    })
  })

  test.each(['AAPL', 'SPY'])('%s quote is stale at 10 seconds plus one nanosecond', (symbol) => {
    const at = sixBarObservedMs + 20_000
    const inputs = change(quote(symbol), {
      eventAtMs: at - 10_001,
      eventAtText: '2026-09-04T13:36:11.999999999Z',
      availableAtMs: at - 10_000,
      ingestedAtMs: at - 10_000,
    }).map((input) =>
      input.channel === 'quotes' && input.symbol !== symbol
        ? { ...input, eventAtMs: at, availableAtMs: at }
        : input.channel === 'trades'
          ? { ...input, eventAtMs: at, availableAtMs: at }
          : input,
    )
    expect(Result.getOrThrow(observe(inputs, at))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Quote,
      message: 'stale-arrival-quote',
      symbol,
    })
  })

  test('the exact ten-second quote-age boundary is admitted', () => {
    const at = sixBarObservedMs + 20_000
    const inputs = sixBarFixtureInputs().map((input) =>
      input.channel === 'quotes' || input.channel === 'trades'
        ? { ...input, eventAtMs: at - 10_000, availableAtMs: at - 10_000 }
        : input,
    )
    expect(available(inputs, at).values.slice(0, 6)).toEqual(available().values.slice(0, 6))
  })

  test('a future quote at one nanosecond and a future trade fail strict zero-skew validation', () => {
    const futureQuote = change(quote('AAPL'), {
      eventAtMs: sixBarObservedMs,
      eventAtText: '2026-09-04T13:36:02.000000001Z',
      availableAtMs: sixBarObservedMs,
      ingestedAtMs: sixBarObservedMs,
    })
    expect(observe(futureQuote)).toMatchObject({ _tag: 'Failure', failure: { cause: { reason: 'ordering' } } })
    expect(
      observe(
        change(trade('AAPL'), {
          eventAtMs: sixBarObservedMs + 1,
          availableAtMs: sixBarObservedMs,
          ingestedAtMs: sixBarObservedMs + 1,
        }),
      ),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        cause: { message: 'Selected record precedes its producer publication under the zero-skew research contract' },
      },
    })
  })

  test.each(['AAPL', 'SPY'])('%s wide spread and one-sided size produce evidenced exclusions', (symbol) => {
    const wide = symbol === 'AAPL' ? { bid: 104.9, ask: 105.1 } : { bid: 201.9, ask: 202.1 }
    expect(Result.getOrThrow(observe(change(quote(symbol), wide)))).toMatchObject({
      status: 'EXCLUDED',
      symbol,
      reason: 'spread',
      qualification: 'UNQUALIFIED',
    })
    for (const sizes of [{ bidSize: 0 }, { askSize: 0 }, { bidSize: 0, askSize: 0 }])
      expect(Result.getOrThrow(observe(change(quote(symbol), sizes)))).toMatchObject({
        status: 'EXCLUDED',
        symbol,
        reason: 'displayed-size',
      })
  })

  test('missing benchmark evidence cannot become a candidate policy exclusion', () => {
    const inputs = change(quote('AAPL'), { bidSize: 0 }).filter((input) => !trade('SPY')(input))
    expect(Result.getOrThrow(observe(inputs))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Trade,
      symbol: 'SPY',
    })
  })

  test('crossed quotes and non-final or subminute bars remain invalid', () => {
    expect(observe(change(quote('AAPL'), { bid: 106, ask: 105 }))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SixBarResearchFailure' },
    })
    expect(
      observe(change((input) => input.channel === 'bars' && input.symbol === 'AAPL', { final: false })),
    ).toMatchObject({ _tag: 'Failure', failure: { cause: { reason: 'freshness' } } })
    expect(
      observe(
        change((input) => input.channel === 'bars' && input.symbol === 'AAPL' && input.eventAtMs === sixBarOpenMs, {
          eventAtText: '2026-09-04T13:30:00.000000001Z',
        }),
      ),
    ).toMatchObject({ _tag: 'Failure', failure: { cause: { reason: 'coverage' } } })
  })

  test('preopen and cross-session bars cannot replace a required RTH minute', () => {
    const target = (input: SixBarFixtureInput) =>
      input.channel === 'bars' && input.symbol === 'AAPL' && input.eventAtMs === sixBarOpenMs + 120_000
    expect(Result.getOrThrow(observe(change(target, { marketSession: 'pre' })))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Bars,
    })
    expect(
      Result.getOrThrow(
        observe(change(target, { eventAtMs: sixBarOpenMs - 86_400_000, availableAtMs: sixBarOpenMs - 86_339_000 })),
      ),
    ).toMatchObject({ status: 'UNAVAILABLE', reason: SixBarUnavailableReason.Bars })
  })

  test('candidate trade may precede the window end while SPY requires post-window evidence', () => {
    const oldCandidateTrade = change(trade('AAPL'), {
      eventAtMs: sixBarOpenMs + 240_000,
      availableAtMs: sixBarOpenMs + 240_000,
    })
    expect(available(oldCandidateTrade).values).toEqual(available().values)
    const oldSpyTrade = change(trade('SPY'), { eventAtMs: sixBarEndMs - 1, availableAtMs: sixBarEndMs - 1 })
    expect(Result.getOrThrow(observe(oldSpyTrade))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.Freshness,
      message: 'intraday snapshot lacks a post-range trade for every symbol',
    })
  })

  test('later observations enforce SPY trade age even with fresh post-window quotes', () => {
    const at = sixBarEndMs + 30_000
    const inputs = sixBarFixtureInputs().map((input) =>
      input.channel === 'quotes' ? { ...input, eventAtMs: at, availableAtMs: at } : input,
    )
    expect(Result.getOrThrow(observe(inputs, at))).toMatchObject({
      status: 'UNAVAILABLE',
      reason: SixBarUnavailableReason.BenchmarkTrade,
      symbol: 'SPY',
    })
    expect(
      available(
        inputs.map((input) => (trade('SPY')(input) ? { ...input, eventAtMs: at, availableAtMs: at } : input)),
        at,
      ).values.slice(0, 6),
    ).toEqual(available().values.slice(0, 6))
  })

  test('calendar session length determines elapsed fraction, including early close', () => {
    expect(available(undefined, sixBarObservedMs, '13:00').values[6]).toBeCloseTo(362 / 12_600, 12)
    expect(available().values[6]).toBeCloseTo(362 / 23_400, 12)
  })

  test('JSON-persisted original bytes reconstruct the same observation and receipt hashes', () => {
    const fixture = sixBarFixture()
    const events: unknown[] = JSON.parse(JSON.stringify(fixture.events))
    let cursor: HistoricalMarketCursor = Result.getOrThrow(
      createHistoricalMarketCursor(fixture.source.runId, fixture.universe, undefined, fixture.source),
    )
    for (const event of events) cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event))
    expect(Result.getOrThrow(extractSixBarResearchObservation(cursor, fixture.query))).toEqual(available())
    const first = fixture.events[0]!
    const empty = Result.getOrThrow(
      createHistoricalMarketCursor(fixture.source.runId, fixture.universe, undefined, fixture.source),
    )
    expect(
      advanceHistoricalMarketCursor(empty, { ...first, record: { ...first.record, value: `${first.record.value} ` } }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { message: 'Original arrival lost its exact bytes, timestamp or delivered sequence' },
    })

    expect(
      advanceHistoricalMarketCursor(empty, { ...first, receipt: { ...first.receipt, consumerSequence: 2 } }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { message: 'Original arrival lost its exact bytes, timestamp or delivered sequence' },
    })
  })

  test('original raw bytes and decoded record text remain distinct with invalid UTF-8 in an ignored field', () => {
    const encode = (value: string) =>
      Buffer.concat([Buffer.from(`${value.slice(0, -1)},"ignored":"`), Buffer.from([0x80]), Buffer.from('"}')])
    const fixture = sixBarFixture(undefined, undefined, encode)
    const observation = Result.getOrThrow(extractSixBarResearchObservation(replaySixBarFixture(fixture), fixture.query))
    expect(observation.status).toBe(SixBarResearchStatus.Available)
    expect(observation.receipts[0]!.recordTextSha256).toBe(
      '4141e387a5603868d9da28b17b4cf40fa374feadae1e25935e9af11146d30a79',
    )
    const normalized = sixBarFixture(undefined, undefined, (value) => Buffer.from(encode(value).toString('utf8')))
    const normalizedObservation = Result.getOrThrow(
      extractSixBarResearchObservation(replaySixBarFixture(normalized), normalized.query),
    )
    expect(normalizedObservation.status).toBe(SixBarResearchStatus.Available)
    if (
      observation.status !== SixBarResearchStatus.Available ||
      normalizedObservation.status !== SixBarResearchStatus.Available
    )
      throw new Error('Expected both decoded records to remain usable')
    expect(observation.values).toEqual(normalizedObservation.values)
    expect(observation.receipts).toEqual(normalizedObservation.receipts)
    expect(observation.source.sourceManifestHash).not.toBe(normalizedObservation.source.sourceManifestHash)
    expect(observation.source.deliveryModel).not.toEqual(normalizedObservation.source.deliveryModel)
    expect(observation.evidenceHash).not.toBe(normalizedObservation.evidenceHash)
  })

  test('unbound legacy cursors, future cuts and altered query contracts fail closed', () => {
    const fixture = sixBarFixture()
    const cursor = replaySixBarFixture(fixture)
    const legacy = Result.getOrThrow(createHistoricalMarketCursor(fixture.source.runId, fixture.universe))
    expect(extractSixBarResearchObservation(legacy, fixture.query)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SixBarResearchFailure' },
    })
    expect(extractSixBarResearchObservation(cursor, { ...fixture.query, maximumQuoteAgeMs: 11_000 })).toMatchObject({
      _tag: 'Failure',
      failure: {
        cause: { message: 'Six-bar research requires its exact candidate, benchmark, window and timing contract' },
      },
    })
    expect(
      extractSixBarResearchObservation(cursor, {
        ...fixture.query,
        sourceTopics: { ...fixture.query.sourceTopics, bars: 'other-bars' },
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        cause: { message: 'Six-bar research requires a matching original-byte receipt cursor at the observation cut' },
      },
    })
    const later = sixBarFixture([
      ...sixBarFixtureInputs(),
      {
        channel: 'trades',
        symbol: 'AAPL',
        eventAtMs: sixBarObservedMs + 1,
        availableAtMs: sixBarObservedMs + 1,
        close: 106,
      },
    ])
    expect(
      extractSixBarResearchObservation(replaySixBarFixture(later, sixBarObservedMs + 1), later.query),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        cause: { message: 'Six-bar research requires a matching original-byte receipt cursor at the observation cut' },
      },
    })
  })

  test('the unchanged native Jev selector still rejects the six-bar fixture', () => {
    const fixture = sixBarFixture()
    expect(defaultJevProtocolDocument.lookbackMinutes).toBe(30)
    expect(selectStreamingInputs(replaySixBarFixture(fixture).projection, fixture.query)).toMatchObject({
      _tag: 'Failure',
      failure: { message: 'Required rolling feature is unavailable for SPY' },
    })
    expect(available().values).toHaveLength(7)
  })

  test('property: every interior missing minute stays explicit for either symbol', () => {
    checkProperty(
      'six-bar-exact-grid',
      fc.property(fc.constantFrom('AAPL', 'SPY'), fc.integer({ min: 0, max: 5 }), (symbol, index) => {
        const inputs = sixBarFixtureInputs().filter(
          (input) =>
            !(input.channel === 'bars' && input.symbol === symbol && input.eventAtMs === sixBarOpenMs + index * 60_000),
        )
        expect(Result.getOrThrow(observe(inputs))).toMatchObject({
          status: 'UNAVAILABLE',
          symbol,
          reason: SixBarUnavailableReason.Bars,
          missingBarInstants: [new Date(sixBarOpenMs + index * 60_000).toISOString()],
        })
      }),
    )
  })

  test('property: later changed corrections never enter the earlier feature values', () => {
    checkProperty(
      'six-bar-causal-revisions',
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 110, max: 300 }), (index, close) => {
        const fixture = sixBarFixture([
          ...sixBarFixtureInputs(),
          {
            channel: 'updatedBars',
            symbol: 'AAPL',
            eventAtMs: sixBarOpenMs + index * 60_000,
            availableAtMs: sixBarObservedMs + 1,
            close,
          },
        ])
        const earlier = Result.getOrThrow(extractSixBarResearchObservation(replaySixBarFixture(fixture), fixture.query))
        expect(earlier.status).toBe(SixBarResearchStatus.Available)
        if (earlier.status !== SixBarResearchStatus.Available) throw new Error('Expected original causal features')
        earlier.values.forEach((value, feature) => expect(value).toBeCloseTo(expected[feature]!, 10))
        expect(earlier.cut.lastArrival?.receipt?.sequence).toBe(16)
        expect(earlier.receipts.some((receipt) => receipt.availableAtMs > sixBarObservedMs)).toBe(false)
      }),
    )
  })
})
