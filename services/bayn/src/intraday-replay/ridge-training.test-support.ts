import { gzipSync } from 'node:zlib'
import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1, sha256 } from '../hash'
import { jevModel } from '../jev/contract'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { config } from '../testing/runtime-fixtures'
import { utcInstantFromEpochMillis as iso } from '../time'
import { sixBarFixture, type SixBarFixtureInput } from './six-bar-features.test-support'
import { SixBarRidgePartition } from './six-bar-ridge'
import { validateBacktestSourceReceipt, type BacktestSourceManifest } from './source'

export const ridgeTrainingFixture = (mode: 'resolved' | 'unresolved' | 'excluded' = 'resolved') => {
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const rawCalendar = (['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'] as const).map((date) => ({
    date,
    open: '09:30',
    close: '10:10',
  }))
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(rawCalendar, { start: '2026-09-01', end: '2026-09-04' }),
  )
  const trainingSessions = calendar.sessions.slice(0, 2)
  const inputs: SixBarFixtureInput[] = []
  for (const session of trainingSessions) {
    const openMs = Date.parse(session.openAt)
    for (const symbol of protocol.universe) {
      for (let minute = 0; minute < 40; minute++)
        inputs.push({
          channel: 'bars',
          symbol,
          eventAtMs: openMs + minute * 60_000,
          availableAtMs: openMs + (minute + 1) * 60_000 + 1000,
          close: 100 + minute * 0.01,
        })
      for (let second = 24 * 60; second <= 40 * 60; second += 30) {
        const atMs = openMs + second * 1000 - 1000
        const price = second >= 34 * 60 ? 98 : second >= 32 * 60 ? 99 : 100
        inputs.push({
          channel: 'quotes',
          symbol,
          eventAtMs: atMs,
          availableAtMs: atMs,
          bid: price - 0.01,
          ask: price + 0.01,
          bidSize: mode === 'unresolved' && symbol !== 'SPY' && second >= 32 * 60 ? 0 : 2,
          askSize: mode === 'excluded' && symbol !== 'SPY' ? 0 : 5,
        })
        inputs.push({ channel: 'trades', symbol, eventAtMs: atMs, availableAtMs: atMs, close: price })
      }
    }
  }
  // The session-final bar has not arrived at the training coverage end.
  const endMs = Date.parse(trainingSessions.at(-1)!.closeAt)
  const captured = sixBarFixture(
    inputs.filter((entry) => entry.availableAtMs <= endMs),
    '10:10',
  )
  const body = gzipSync(captured.events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const nativeVisiblePartitions = Object.values(captured.universe.topics)
    .sort()
    .map((topic) => ({ topic, partition: 0 }))
  const source: BacktestSourceManifest = {
    schemaVersion: 'bayn.backtest-source.v1',
    encoding: 'ndjson-gzip',
    transport: 'original-capture',
    dataSha256: sha256(body),
    recordCount: captured.events.length,
    coverageStartMs: Date.parse(trainingSessions[0]!.openAt),
    coverageEndMs: endMs,
    firstAvailableAtMs: captured.events[0]!.availableAtMs,
    lastAvailableAtMs: captured.events.at(-1)!.availableAtMs,
    origin: 'SYNTHETIC causal ridge training integration fixture, not market evidence',
    nativeVisiblePartitions,
    positions: nativeVisiblePartitions.map(({ topic, partition }) => ({
      topic,
      partition,
      startOffset: '0',
      endOffsetExclusive: String(captured.events.filter((event) => event.record.topic === topic).length),
    })),
    universe: captured.universe,
    deliveryModel: captured.source.deliveryModel,
  }
  const receiptText = JSON.stringify({
    schemaVersion: 'bayn.original-capture-replay-receipt.v1',
    recordedAt: iso(endMs + 1),
    origin: source.origin,
    coverageStartMs: source.coverageStartMs,
    coverageEndMs: source.coverageEndMs,
    universe: source.universe,
    positions: source.positions,
    nativeVisiblePartitions,
    deliveryModel: source.deliveryModel,
    sourceDataSha256: source.dataSha256,
  })
  const receipt = Result.getOrThrow(validateBacktestSourceReceipt(receiptText, sha256(receiptText)))
  const { verification: _verification, ...build } = config.build
  const input = {
    schemaVersion: 'bayn.ridge-training-input.v1',
    sampling: 'INDEPENDENT_SERIAL_FIXED_CANDIDATES',
    candidateSymbols: protocol.candidateSymbols,
    calendar: rawCalendar,
    expectedCalendarHash: calendar.normalizedResponseHash,
    sessions: calendar.sessions.map((session, index) => ({
      ...session,
      firstDecisionAt: iso(Date.parse(session.openAt) + 1_830_000),
      partition:
        index < 2
          ? SixBarRidgePartition.Training
          : index === 2
            ? SixBarRidgePartition.Validation
            : SixBarRidgePartition.Holdout,
    })),
    fitCutoffAt: '2026-09-03T00:00:00.000Z',
    allocationBudgetMicros: '20000000000',
    decisionLatencyMs: 1000,
    turnoverPolicy: EntryTurnoverPolicy.EntryAndExpectedExit,
    backtest: {
      schemaVersion: 'bayn.backtest.v3',
      source,
      openingCashMicros: '100000000000',
      fractionalTrading: false,
      inference: {
        mode: 'measured-provider',
        model: jevModel,
        inputDefinition: 'bayn.jev-trading-signal-state.v2',
        costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
      },
      allocatedDataCostPerSessionMicros: '1000000',
      replicate: 'SYNTHETIC fixed-candidate training',
      sessionDates: trainingSessions.map((session) => session.date),
      calendar: rawCalendar.slice(0, 3),
      build,
      assumptions: { latencyMs: 100, slippageBps: 1, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
      assets: protocol.universe.map((symbol, index) => ({
        id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'us_equity',
        exchange: 'NASDAQ',
        status: 'active',
        tradable: true,
        fractionable: true,
      })),
      assetObservationAt: '2026-09-01T13:29:00.000Z',
      assetObservationPolicy: 'retained-as-of-session',
      cadence: {
        pollIntervalMs: 30000,
        reconciliationIntervalMs: 30000,
        reconciliationPassTimeoutMs: 30000,
        reconciliationStaleThresholdMs: 120000,
      },
    },
  }
  return { input, body, receipt, receiptText, source, calendar, protocol, inputHash: canonicalHashV1(input) }
}
