import { expect, test } from 'bun:test'
import { Clock, Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'
import fc from 'fast-check'

import { AssetClass, AssetExchange, AssetStatus, OrderStatus } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import type { IntradayQuote } from '../market-data/intraday/model'
import { observedQuoteAt, type ObservedMarketValue } from '../market-data/streaming/projection'
import { checkAsyncProperty } from '../testing/property-test-support'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { utcInstantFromEpochMillis } from '../time'
import { makeReplayBroker, type ReplayBrokerConfig } from './broker'
import { driveReplaySession } from './session'

const at = '2026-09-04T14:31:00.000Z'
const start = Date.parse(at)
const runId = 'a'.repeat(64)
const { protocol, snapshot } = streamingFixture()
const original = snapshot.quotes.find((quote) => quote.symbol === 'AAPL')
if (original === undefined) throw new Error('Missing AAPL fixture quote')
const quote = (delay: number, price: number, size: number, offset: string): ObservedMarketValue<IntradayQuote> => {
  const value: IntradayQuote = {
    ...original,
    eventAt: utcInstantFromEpochMillis(start + delay),
    ingestedAt: utcInstantFromEpochMillis(start + delay),
    bidPrice: price,
    askPrice: price,
    bidSize: size,
    askSize: size,
    sourceOffset: offset,
  }
  return {
    value,
    availableAtMs: start + delay,
    sequence: Number(offset) + 1,
    recordHash: Result.getOrThrow(canonicalHashV1Result(value)),
  }
}
const asset = Result.getOrThrow(
  normalizeAssetResult(
    {
      id: '12345678-1234-4234-8234-123456789abc',
      symbol: 'AAPL',
      class: AssetClass.UsEquity,
      exchange: AssetExchange.Nasdaq,
      status: AssetStatus.Active,
      tradable: true,
      fractionable: true,
    },
    'AAPL',
    at,
  ),
)

test('property: DAY partial fills conserve the account across quote retries, cancellation and restart', async () => {
  await checkAsyncProperty(
    'day-order-lifetime',
    fc.asyncProperty(
      fc.record({
        quantity: fc.integer({ min: 1, max: 20 }),
        cancelBefore: fc.integer({ min: 0, max: 10 }),
        quotes: fc.array(
          fc.record({
            cents: fc.integer({ min: 9900, max: 10100 }),
            size: fc.integer({ min: 0, max: 5 }),
            elapsedSeconds: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 2, maxLength: 10 },
        ),
      }),
      async (input) => {
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* TestClock.setTime(start)
            const retained = [quote(0, 101, 100, '0')]
            const config: ReplayBrokerConfig = {
              runId,
              sourceManifestHash: 'c'.repeat(64),
              protocol,
              openingCashMicros: '10000000000',
              assumptions: {
                latencyMs: 100,
                slippageBps: 0,
                availableLiquidityPpm: 1_000_000,
                feeMultiplierPpm: 1_000_000,
              },
              fractionalTrading: false,
              assets: [asset],
              calendar: [
                { date: '2026-09-04', open: '09:30', close: '16:00', session_open: '0930', session_close: '1600' },
              ],
              quoteAt: (symbol, now, source) =>
                Effect.succeed(observedQuoteAt({ quoteHistory: new Map([[symbol, retained]]) }, symbol, now, source)),
              advanceToArrival: (now) => TestClock.setTime(now),
            }
            let broker = yield* makeReplayBroker(config)
            const order: Intent = {
              schemaVersion: 'bayn.execution-intent.v5',
              intentId: '1'.repeat(64),
              riskDecisionId: '6'.repeat(64),
              authorityGenerationHash: '2'.repeat(64),
              cycleId: '3'.repeat(64),
              decisionHash: '4'.repeat(64),
              policyHash: '5'.repeat(64),
              strategyName: 'jev',
              accountId: broker.accountId,
              clientOrderId: 'day-property',
              symbol: 'AAPL',
              side: OrderSide.Buy,
              orderType: OrderType.Limit,
              timeInForce: TimeInForce.Day,
              quantityAtoms: String(BigInt(input.quantity) * 1_000_000_000n),
              notionalLimitMicros: String(input.quantity * 100_000_000),
              limitPriceMicros: (
                (BigInt(String(input.quantity * 100_000_000)) * 1000000000n) /
                BigInt(String(BigInt(input.quantity) * 1_000_000_000n))
              ).toString(),
              state: IntentState.IoStarted,
              createdAt: at,
            }
            const submitted = yield* broker.mutation.submit(order)
            let now = start + 1_000
            for (const [index, next] of input.quotes.entries()) {
              now += next.elapsedSeconds * 1_000
              yield* TestClock.setTime(now)
              if (index === input.cancelBefore) yield* broker.mutation.cancel(submitted.order.brokerOrderId)
              const incoming = quote(now - start, next.cents / 100, next.size, String(index + 1))
              retained.push(incoming)
              yield* broker.observeMarket(now, incoming)
              const beforeRetry = yield* broker.snapshot
              const mark = yield* broker.valuationAt(utcInstantFromEpochMillis(now))
              expect(mark.openOrderCount).toBe(
                beforeRetry.orders.filter(({ order }) =>
                  [OrderStatus.New, OrderStatus.PartiallyFilled].includes(order.status),
                ).length,
              )
              expect(mark.equityMicros).toBe((yield* broker.read.account).value.equityMicros)
              expect(yield* broker.snapshot).toEqual(beforeRetry)
              yield* broker.observeMarket(now, incoming)
              expect(yield* broker.snapshot).toEqual(beforeRetry)
              if (index === Math.floor(input.quotes.length / 2)) {
                const checkpoint = yield* broker.checkpoint
                broker = yield* makeReplayBroker({
                  ...config,
                  restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
                })
                expect(yield* broker.snapshot).toEqual(beforeRetry)
              }
            }
            const state = yield* broker.snapshot
            const filled = state.ledger.fills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
            const spent = state.ledger.fills.reduce((sum, fill) => sum + BigInt(fill.notionalMicros), 0n)
            expect(filled).toBeLessThanOrEqual(BigInt(order.quantityAtoms))
            expect(state.ledger.positions.reduce((sum, position) => sum + BigInt(position.quantityAtoms), 0n)).toBe(
              filled,
            )
            expect(BigInt(state.ledger.cashMicros) + spent + BigInt(state.ledger.executionFeesMicros)).toBe(
              BigInt(config.openingCashMicros),
            )
            for (const fill of state.ledger.fills) {
              const source = retained.find((entry) => entry.value.sourceOffset === fill.quoteSource.offset)
              if (source === undefined) throw new Error('Fill lost its source quote')
              expect(BigInt(fill.quantityAtoms)).toBeLessThanOrEqual(BigInt(source.value.askSize) * 1_000_000_000n)
              expect(BigInt(fill.priceMicros)).toBeLessThanOrEqual(100_000_000n)
            }
            expect(new Set(state.fills.map((fill) => fill.activityId)).size).toBe(state.fills.length)
            expect(new Set(state.fees.map((fee) => fee.activityId)).size).toBe(state.fees.length)
            yield* broker.checkpoint
          }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
        )
      },
    ),
  )
}, 150_000)

test('property: UTC reports preserve continuous production polls with measured command latency', async () => {
  await checkAsyncProperty(
    'continuous-report-polling',
    fc.asyncProperty(
      fc.record({
        before: fc.integer({ min: 1, max: 2000 }),
        after: fc.integer({ min: 1, max: 2000 }),
        delay: fc.integer({ min: 100, max: 500 }),
        latency: fc.integer({ min: 0, max: 25 }),
      }),
      async ({ before, after, delay, latency }) => {
        const boundary = Date.parse('2026-10-19T00:00:00.000Z')
        const open = boundary - before
        const close = boundary + after
        const execute = (split: boolean) =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* TestClock.setTime(open)
              const polls: number[] = []
              const runtime = {
                nextDelayMs: delay,
                advance: Effect.gen(function* () {
                  const at = yield* Clock.currentTimeMillis
                  polls.push(at)
                  yield* TestClock.setTime(at + latency)
                  return {
                    observation: {
                      result: 'SUCCESS' as const,
                      outcome: 'WINDOW_CLOSED' as const,
                      observedAt: utcInstantFromEpochMillis(at),
                    },
                  }
                }),
              }
              let next = open
              if (split)
                next = (yield* driveReplaySession(runtime, (at) => TestClock.setTime(at), open, boundary, false))
                  .nextPollAtMs
              yield* driveReplaySession(
                runtime,
                (at) => TestClock.setTime(at),
                Math.max(next, yield* Clock.currentTimeMillis),
                close,
                true,
              )
              return polls
            }).pipe(Effect.provide(TestClock.layer())),
          )
        expect(await execute(true)).toEqual(await execute(false))
      },
    ),
  )
}, 150_000)
