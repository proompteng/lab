import { describe, expect, test } from 'bun:test'
import type { ClickHouseClient } from '@clickhouse/client'
import { Effect, Result } from 'effect'

import { officialMonthEndSignalDates, preflightCandidateDevelopment } from '../../candidate-development'
import { frozenCandidateDevelopmentSessions } from '../../candidate-development-calendar'
import { makeOrderOutcome } from '../../execution-model'
import { canonicalHashV1Result } from '../../hash'
import type { AlignedSession } from '../../simulation'
import { ContractVersion, DataFeed, DataSource, PriceAdjustment, PublicationSchema, type IsoDate } from '../../types'
import {
  CANDIDATE_16_ORDINAL,
  CANDIDATE_16_PRIOR_TRIAL_COUNT,
  CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
  candidate16SimulationProtocol,
  candidate16StrategyProtocolMaterial,
  candidate16Universe,
  type Candidate16Symbol,
} from './model'
import { queryCandidate16DevelopmentBars, queryCandidate16FinalizedSnapshot } from './program'
import { buildCandidate16Plan, candidate16FeatureAtSignal } from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected Result success')
  return result.success
}

const sessionsWithReturns = (
  finalReturns: Readonly<Record<Candidate16Symbol, number>>,
  dates: readonly IsoDate[] = frozenCandidateDevelopmentSessions().slice(0, 127),
): readonly AlignedSession[] =>
  dates.map((date, index) => ({
    date,
    bars: Object.fromEntries(
      candidate16Universe.map((symbol) => {
        const close = 100 * (1 + (finalReturns[symbol] * index) / (dates.length - 1))
        return [
          symbol,
          {
            symbol,
            sessionDate: date,
            open: close,
            high: close * 1.001,
            low: close * 0.999,
            close,
            volume: 1_000_000,
            source: DataSource.Alpaca,
            sourceFeed: DataFeed.Sip,
            adjustment: PriceAdjustment.All,
            publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
          },
        ]
      }),
    ) as AlignedSession['bars'],
  }))

const candidate16Preflight = () => {
  const dates = frozenCandidateDevelopmentSessions()
  const preflight = successOf(
    preflightCandidateDevelopment({
      candidateOrdinal: CANDIDATE_16_ORDINAL,
      priorTrialCount: CANDIDATE_16_PRIOR_TRIAL_COUNT,
      expectedStrategyProtocolHash: CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
      officialSessions: dates,
      signalSessionDates: officialMonthEndSignalDates(dates),
      featureLookbackSessions: 126,
    }),
  )
  expect(preflight.status).toBe('PASS')
  if (preflight.status !== 'PASS') throw new Error('expected passing preflight')
  return preflight
}

describe('Candidate 16 macro breadth regime', () => {
  test('binds the exact source-controlled strategy protocol hash', () => {
    expect(successOf(canonicalHashV1Result(candidate16StrategyProtocolMaterial))).toBe(
      CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
    )
  })

  test('classifies growth, inflation defense, and defense ties without ranking', () => {
    const growth = successOf(
      candidate16FeatureAtSignal(sessionsWithReturns({ DBC: 0.02, EFA: 0.05, IEF: 0.03, SPY: 0.1, VNQ: -0.02 }), 126),
    )
    const inflationDefense = successOf(
      candidate16FeatureAtSignal(sessionsWithReturns({ DBC: 0.1, EFA: -0.05, IEF: 0.02, SPY: -0.03, VNQ: -0.02 }), 126),
    )
    const deflationTie = successOf(
      candidate16FeatureAtSignal(
        sessionsWithReturns({ DBC: 0.04, EFA: -0.05, IEF: 0.04, SPY: -0.03, VNQ: -0.02 }),
        126,
      ),
    )

    expect(growth).toMatchObject({ state: 'GROWTH', selectedSymbol: 'SPY', positiveRiskSleeves: 2 })
    expect(inflationDefense).toMatchObject({
      state: 'INFLATION_DEFENSE',
      selectedSymbol: 'DBC',
      positiveRiskSleeves: 0,
    })
    expect(deflationTie).toMatchObject({
      state: 'DEFLATION_DEFENSE',
      selectedSymbol: 'IEF',
      positiveRiskSleeves: 0,
    })
  })

  test('builds only the governed official schedule and liquidates on its final execution', () => {
    const dates = frozenCandidateDevelopmentSessions()
    const sessions = sessionsWithReturns({ DBC: 0.08, EFA: 0.12, IEF: 0.04, SPY: 0.2, VNQ: 0.1 }, dates)
    const preflight = candidate16Preflight()

    const plan = successOf(buildCandidate16Plan(sessions, preflight))
    const observed = plan.targets
      .map((target) => ({
        signalDate: dates.at(target.signalIndex),
        executionDate: dates.at(target.executionIndex),
      }))
      .filter(
        (rebalance) =>
          rebalance.executionDate !== undefined &&
          rebalance.executionDate >= preflight.selectedObservationStart &&
          rebalance.executionDate <= preflight.selectedObservationEnd,
      )

    expect(observed).toEqual([...preflight.expectedRebalanceSchedule])
    expect(plan.targets.at(-1)).toMatchObject({
      weights: { DBC: 0, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 },
    })
    expect(observed.at(-1)).toEqual({ signalDate: '2022-11-30', executionDate: '2022-12-01' })
  })

  test('the frozen terminal sell identities fully fill for every possible selected sleeve', () => {
    for (const symbol of ['DBC', 'IEF', 'SPY'] as const) {
      const outcome = successOf(
        makeOrderOutcome({
          identity: {
            schemaVersion: ContractVersion.PartialFillSeed,
            signalDate: '2022-11-30',
            executionDate: '2022-12-01',
            symbol,
            side: 'sell',
          },
          side: 'sell',
          requestedQuantityMicros: 1_000_000n,
          referencePriceMicros: 100_000_000n,
          model: candidate16SimulationProtocol.executionModel,
        }),
      )
      expect(outcome).toMatchObject({
        status: 'filled',
        requestedQuantityMicros: 1_000_000n,
        filledQuantityMicros: 1_000_000n,
        unfilledRemainder: 'none',
      })
    }
  })

  test('queries only the exact frozen development bars', async () => {
    let observed: Record<string, unknown> | undefined
    const client = {
      query: async (options: Record<string, unknown>) => {
        observed = options
        return { json: async () => [] }
      },
    } as unknown as ClickHouseClient

    expect(await Effect.runPromise(queryCandidate16DevelopmentBars(client))).toEqual([])
    expect(observed?.query_params).toEqual({
      snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
      symbols: candidate16Universe,
      start: '2016-01-04',
      end: '2022-12-30',
    })
    expect(String(observed?.query)).toContain('FROM signal.adjusted_daily_bars_v2')
    expect(String(observed?.query)).not.toContain('2023-')
    expect(observed?.query_id).toBe('bayn-candidate-16-development-bars-one-shot')
  })

  test('verifies the frozen manifest before any bar query can run', async () => {
    const queries: Record<string, unknown>[] = []
    const client = {
      query: async (options: Record<string, unknown>) => {
        queries.push(options)
        return { json: async () => [] }
      },
    } as unknown as ClickHouseClient

    const failure = await Effect.runPromise(
      Effect.flip(queryCandidate16FinalizedSnapshot(client, candidate16Preflight())),
    )

    expect(failure).toMatchObject({
      _tag: 'Candidate16InvalidInput',
      operation: 'verify-development-manifest',
      reason: 'manifest missing',
    })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.query_params).toEqual({
      snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
    })
    expect(String(queries[0]?.query)).toContain('FROM signal.snapshot_manifests_v2')
    expect(String(queries[0]?.query)).not.toContain('adjusted_daily_bars_v2')
    expect(queries[0]?.query_id).toBe('bayn-candidate-16-development-manifest-one-shot')
  })
})
