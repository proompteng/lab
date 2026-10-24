import { jevHoldingMinutesForSymbol, jevMarketForSymbol } from './markets'
import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import {
  decideJevExit,
  jevProfitTargetHoldingDeadlineAt,
  jevProfitTargetLimitFloors,
  jevProtectiveQuoteIsFresh,
  JevExitReason,
  JevExitTargetSchema,
} from './exit'
import { nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { jevProtectiveQuoteDiagnostics, JevQuoteReferenceScope } from './quote-diagnostics'
import { jevPricingQuery } from './runtime'

const fixture = nativeJevFixture(JevPurpose.Manage)
const evidence = {
  cycleId: fixture.draft.identity.cycleId,
  sessionDate: fixture.snapshot.manifest.sessionDate,
  protocol: fixture.protocol,
  portfolio: fixture.portfolio,
  observedAt: fixture.observation.payload.observedAt,
}

const portfolioWithBrokerAge = (ageMs: number) => {
  const original = fixture.portfolio.brokerState
  const at = new Date(Date.parse(evidence.observedAt) - ageMs).toISOString()
  const state = {
    ...original,
    account: { ...original.account, observedAt: at },
    positions: original.positions.map((position) => ({ ...position, observedAt: at })),
    positionsObservedAt: at,
    orders: original.orders.map((order) => ({ ...order, observedAt: at })),
    ordersObservedAt: at,
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  return {
    ...fixture.portfolio,
    brokerState: {
      ...state,
      reconciliation: { ...original.reconciliation, reconciledAt: at, expectedHash: hash, observedHash: hash },
    },
  }
}

describe('native Jev exit targets', () => {
  test.each([
    [0.051, 0, true],
    [0.002, 0, false],
    [-0.02, 0, false],
    [0.05, 10_001, false],
    [0.05, -1, false],
  ])('profit exit requires a verified net target: change %s, quote age %i', (change, ageMs, accepted) => {
    const fixture = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
    if (fixture.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
    const evidence = {
      cycleId: fixture.draft.identity.cycleId,
      sessionDate: fixture.snapshot.manifest.sessionDate,
      protocol: fixture.protocol,
      portfolio: fixture.portfolio,
      observedAt: fixture.observation.payload.observedAt,
    }
    const query = Result.getOrThrow(
      jevPricingQuery(
        fixture.draft,
        fixture.protocol,
        fixture.snapshot.manifest.calendar,
        evidence.observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const raw = makeIntradayMomentumTestSnapshot(
      fixture.protocol,
      { ...query, archiveWatermarks: [] },
      { AAPL: change },
    )
    const quoteAt = new Date(Date.parse(evidence.observedAt) - ageMs).toISOString()
    const snapshot = streamingFixtureFromRaw(
      { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, eventAt: quoteAt, ingestedAt: quoteAt })) },
      query,
    ).snapshot
    const trigger = {
      reason: JevExitReason.ProfitTarget,
      manifest: snapshot.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
    }
    const result = decideJevExit({ ...evidence, trigger })
    expect(Result.isSuccess(result)).toBe(accepted)
    if (!Result.isSuccess(result)) return
    const plan = fixture.portfolio.exitPolicy.plans['AAPL']
    if (plan === undefined) throw new Error('Expected the sealed exit plan')
    const reference = [{ symbol: 'AAPL', referencePriceMicros: plan.levels.profitLimitPriceMicros }]
    const deadline = Result.getOrThrow(jevProfitTargetHoldingDeadlineAt(result.success))
    if (deadline === undefined) throw new Error('Expected the actual holding deadline')
    expect(Result.getOrThrow(jevProfitTargetLimitFloors(result.success, evidence.observedAt, reference))).toEqual({
      AAPL: BigInt(plan.levels.profitLimitPriceMicros),
    })
    expect(Result.getOrThrow(jevProfitTargetLimitFloors(result.success, deadline, reference))).toEqual({})
    expect(
      Result.getOrThrow(
        jevProfitTargetLimitFloors(result.success, evidence.observedAt, [
          { symbol: 'AAPL', referencePriceMicros: plan.levels.stopPriceMicros },
        ]),
      ),
    ).toEqual({})
    expect(Result.getOrThrow(Schema.decodeUnknownResult(JevExitTargetSchema)(result.success))).toEqual(result.success)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(JevExitTargetSchema)({
          ...result.success,
          schemaVersion: 'bayn.jev-exit-target.v1',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({ ...evidence, trigger: { ...trigger, manifest: { ...snapshot.manifest, feed: 'sip' } } }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(JevExitTargetSchema)({ ...result.success, reason: 'JEV_EXIT' })),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({
          ...evidence,
          portfolio: {
            ...fixture.portfolio,
            exitPolicy: { ...fixture.portfolio.exitPolicy, profitTargetNetBps: 1 },
          },
          trigger,
        }),
      ),
    ).toBe(true)
  })

  test('an exchange-only wide-spread stop is diagnosed without suppressing the protective exit', () => {
    const held = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
    const observedAt = held.observation.payload.observedAt
    const query = Result.getOrThrow(
      jevPricingQuery(
        held.draft,
        held.protocol,
        held.snapshot.manifest.calendar,
        observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const raw = makeIntradayMomentumTestSnapshot(held.protocol, { ...query, archiveWatermarks: [] }, { AAPL: -0.02 })
    const snapshot = streamingFixtureFromRaw(
      { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, askPrice: quote.bidPrice * 1.02 })) },
      query,
    ).snapshot
    const material = {
      cycleId: held.draft.identity.cycleId,
      sessionDate: held.snapshot.manifest.sessionDate,
      protocol: held.protocol,
      portfolio: held.portfolio,
      observedAt,
      trigger: {
        reason: JevExitReason.ProtectiveStop,
        manifest: snapshot.manifest,
        rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
      },
    }
    const target = Result.getOrThrow(decideJevExit(material))
    const quote = snapshot.latestQuotes['AAPL']
    if (quote === undefined) throw new Error('Missing synthetic protective quote')
    const diagnostic = jevProtectiveQuoteDiagnostics(quote, jevMarketForSymbol('AAPL').maximumEntrySpreadBps)
    expect(diagnostic).toMatchObject({
      referenceScope: JevQuoteReferenceScope.ExchangeOnly,
      pairedFeedComparisonAvailable: false,
      quoteEventAt: quote.eventAt,
      entrySpreadLimitBps: jevMarketForSymbol('AAPL').maximumEntrySpreadBps,
    })
    expect(diagnostic.spreadBpsApprox).toBeGreaterThan(jevMarketForSymbol('AAPL').maximumEntrySpreadBps)
    expect(diagnostic).not.toHaveProperty('bidPrice')
    expect(diagnostic).not.toHaveProperty('askPrice')
    expect(target.targetWeights).toEqual({ AAPL: 0 })
    expect(Result.getOrThrow(decideJevExit(material))).toEqual(target)
    expect(Result.getOrThrow(Schema.decodeUnknownResult(JevExitTargetSchema)(target))).toEqual(target)
  })

  test('a narrow or locked venue quote never claims consolidated-price observation', () => {
    for (const askPrice of [100, 100.01]) {
      const diagnostic = jevProtectiveQuoteDiagnostics(
        { feed: 'iex', bidPrice: 100, askPrice, eventAt: '2026-09-04T14:30:31.999999999Z' },
        5,
      )
      expect(diagnostic.pairedFeedComparisonAvailable).toBe(false)
      expect(diagnostic.spreadBpsApprox).toBeGreaterThanOrEqual(0)
      expect(diagnostic.spreadBpsApprox).toBeLessThan(5)
      expect(diagnostic.quoteEventAt).toBe('2026-09-04T14:30:31.999999999Z')
    }
  })

  test('delayed consolidated quotes are not relabelled as current NBBO or IEX', () => {
    const diagnostic = jevProtectiveQuoteDiagnostics(
      { feed: 'delayed_sip', bidPrice: 100, askPrice: 100.01, eventAt: '2026-09-04T14:15:31.000Z' },
      5,
    )
    expect(diagnostic.referenceScope).toBe(JevQuoteReferenceScope.DelayedConsolidated)
    expect(diagnostic.pairedFeedComparisonAvailable).toBe(false)
    expect(
      jevProtectiveQuoteDiagnostics(
        { feed: 'sip', bidPrice: 100, askPrice: 100.01, eventAt: '2026-09-04T14:30:31.000Z' },
        5,
      ).referenceScope,
    ).toBe(JevQuoteReferenceScope.Consolidated)
  })

  test.each([
    [23_039, true],
    [59_999, true],
    [60_000, false],
    [-1, false],
  ])('holding deadline uses the broker lifetime for a %ims-old reconciled cut', (ageMs, accepted) => {
    const portfolio = portfolioWithBrokerAge(ageMs)
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
    const firstAt = Date.parse(evidence.observedAt) - jevHoldingMinutesForSymbol(fixture.protocol, 'AAPL') * 60_000
    const result = decideJevExit({
      ...evidence,
      portfolio: {
        ...portfolio,
        exitPolicy: {
          ...portfolio.exitPolicy,
          plans: Object.fromEntries(
            Object.entries(portfolio.exitPolicy.plans).map(([symbol, plan]) => [
              symbol,
              {
                ...plan,
                levels: {
                  ...plan.levels,
                  sourceEndAt: new Date(Math.floor(firstAt / 60_000) * 60_000).toISOString(),
                  sourceStartAt: new Date(Math.floor(firstAt / 60_000) * 60_000 - 15 * 60_000).toISOString(),
                },
              },
            ]),
          ),
        },
        entryFills: portfolio.entryFills.map((fill, index) => ({
          ...fill,
          occurredAt: new Date(firstAt + index * 1000).toISOString(),
        })),
      },
      trigger: { reason: JevExitReason.MaximumHold },
    })
    expect(Result.isSuccess(result)).toBe(accepted)
    if (Result.isSuccess(result))
      expect(result.success.commitDeadlineAt).toBe(
        new Date(Date.parse(evidence.observedAt) + fixture.protocol.maximumQuoteAgeMs).toISOString(),
      )
  })

  test('protective quote freshness preserves nanosecond boundaries and rejects future bids', () => {
    const at = '2026-09-04T14:30:32.000Z'
    expect(jevProtectiveQuoteIsFresh({ eventAt: '2026-09-04T14:30:22.000000000Z' }, at, 10_000)).toBe(true)
    expect(jevProtectiveQuoteIsFresh({ eventAt: '2026-09-04T14:30:21.999999999Z' }, at, 10_000)).toBe(false)
    expect(jevProtectiveQuoteIsFresh({ eventAt: '2026-09-04T14:30:32.000000001Z' }, at, 10_000)).toBe(false)
  })

  test.each([
    [9_000, true],
    [10_000, true],
    [10_001, false],
    [31_000, false],
  ])('protective stop reproduces a %ims-old bid only when it is executable', (ageMs, accepted) => {
    const held = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
    const observedAt = held.observation.payload.observedAt
    const query = Result.getOrThrow(
      jevPricingQuery(
        held.draft,
        held.protocol,
        held.snapshot.manifest.calendar,
        observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const raw = makeIntradayMomentumTestSnapshot(held.protocol, { ...query, archiveWatermarks: [] }, { AAPL: -0.02 })
    const quoteAt = new Date(Date.parse(observedAt) - ageMs).toISOString()
    const snapshot = streamingFixtureFromRaw(
      { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, eventAt: quoteAt, ingestedAt: quoteAt })) },
      query,
    ).snapshot
    const trigger = {
      reason: JevExitReason.ProtectiveStop,
      manifest: snapshot.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
    }
    const result = decideJevExit({
      cycleId: held.draft.identity.cycleId,
      sessionDate: held.snapshot.manifest.sessionDate,
      protocol: held.protocol,
      portfolio: held.portfolio,
      observedAt,
      trigger,
    })
    expect(Result.isSuccess(result)).toBe(accepted)
    if (Result.isSuccess(result))
      expect(result.success.commitDeadlineAt).toBe(
        new Date(Date.parse(quoteAt) + held.protocol.maximumQuoteAgeMs).toISOString(),
      )
  })

  test('pricing waits at the exact minute boundary instead of invalidating the position', () => {
    const result = jevPricingQuery(
      fixture.draft,
      fixture.protocol,
      fixture.snapshot.manifest.calendar,
      '2026-09-04T14:30:00.000Z',
      ['AAPL'],
      IntradaySnapshotPurpose.Liquidation,
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ _tag: 'JevAwaitingEvidence', availableAt: '2026-09-04T14:30:00.001Z' })
  })
  test('the holding limit starts at the first real partial fill and does not require inference', () => {
    if (fixture.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
    const firstAt = Date.parse(evidence.observedAt) - jevHoldingMinutesForSymbol(fixture.protocol, 'AAPL') * 60_000
    const material = {
      ...evidence,
      portfolio: {
        ...fixture.portfolio,
        exitPolicy: {
          ...fixture.portfolio.exitPolicy,
          plans: Object.fromEntries(
            Object.entries(fixture.portfolio.exitPolicy.plans).map(([symbol, plan]) => [
              symbol,
              {
                ...plan,
                levels: {
                  ...plan.levels,
                  sourceEndAt: new Date(Math.floor(firstAt / 60_000) * 60_000).toISOString(),
                  sourceStartAt: new Date(Math.floor(firstAt / 60_000) * 60_000 - 15 * 60_000).toISOString(),
                },
              },
            ]),
          ),
        },
        entryFills: fixture.portfolio.entryFills.map((fill, index) => ({
          ...fill,
          occurredAt: new Date(firstAt + index * 1000).toISOString(),
        })),
      },
      trigger: { reason: JevExitReason.MaximumHold },
    }
    expect(Result.getOrThrow(decideJevExit(material)).reason).toBe(JevExitReason.MaximumHold)
    expect(
      Result.isFailure(
        decideJevExit({
          ...material,
          portfolio: {
            ...material.portfolio,
            entryFills: material.portfolio.entryFills.map((fill) => ({
              ...fill,
              occurredAt: new Date(Date.parse(fill.occurredAt) + 1).toISOString(),
            })),
          },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({ ...material, observedAt: new Date(Date.parse(evidence.observedAt) + 60_000).toISOString() }),
      ),
    ).toBe(true)
  })

  test('the protective stop requires a fresh verified adverse bid, not a model score or substituted price', () => {
    const query = Result.getOrThrow(
      jevPricingQuery(
        fixture.draft,
        fixture.protocol,
        fixture.snapshot.manifest.calendar,
        evidence.observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const pricing = (change: number) =>
      streamingFixtureFromRaw(
        makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] }, { AAPL: change }),
        query,
      ).snapshot
    const snapshot = pricing(-0.02)
    const trigger = {
      reason: JevExitReason.ProtectiveStop,
      manifest: snapshot.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
    }
    expect(Result.getOrThrow(decideJevExit({ ...evidence, trigger })).reason).toBe(JevExitReason.ProtectiveStop)
    const aboveStop = pricing(0.02)
    expect(
      Result.isFailure(
        decideJevExit({
          ...evidence,
          trigger: {
            ...trigger,
            manifest: aboveStop.manifest,
            rows: Result.getOrThrow(persistIntradayRecordRows(aboveStop)),
          },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({ ...evidence, trigger: { ...trigger, manifest: { ...snapshot.manifest, feed: 'sip' } } }),
      ),
    ).toBe(true)
  })
})
