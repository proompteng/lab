import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { canonicalHashV1Result } from '../hash'
import { studyRoundTrip } from './signal-study'
import { matchedCalendarSessions, MatchedDataRole } from './matched-entry-study'
import { continuousMarketHours } from '../market-hours'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { defaultJevProtocolDocument } from '../jev/protocol'
import { receivedCryptoFee, calculateSessionFees } from '../strategy/execution-model/fees'
import { notionalMicros } from '../strategy/execution-model/fixed-point'
import { createReplayLedger, applyReplayFill } from './ledger'
import { replayFeeActivity } from './broker-fees'
import { replayInstrument, simulateIntradayReplayExecution } from './execution-core'
import { replayTestInstruments } from '../testing/replay-instruments'
import { OrderSide } from '../execution/contracts'

const model = defaultJevProtocolDocument.executionModel
for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} deducts buy fees from received coins and sells only the net quantity across UTC midnight`, () => {
    const quantityAtoms = 33_050_000n
    const priceMicros = 2_425_310_000n
    const notional = Result.getOrThrow(notionalMicros(quantityAtoms, priceMicros))
    const buy = { symbol, side: 'buy' as const, quantityAtoms, notionalMicros: notional }
    expect(receivedCryptoFee(buy, 1_000_000n, cryptoMaximumTakerFeeBps)).toEqual({
      quantityAtoms: 82_625n,
      valueMicros: 200_392n,
      cashMicros: 0n,
    })
    const opening = Result.getOrThrow(createReplayLedger('1000000000'))
    const fill = {
      symbol,
      side: 'buy' as const,
      observedAt: '2026-10-11T23:59:00.000Z',
      quantityAtoms: String(quantityAtoms),
      priceMicros: String(priceMicros),
      notionalMicros: String(notional),
    }
    const bought = Result.getOrThrow(applyReplayFill(opening, fill, fill.quantityAtoms, model, 1_000_000))
    expect(bought.positions[0]?.quantityAtoms).toBe('32967375')
    expect(bought.cashMicros).toBe(String(1_000_000_000n - notional))
    expect(bought.executionFeesMicros).toBe('200392')
    expect(bought.positions[0]?.costBasisMicros).toBe(String(notional - 200_392n))
    expect(
      replayFeeActivity(
        'paper',
        { ...fill, brokerOrderId: 'buy', executionIndex: 1 },
        '0',
        bought.executionFeesMicros,
        1_000_000,
      ),
    ).toMatchObject({
      netAmountMicros: '0',
      coinDebit: { symbol, quantityAtoms: '82625', priceAtoms: '2425310000000' },
    })
    const sellPrice = 2_409_457_000n
    const sell = {
      ...fill,
      side: 'sell' as const,
      observedAt: '2026-10-12T00:14:00.000Z',
      quantityAtoms: '32967375',
      priceMicros: String(sellPrice),
      notionalMicros: String(Result.getOrThrow(notionalMicros(32_967_375n, sellPrice))),
    }
    const closed = Result.getOrThrow(applyReplayFill(bought, sell, sell.quantityAtoms, model, 1_000_000))
    const cashFee = 200_000n
    expect(closed.positions).toEqual([])
    expect(closed.cashMicros).toBe(String(BigInt(bought.cashMicros) + BigInt(sell.notionalMicros) - cashFee))
    expect(closed.netRealizedPnlAfterCostsMicros).toBe(String(BigInt(closed.cashMicros) - 1_000_000_000n))
    expect(closed.executionFeesMicros).toBe('400392')
    const oversell = {
      ...sell,
      quantityAtoms: String(quantityAtoms),
      notionalMicros: String(Result.getOrThrow(notionalMicros(quantityAtoms, sellPrice))),
    }
    expect(Result.isFailure(applyReplayFill(bought, oversell, oversell.quantityAtoms, model, 1_000_000))).toBeTrue()
    const fees = Result.getOrThrow(calculateSessionFees([buy], model, 2_000_000n, cryptoMaximumTakerFeeBps))
    expect(fees.cryptoMicros).toBeGreaterThan(400_000n)
    expect(fees.cashMicros).toBe(0n)
    expect(fees.secMicros + fees.tafMicros + fees.catMicros).toBe(0n)
  })

  test(`${symbol} uses frozen instrument increments and closes an exact fee-adjusted quantity`, () => {
    const instrument = Result.getOrThrow(replayInstrument(symbol, replayTestInstruments))
    const shared = {
      instrument,
      executionModel: model,
      assumptions: { slippageBps: 0, availableLiquidityPpm: 1_000_000 },
      quote: { priceMicros: 100_000_000n, displayedQuantityAtoms: 100_000_000n },
    }
    expect(
      Result.getOrThrow(
        simulateIntradayReplayExecution({
          ...shared,
          order: { side: OrderSide.Buy, quantityAtoms: 33_050_000n, limitPriceMicros: 100_000_000n },
        }),
      ),
    ).toMatchObject({ status: 'filled', filledQuantityAtoms: 33_050_000n })
    expect(
      Result.isFailure(
        simulateIntradayReplayExecution({
          ...shared,
          instrument: { ...instrument, quantityIncrementAtoms: 10000n },
          order: { side: OrderSide.Buy, quantityAtoms: 33_050_001n, limitPriceMicros: 100_000_000n },
        }),
      ),
    ).toBeTrue()
    expect(
      Result.getOrThrow(
        simulateIntradayReplayExecution({
          ...shared,
          order: { side: OrderSide.Sell, quantityAtoms: 32_967_375n, limitPriceMicros: 99_900_000n },
        }),
      ),
    ).toMatchObject({ status: 'filled', filledQuantityAtoms: 32_967_375n })
    expect(Result.isFailure(replayInstrument(symbol, {}))).toBeTrue()
  })
}

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} uses the same study lifecycle across midnight and includes both execution fees`, () => {
    const at = Date.parse('2026-10-11T23:59:00.000Z')
    const original = cryptoMarketFixture(symbol).snapshot.latestQuotes[symbol]
    if (original === undefined) throw new Error('Missing crypto quote fixture')
    const quoteAt = (time: number) => {
      const value = {
        ...original,
        eventAt: new Date(time).toISOString(),
        ingestedAt: new Date(time).toISOString(),
        bidPrice: 100,
        askPrice: 100,
      }
      return { value, sequence: 1, availableAtMs: time, recordHash: Result.getOrThrow(canonicalHashV1Result(value)) }
    }
    const result = Result.getOrThrow(
      studyRoundTrip({
        symbol,
        protocol: defaultJevProtocolDocument,
        assumptions: {
          instruments: replayTestInstruments,
          latencyMs: 100,
          slippageBps: 0,
          availableLiquidityPpm: 1_000_000,
          feeMultiplierPpm: 1_000_000,
        },
        entryBudgetMicros: '10000000000',
        holdingIntervalMs: 900_000,
        decidedAtMs: at,
        entryDecisionQuote: quoteAt(at),
        entryArrivalQuote: quoteAt(at + 100),
        exitDecisionQuote: quoteAt(at + 900_100),
        exitArrivalQuote: quoteAt(at + 900_200),
      }),
    )
    expect(result.outcome.status).toBe('RESOLVED')
    expect(result.fills.map((fill) => fill.quantityAtoms)).toEqual(['31234567', '31156480'])
    expect(result.fills[1]?.observedAt).toBe('2026-10-12T00:14:00.200Z')
    expect(result.outcome).toMatchObject({ netExecutionPnlMicros: '-17809' })
  })
}

test('continuous frozen comparison registers five consecutive UTC days including weekends without a midnight close', () => {
  const registration = {
    schemaVersion: 'bayn.matched-entry-registration.v2' as const,
    definitionHash: 'a'.repeat(64),
    sourceRevision: 'b'.repeat(40),
    protocolHash: 'c'.repeat(64),
    registeredAt: '2026-10-08T23:00:00.000Z',
    dataRole: MatchedDataRole.Prospective,
    sessionDates: ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'] as const,
    latencyMs: 100,
    executionAssumptionsHash: 'd'.repeat(64),
    latencyEvidenceHash: null,
    capacityEvidenceHash: null,
  }
  expect(Result.getOrThrow(matchedCalendarSessions(registration, [continuousMarketHours]))).toHaveLength(5)
  expect(
    Result.isFailure(
      matchedCalendarSessions({ ...registration, registeredAt: '2026-10-09T00:00:00.000Z' }, [continuousMarketHours]),
    ),
  ).toBeTrue()
  expect(
    Result.isFailure(
      matchedCalendarSessions(
        { ...registration, sessionDates: ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'] },
        [continuousMarketHours],
      ),
    ),
  ).toBeTrue()
})
