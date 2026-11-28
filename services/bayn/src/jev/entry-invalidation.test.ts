import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decideJevEntry } from './decision'
import { jevEligibleEntryBoundaryCrossed, jevPendingEntryBoundaryCrossed } from './entry-invalidation'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { shortNativeEntryFixture } from './short-entry.test-support'
import { jevPricingQuery } from './runtime'
import { isShortExitPlan } from '../strategy/funded-exit-plan'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { makeJevMarketTestSnapshot } from '../testing/jev-market-fixture'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'

const long = nativeJevFixture()
const short = Result.getOrThrow(shortNativeEntryFixture())
const longTarget = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(long)))

describe.each([
  ['long', long, longTarget],
  ['short', short, short.decision],
] as const)('pending %s entry boundary evidence', (_side, fixture, target) => {
  test.each([
    'stop',
    'target',
    'inside',
    'wide-stop',
    'wide-target',
    'stale',
    'future-clock',
    'missing-bid',
    'missing-ask',
    'wrong-symbol',
    'wrong-source',
    'malformed',
  ] as const)('uses the original executable-side boundaries with %s evidence', (scenario) => {
    const plan = target.exitPolicy.plans['AAPL']
    if (plan === undefined) throw new Error('Expected funded plan')
    const shortSide = isShortExitPlan(plan)
    const observedAt = new Date(Date.parse(target.decidedAt) + 1_000).toISOString()
    const evaluatedAt =
      scenario === 'stale'
        ? new Date(Date.parse(observedAt) + fixture.protocol.maximumQuoteAgeMs + 1).toISOString()
        : scenario === 'future-clock'
          ? target.decidedAt
          : observedAt
    const query = Result.getOrThrow(
      jevPricingQuery(
        fixture.draft,
        fixture.protocol,
        fixture.snapshot.manifest.calendar,
        observedAt,
        [scenario === 'wrong-symbol' ? 'AMZN' : 'AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const stop = Number(plan.levels.stopPriceMicros) / 1_000_000
    const profit = Number(plan.levels.profitLimitPriceMicros) / 1_000_000
    const boundary =
      scenario === 'target' || scenario === 'wide-target' ? profit : scenario === 'inside' ? (stop + profit) / 2 : stop
    const spread = scenario.startsWith('wide-') ? boundary / 100 : 0.01
    const raw = makeJevMarketTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.02 }, 10)
    const snapshot = streamingFixtureFromRaw(
      {
        ...raw,
        quotes: raw.quotes.map((quote) => ({
          ...quote,
          eventAt: observedAt,
          bidPrice: shortSide ? boundary - spread : boundary,
          askPrice: shortSide ? boundary : boundary + spread,
          bidSize: scenario === 'missing-bid' ? 0 : 100,
          askSize: scenario === 'missing-ask' ? 0 : 100,
        })),
      },
      query,
    ).snapshot
    const source = {
      manifest:
        scenario === 'wrong-source'
          ? { ...snapshot.manifest, universeId: 'unrelated-source' }
          : scenario === 'malformed'
            ? { ...snapshot.manifest, contentHash: '0'.repeat(64) }
            : snapshot.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
    }
    const result = jevPendingEntryBoundaryCrossed(target, 'AAPL', observedAt, evaluatedAt, source)
    if (
      scenario === 'stop' ||
      scenario === 'target' ||
      scenario === 'inside' ||
      scenario.startsWith('wide-') ||
      scenario === 'stale' ||
      scenario === 'missing-bid' ||
      scenario === 'missing-ask'
    )
      expect(Result.getOrThrow(result)).toBe(scenario === 'stop' || scenario === 'target')
    else expect(Result.isFailure(result)).toBe(true)
  })
})

test.each([
  [153.22, 153.67, false],
  [153.6, 153.61, true],
  [153.58, 153.59, false],
  [153.09, 153.1, true],
] as const)('NVDA pending short quote %s/%s preserves existing entry spread quality', (bidPrice, askPrice, crossed) => {
  const quote = short.snapshot.latestQuotes['AAPL']
  if (quote === undefined) throw new Error('Expected quote fixture')
  expect(
    Result.getOrThrow(
      jevEligibleEntryBoundaryCrossed(
        { short: true, stopPriceMicros: '153600000', profitLimitPriceMicros: '153100000' },
        { ...quote, symbol: 'NVDA', bidPrice, askPrice },
      ),
    ),
  ).toBe(crossed)
})
