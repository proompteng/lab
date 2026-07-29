import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import type { ClickHouseClient } from '@clickhouse/client'
import { Effect, Result } from 'effect'

import {
  candidateDevelopmentCalendarContract,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  runCandidateDevelopment,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { queryCandidate12DevelopmentData } from '../candidate-12-development-command'
import { analyzeQualification, type QualificationSeries } from '../qualification-statistics'
import type { AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate12DatasetHashes,
  evaluateCandidate12Development,
  prepareCandidate12DevelopmentData,
  selectCandidate12SpecificationId,
} from './development'
import { decideCandidate12HoldoutAccess } from './holdout-access'
import {
  CANDIDATE_12_DEVELOPMENT_END,
  CANDIDATE_12_DEVELOPMENT_START,
  CANDIDATE_12_PREREGISTRATION_COMMIT,
  CANDIDATE_12_PREREGISTRATION_SHA256,
  CANDIDATE_12_SNAPSHOT_ID,
  candidate12DevelopmentSessions,
  candidate12DevelopmentStatisticsPolicy,
  candidate12PriorAttemptIds,
  candidate12Protocol,
  candidate12SelectionMultiplicity,
  candidate12Specifications,
  candidate12Universe,
  type Candidate12Bar,
  type Candidate12Dataset,
  type Candidate12Registration,
  type Candidate12Symbol,
} from './model'
import {
  buildCandidate12Plan,
  candidate12DecisionAtSignal,
  candidate12TerminalLiquidationIsComplete,
  sameCalendarMonthReturn,
} from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${JSON.stringify(result.failure)}`)
  return result.success
}

const marketBar = (
  symbol: Candidate12Symbol,
  sessionDate: IsoDate,
  open: number,
  close = open,
  volume = 1_000_000,
): DailyBar => ({
  symbol,
  sessionDate,
  open,
  high: Math.max(open, close) * 1.01,
  low: Math.min(open, close) * 0.99,
  close,
  volume,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
})

const constantAlignedFixture = (): readonly AlignedSession[] =>
  candidate12DevelopmentSessions().map((date) => ({
    date,
    bars: Object.fromEntries(candidate12Universe.map((symbol) => [symbol, marketBar(symbol, date, 100)])),
  }))

const signalIndexFor = (sessions: readonly AlignedSession[], date: IsoDate): number => {
  const index = sessions.findIndex((session) => session.date === date)
  if (index < 0) throw new Error(`missing signal date ${date}`)
  return index
}

const seasonalDecisionFixture = (): readonly AlignedSession[] => {
  const sessions = candidate12DevelopmentSessions().slice(0, 280)
  const sourceDates = sessions.filter((date) => date.startsWith('2016-02'))
  const sourceIndex = new Map(sourceDates.map((date, index) => [date, index] as const))
  const sourceReturns: Readonly<Record<Candidate12Symbol, number>> = {
    DBC: 0.12,
    EFA: 0.08,
    IEF: 0.02,
    SPY: 0.03,
    VNQ: 0.01,
  }

  return sessions.map((date) => ({
    date,
    bars: Object.fromEntries(
      candidate12Universe.map((symbol) => {
        const monthIndex = sourceIndex.get(date)
        if (monthIndex === undefined) return [symbol, marketBar(symbol, date, 100)]
        const progress = sourceDates.length === 1 ? 1 : monthIndex / (sourceDates.length - 1)
        return [symbol, marketBar(symbol, date, 100, 100 * (1 + sourceReturns[symbol] * progress))]
      }),
    ),
  }))
}

const developmentPreflight = (): CandidateDevelopmentPreflightPass => {
  const sessions = candidate12DevelopmentSessions()
  const result = successOf(
    preflightCandidateDevelopment({
      officialSessions: sessions,
      signalSessionDates: officialMonthEndSignalDates(sessions),
      featureLookbackSessions: candidate12Protocol.feature.declaredLookbackSessions,
    }),
  )
  expect(result.status).toBe('PASS')
  if (result.status !== 'PASS') throw new Error('expected passing development geometry')
  return result
}

const syntheticDataset = (): Candidate12Dataset => {
  const sessions = candidate12DevelopmentSessions()
  const monthSessions = new Map<string, IsoDate[]>()
  for (const date of sessions) {
    const month = date.slice(0, 7)
    const dates = monthSessions.get(month) ?? []
    dates.push(date)
    monthSessions.set(month, dates)
  }

  const previousClose = Object.fromEntries(candidate12Universe.map((symbol) => [symbol, 100])) as Record<
    Candidate12Symbol,
    number
  >
  const monthFirstOpen = new Map<string, Readonly<Record<Candidate12Symbol, number>>>()
  const bars: Candidate12Bar[] = []
  for (const sessionDate of sessions) {
    const month = sessionDate.slice(0, 7)
    const dates = monthSessions.get(month)
    if (dates === undefined) throw new Error(`missing month ${month}`)
    const ordinal = dates.indexOf(sessionDate)
    const progress = (ordinal + 1) / dates.length
    const year = Number(month.slice(0, 4))
    const monthNumber = Number(month.slice(5, 7))
    const nonSpy = candidate12Universe.filter((symbol): symbol is Exclude<Candidate12Symbol, 'SPY'> => symbol !== 'SPY')
    const favored = nonSpy[(year * 12 + monthNumber) % nonSpy.length]
    const firstOpens =
      monthFirstOpen.get(month) ??
      (Object.fromEntries(candidate12Universe.map((symbol) => [symbol, previousClose[symbol]])) as Readonly<
        Record<Candidate12Symbol, number>
      >)
    monthFirstOpen.set(month, firstOpens)
    for (const symbol of candidate12Universe) {
      const open = previousClose[symbol]
      const targetReturn = symbol === 'SPY' ? 0.01 : symbol === favored ? 0.05 : -0.005
      const close = firstOpens[symbol] * (1 + targetReturn * progress)
      previousClose[symbol] = close
      bars.push({
        symbol,
        sessionDate,
        open,
        high: Math.max(open, close) * 1.002,
        low: Math.min(open, close) * 0.998,
        close,
        volume: 10_000_000,
      })
    }
  }

  const hashes = successOf(candidate12DatasetHashes(sessions, bars))
  return { snapshotId: CANDIDATE_12_SNAPSHOT_ID, sessions, bars, ...hashes }
}

describe('Candidate 12 same-calendar-month seasonal excess rotation', () => {
  test('binds the immutable preregistration and singleton family', async () => {
    const bytes = await Bun.file(
      new URL('../../candidates/ordinal-12-same-calendar-month-seasonality-preregistration.md', import.meta.url),
    ).arrayBuffer()

    expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(CANDIDATE_12_PREREGISTRATION_SHA256)
    expect(CANDIDATE_12_PREREGISTRATION_COMMIT).toBe('7be1b88d8d7551c892dfdc94bb6971171e22b529')
    expect(candidate12Specifications).toEqual([
      {
        id: 'same-month-seasonal-excess-lag1',
        annualLagYears: 1,
        declaredFeatureLookbackSessions: 252,
        minimumSeasonalExcess: 0,
        selectedWeight: 1,
      },
    ])
  })

  test('freezes the exact calendar and five chronological 197-session folds', () => {
    const sessions = candidate12DevelopmentSessions()
    const geometry = developmentPreflight()

    expect(sessions).toHaveLength(1_762)
    expect(sessions.at(0)).toBe(CANDIDATE_12_DEVELOPMENT_START)
    expect(sessions.at(-1)).toBe(CANDIDATE_12_DEVELOPMENT_END)
    expect(candidateDevelopmentCalendarContract.sessionsHash).toBe(
      'a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1',
    )
    expect(geometry.firstEligibleExecution).toEqual({
      signalIndex: 271,
      signalDate: '2017-01-31',
      executionIndex: 272,
      executionDate: '2017-02-01',
    })
    expect(geometry.selectedObservationStartIndex).toBe(273)
    expect(geometry.selectedObservationStart).toBe('2017-02-02')
    expect(geometry.selectedObservationEndIndex).toBe(1_761)
    expect(geometry.folds.map((fold) => fold.testObservationCount)).toEqual([197, 197, 197, 197, 197])
    expect(
      geometry.folds.every((fold, index) => index === 0 || fold.testStart > geometry.folds[index - 1].testEnd),
    ).toBe(true)
  })

  test('computes only the prior matching calendar month within the 252-session lag', () => {
    const sessions = seasonalDecisionFixture()
    const signalIndex = signalIndexFor(sessions, '2017-01-31')
    const feature = successOf(sameCalendarMonthReturn(sessions, signalIndex, signalIndex + 1, 'DBC', 1))

    expect(feature).toEqual({
      symbol: 'DBC',
      sourceMonth: '2016-02',
      firstSession: '2016-02-01',
      lastSession: '2016-02-29',
      seasonalReturn: 0.12,
    })
    expect(sameCalendarMonthReturn(sessions, signalIndex, signalIndex + 2, 'DBC', 1)).toEqual(
      Result.fail({
        _tag: 'Candidate12InvalidInput',
        operation: 'seasonal-return',
        reason: `execution index ${signalIndex + 2} is not one session after signal ${signalIndex}`,
      }),
    )
  })

  test('selects the greatest positive seasonal excess and falls back fully to SPY', () => {
    const sessions = seasonalDecisionFixture()
    const signalIndex = signalIndexFor(sessions, '2017-01-31')
    const decision = successOf(candidate12DecisionAtSignal(sessions, signalIndex, candidate12Specifications[0]))

    expect(decision).toMatchObject({
      signalDate: '2017-01-31',
      executionDate: '2017-02-01',
      targetMonth: '2017-02',
      sourceMonth: '2016-02',
      selectedSymbol: 'DBC',
    })
    expect(decision.challengers.find(({ symbol }) => symbol === 'DBC')).toMatchObject({
      seasonalReturn: 0.12,
      seasonalExcess: 0.09,
      eligible: true,
    })
    expect(decision.weights).toEqual({ DBC: 1, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 })

    const fallbackSessions = constantAlignedFixture().slice(0, 280)
    const fallback = successOf(candidate12DecisionAtSignal(fallbackSessions, signalIndex, candidate12Specifications[0]))
    expect(fallback.selectedSymbol).toBe('SPY')
    expect(fallback.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0, SPY: 1, VNQ: 0 })
  })

  test('ignores all future bars and changes only when causal source-month bars change', () => {
    const sessions = seasonalDecisionFixture()
    const signalIndex = signalIndexFor(sessions, '2017-01-31')
    const original = successOf(candidate12DecisionAtSignal(sessions, signalIndex, candidate12Specifications[0]))
    const futureChanged = sessions.map((session, index) =>
      index <= signalIndex
        ? session
        : {
            ...session,
            bars: Object.fromEntries(
              candidate12Universe.map((symbol) => [symbol, marketBar(symbol, session.date, 1_000_000)]),
            ),
          },
    )
    expect(successOf(candidate12DecisionAtSignal(futureChanged, signalIndex, candidate12Specifications[0]))).toEqual(
      original,
    )

    const causalChanged = sessions.map((session) =>
      session.date === '2016-02-29'
        ? {
            ...session,
            bars: { ...session.bars, DBC: marketBar('DBC', session.date, 100, 101) },
          }
        : session,
    )
    expect(
      successOf(candidate12DecisionAtSignal(causalChanged, signalIndex, candidate12Specifications[0])).selectedSymbol,
    ).toBe('EFA')
  })

  test('executes every month-end decision next session and closes at the frozen terminal open', () => {
    const geometry = developmentPreflight()
    const plan = successOf(buildCandidate12Plan(constantAlignedFixture(), geometry, candidate12Specifications[0]))

    expect(plan.simulationStartIndex).toBe(272)
    expect(plan.evaluationStartIndex).toBe(273)
    expect(plan.targets.at(0)).toMatchObject({ signalIndex: 271, executionIndex: 272 })
    for (const target of plan.targets) expect(target.executionIndex).toBe(target.signalIndex + 1)
    expect(plan.targets.at(-1)).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(Object.values(plan.targets.at(-1)?.weights ?? {}).every((weight) => weight === 0)).toBe(true)
    expect(successOf(candidate12TerminalLiquidationIsComplete())).toBe(true)
  })

  test('fails preflight before preregistration or any data I/O', async () => {
    const order: string[] = []
    const sessions = candidate12DevelopmentSessions().slice(1)
    const exit = await Effect.runPromiseExit(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: candidate12Protocol.feature.declaredLookbackSessions,
        },
        {
          preregisterCandidate: () => Effect.sync(() => (order.push('preregister'), 'registration')),
          loadDevelopmentData: () => Effect.sync(() => (order.push('data'), 'dataset')),
          evaluateDevelopment: () => Effect.sync(() => (order.push('evaluate'), 'report')),
        },
      ),
    )

    expect(exit._tag).toBe('Failure')
    expect(order).toEqual([])
  })

  test('runs immutable preregistration before bounded ClickHouse I/O and evaluation', async () => {
    const sessions = candidate12DevelopmentSessions()
    const order: string[] = []
    const report = await Effect.runPromise(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: candidate12Protocol.feature.declaredLookbackSessions,
        },
        {
          preregisterCandidate: () => Effect.sync(() => (order.push('preregister'), 'registration')),
          loadDevelopmentData: () => Effect.sync(() => (order.push('data'), 'dataset')),
          evaluateDevelopment: (_data, geometry) => Effect.sync(() => (order.push('evaluate'), geometry.folds.length)),
        },
      ),
    )

    expect(report).toBe(5)
    expect(order).toEqual(['preregister', 'data', 'evaluate'])
  })

  test('materializes the bounded official calendar before the first adjusted-bar query', async () => {
    const operations: string[] = []
    const client = {
      query: async (request: {
        readonly query_id: string
        readonly query_params: Readonly<Record<string, unknown>>
      }) => {
        operations.push(`query:${request.query_id}`)
        expect(request.query_params.start).toBe(CANDIDATE_12_DEVELOPMENT_START)
        expect(request.query_params.end).toBe(CANDIDATE_12_DEVELOPMENT_END)
        expect(String(request.query_params.end) < '2023-01-03').toBe(true)
        if (request.query_id.endsWith('bars')) expect(request.query_params.symbols).toEqual(candidate12Universe)
        return {
          json: async () => {
            operations.push(`json:${request.query_id}`)
            return request.query_id.endsWith('sessions')
              ? candidate12DevelopmentSessions().map((session_date) => ({ session_date }))
              : candidate12Universe.map((symbol) => ({
                  symbol,
                  session_date: CANDIDATE_12_DEVELOPMENT_START,
                  adjusted_open: '100.00000000',
                  adjusted_high: '101.00000000',
                  adjusted_low: '99.00000000',
                  adjusted_close: '100.50000000',
                  adjusted_volume: '1000000.00000000',
                }))
          },
        }
      },
    } as unknown as ClickHouseClient

    await Effect.runPromise(queryCandidate12DevelopmentData(client))
    expect(operations).toEqual([
      'query:bayn-candidate-12-development-sessions',
      'json:bayn-candidate-12-development-sessions',
      'query:bayn-candidate-12-development-bars',
      'json:bayn-candidate-12-development-bars',
    ])
  })

  test('rejects remote calendar drift before querying any adjusted bar', async () => {
    const operations: string[] = []
    const client = {
      query: async (request: { readonly query_id: string }) => {
        operations.push(`query:${request.query_id}`)
        if (request.query_id.endsWith('bars')) throw new Error('bar query must not start')
        return {
          json: async () => {
            operations.push(`json:${request.query_id}`)
            return [{ session_date: CANDIDATE_12_DEVELOPMENT_START }]
          },
        }
      },
    } as unknown as ClickHouseClient

    const exit = await Effect.runPromiseExit(queryCandidate12DevelopmentData(client))
    expect(exit._tag).toBe('Failure')
    expect(operations).toEqual([
      'query:bayn-candidate-12-development-sessions',
      'json:bayn-candidate-12-development-sessions',
    ])
  })

  test('applies the twelfth-attempt multiplicity with exactly twenty lower-tail samples', () => {
    const sessions = candidate12DevelopmentSessions().slice(273)
    const series: QualificationSeries = {
      schemaVersion: 'bayn.qualification-series.v1',
      runId: 'f'.repeat(64),
      observations: sessions.map((sessionDate, index) => ({
        sessionDate,
        strategyReturn: index % 17 === 0 ? -0.001 : 0.0008,
        cashReturn: 0,
        buyAndHoldReturn: index % 13 === 0 ? -0.001 : 0.0002,
        directVolatilityReturn: index % 15 === 0 ? -0.0008 : 0.00025,
      })),
      rebalanceExecutionDates: sessions.filter((_date, index) => index % 21 === 0),
    }
    const analysis = successOf(
      analyzeQualification(series, candidate12DevelopmentStatisticsPolicy, candidate12PriorAttemptIds),
    )

    expect(candidate12SelectionMultiplicity).toBe(1)
    expect(candidate12PriorAttemptIds).toHaveLength(11)
    expect(candidate12PriorAttemptIds).toEqual(candidate12PriorAttemptIds.toSorted())
    expect(analysis.candidateOrdinal).toBe(12)
    expect(analysis.bootstrap.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 12, 15)
    expect(analysis.bootstrap.tailSampleCount).toBe(20)
    expect(analysis.bootstrap.producedSamples).toBe(5_000)
    expect(analysis.walkForward.folds).toHaveLength(5)
    expect(analysis.completeBlocks.every((block) => block.endSession < block.nextRebalanceSession)).toBe(true)
  })

  test('selects the singleton only after every frozen development gate passes', () => {
    const id = candidate12Specifications[0].id
    expect(
      selectCandidate12SpecificationId([
        {
          specificationId: id,
          developmentPass: true,
          annualizedExcessReturnLowerBound: 0.01,
          sharpeDifferenceLowerBound: 0.02,
          annualTurnover: 2,
        },
      ]),
    ).toBe(id)
    expect(
      selectCandidate12SpecificationId([
        {
          specificationId: id,
          developmentPass: false,
          annualizedExcessReturnLowerBound: 1,
          sharpeDifferenceLowerBound: 1,
          annualTurnover: 0,
        },
      ]),
    ).toBeNull()
  })

  test('permits holdout access exactly once only after an immutable passing lock', () => {
    expect(
      decideCandidate12HoldoutAccess({ developmentStatus: 'HOLD_REJECT', identityLocked: true, priorAccessCount: 0 }),
    ).toEqual({ status: 'DENY', reason: 'DEVELOPMENT_NOT_PASSED' })
    expect(
      decideCandidate12HoldoutAccess({ developmentStatus: 'PASS', identityLocked: false, priorAccessCount: 0 }),
    ).toEqual({ status: 'DENY', reason: 'IDENTITY_NOT_LOCKED' })
    expect(
      decideCandidate12HoldoutAccess({ developmentStatus: 'PASS', identityLocked: true, priorAccessCount: 0 }),
    ).toEqual({ status: 'ALLOW_ONCE', nextAccessCount: 1 })
    expect(
      decideCandidate12HoldoutAccess({ developmentStatus: 'PASS', identityLocked: true, priorAccessCount: 1 }),
    ).toEqual({ status: 'DENY', reason: 'HOLDOUT_ALREADY_ACCESSED' })
  })

  test('binds data, realistic costs, folds, multiplicity, and zero holdout access deterministically', () => {
    const dataset = syntheticDataset()
    expect(successOf(prepareCandidate12DevelopmentData(dataset)).sessions).toHaveLength(1_762)
    const registration: Candidate12Registration = {
      preregistrationHash: CANDIDATE_12_PREREGISTRATION_SHA256,
      preregistrationCommit: CANDIDATE_12_PREREGISTRATION_COMMIT,
      evaluatedCommit: 'a'.repeat(40),
    }
    const geometry = developmentPreflight()
    const first = successOf(evaluateCandidate12Development(registration, dataset, geometry))
    const second = successOf(evaluateCandidate12Development(registration, dataset, geometry))

    expect(second.identity).toEqual(first.identity)
    expect(first.specifications).toHaveLength(1)
    expect(first.selection).toMatchObject({
      specificationCount: 1,
      familyMultiplicityDivisor: 1,
      priorAttemptCount: 11,
    })
    expect(first.selection.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 12, 15)
    const specification = first.specifications[0]
    expect(specification.metrics.strategy.observations).toBe(1_489)
    expect(specification.metrics.strategy.totalSpreadCostMicros).not.toBe('0')
    expect(specification.metrics.strategy.totalSlippageCostMicros).not.toBe('0')
    expect(BigInt(specification.metrics.doubleCostStrategy.totalFeesMicros)).toBeGreaterThanOrEqual(
      BigInt(specification.metrics.strategy.totalFeesMicros),
    )
    expect(specification.uncertainty.producedBootstrapSamples).toBe(5_000)
    expect(specification.uncertainty.walkForwardFolds.map((fold) => fold.testObservationCount)).toEqual([
      197, 197, 197, 197, 197,
    ])
    expect(first.holdout).toEqual({
      start: '2023-01-03',
      end: '2025-12-31',
      inspected: false,
      accessCount: 0,
    })
  })
})
