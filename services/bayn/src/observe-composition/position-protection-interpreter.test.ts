import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { OrderSide } from '../execution/contracts'
import { decideJevExit, JevExitReason } from '../jev/exit'
import { nativeJevFixture } from '../jev/native.test-support'
import { decodeJevPortfolio, JevPurpose, jevManagedExitPlan } from '../jev/portfolio'
import { jevPricingQuery } from '../jev/runtime'
import { shortNativeEntryFixture } from '../jev/short-entry.test-support'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import {
  armedNativeProtectionRequiresStopCancellation,
  shouldReanchorProtectionCancel,
} from './position-protection-interpreter'

describe('armed native protection IEX stop confirmation', () => {
  const buildLongStopTarget = (
    quoteTransform: (
      bid: number,
      stopPrice: number,
    ) => {
      readonly feed?: 'iex' | 'sip'
      readonly bidPrice: number
      readonly askPrice: number
      readonly bidSize?: number
      readonly askSize?: number
    },
  ) => {
    const held = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
    if (held.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected managed portfolio')
    const plan = Result.getOrThrow(jevManagedExitPlan(held.portfolio))
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
    const stopPrice = Number(plan.levels.stopPriceMicros) / 1_000_000
    const nextRaw = {
      ...raw,
      quotes: raw.quotes.map((quote) => {
        const next = quoteTransform(quote.bidPrice, stopPrice)
        return {
          ...quote,
          ...(next.feed === undefined ? {} : { feed: next.feed }),
          bidPrice: next.bidPrice,
          askPrice: next.askPrice,
          ...(next.bidSize === undefined ? {} : { bidSize: next.bidSize }),
          ...(next.askSize === undefined ? {} : { askSize: next.askSize }),
        }
      }),
    }
    const snapshot = streamingFixtureFromRaw(nextRaw, query).snapshot
    const target = Result.getOrThrow(
      decideJevExit({
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
      }),
    )
    return { plan, target }
  }

  const buildShortStopTarget = (
    quoteTransform: (stopPrice: number) => {
      readonly feed?: 'iex' | 'sip'
      readonly bidPrice: number
      readonly askPrice: number
      readonly bidSize?: number
      readonly askSize?: number
    },
  ) => {
    const opening = Result.getOrThrow(shortNativeEntryFixture('jev-native-test'))
    const entryAt = opening.observation.observedAt
    const at = new Date(Date.parse(entryAt) + 60_000).toISOString()
    const managed = nativeJevFixture(JevPurpose.Manage, at)
    if (managed.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected managed portfolio')
    const plan = opening.decision.exitPolicy.plans['AAPL']
    if (plan?.schemaVersion !== 'bayn.jev-short-funded-exit-plan.v1') throw new Error('Expected short exit plan')
    const price = BigInt(plan.levels.minimumEntryPriceMicros)
    const value = price * 5n
    const previous = managed.portfolio.brokerState
    const state = {
      ...previous,
      account: { ...previous.account, cashMicros: (BigInt(previous.account.equityMicros) + value).toString() },
      positions: previous.positions.map((position) => ({
        ...position,
        quantityAtoms: '-5000000000',
        averageEntryPriceMicros: price.toString(),
        costBasisMicros: (-value).toString(),
        marketPriceMicros: price.toString(),
        marketValueMicros: (-value).toString(),
        unrealizedPnlMicros: '0',
      })),
      orders: previous.orders.map((order) => ({ ...order, side: OrderSide.Sell })),
    }
    const hash = Result.getOrThrow(reconciledStateHash(state))
    const portfolio = Result.getOrThrow(
      decodeJevPortfolio({
        ...managed.portfolio,
        entryDecisionHash: Result.getOrThrow(canonicalHashV1Result(opening.decision)),
        exitPolicy: opening.decision.exitPolicy,
        entryFills: managed.portfolio.entryFills.map((fill) => ({
          ...fill,
          side: OrderSide.Sell,
          priceAtoms: (price * 1000n).toString(),
          occurredAt: entryAt,
        })),
        brokerState: {
          ...state,
          reconciliation: {
            ...previous.reconciliation,
            expectedHash: hash,
            observedHash: hash,
          },
        },
      }),
    )
    const query = Result.getOrThrow(
      jevPricingQuery(
        managed.draft,
        managed.protocol,
        managed.snapshot.manifest.calendar,
        at,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const raw = makeIntradayMomentumTestSnapshot(managed.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.05 })
    const stopPrice = Number(plan.levels.stopPriceMicros) / 1_000_000
    const nextRaw = {
      ...raw,
      quotes: raw.quotes.map((quote) => {
        const next = quoteTransform(stopPrice)
        return {
          ...quote,
          ...(next.feed === undefined ? {} : { feed: next.feed }),
          bidPrice: next.bidPrice,
          askPrice: next.askPrice,
          ...(next.bidSize === undefined ? {} : { bidSize: next.bidSize }),
          ...(next.askSize === undefined ? {} : { askSize: next.askSize }),
        }
      }),
    }
    const snapshot = streamingFixtureFromRaw(nextRaw, query).snapshot
    const target = Result.getOrThrow(
      decideJevExit({
        cycleId: managed.draft.identity.cycleId,
        sessionDate: managed.snapshot.manifest.sessionDate,
        protocol: managed.protocol,
        portfolio,
        observedAt: at,
        trigger: {
          reason: JevExitReason.ProtectiveStop,
          manifest: snapshot.manifest,
          rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
        },
      }),
    )
    return { plan, target }
  }

  test('defers canceling armed long protection for wide single-sided IEX bid excursions below stop', () => {
    const { plan, target } = buildLongStopTarget((bid, stopPrice) => ({
      bidPrice: Math.min(bid, stopPrice - 0.1),
      askPrice: stopPrice + 0.15,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(false)
  })

  test('defers canceling armed long protection when narrow IEX bid touches stop while ask remains above stop', () => {
    const { plan, target } = buildLongStopTarget((_bid, stopPrice) => ({
      bidPrice: stopPrice,
      askPrice: stopPrice + 0.01,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(false)
  })

  test('cancels armed long protection when both IEX bid and ask cross stop in a genuine break/gap', () => {
    const { plan, target } = buildLongStopTarget((_bid, stopPrice) => ({
      bidPrice: stopPrice - 0.15,
      askPrice: stopPrice - 0.05,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(true)
  })

  test('preserves nanosecond instant ordering across mixed millisecond and nanosecond quote timestamps', () => {
    const { plan, target } = buildLongStopTarget((_bid, stopPrice) => ({
      bidPrice: stopPrice - 0.15,
      askPrice: stopPrice + 0.15,
    }))
    const trigger = target.evidence.trigger
    if (trigger.reason !== JevExitReason.ProtectiveStop) throw new Error('Expected protective stop trigger')
    const baseQuote = trigger.rows.quotes[0] as Record<string, unknown>
    const stopPrice = Number(plan.levels.stopPriceMicros) / 1_000_000
    const earlierMillisecond = {
      ...baseQuote,
      event_at: '2026-09-04T14:30:31.123Z',
      bid_price: stopPrice - 0.15,
      ask_price: stopPrice + 0.15,
    }
    const laterNanosecond = {
      ...baseQuote,
      event_at: '2026-09-04T14:30:31.123000001Z',
      bid_price: stopPrice - 0.15,
      ask_price: stopPrice - 0.05,
    }
    for (const quotes of [
      [earlierMillisecond, laterNanosecond],
      [laterNanosecond, earlierMillisecond],
    ]) {
      const mixedTarget = {
        ...target,
        evidence: {
          ...target.evidence,
          trigger: {
            ...trigger,
            rows: {
              ...trigger.rows,
              quotes,
            },
          },
        },
      }
      expect(armedNativeProtectionRequiresStopCancellation(mixedTarget, plan)).toBe(true)
    }
  })

  test('fails safe and cancels armed protection when opposite IEX size is zero', () => {
    const { plan, target } = buildLongStopTarget((_bid, stopPrice) => ({
      bidPrice: stopPrice - 0.1,
      askPrice: stopPrice + 0.15,
      askSize: 0,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(true)
  })

  test('defers canceling armed short protection for wide single-sided IEX ask spikes while bid stays below stop', () => {
    const { plan, target } = buildShortStopTarget((stopPrice) => ({
      bidPrice: stopPrice - 0.15,
      askPrice: stopPrice + 0.15,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(false)
  })

  test('cancels armed short protection when both IEX bid and ask cross above stop', () => {
    const { plan, target } = buildShortStopTarget((stopPrice) => ({
      bidPrice: stopPrice + 0.05,
      askPrice: stopPrice + 0.15,
    }))
    expect(armedNativeProtectionRequiresStopCancellation(target, plan)).toBe(true)
  })

  test('never suppresses profit-target exits', () => {
    const held = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
    if (held.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected managed portfolio')
    const plan = Result.getOrThrow(jevManagedExitPlan(held.portfolio))
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
    const raw = makeIntradayMomentumTestSnapshot(held.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.051 })
    const snapshot = streamingFixtureFromRaw(
      { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, eventAt: observedAt, ingestedAt: observedAt })) },
      query,
    ).snapshot
    const profitTarget = Result.getOrThrow(
      decideJevExit({
        cycleId: held.draft.identity.cycleId,
        sessionDate: held.snapshot.manifest.sessionDate,
        protocol: held.protocol,
        portfolio: held.portfolio,
        observedAt,
        trigger: {
          reason: JevExitReason.ProfitTarget,
          manifest: snapshot.manifest,
          rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
        },
      }),
    )
    expect(armedNativeProtectionRequiresStopCancellation(profitTarget, plan)).toBe(true)
  })
})

describe('fill-anchored protection reanchor cancel classification', () => {
  const bracketProtection = {
    _tag: 'Bracket' as const,
    stopPriceMicros: '490000000',
    stopLimitPriceMicros: '485000000',
    profitLimitPriceMicros: '575000000',
  }
  const shortBracketProtection = {
    _tag: 'EquityShortBracket' as const,
    stopPriceMicros: '510000000',
    stopLimitPriceMicros: '515000000',
    profitLimitPriceMicros: '425000000',
  }
  const ocoProtection = {
    _tag: 'Oco' as const,
    stopPriceMicros: '490000000',
    stopLimitPriceMicros: '485000000',
    profitLimitPriceMicros: '575000000',
    entryDecisionHash: 'a'.repeat(64),
  }

  test('preserves reanchor intent when draining a remaining bracket profit child after the stop child canceled', () => {
    for (const owner of [bracketProtection, shortBracketProtection]) {
      expect(
        shouldReanchorProtectionCancel({
          fillAnchored: true,
          closeDue: false,
          exitRequested: false,
          quantityAtoms: 10_000_000_000n,
          action: { _tag: 'Arm', method: 'OCO', quantityAtoms: 10_000_000_000n },
          protection: { _tag: 'Absent' },
          orderOwnerProtection: owner,
        }),
      ).toBe(true)
    }
  })

  test('marks initial armed bracket cancellation as reanchor and rejects exits, close windows, flat inventory, and non-bracket orders', () => {
    expect(
      shouldReanchorProtectionCancel({
        fillAnchored: true,
        closeDue: false,
        exitRequested: false,
        quantityAtoms: 10_000_000_000n,
        action: { _tag: 'CancelProtection', intentId: 'entry-1' },
        protection: {
          _tag: 'Armed',
          intentId: 'entry-1',
          method: 'BRACKET',
          quantityAtoms: 10_000_000_000n,
          stopPriceMicros: 490_000_000n,
          stopLimitPriceMicros: 485_000_000n,
          profitLimitPriceMicros: 575_000_000n,
        },
        orderOwnerProtection: bracketProtection,
      }),
    ).toBe(true)

    expect(
      shouldReanchorProtectionCancel({
        fillAnchored: true,
        closeDue: false,
        exitRequested: true,
        quantityAtoms: 10_000_000_000n,
        action: { _tag: 'Liquidate', quantityAtoms: 10_000_000_000n },
        protection: { _tag: 'Absent' },
        orderOwnerProtection: bracketProtection,
      }),
    ).toBe(false)

    expect(
      shouldReanchorProtectionCancel({
        fillAnchored: true,
        closeDue: true,
        exitRequested: false,
        quantityAtoms: 10_000_000_000n,
        action: { _tag: 'Arm', method: 'OCO', quantityAtoms: 10_000_000_000n },
        protection: { _tag: 'Absent' },
        orderOwnerProtection: bracketProtection,
      }),
    ).toBe(false)

    expect(
      shouldReanchorProtectionCancel({
        fillAnchored: true,
        closeDue: false,
        exitRequested: false,
        quantityAtoms: 0n,
        action: { _tag: 'Complete' },
        protection: { _tag: 'Absent' },
        orderOwnerProtection: bracketProtection,
      }),
    ).toBe(false)

    expect(
      shouldReanchorProtectionCancel({
        fillAnchored: true,
        closeDue: false,
        exitRequested: false,
        quantityAtoms: 10_000_000_000n,
        action: { _tag: 'Arm', method: 'OCO', quantityAtoms: 10_000_000_000n },
        protection: { _tag: 'Absent' },
        orderOwnerProtection: ocoProtection,
      }),
    ).toBe(false)
  })
})
