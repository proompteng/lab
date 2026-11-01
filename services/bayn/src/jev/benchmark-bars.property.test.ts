import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { checkProperty } from '../testing/property-test-support'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { IntradayBenchmarkEvidencePolicy } from '../market-data/intraday/model'
import { jevBenchmarkSignalFor, jevSignalFor } from './trading-signals'

const momentumSnapshot = (fixture: ReturnType<typeof cryptoMarketFixture>) =>
  Result.getOrThrow(
    constructStreamingSnapshot(fixture.cut, {
      ...fixture.query,
      symbols: ['BTC/USD', 'ETH/USD'],
      benchmarkEvidencePolicy: IntradayBenchmarkEvidencePolicy.CompletedBars,
      benchmarkSymbols: ['ETH/USD'],
    }),
  )

test('property: ETH print availability and quote age cannot change BTC benchmark prices', () => {
  const baseline = Result.getOrThrow(jevBenchmarkSignalFor(momentumSnapshot(cryptoMarketFixture('BTC/USD')), 'ETH/USD'))
  checkProperty(
    'jev-completed-bar-benchmark-independence',
    fc.property(
      fc.record({
        quoteLagMs: fc.integer({ min: 0, max: 6000 }),
        benchmarkQuoteLagMs: fc.integer({ min: 0, max: 2_400_000 }),
        missingTrade: fc.boolean(),
      }),
      ({ quoteLagMs, benchmarkQuoteLagMs, missingTrade }) => {
        const fixture = cryptoMarketFixture('BTC/USD', {
          quoteLagMs,
          benchmarkQuoteLagMs,
          missingTradeSymbols: missingTrade ? ['ETH/USD'] : [],
        })
        const snapshot = momentumSnapshot(fixture)
        const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(snapshot, 'ETH/USD'))
        expect(benchmark).toEqual(baseline)
        expect(Result.isSuccess(jevSignalFor(snapshot, 'BTC/USD'))).toBe(true)
        expect(benchmark.state).not.toHaveProperty('quote')
        expect(benchmark.state).not.toHaveProperty('latestTrade')
      },
    ),
  )
}, 150_000)
