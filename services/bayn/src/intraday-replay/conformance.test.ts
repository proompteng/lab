import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { desiredQuantityMicros, numberToMicros } from '../execution-model'
import { canonicalHashV1, sha256 } from '../hash'
import { archiveRecordReferences, verifyArchiveAvailabilityReceipt } from '../market-data/intraday/availability'
import { ExecutionMarketDataBindingSchema, reconstructBoundIntradaySnapshot } from '../shadow-decision-contract'
import { verifyIntradayMomentumDecisionEnvelope } from '../strategy/intraday-momentum/decision'
import { IntradayMomentumTargetPortfolioSchema } from '../strategy/intraday-momentum/model'
import { decodeIntradayMomentumProtocol, hashIntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'

test('reproduces the retained IWM decision under its original strategy identity and reader clocks', () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/2026-09-10-iwm-decision.json', import.meta.url), 'utf8'),
  )
  expect(canonicalHashV1(raw)).toBe('8bdc4ef305ac3ff214520d0aea4bca805045c0156dc5639d6520298105b14d37')
  const fixture = Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.Struct({
        sourceRevision: Schema.String,
        behaviorVersion: Schema.String,
        protocol: Schema.Unknown,
        strategyProtocolHash: Schema.String,
        decisionBinding: ExecutionMarketDataBindingSchema,
        decisionRows: Schema.Struct({
          bars: Schema.Array(Schema.Unknown),
          quotes: Schema.Array(Schema.Unknown),
          trades: Schema.Array(Schema.Unknown),
        }),
        expectedDecision: IntradayMomentumTargetPortfolioSchema,
        expectedDecisionHash: Schema.String,
        sourceCutoffAt: Schema.String,
        readerCompletedAt: Schema.String,
        planningReaderCompletedAt: Schema.String,
        submissionStartedAt: Schema.String,
        submissionAcceptedAt: Schema.String,
        arrivalAt: Schema.Null,
        allocationCapitalMicros: Schema.String,
        expectedQuantityMicros: Schema.String,
        expectedLimitPriceMicros: Schema.String,
        receipts: Schema.Array(Schema.Unknown),
      }),
    )(raw),
  )
  const protocol = Result.getOrThrow(decodeIntradayMomentumProtocol(fixture.protocol))
  const identity = Result.getOrThrow(
    makeStrategyProtocolHashResult({
      name: 'intraday-momentum',
      behaviorHash: sha256(fixture.behaviorVersion),
      parameterHash: Result.getOrThrow(hashIntradayMomentumProtocol(protocol)),
      parameterSchemaVersion: protocol.schemaVersion,
    }),
  )
  expect(identity).toBe(fixture.strategyProtocolHash)
  // This is the retained v11 decision, whose quote-age limit was 2 seconds. It is not a v13 trading result.
  expect(fixture.behaviorVersion).toBe('bayn.intraday-momentum.behavior.v11')
  expect(protocol.maximumQuoteAgeMs).toBe(2_000)
  const binding = fixture.decisionBinding
  if (binding.schemaVersion !== 'bayn.execution-market-data-binding.v2') throw new Error('expected archive binding')
  const snapshot = reconstructBoundIntradaySnapshot(binding, fixture.decisionRows)
  if (snapshot === undefined) throw new Error('retained rows do not reconstruct their bound snapshot')
  const calendar = binding.calendar.sessions.find(({ date }) => date === binding.sessionDate)
  if (calendar === undefined) throw new Error('retained session is absent from its calendar')
  expect(canonicalHashV1(fixture.expectedDecision)).toBe(fixture.expectedDecisionHash)
  expect(
    Result.isSuccess(
      verifyIntradayMomentumDecisionEnvelope(
        {
          snapshot,
          session: {
            sessionDate: binding.sessionDate,
            openAt: calendar.openAt,
            closeAt: calendar.closeAt,
            calendarHash: fixture.expectedDecision.calendarHash,
          },
        },
        protocol,
        fixture.expectedDecisionHash,
      ),
    ),
  ).toBe(true)
  expect(fixture.expectedDecision.selectedSymbols).toEqual(['IWM'])
  expect(fixture.expectedDecision.excludedCandidates?.map(({ symbol }) => symbol)).toEqual([
    'AAPL',
    'NVDA',
    'QQQ',
    'SMH',
  ])
  const quote = snapshot.latestQuotes['IWM']
  if (quote === undefined) throw new Error('retained IWM pricing is absent')
  const ask = Result.getOrThrow(numberToMicros(quote.askPrice, 'retained IWM ask'))
  expect(ask.toString()).toBe(fixture.expectedLimitPriceMicros)
  const quantity = Result.getOrThrow(
    desiredQuantityMicros(BigInt(fixture.allocationCapitalMicros), 0.1, ask, protocol.executionModel),
  )
  expect(quantity.toString()).toBe(fixture.expectedQuantityMicros)
  const references = Result.getOrThrow(archiveRecordReferences(snapshot))
  const receipts = fixture.receipts.map((receipt) => Result.getOrThrow(verifyArchiveAvailabilityReceipt(receipt)))
  expect(references).toHaveLength(223)
  expect(receipts).toHaveLength(references.length)
  const byId = new Map(receipts.map((receipt) => [receipt.recordId, receipt]))
  for (const reference of references) {
    expect(byId.get(reference.recordId)?.recordContentHash).toBe(reference.recordContentHash)
  }
  const latestReceipt = receipts
    .map(({ availableAt }) => availableAt)
    .sort()
    .at(-1)
  expect(latestReceipt).toBe(fixture.readerCompletedAt)
  expect(fixture.readerCompletedAt > fixture.sourceCutoffAt).toBe(true)
  expect(fixture.planningReaderCompletedAt > fixture.readerCompletedAt).toBe(true)
  expect(fixture.submissionStartedAt > fixture.planningReaderCompletedAt).toBe(true)
  expect(Date.parse(fixture.submissionStartedAt) - Date.parse(fixture.sourceCutoffAt)).toBe(8_745)
  expect(fixture.submissionAcceptedAt > fixture.submissionStartedAt).toBe(true)
  expect(fixture.arrivalAt).toBeNull()
})
