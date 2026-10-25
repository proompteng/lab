import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { checkProperty } from '../../testing/property-test-support'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { marketFeatureClockSkewAllowanceMs } from '../features/feature-core'
import { IntradaySnapshotPurpose, type IntradaySnapshotQuery } from '../intraday/model'
import { latestQuotes, persistIntradayRecordRows } from '../intraday/verification'
import { reproduceStreamingSnapshot } from './replay'

const fixture = streamingFixture()
const { candidateSymbols: _candidates, ...baseQuery } = fixture.query
const query: IntradaySnapshotQuery = {
  ...baseQuery,
  symbols: ['AAPL'],
  rangeStartAt: '2026-09-04T14:29:00.000Z',
  maximumQuoteAgeMs: 10_000,
  minimumWatermarkLagMs: 0,
  purpose: IntradaySnapshotPurpose.EntryPricing,
}
const quote = fixture.snapshot.latestQuotes['AAPL']
if (quote === undefined) throw new Error('Missing fixture quote')

describe.each([IntradaySnapshotPurpose.EntryPricing, IntradaySnapshotPurpose.Liquidation])(
  '%s quotes across the completed-minute boundary',
  (purpose) => {
    test.each(['2026-09-04T14:29:59.000Z', '2026-09-04T14:29:52.000Z'])(
      'constructs and reproduces pricing with the still-fresh quote at %s',
      (eventAt) => {
        const snapshot = streamingFixtureFromRaw(
          {
            ...fixture.archive,
            quotes: [{ ...quote, eventAt, ingestedAt: eventAt }],
          },
          { ...query, purpose },
        ).snapshot
        expect(snapshot.latestQuotes['AAPL']?.eventAt).toBe(eventAt)
        expect(
          Result.getOrThrow(
            reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
          ),
        ).toEqual(snapshot)
      },
    )

    test.each([
      ['2026-09-04T14:29:52.000000000Z', true],
      ['2026-09-04T14:29:51.999999999Z', false],
    ] as const)('preserves the exact quote-age boundary at %s', (eventAt, accepted) => {
      expect(
        Result.isSuccess(latestQuotes({ ...query, purpose }, [{ ...quote, eventAt, ingestedAt: eventAt }], [])),
      ).toBe(accepted)
    })

    test('still fails the complete pricing snapshot when a required symbol has no quote', () => {
      expect(latestQuotes({ ...query, purpose, symbols: ['AAPL', 'AMZN'] }, [quote], [])).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'not-ready', facts: { symbol: 'AMZN' } },
      })
    })

    test.each(['event', 'ingestion'] as const)('rejects future %s beyond the permitted producer clock skew', (kind) => {
      const ingestedAt = new Date(Date.parse(query.observedAt) + marketFeatureClockSkewAllowanceMs + 1).toISOString()
      const eventAt = kind === 'event' ? ingestedAt : '2026-09-04T14:29:59.000Z'
      expect(() =>
        streamingFixtureFromRaw(
          { ...fixture.archive, quotes: [{ ...quote, eventAt, ingestedAt }] },
          { ...query, purpose },
        ),
      ).toThrow()
    })
  },
)

test('property: pricing admits a quote before the minute boundary only within its exact freshness bound', () => {
  const end = Date.parse(query.rangeEndAt)
  checkProperty(
    'pricing-minute-boundary',
    fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 10_001 }),
      fc.constantFrom(IntradaySnapshotPurpose.EntryPricing, IntradaySnapshotPurpose.Liquidation),
      (afterBoundaryMs, beforeBoundaryMs, purpose) => {
        const eventAt = new Date(end - beforeBoundaryMs).toISOString()
        const observedAt = new Date(end + afterBoundaryMs).toISOString()
        expect(
          Result.isSuccess(
            latestQuotes({ ...query, purpose, observedAt }, [{ ...quote, eventAt, ingestedAt: eventAt }], []),
          ),
        ).toBe(beforeBoundaryMs + afterBoundaryMs <= query.maximumQuoteAgeMs)
      },
    ),
  )
})
