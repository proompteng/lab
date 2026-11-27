import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem, Result } from 'effect'
import { cryptoMaximumTakerFeeBps } from '../src/broker/crypto-fees'
import { quantityScale } from '../src/quantity'
import { adaptiveEntryCollarBps, adaptiveStopBufferBps } from '../src/strategy/execution-model/adaptive-collars'
import { calculateSessionFees, type FeeInput } from '../src/strategy/execution-model/fees'
import { intradayAlphaBenchmarkSymbol, intradayAlphaCandidateSymbols } from '../src/strategy/intraday-alpha/constants'
import { IntradayAlphaPhase, intradayAlphaStrategyIdentity } from '../src/strategy/intraday-alpha/policy'
import { resolveAlphaRegularSession } from '../src/strategy/intraday-alpha/signals'
import { TargetPlanStatus } from '../src/target-planner'
import {
  phaseDeadline,
  planCohortLegs,
  policy,
  protocol,
  scanExecutionCohort,
  sideOf,
  type CohortLeg,
} from './execution-microstructure-cohort'
import { asReplayBar, readHistoricalMicrostructureBars } from './execution-microstructure-data'
import {
  adversePrice,
  bps,
  clearsLimit,
  entryLimit,
  followExit,
  microsPerDollar,
  probeTimedClose,
  stopLimit,
  type ExitPath,
} from './execution-microstructure-model'
import { evaluationStart, readFrozenMiddayTape, type Session } from './midday-research-data'
import { mean, sessionEconomics, sum } from './midday-research-statistics'

const phases = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const
const costs = [2, 5, 10]
const baselineCost = 5
const baselineCollar = 10
const entryCollars = [2, 5, 10, 15, 20, 25, 35, 'atr14'] as const
const stopOffsets = [10, 25, 50, 'atr14'] as const
const stopSplits = [
  { id: 'train_dev', start: '2024-01-02', end: '2025-06-30' },
  { id: 'validation', start: '2025-07-01', end: '2026-03-31' },
  { id: 'frozen_holdout', start: '2026-04-01', end: '2026-09-11' },
]
type Collar = (typeof entryCollars)[number]

const distribution = (samples: readonly number[]) => {
  const ordered = samples.toSorted((a, b) => a - b)
  const at = (q: number) => {
    const index = (ordered.length - 1) * q
    const low = ordered[Math.floor(index)]
    const high = ordered[Math.ceil(index)]
    return low === undefined || high === undefined ? null : low + (high - low) * (index % 1)
  }
  return {
    count: ordered.length,
    mean: ordered.length === 0 ? null : mean(ordered),
    min: at(0),
    p01: at(0.01),
    p05: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    p99: at(0.99),
    max: at(1),
  }
}

type Samples = { samples: number[]; missing: number }
const observe = (bucket: Samples, value: number | undefined) => {
  if (value === undefined) bucket.missing++
  else bucket.samples.push(value)
}

const describeDrift = ({ samples, missing }: Samples) => {
  const edges = [-35, -25, -20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20, 25, 35]
  const bins = Array.from({ length: edges.length + 1 }, () => 0)
  for (const value of samples) {
    const first = edges.findIndex((edge) => value <= edge)
    const index = first === -1 ? edges.length : first
    bins[index] = (bins[index] ?? 0) + 1
  }
  return {
    ...distribution(samples),
    missing,
    negative: samples.filter((value) => value < 0).length,
    zero: samples.filter((value) => value === 0).length,
    positive: samples.filter((value) => value > 0).length,
    binsUpperInclusiveBps: edges,
    binCountsIncludingUpperTail: bins,
  }
}

const groupDistribution = (samples: Map<string, Samples>) =>
  Object.fromEntries([...samples].map(([key, value]) => [key, describeDrift(value)]))

const recordDrift = (map: Map<string, Samples>, key: string, value: number | undefined) => {
  const bucket = map.get(key) ?? { samples: [], missing: 0 }
  observe(bucket, value)
  map.set(key, bucket)
}

const entryBound = (leg: CohortLeg, collar: Collar) => {
  if (collar === baselineCollar) return leg.limit
  const width = collar === 'atr14' ? (leg.atr14 === null ? null : adaptiveEntryCollarBps(leg.close, leg.atr14)) : collar
  return width === null ? null : entryLimit(leg.symbol, leg.direction, leg.close, width)
}

export const probeEntry = (leg: CohortLeg, minute: number, collar: Collar, cost: number) => {
  const limit = entryBound(leg, collar)
  const open = leg.bars.get(minute)?.open
  if (limit === null || open === undefined) return null
  const price = adversePrice(open, leg.direction, cost)
  return { price, fills: clearsLimit(price, limit, leg.direction), driftBps: leg.direction * bps(open, leg.close) }
}

const evaluateExit = (leg: CohortLeg, minute: number, cost: number, offset: (typeof stopOffsets)[number]) => {
  const width = offset === 'atr14' ? (leg.atr14 === null ? null : adaptiveStopBufferBps(leg.stop, leg.atr14)) : offset
  if (width === null) return null
  const limit = stopLimit(leg.symbol, leg.direction, leg.stop, width)
  return {
    limit,
    width,
    ...followExit({
      bars: leg.bars,
      direction: leg.direction,
      entryMinute: minute,
      dueMinute: leg.dueMinute(minute),
      sessionMinutes: leg.sessionMinutes,
      stop: leg.stop,
      stopLimit: limit,
      target: leg.target,
      roundTripBps: cost,
    }),
  }
}

type Trade = { readonly leg: CohortLeg; readonly entry: number; readonly exit: number }
type EntryRow = {
  readonly leg: CohortLeg
  readonly price: number
  readonly driftBps: number
  readonly fills: boolean
  readonly exit: ExitPath['exit']
}

const tradesFor = (rows: readonly EntryRow[]) =>
  rows.flatMap(({ leg, price, fills, exit }): Trade[] =>
    fills && exit !== null ? [{ leg, entry: price, exit: exit.price }] : [],
  )

const feeInput = (symbol: string, shares: number, price: number, side: FeeInput['side']): FeeInput => ({
  symbol,
  side,
  quantityAtoms: BigInt(shares) * quantityScale,
  notionalMicros: BigInt(Math.round(price * shares * microsPerDollar)),
})

const dayEconomics = (trades: readonly Trade[], date: string) => {
  const grossUsd = sum(trades.map(({ leg, entry, exit }) => leg.direction * leg.shares * (exit - entry)))
  const fees = Result.getOrThrow(
    calculateSessionFees(
      trades.flatMap(({ leg, entry, exit }) => [
        feeInput(leg.symbol, leg.shares, entry, leg.direction === 1 ? 'buy' : 'sell'),
        feeInput(leg.symbol, leg.shares, exit, leg.direction === 1 ? 'sell' : 'buy'),
      ]),
      protocol.executionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
      date,
    ),
  )
  const feeUsd = Number(fees.totalMicros) / microsPerDollar
  const entryNotionalUsd = sum(trades.map(({ leg, entry }) => leg.shares * entry))
  return { grossUsd, feeUsd, entryNotionalUsd, netUsd: grossUsd - feeUsd }
}

const groupByDay = (trades: readonly Trade[]) => {
  const days = new Map<string, Trade[]>()
  for (const trade of trades) {
    const group = days.get(trade.leg.date) ?? []
    group.push(trade)
    days.set(trade.leg.date, group)
  }
  return days
}

const measures = (trades: readonly Trade[]) => {
  const daily = [...groupByDay(trades)].map(([date, group]) => dayEconomics(group, date))
  const netUsd = sum(daily.map((day) => day.netUsd))
  const notionalUsd = sum(daily.map((day) => day.entryNotionalUsd))
  return {
    closed: trades.length,
    notionalUsd,
    netUsd,
    netBps: notionalUsd === 0 ? null : (netUsd / notionalUsd) * 10_000,
    feeUsd: sum(daily.map((day) => day.feeUsd)),
  }
}

const analyzeEntry = (
  cohort: readonly CohortLeg[],
  dates: readonly string[],
  clock: 'nextMinute' | 'postDecisionMinute',
) =>
  costs.map((cost) => {
    // Same protection levels, same shares, same legs in every scenario. Exits are cached for both
    // marketable and rejected legs to reveal the return actually selected by each collar.
    const memos = cohort.map((leg) => ({
      leg,
      exit: leg.bars.has(leg[clock]) ? (evaluateExit(leg, leg[clock], cost, 10)?.exit ?? null) : null,
    }))
    const rowsFor = (collar: Collar) =>
      memos.flatMap(({ leg, exit }): EntryRow[] => {
        const entry = probeEntry(leg, leg[clock], collar, cost)
        return entry === null ? [] : [{ leg, exit, ...entry }]
      })
    const baseline = new Map(rowsFor(baselineCollar).map((row) => [row.leg, row]))
    return {
      roundTripCostBps: cost,
      scenarios: entryCollars.map((collar) => {
        const rows = rowsFor(collar)
        const fill = rows.filter((row) => row.fills)
        const missed = rows.filter((row) => !row.fills)
        const closed = tradesFor(rows)
        const byDay = groupByDay(closed)
        const paired = rows.filter((row) => baseline.has(row.leg) && row.exit !== null)
        const base = paired.flatMap(({ leg }) => {
          const row = baseline.get(leg)
          return row === undefined ? [] : [row]
        })
        const gained = paired.filter((row) => row.fills && baseline.get(row.leg)?.fills === false)
        const unknownDates = new Set([
          ...cohort
            .filter((leg) => !leg.bars.has(leg[clock]) || (collar === 'atr14' && leg.atr14 === null))
            .map((leg) => leg.date),
          ...fill.filter((row) => row.exit === null).map(({ leg }) => leg.date),
        ])
        const supported = measures(closed)
        return {
          collar,
          attempted: cohort.length,
          fills: fill.length,
          missed: missed.length,
          unknownEntry: cohort.length - rows.length,
          unresolvedExits: fill.filter((row) => row.exit === null).length,
          meanFillDriftBps: fill.length === 0 ? null : mean(fill.map((row) => row.driftBps)),
          meanMissedDriftBps: missed.length === 0 ? null : mean(missed.map((row) => row.driftBps)),
          fillsWithSignal: fill.filter((row) => row.driftBps > 0).length,
          fillsAgainstSignal: fill.filter((row) => row.driftBps < 0).length,
          missesWithSignal: missed.filter((row) => row.driftBps > 0).length,
          supported,
          pairedClosedLegs: paired.length,
          pairedDeltaVs10Usd: measures(tradesFor(paired)).netUsd - measures(tradesFor(base)).netUsd,
          marginalFillsVs10: measures(tradesFor(gained)),
          missedCounterfactualClosed: measures(tradesFor(missed.map((row) => ({ ...row, fills: true })))),
          fullCohortEconomics: sessionEconomics(
            dates.map((date) => (unknownDates.has(date) ? null : dayEconomics(byDay.get(date) ?? [], date).netUsd)),
          ),
          supportedClosedSubsetEconomics: sessionEconomics(
            dates.map((date) => dayEconomics(byDay.get(date) ?? [], date).netUsd),
          ),
          phases: Object.fromEntries(
            phases.map((phase) => {
              const phaseRows = rows.filter(({ leg }) => leg.phase === phase)
              return [
                phase,
                {
                  filled: phaseRows.filter((row) => row.fills).length,
                  observed: phaseRows.length,
                  ...measures(tradesFor(phaseRows)),
                },
              ]
            }),
          ),
          leaveOneSymbolOutSupportedUsd: Object.fromEntries(
            intradayAlphaCandidateSymbols.map((symbol) => [
              symbol,
              measures(closed.filter(({ leg }) => leg.symbol !== symbol)).netUsd,
            ]),
          ),
        }
      }),
    }
  })

const stopAtBaseline = (cohort: readonly CohortLeg[], offset: (typeof stopOffsets)[number]) =>
  cohort.flatMap((leg) => {
    const entry = probeEntry(leg, leg.postDecisionMinute, baselineCollar, baselineCost)
    if (entry?.fills !== true) return []
    const path = evaluateExit(leg, leg.postDecisionMinute, baselineCost, offset)
    return [{ leg, entry: entry.price, path }]
  })

const analyzeStops = (cohort: readonly CohortLeg[], splits: readonly (typeof stopSplits)[number][]) => {
  const baseline = new Map(stopAtBaseline(cohort, 10).map(({ leg, path }) => [leg, path]))
  return stopOffsets.map((offset) => {
    const rows = stopAtBaseline(cohort, offset)
    const summarize = (selected: typeof rows) => {
      const triggered = selected.filter(({ path }) => path !== null && path.triggeredMinute !== null)
      const gaps = triggered.flatMap(({ leg, path }) => {
        if (path === null || path.worstBlockedPrice === null || path.triggeredMinute === null) return []
        return [
          {
            date: leg.date,
            symbol: leg.symbol,
            phase: leg.phase,
            direction: leg.direction,
            triggerMinute: path.triggeredMinute,
            blockedMinutes: path.blockedMinutes,
            worstAdverseBeyondStopBps: -leg.direction * bps(path.worstBlockedPrice, leg.stop),
            worstAdverseBeyondStopUsd: leg.direction * (leg.stop - path.worstBlockedPrice) * leg.shares,
            realizedAdverseBeyondStopUsd:
              path.exit === null ? null : leg.direction * (leg.stop - path.exit.price) * leg.shares,
            exit: path.exit,
          },
        ]
      })
      const priced = selected.flatMap(({ leg, entry, path }): Trade[] =>
        path === null || path.exit === null ? [] : [{ leg, entry, exit: path.exit.price }],
      )
      const paired = selected.flatMap(({ leg, path }) => {
        const base = baseline.get(leg)
        return path === null || path.exit === null || base === undefined || base === null || base.exit === null
          ? []
          : [
              {
                deltaUsd: leg.direction * (path.exit.price - base.exit.price) * leg.shares,
                recovered: path.blockedMinutes === 0 && base.blockedMinutes > 0,
              },
            ]
      })
      return {
        pairedClosedLegs: paired.length,
        pairedGrossDeltaVs10Usd: sum(paired.map(({ deltaUsd }) => deltaUsd)),
        avoidedBlockedTradeVs10: paired.filter(({ recovered }) => recovered).length,
        filled: selected.length,
        unavailableOffset: selected.filter(({ path }) => path === null).length,
        triggered: triggered.length,
        nonExecutionTrades: gaps.length,
        nonExecutionPctOfTriggered: triggered.length > 0 ? (gaps.length / triggered.length) * 100 : null,
        blockedMinutes: sum(gaps.map((gap) => gap.blockedMinutes)),
        missingWorkingMinutes: sum(triggered.map(({ path }) => path?.missingWorkingMinutes ?? 0)),
        ambiguousTriggerBars: sum(triggered.map(({ path }) => path?.ambiguousTriggers ?? 0)),
        stillWorkingAtDeadline: gaps.filter(({ exit }) => exit?.reason !== 'stop').length,
        unresolved: selected.length - priced.length,
        supported: measures(priced.filter(({ leg }) => leg.date >= '2026-07-01')),
        grossClosedUsd: sum(priced.map(({ leg, entry, exit }) => leg.direction * leg.shares * (exit - entry))),
        worstBlockedBeyondStopBps: distribution(gaps.map((gap) => gap.worstAdverseBeyondStopBps)),
        worstBlockedBeyondStopUsd: distribution(gaps.map((gap) => gap.worstAdverseBeyondStopUsd)),
        realizedBeyondStopUsd: distribution(
          gaps.flatMap((gap) => (gap.realizedAdverseBeyondStopUsd === null ? [] : [gap.realizedAdverseBeyondStopUsd])),
        ),
        worst: gaps.toSorted((a, b) => b.worstAdverseBeyondStopUsd - a.worstAdverseBeyondStopUsd).slice(0, 5),
      }
    }
    return {
      offset,
      bufferBps: distribution(rows.flatMap(({ path }) => (path === null ? [] : [path.width]))),
      ...summarize(rows),
      byPhase: Object.fromEntries(
        phases.map((phase) => [phase, summarize(rows.filter(({ leg }) => leg.phase === phase))]),
      ),
      splits: Object.fromEntries(
        splits.map(({ id, start, end }) => [
          id,
          summarize(rows.filter(({ leg }) => leg.date >= start && leg.date <= end)),
        ]),
      ),
    }
  })
}

const analyzeTimedCloses = (cohort: readonly CohortLeg[]) => {
  const rows = stopAtBaseline(cohort, 10)
  return phases.flatMap((phase) =>
    ['early', 'regular'].flatMap((session) =>
      ['maximum_hold', 'phase_flatten'].map((reason) => {
        const group = rows.filter(
          ({ leg, path }) =>
            leg.phase === phase &&
            leg.sessionMinutes < 390 === (session === 'early') &&
            path?.exit?.reason === 'timed' &&
            (leg.dueMinute(leg.postDecisionMinute) === phaseDeadline(phase, leg.sessionMinutes)) ===
              (reason === 'phase_flatten'),
        )
        return {
          phase,
          session,
          reason,
          modeledTimedExits: group.length,
          marks: [1, 2, 5].map((delayMinutes) => {
            const observed = group.flatMap(({ leg }) => {
              const common = {
                ...leg,
                dueMinute: leg.dueMinute(leg.postDecisionMinute),
                roundTripBps: baselineCost,
                limitBps: 10,
              }
              const mark = probeTimedClose({ ...common, delayMinutes })
              const initial = probeTimedClose({ ...common, delayMinutes: 1 })
              return mark === null || initial === null ? [] : [{ leg, mark, initial }]
            })
            return {
              delayMinutes,
              unavailableOrPastRegularClose: group.length - observed.length,
              adverseMarkBps: distribution(observed.map(({ mark }) => mark.adverseBps)),
              limitClears: Object.fromEntries(
                [2, 5, 10].map((limit) => [limit, observed.filter(({ mark }) => mark.adverseBps <= limit).length]),
              ),
              incrementalAdverseUsdVsOneMinute: sum(
                observed.map(({ leg, mark, initial }) => leg.direction * (initial.price - mark.price) * leg.shares),
              ),
            }
          }),
        }
      }),
    ),
  )
}

const quoteAudit = (sessions: readonly Session[], cohort: readonly CohortLeg[]) =>
  intradayAlphaCandidateSymbols.map((symbol) => {
    const buckets = sessions.flatMap(({ tapes, minutes }) => {
      const tape = tapes.get(symbol)
      return tape === undefined
        ? []
        : [...tape.quotes.entries()].filter(([minute]) => minute < minutes).map(([, quote]) => quote)
    })
    const byDate = new Map(sessions.map(({ date, tapes }) => [date, tapes.get(symbol)]))
    const opportunities = cohort.filter((leg) => leg.symbol === symbol)
    const entryQuotes = opportunities.flatMap((leg) => {
      const quote = byDate.get(leg.date)?.quotes.get(leg.nextMinute)
      return quote === undefined ? [] : [{ leg, quote }]
    })
    return {
      symbol,
      expectedRthMinutes: sum(sessions.map(({ minutes }) => minutes)),
      rthQuoteBuckets: buckets.length,
      rthBucketMedianSpreadBps: distribution(buckets.map((quote) => quote.medianBps)),
      rthBucketP75SpreadBps: distribution(buckets.map((quote) => quote.p75Bps)),
      signalLegs: opportunities.length,
      signalMinuteQuotePresent: opportunities.filter((leg) => byDate.get(leg.date)?.quotes.has(leg.completedMinute))
        .length,
      nextMinuteQuotePresent: entryQuotes.length,
      nextMinuteFirstSideDriftBps: distribution(
        entryQuotes.map(
          ({ leg, quote }) => leg.direction * bps(leg.direction === 1 ? quote.firstAsk : quote.firstBid, leg.close),
        ),
      ),
      firstQuoteWithinCollar: Object.fromEntries(
        entryCollars.map((collar) => [
          collar,
          entryQuotes.filter(({ leg, quote }) => {
            const limit = entryBound(leg, collar)
            return (
              limit !== null && clearsLimit(leg.direction === 1 ? quote.firstAsk : quote.firstBid, limit, leg.direction)
            )
          }).length,
        ]),
      ),
    }
  })

const fundingCases = [
  { equityUsd: 100_000, buyingPowerUsd: 400_000 },
  { equityUsd: 100_000, buyingPowerUsd: 90_000 },
  { equityUsd: 100_000, buyingPowerUsd: 89_500 },
  { equityUsd: 100_000, buyingPowerUsd: 80_000 },
  { equityUsd: 2_500, buyingPowerUsd: 2_500 },
  { equityUsd: 1_000, buyingPowerUsd: 1_000 },
]
type Checkpoint = Parameters<NonNullable<Parameters<typeof scanExecutionCohort>[0]['onCheckpoint']>>[0]

const probeBasket = (checkpoint: Checkpoint, fundingCase: (typeof fundingCases)[number]) => {
  const { legs } = checkpoint
  const { fundedSymbols, selectedSymbols, planned, balanced } = planCohortLegs({ ...checkpoint, ...fundingCase })
  const targets = planned?.targets ?? []
  const legsWithShares = targets.filter((target) => BigInt(target.targetQuantityAtoms) !== 0n)
  const sized = legsWithShares.map((target) => ({
    // targetQuantityAtoms is negative for shorts. Use the planner's actual adverse reference.
    signedUsd:
      Number(BigInt(target.targetQuantityAtoms) * BigInt(target.referencePriceMicros)) /
      Number(quantityScale) /
      microsPerDollar,
    legBudgetUsd: Math.abs(target.targetWeight) * fundingCase.equityUsd,
    sharePriceUsd: Number(target.referencePriceMicros) / microsPerDollar,
  }))
  const longUsd = sum(sized.filter(({ signedUsd }) => signedUsd > 0).map(({ signedUsd }) => signedUsd))
  const shortUsd = -sum(sized.filter(({ signedUsd }) => signedUsd < 0).map(({ signedUsd }) => signedUsd))
  const gross = longUsd + shortUsd
  return {
    date: checkpoint.date,
    chosen: legs.length,
    funded: fundedSymbols.length,
    afterPairing: selectedSymbols.length,
    intents: planned?.status === TargetPlanStatus.Planned && balanced ? planned.intentTargets.length : 0,
    block: planned === null ? 'NO_FUNDED_LEGS' : (planned.reason ?? (!balanced ? 'MIDDAY_IMBALANCE' : null)),
    longMinusShortUsd: gross === 0 ? null : longUsd - shortUsd,
    imbalanceUsd: gross === 0 ? null : Math.abs(longUsd - shortUsd),
    imbalanceBpsOfGross: gross === 0 ? null : (Math.abs(longUsd - shortUsd) / gross) * 10_000,
    allocationUnusedUsd:
      gross === 0 ? null : sum(sized.map(({ legBudgetUsd, signedUsd }) => legBudgetUsd - Math.abs(signedUsd))),
    legsReducedByMoreThanOneShare: sized.filter(
      ({ legBudgetUsd, signedUsd, sharePriceUsd }) => legBudgetUsd - Math.abs(signedUsd) >= sharePriceUsd,
    ).length,
  }
}

const summarizeBaskets = (rows: ReturnType<typeof probeBasket>[]) => ({
  attempts: rows.length,
  sessions: new Set(rows.map(({ date }) => date)).size,
  unfundedLegs: sum(rows.map(({ chosen, funded }) => chosen - funded)),
  attemptsWithUnfundedLeg: rows.filter(({ funded }) => funded < 4).length,
  attemptsTrimmedByPairing: rows.filter(({ funded, afterPairing }) => afterPairing < funded).length,
  preservedFourIntents: rows.filter(({ intents }) => intents === 4).length,
  reducedToTwoOrOneIntent: rows.filter(({ intents }) => intents > 0 && intents < 4).length,
  blocked: Object.fromEntries(
    [...new Set(rows.flatMap(({ block }) => (block === null ? [] : [block])))].map((reason) => [
      reason,
      rows.filter(({ block }) => block === reason).length,
    ]),
  ),
  longUnderweight: rows.filter(({ longMinusShortUsd }) => longMinusShortUsd !== null && longMinusShortUsd < -0.000001)
    .length,
  shortUnderweight: rows.filter(({ longMinusShortUsd }) => longMinusShortUsd !== null && longMinusShortUsd > 0.000001)
    .length,
  imbalanceUsd: distribution(rows.flatMap(({ imbalanceUsd }) => (imbalanceUsd === null ? [] : [imbalanceUsd]))),
  imbalanceBpsOfGross: distribution(
    rows.flatMap(({ imbalanceBpsOfGross }) => (imbalanceBpsOfGross === null ? [] : [imbalanceBpsOfGross])),
  ),
  allocationUnusedUsd: distribution(
    rows.flatMap(({ allocationUnusedUsd }) => (allocationUnusedUsd === null ? [] : [allocationUnusedUsd])),
  ),
  legsReducedByMoreThanOneShare: sum(rows.map(({ legsReducedByMoreThanOneShare }) => legsReducedByMoreThanOneShare)),
})

const feesAudit = (cohort: readonly CohortLeg[]) => ({
  model: protocol.executionModel.fees,
  observedPaper: { equityFills: 2693, feeActivities: 69, feesUsd: 195.93, aggregateUsdPerFill: 195.93 / 2693 },
  examples: [40, 150, 300].flatMap((price) =>
    [10, 50, 150].map((shares) => ({
      price,
      shares,
      sellNotionalUsd: price * shares,
      days: ['2026-09-30', '2026-11-25', '2027-01-04'].map((date) => {
        const fees = Result.getOrThrow(
          calculateSessionFees(
            [feeInput('AAPL', shares, price, 'buy'), feeInput('AAPL', shares, price, 'sell')],
            protocol.executionModel,
            1_000_000n,
            cryptoMaximumTakerFeeBps,
            date,
          ),
        )
        return {
          date,
          secUsd: Number(fees.secMicros) / microsPerDollar,
          tafUsd: Number(fees.tafMicros) / microsPerDollar,
          catUsd: Number(fees.catMicros) / microsPerDollar,
          roundTripBpsOnSellNotional: (Number(fees.totalMicros) / microsPerDollar / (price * shares)) * 10_000,
        }
      }),
    })),
  ),
  selectedWholeShares: distribution(cohort.map(({ shares }) => shares)),
  selectedNotionalAtReferenceUsd: distribution(cohort.map(({ shares, close }) => shares * close)),
  baselineModeledRoundTrips: measures(
    stopAtBaseline(cohort, 10).flatMap(({ leg, entry, path }) =>
      path === null || path.exit === null ? [] : [{ leg, entry, exit: path.exit.price }],
    ),
  ),
})

const buildExecutionMicrostructureReport = (
  live: ReturnType<typeof readFrozenMiddayTape>,
  historical: ReturnType<typeof readHistoricalMicrostructureBars>,
) => {
  const { calendar } = live
  const byDate = new Map(
    live.sessions.map(({ date, tapes }) => {
      const start = Result.getOrThrow(resolveAlphaRegularSession(calendar, date)).openMs
      return [
        date,
        new Map(
          [...tapes].map(([symbol, tape]) => [
            symbol,
            [...tape.bars.entries()]
              .toSorted(([a], [b]) => a - b)
              .map(([minute, bar]) => asReplayBar(symbol, start, minute, bar)),
          ]),
        ),
      ]
    }),
  )
  const evaluationSessions = live.sessions.filter(({ date }) => date >= evaluationStart)
  const dates = evaluationSessions.map(({ date }) => date)
  const driftKeys = phases.flatMap((phase) => [
    phase,
    ...intradayAlphaCandidateSymbols.map((symbol) => `${phase}/${symbol}`),
  ])
  const windows = new Map(driftKeys.map((key) => [key, { samples: [], missing: 0 } as Samples]))
  const signals = new Map(driftKeys.map((key) => [key, { samples: [], missing: 0 } as Samples]))
  const inputs = new Map(fundingCases.map((fundingCase) => [fundingCase, [] as ReturnType<typeof probeBasket>[]]))
  const midday = { oneLeg: 0, twoLegs: 0, fourLegs: 0 }
  const liveCohort = scanExecutionCohort({
    byDate,
    dates,
    calendar,
    onCheckpoint(checkpoint) {
      const { phase, completedMinute, bars, candidates, legs } = checkpoint
      const jump = (symbol: string) => {
        const tape = bars.get(symbol)
        const close = tape?.get(completedMinute)?.close
        const open = tape?.get(completedMinute + 1)?.open
        return close === undefined || open === undefined ? undefined : bps(open, close)
      }
      for (const symbol of intradayAlphaCandidateSymbols) {
        const value = jump(symbol)
        recordDrift(windows, phase, value)
        recordDrift(windows, `${phase}/${symbol}`, value)
      }
      for (const candidate of candidates) {
        const drift = jump(candidate.symbol)
        const signed = drift === undefined ? undefined : sideOf(candidate.direction) * drift
        recordDrift(signals, phase, signed)
        recordDrift(signals, `${phase}/${candidate.symbol}`, signed)
      }
      if (phase !== IntradayAlphaPhase.MiddayReversion) return
      if (legs.length === 1) midday.oneLeg++
      else if (legs.length === 2) midday.twoLegs++
      else if (legs.length === 4) {
        midday.fourLegs++
        for (const [fundingCase, rows] of inputs) rows.push(probeBasket(checkpoint, fundingCase))
      }
    },
  })
  const historicalDates = historical.calendar.providerSessions
    .map(({ date }) => date)
    .filter((date) => date >= '2024-01-02' && date <= '2026-09-11')
  const historicalCohort = scanExecutionCohort({
    byDate: historical.byDate,
    calendar: historical.calendar,
    dates: historicalDates,
  })
  return {
    schemaVersion: 'bayn.execution-microstructure-study.v1',
    qualification: 'UNQUALIFIED',
    strategyIdentity: Result.getOrThrow(intradayAlphaStrategyIdentity(policy)),
    assumptions: {
      anchor: 'Frozen IEX trade bar close; adjacent open is a proxy, not consolidated NBBO',
      entry:
        'Adjacent open is timing sensitivity only; the executable-clock proxy uses the first full post-decision minute in the 60-second working window, also used by stop and close studies',
      fills: 'Whole modeled lots, no quote size, depth, queue, borrow, or partial fills',
      cohort:
        'Fixed flat-book decisions, no concurrent inventory, first funded ORB and Midday, first funded Noise per symbol; pre-quota candidate drift',
      entryAtr: '10% of trailing production daily ATR14 ratio expressed at the completed close, clamped to 15–40 bp',
      stopAtr: '25% of the same trailing daily ATR14 dollar amount, separate from entry',
      costs:
        'Fixed total spread/slippage stress, split between two sides, plus date-effective modeled fees; historical pre-schedule stops report gross only',
    },
    sources: {
      live: live.sources,
      historical: historical.sources,
      historicalRthSymbols: historical.symbols,
      historicalNvdaSplitAdjustedRows: historical.splitAdjustedRows,
    },
    coverage: {
      live: {
        calendarSessions: dates.length,
        plannedLegs: liveCohort.cohort.length,
        ...liveCohort.counts,
        checkpoints: liveCohort.observedCheckpointsPerPhase,
      },
      historical: {
        calendarSessions: historicalDates.length,
        representedSessions: historical.byDate.size,
        plannedLegs: historicalCohort.cohort.length,
        ...historicalCohort.counts,
        checkpoints: historicalCohort.observedCheckpointsPerPhase,
      },
    },
    adjacentDrift: {
      unsignedAllCandidateWindowMinutes: groupDistribution(windows),
      signedEligibleSignalMinutes: groupDistribution(signals),
    },
    nbboCostProxyEntry: {
      adjacentOpen: analyzeEntry(liveCohort.cohort, dates, 'nextMinute'),
      fullPostDecisionOpen: analyzeEntry(liveCohort.cohort, dates, 'postDecisionMinute'),
    },
    iexQuoteLiveness: quoteAudit(evaluationSessions, liveCohort.cohort),
    stopLimit: {
      live: analyzeStops(liveCohort.cohort, []),
      historical: analyzeStops(historicalCohort.cohort, stopSplits),
    },
    timedExit: {
      configuredDeadlineMinutesFromOpen: Object.fromEntries(
        [390, 210].map((minutes) => [
          minutes,
          Object.fromEntries(phases.map((phase) => [phase, phaseDeadline(phase, minutes)])),
        ]),
      ),
      live: analyzeTimedCloses(liveCohort.cohort),
      historical: analyzeTimedCloses(historicalCohort.cohort),
    },
    middayFunding: {
      candidateWindows: midday,
      headroomScenarios: [...inputs].map(([fundingCase, rows]) => ({ ...fundingCase, ...summarizeBaskets(rows) })),
    },
    fees: feesAudit(liveCohort.cohort),
  }
}

class ExecutionMicrostructureError extends Data.TaggedError('ExecutionMicrostructureError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const loadFrozenInput = <A>(name: string, read: () => A) =>
  Effect.try({
    try: read,
    catch: (cause) => new ExecutionMicrostructureError({ message: `Cannot load frozen ${name} inputs`, cause }),
  })

export const runExecutionMicrostructureCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [input, output] = args
    if (args.length !== 2 || input === undefined || output === undefined || input === '' || output === '')
      return yield* new ExecutionMicrostructureError({
        message:
          'Usage: bun services/bayn/tools/research-execution-microstructure.ts <frozen-datasets-dir> <results.json>',
      })
    const live = yield* loadFrozenInput('live', () =>
      readFrozenMiddayTape(input, [...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol]),
    )
    const historical = yield* loadFrozenInput('historical', () => readHistoricalMicrostructureBars(input))
    const report = buildExecutionMicrostructureReport(live, historical)
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runExecutionMicrostructureCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the offline command owns its filesystem
      Effect.provide(NodeServices.layer),
    ),
  )
