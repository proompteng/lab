import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Result } from 'effect'

import { operationalError, retryableOperationalError } from '../errors'
import {
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
  type IntradayMarketDataService,
  type IntradaySnapshotRequest,
  type IntradaySnapshotQuery,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { decodeDefaultIntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { OrderSide } from '../execution/contracts'
import { runIntradayReplay } from './program'
import type { IntradayReplayInput } from './model'

const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
const sessionDates = ['2026-09-04', '2026-09-05'] as const
const finalizedNow = '2026-09-06T00:00:00.000Z'
const initialCapitalMicros = '2000000000'
const defaultAssumptions = {
  pollIntervalMs: 30_000,
  firstPollDelayMs: 2_000,
  orderLatencyMs: 1_000,
  availableLiquidityPpm: 1_000_000,
  slippageBps: 0,
  feeMultiplierPpm: 1_000_000,
} as const

type ReplayPhase = 'decision' | 'entry-pricing' | 'liquidation'
type SnapshotFactory = (
  request: IntradaySnapshotRequest,
  phase: ReplayPhase,
  phaseOccurrence: number,
) => ArchiveVerifiedIntradayMarketSnapshot
type ArchiveFailureMode = 'retryable-entry' | 'defect-entry'

const snapshotFor = (
  request: IntradaySnapshotRequest,
  premiums: Readonly<Record<string, number>> = {},
  bidSizes: Readonly<Record<string, number>> = {},
): ArchiveVerifiedIntradayMarketSnapshot =>
  makeIntradayMomentumTestSnapshot(protocol, request, premiums, 100, bidSizes) as ArchiveVerifiedIntradayMarketSnapshot

const phaseFor = (request: IntradaySnapshotQuery): ReplayPhase => {
  if (request.purpose === undefined) return 'decision'
  return request.purpose === IntradaySnapshotPurpose.Liquidation ? 'liquidation' : 'entry-pricing'
}

const makeArchive = (options: { readonly snapshot?: SnapshotFactory; readonly failure?: ArchiveFailureMode } = {}) => {
  const requests: IntradaySnapshotQuery[] = []
  const phaseOccurrences = new Map<string, number>()
  let archiveCalls = 0
  const captureVersion = (_query: IntradaySnapshotQuery) => {
    archiveCalls += 1
    return Effect.succeed(
      Object.values(protocol.sourceTopics)
        .sort()
        .map((sourceTopic) => ({ sourceTopic, sourcePartition: 0, inclusiveLastOffset: '100' })),
    )
  }
  const loadSnapshot = (request: IntradaySnapshotRequest) => {
    archiveCalls += 1
    requests.push(request)
    const phase = phaseFor(request)
    const key = `${request.sessionDate}:${phase}`
    const phaseOccurrence = phaseOccurrences.get(key) ?? 0
    phaseOccurrences.set(key, phaseOccurrence + 1)
    if (phase === 'decision' && options.failure !== undefined) {
      const snapshotFailure = new IntradaySnapshotFailure({
        reason: options.failure === 'retryable-entry' ? 'not-ready' : 'coverage',
        message:
          options.failure === 'retryable-entry'
            ? 'entry archive is not yet complete'
            : 'entry archive contains an impossible row set',
      })
      const errorFactory = options.failure === 'retryable-entry' ? retryableOperationalError : operationalError
      return Effect.fail(
        errorFactory({
          component: 'market-data',
          operation: 'load-intraday',
          message: snapshotFailure.message,
          cause: snapshotFailure,
        }),
      )
    }
    return Effect.succeed(
      options.snapshot?.(request, phase, phaseOccurrence) ??
        snapshotFor(request, phase === 'decision' ? { AAPL: 0.01 } : {}),
    )
  }
  const service: IntradayMarketDataService = {
    check: Effect.void,
    captureVersion,
    loadSnapshot,
    verifyArchiveSnapshot: (snapshot) => Effect.succeed(snapshot as ArchiveVerifiedIntradayMarketSnapshot),
  }
  return {
    service,
    requests,
    get archiveCalls() {
      return archiveCalls
    },
  }
}

const replayInput = (dates: readonly string[], overrides: Partial<IntradayReplayInput> = {}): IntradayReplayInput => {
  const start = dates[0] ?? '2026-09-04'
  const end = dates.at(-1) ?? start
  return {
    schemaVersion: 'bayn.intraday-replay-input.v1',
    range: { start, end },
    calendar: dates.map((date) => ({ date, open: '09:30', close: '16:00' })),
    initialCapitalMicros,
    allocationCapitalMicros: initialCapitalMicros,
    assumptions: defaultAssumptions,
    ...overrides,
  } as IntradayReplayInput
}

const run = (input: IntradayReplayInput, archive: ReturnType<typeof makeArchive>, now = finalizedNow) =>
  Effect.runPromise(runIntradayReplay(input, archive.service, now))

const runFailure = async (input: IntradayReplayInput, archive: ReturnType<typeof makeArchive>, now = finalizedNow) =>
  Effect.runPromise(Effect.flip(runIntradayReplay(input, archive.service, now)))

const entryAndCloseSnapshot: SnapshotFactory = (request, phase, occurrence) => {
  if (phase === 'decision') return snapshotFor(request, { AAPL: 0.01 })
  if (phase === 'entry-pricing') return snapshotFor(request)
  return snapshotFor(request, occurrence % 2 === 0 ? { AAPL: 0.01 } : {})
}

describe('intraday replay program', () => {
  test('uses the planned entry limit and arrival quote without lookahead', async () => {
    const archive = makeArchive({
      snapshot: (request, phase, occurrence) => {
        if (phase === 'decision') return snapshotFor(request, { AAPL: 0.01 })
        if (phase === 'entry-pricing' && occurrence === 0) return snapshotFor(request)
        if (phase === 'entry-pricing' && occurrence === 1) return snapshotFor(request, { AAPL: 0.01 })
        throw new Error(`unexpected replay phase ${phase}:${occurrence}`)
      },
    })

    const report = await run(replayInput(['2026-09-04']), archive)
    const session = report.sessions[0]
    const order = session?.orders[0]
    expect(session).toMatchObject({
      status: 'COMPLETE',
      fills: [],
      cashMicros: initialCapitalMicros,
      netRealizedPnlAfterCostsMicros: '0',
    })
    expect(order).toMatchObject({
      status: 'canceled',
      reason: 'adverse-price-exceeds-limit',
      side: OrderSide.Buy,
      limitPriceMicros: '100010000',
      submittedAt: '2026-09-04T14:30:02.000Z',
      observedAt: '2026-09-04T14:30:03.000Z',
    })
    expect(archive.requests).toHaveLength(3)
    expect(archive.requests.map(({ purpose, observedAt }) => [purpose, observedAt])).toEqual([
      [undefined, '2026-09-04T14:30:02.000Z'],
      [IntradaySnapshotPurpose.EntryPricing, '2026-09-04T14:30:02.000Z'],
      [IntradaySnapshotPurpose.EntryPricing, '2026-09-04T14:30:03.000Z'],
    ])
  })

  test('keeps an IOC close causal when the arrival bid falls below the planned limit', async () => {
    const archive = makeArchive({ snapshot: entryAndCloseSnapshot })
    const report = await run(replayInput(sessionDates), archive)
    const first = report.sessions[0]
    const following = report.sessions[1]
    const closeOrder = first?.orders.find(({ side }) => side === OrderSide.Sell)
    expect(first).toMatchObject({
      status: 'INCOMPLETE',
      netRealizedPnlAfterCostsMicros: null,
      fills: [{ side: 'buy', quantityMicros: '1000000' }],
      positions: [{ symbol: 'AAPL', quantityMicros: '1000000' }],
    })
    expect(closeOrder).toMatchObject({
      status: 'canceled',
      reason: 'adverse-price-exceeds-limit',
      side: OrderSide.Sell,
      limitPriceMicros: '100990000',
    })
    expect(closeOrder).not.toHaveProperty('fillPriceMicros')
    expect(following).toMatchObject({
      status: 'INCOMPLETE',
      reason: 'skipped after an earlier incomplete session',
      orders: [],
      positions: [{ symbol: 'AAPL', quantityMicros: '1000000' }],
      netRealizedPnlAfterCostsMicros: null,
    })
    expect(new Set(archive.requests.map(({ sessionDate }) => sessionDate))).toEqual(new Set(['2026-09-04']))
  })

  test('carries exact fee-costed profit and loss across complete sessions', async () => {
    const archive = makeArchive({
      snapshot: (request, phase, _occurrence) => {
        if (phase === 'decision') return snapshotFor(request, { AAPL: 0.01 })
        if (phase === 'entry-pricing') return snapshotFor(request)
        return snapshotFor(request, request.sessionDate === '2026-09-04' ? { AAPL: 0.01 } : {})
      },
    })
    const report = await run(replayInput(sessionDates), archive)
    const profitable = report.sessions[0]
    const losing = report.sessions[1]
    expect(profitable).toMatchObject({
      status: 'COMPLETE',
      fills: [
        { side: 'buy', notionalMicros: '100010000' },
        { side: 'sell', notionalMicros: '100990000' },
      ],
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: '950000',
      cashMicros: '2000950000',
    })
    expect(losing).toMatchObject({
      status: 'COMPLETE',
      fills: [
        { side: 'buy', notionalMicros: '100010000' },
        { side: 'sell', notionalMicros: '99990000' },
      ],
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: '-50000',
      cashMicros: '2000900000',
    })
    expect(report.totals).toMatchObject({
      completedSessionCount: 2,
      incompleteSessionCount: 0,
      executionSessionCount: 2,
      netRealizedPnlAfterCostsMicros: '900000',
    })
  })

  test('keeps an unavailable entry window incomplete instead of calling it no-trade', async () => {
    const archive = makeArchive({ failure: 'retryable-entry' })
    const report = await run(replayInput(['2026-09-04']), archive)
    const session = report.sessions[0]
    expect(session?.status).toBe('INCOMPLETE')
    expect(session?.reason).toContain('entry evidence incomplete')
    expect(session?.orders).toEqual([])
    expect(session?.fills).toEqual([])
    expect(report.totals).toMatchObject({ completedSessionCount: 0, incompleteSessionCount: 1 })
    expect(archive.archiveCalls).toBeGreaterThan(0)
  })

  test('retains the failing IOC field and reason in incomplete evidence', async () => {
    const archive = makeArchive({
      snapshot: (request, phase, occurrence) => {
        const snapshot = snapshotFor(request, phase === 'decision' ? { AAPL: 0.01 } : {})
        if (phase !== 'entry-pricing' || occurrence === 0) return snapshot
        const quote = snapshot.latestQuotes['AAPL']
        if (quote === undefined) throw new Error('fixture requires AAPL')
        return {
          ...snapshot,
          latestQuotes: { AAPL: { ...quote, eventAt: '2026-09-04T15:00:00.000Z' } },
        }
      },
    })
    const report = await run(replayInput(['2026-09-04']), archive)
    expect(report.sessions[0]).toMatchObject({ status: 'INCOMPLETE', orders: [], fills: [] })
    expect(report.sessions[0]?.observations.at(-1)).toMatchObject({
      kind: 'unavailable',
      purpose: 'arrival',
      reason: 'execution',
      message: 'arrivalSnapshot.latestQuotes.AAPL.eventAt: future-quote',
      retryable: false,
    })
  })

  test('lets an explicit allocation cap change whole-share quantity without changing canceled cash', async () => {
    const makeCanceledArchive = () =>
      makeArchive({
        snapshot: (request, phase, occurrence) => {
          if (phase === 'decision') return snapshotFor(request, { AAPL: 0.01 })
          if (phase === 'entry-pricing' && occurrence === 0) return snapshotFor(request)
          if (phase === 'entry-pricing') return snapshotFor(request, { AAPL: 0.01 })
          throw new Error(`unexpected replay phase ${phase}:${occurrence}`)
        },
      })
    const uncappedArchive = makeCanceledArchive()
    const cappedArchive = makeCanceledArchive()
    const uncapped = await run(
      replayInput(['2026-09-04'], { allocationCapitalMicros: '10000000000', initialCapitalMicros: '10000000000' }),
      uncappedArchive,
    )
    const capped = await run(
      replayInput(['2026-09-04'], { allocationCapitalMicros: '1100000000', initialCapitalMicros: '10000000000' }),
      cappedArchive,
    )
    const uncappedOrder = uncapped.sessions[0]?.orders[0]
    const cappedOrder = capped.sessions[0]?.orders[0]
    expect(uncappedOrder).toMatchObject({ status: 'canceled', requestedQuantityMicros: '9000000' })
    expect(cappedOrder).toMatchObject({ status: 'canceled', requestedQuantityMicros: '1000000' })
    expect(uncapped.sessions[0]?.cashMicros).toBe('10000000000')
    expect(capped.sessions[0]?.cashMicros).toBe('10000000000')
  })

  test('rejects empty and future calendars before touching the archive', async () => {
    const emptyArchive = makeArchive()
    const emptyFailure = await runFailure(replayInput([]), emptyArchive)
    expect(emptyFailure).toMatchObject({ operation: 'calendar' })
    expect(emptyArchive.archiveCalls).toBe(0)

    const futureArchive = makeArchive()
    const futureFailure = await runFailure(replayInput(['2026-09-04']), futureArchive, '2026-09-04T14:00:00.000Z')
    expect(futureFailure).toMatchObject({ operation: 'calendar' })
    expect(futureArchive.archiveCalls).toBe(0)
  })

  test('retains a non-retryable archive contract failure as incomplete evidence', async () => {
    const archive = makeArchive({ failure: 'defect-entry' })
    const report = await run(replayInput(['2026-09-04']), archive)
    const session = report.sessions[0]
    const unavailable = session?.observations.find(({ kind }) => kind === 'unavailable')
    expect(session).toMatchObject({
      status: 'INCOMPLETE',
      reason: expect.stringContaining('entry evidence incomplete'),
      orders: [],
      fills: [],
    })
    expect(unavailable).toMatchObject({ kind: 'unavailable', retryable: false })
  })

  test('propagates defects and interruption without emitting an economic report', async () => {
    const archive = makeArchive()
    const defect = new Error('archive invariant defect')
    const defectiveExit = await Effect.runPromiseExit(
      runIntradayReplay(
        replayInput(['2026-09-04']),
        {
          ...archive.service,
          captureVersion: () => Effect.die(defect),
        },
        finalizedNow,
      ),
    )
    expect(Exit.isFailure(defectiveExit)).toBe(true)
    if (Exit.isFailure(defectiveExit)) {
      expect(defectiveExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(
        true,
      )
      expect(defectiveExit.cause.reasons.some(Cause.isFailReason)).toBe(false)
    }
    const interruptedExit = await Effect.runPromiseExit(
      runIntradayReplay(
        replayInput(['2026-09-04']),
        {
          ...archive.service,
          captureVersion: () => Effect.interrupt,
        },
        finalizedNow,
      ),
    )
    expect(Exit.isFailure(interruptedExit)).toBe(true)
    if (Exit.isFailure(interruptedExit)) {
      expect(interruptedExit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
      expect(interruptedExit.cause.reasons.some(Cause.isFailReason)).toBe(false)
    }
  })
})
