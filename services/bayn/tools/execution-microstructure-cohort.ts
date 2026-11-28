import { Result, Schema } from 'effect'

import { IsoDateSchema } from '../src/schemas'
import { buildTrailingBaseline } from '../src/market-data/intraday/trailing-baseline'
import { quantityScale } from '../src/quantity'
import { retainedIntradayExecutionModel } from '../src/strategy/intraday-market'
import { balancedFundedMiddaySymbols, isBalancedMiddayBasket } from '../src/strategy/intraday-alpha/decision'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import { makeIntradayAlphaFundedExitPlan } from '../src/strategy/intraday-alpha/exit-plan'
import { IntradayAlphaPhase, makeIntradayAlphaPolicy } from '../src/strategy/intraday-alpha/policy'
import {
  extractIntradayAlphaCandidates,
  resolveAlphaRegularSession,
  selectIntradayAlphaLegs,
  type ActiveAlphaPhase,
  type SelectedAlphaLeg,
} from '../src/strategy/intraday-alpha/signals'
import { TargetPlanStatus } from '../src/target-planner'
import { utcInstantFromEpochMillis } from '../src/time'
import { minuteMs } from './midday-research-data'
import { microsPerDollar, type Direction } from './execution-microstructure-model'
import {
  buildReplaySnapshot,
  buildSessionSummaries,
  makeEntryPortfolio,
  makeShortEligibility,
  planReplayTargets,
  type RawBar,
  type ReplayCalendar,
} from './verify-intraday-alpha-replay'

export const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
export const policy = makeIntradayAlphaPolicy(protocol)
export const startingEquityUsd = 100_000
const observationHash = 'b'.repeat(64)

type BarsByMinute = Map<string, Map<number, RawBar>>
type Snapshot = ReturnType<typeof buildReplaySnapshot>
type Eligibility = ReturnType<typeof makeShortEligibility>

export const sideOf = (direction: 'LONG' | 'SHORT'): Direction => (direction === 'LONG' ? 1 : -1)

export const planCohortLegs = (input: {
  readonly equityUsd: number
  readonly buyingPowerUsd: number
  readonly legs: readonly SelectedAlphaLeg[]
  readonly date: string
  readonly snapshot: Snapshot
  readonly completedMinute: number
  readonly bars: BarsByMinute
  readonly eligibility: Eligibility
}) => {
  const { snapshot, completedMinute, bars, eligibility, legs } = input
  const observedAt = snapshot.manifest.observedAt
  const portfolio = makeEntryPortfolio(
    observedAt,
    input.equityUsd,
    [],
    bars,
    completedMinute,
    new Map(),
    input.buyingPowerUsd,
  )
  // Pre-schedule bars can exercise sizing and bracket terms using the retained schedule,
  // but cannot establish historical fee-adjusted returns.
  const fundingPolicy =
    input.date < '2026-07-01'
      ? { ...policy, sharedProtocol: { ...protocol, executionModel: retainedIntradayExecutionModel } }
      : policy
  const funded = new Map(
    legs.flatMap((leg) => {
      const value = Result.getOrThrow(
        makeIntradayAlphaFundedExitPlan({
          policy: fundingPolicy,
          observation: { snapshot, portfolio, observedAt, contentHash: observationHash },
          leg,
        }),
      )
      return value === null ? [] : [[leg.symbol, value] as const]
    }),
  )
  const weights = Object.fromEntries([...funded].map(([symbol, value]) => [symbol, value.signedWeight]))
  const fundedSymbols = [...funded.keys()]
  const midday = legs[0]?.phase === IntradayAlphaPhase.MiddayReversion
  const selectedSymbols = midday ? balancedFundedMiddaySymbols(fundedSymbols, weights) : fundedSymbols
  const at = Date.parse(observedAt)
  const planned =
    selectedSymbols.length === 0
      ? null
      : planReplayTargets({
          sessionDate: input.date,
          selectedSymbols,
          completedBar: (symbol) => bars.get(symbol)?.get(completedMinute),
          portfolio,
          targetWeights: Object.fromEntries(selectedSymbols.map((symbol) => [symbol, weights[symbol] ?? 0])),
          maxBuy: Object.fromEntries(
            selectedSymbols.map((symbol) => {
              const plan = funded.get(symbol)?.plan
              return [
                symbol,
                plan?.schemaVersion === 'bayn.intraday-alpha-long-funded-exit-plan.v1'
                  ? plan.maximumQuantityAtoms
                  : '0',
              ]
            }),
          ),
          maxSell: Object.fromEntries(
            selectedSymbols.map((symbol) => {
              const plan = funded.get(symbol)?.plan
              return [
                symbol,
                plan?.schemaVersion === 'bayn.intraday-alpha-short-funded-exit-plan.v1'
                  ? plan.maximumQuantityAtoms
                  : '0',
              ]
            }),
          ),
          eligibility,
          observedAt,
          orderExpiresAt: utcInstantFromEpochMillis(at + minuteMs),
          disjoint: false,
        })
  const balanced = planned !== null && (!midday || isBalancedMiddayBasket(planned, selectedSymbols))
  return { funded, fundedSymbols, selectedSymbols, planned, balanced }
}

export const phaseDeadline = (phase: ActiveAlphaPhase, sessionMinutes: number) => {
  if (phase === IntradayAlphaPhase.NoiseAreaTrend)
    return Math.min(
      policy.noiseArea.flattenMinuteFromOpen,
      sessionMinutes - (390 - policy.noiseArea.flattenMinuteFromOpen),
    )
  const phaseMinute =
    phase === IntradayAlphaPhase.MorningOrb
      ? policy.morningOrb.hardExitMinuteFromOpen
      : policy.middayReversion.flattenMinuteFromOpen
  return Math.min(phaseMinute, sessionMinutes - protocol.flattenBeforeCloseMinutes)
}

export interface CohortLeg {
  readonly date: string
  readonly symbol: string
  readonly phase: ActiveAlphaPhase
  readonly direction: Direction
  readonly completedMinute: number
  readonly nextMinute: number
  readonly postDecisionMinute: number
  readonly sessionMinutes: number
  readonly bars: ReadonlyMap<number, RawBar>
  readonly close: number
  readonly limit: number
  readonly shares: number
  readonly atr14: number | null
  readonly stop: number
  readonly target: number
  readonly dueMinute: (entryMinute: number) => number
}

export const scanExecutionCohort = (input: {
  readonly byDate: Map<string, Map<string, RawBar[]>>
  readonly calendar: ReplayCalendar
  readonly dates: readonly string[]
  readonly onCheckpoint?: (checkpoint: {
    readonly phase: ActiveAlphaPhase
    readonly date: string
    readonly completedMinute: number
    readonly bars: BarsByMinute
    readonly candidates: readonly { readonly symbol: string; readonly direction: 'LONG' | 'SHORT' }[]
    readonly legs: readonly SelectedAlphaLeg[]
    readonly snapshot: Snapshot
    readonly eligibility: Eligibility
  }) => void
}) => {
  const { byDate, calendar } = input
  const historyDates = [...byDate.keys()].sort()
  const { dailyByDate, checkpointsByDate } = buildSessionSummaries(byDate, historyDates, calendar)
  const counts = {
    sessionsWithoutBaseline: 0,
    sessionsWithoutBars: 0,
    benchmarkUnavailableCheckpoints: 0,
    noSignalCheckpoints: 0,
    selectedBeforeFunding: 0,
    plannerBlocks: 0,
  }
  const cohort: CohortLeg[] = []
  const observedCheckpointsPerPhase: Record<string, number> = {}
  for (const date of input.dates) {
    const symMap = byDate.get(date)
    if (symMap === undefined || symMap.size === 0) {
      counts.sessionsWithoutBars++
      continue
    }
    const regular = Result.getOrThrow(resolveAlphaRegularSession(calendar, date))
    const minutes = (regular.closeMs - regular.openMs) / minuteMs
    const start = utcInstantFromEpochMillis(
      Date.parse(date) - Math.max(35, policy.trailingBaseline.lookbackSessions * 3) * 86_400_000,
    ).slice(0, 10)
    const priors = historyDates.filter((prior) => prior >= start && prior < date)
    const trailingBaseline = buildTrailingBaseline({
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(date),
      symbols: policy.candidateSymbols,
      noiseAreaSymbols: policy.noiseAreaSymbols,
      lookbackSessions: policy.trailingBaseline.lookbackSessions,
      minimumSessions: policy.trailingBaseline.minimumSessions,
      dailyRows: priors.flatMap((d) => dailyByDate.get(d) ?? []),
      checkpointRows: priors.flatMap((d) => checkpointsByDate.get(d) ?? []),
    })
    if (Result.isFailure(trailingBaseline)) {
      counts.sessionsWithoutBaseline++
      continue
    }
    const bars: BarsByMinute = new Map(
      [...symMap].map(([symbol, tape]) => [
        symbol,
        new Map(tape.map((bar) => [(bar.eventMs - regular.openMs) / minuteMs, bar])),
      ]),
    )
    const usedNoise = new Set<string>()
    let morningOrbTakenSymbols: readonly string[] = []
    let middayReversionCompleted = false
    const checkpoints = [
      ...new Set([
        ...Array.from(
          { length: policy.morningOrb.entryEndMinuteFromOpen - policy.morningOrb.entryStartMinuteFromOpen + 1 },
          (_, i) => i + policy.morningOrb.entryStartMinuteFromOpen,
        ),
        ...Array.from(
          {
            length: policy.middayReversion.entryEndMinuteFromOpen - policy.middayReversion.entryStartMinuteFromOpen + 1,
          },
          (_, i) => i + policy.middayReversion.entryStartMinuteFromOpen,
        ),
        ...policy.noiseArea.checkpointMinutesFromOpen.map((minute) => minute - 1),
      ]),
    ].sort((a, b) => a - b)
    for (const completedMinute of checkpoints) {
      const rangeEndMs = regular.openMs + (completedMinute + 1) * minuteMs
      if (
        rangeEndMs + protocol.decisionDelaySeconds * 1000 >=
        regular.closeMs - protocol.entryCutoffMinutesBeforeClose * minuteMs
      )
        break
      const snapshot = buildReplaySnapshot({
        sessionDate: date,
        calendar,
        sessionOpenMs: regular.openMs,
        rangeEndMs,
        symMap,
        quoteModel: { slippageRtBps: 2 },
      })
      const observedAt = snapshot.manifest.observedAt
      const eligibility = makeShortEligibility(observedAt)
      const extraction = {
        snapshot,
        policy,
        trailingBaseline: trailingBaseline.success,
        accountId: 'alpha-replay-verifier',
        equityShortEligibility: eligibility,
      }
      if (input.onCheckpoint !== undefined) {
        // Measure pre-quota signal drift even if the corresponding sleeve has already traded.
        const diagnostic = Result.getOrThrow(extractIntradayAlphaCandidates(extraction))
        const { phase } = diagnostic.context
        if (phase !== IntradayAlphaPhase.OutsideWindow && diagnostic.spyVwapDevBps !== null) {
          const candidates = [...diagnostic.longPool, ...diagnostic.shortPool].filter(
            ({ direction, relVwapDevBps }) =>
              phase !== IntradayAlphaPhase.MiddayReversion ||
              !policy.middayReversion.requireOppositeSigns ||
              (direction === 'LONG' ? relVwapDevBps < 0 : relVwapDevBps > 0),
          )
          const legs = selectIntradayAlphaLegs({ ...diagnostic, policy, vetoedSymbols: new Set() })
          input.onCheckpoint({ phase, date, completedMinute, bars, candidates, legs, snapshot, eligibility })
        }
      }
      const extracted = Result.getOrThrow(
        extractIntradayAlphaCandidates({
          ...extraction,
          morningOrbTakenSymbols,
          middayReversionCompleted,
          noiseAreaTakenSymbols: [...usedNoise],
        }),
      )
      const { phase } = extracted.context
      if (phase === IntradayAlphaPhase.OutsideWindow) continue
      observedCheckpointsPerPhase[phase] = (observedCheckpointsPerPhase[phase] ?? 0) + 1
      if (extracted.spyVwapDevBps === null) {
        counts.benchmarkUnavailableCheckpoints++
        continue
      }
      const legs = selectIntradayAlphaLegs({ ...extracted, policy, vetoedSymbols: new Set() })
      if (legs.length === 0) {
        counts.noSignalCheckpoints++
        continue
      }
      const planned = planCohortLegs({
        equityUsd: startingEquityUsd,
        buyingPowerUsd: startingEquityUsd * 4,
        legs,
        date,
        snapshot,
        completedMinute,
        bars,
        eligibility,
      })
      counts.selectedBeforeFunding += legs.length
      if (planned.planned?.status !== TargetPlanStatus.Planned || !planned.balanced) {
        counts.plannerBlocks++
        continue
      }
      if (phase === IntradayAlphaPhase.NoiseAreaTrend) {
        for (const { symbol } of planned.planned.intentTargets) usedNoise.add(symbol)
      } else if (phase === IntradayAlphaPhase.MorningOrb) {
        morningOrbTakenSymbols = planned.selectedSymbols
      } else {
        middayReversionCompleted = true
      }
      for (const intent of planned.planned.intentTargets) {
        const leg = legs.find(({ symbol }) => symbol === intent.symbol)
        const tape = bars.get(intent.symbol)
        const close = tape?.get(completedMinute)?.close
        const levels = planned.funded.get(intent.symbol)?.plan.levels
        if (leg === undefined || tape === undefined || close === undefined || levels === undefined)
          throw new Error(`Planned cohort leg lacks a price or protected exit plan: ${date} ${intent.symbol}`)
        const atrRatio = trailingBaseline.success.symbols[intent.symbol]?.atr14Ratio
        cohort.push({
          date,
          symbol: intent.symbol,
          phase,
          direction: sideOf(leg.direction),
          completedMinute,
          nextMinute: completedMinute + 1,
          postDecisionMinute: Math.ceil((Date.parse(observedAt) - regular.openMs) / minuteMs),
          sessionMinutes: minutes,
          bars: tape,
          close,
          limit:
            Number(
              'maximumEntryPriceMicros' in levels ? levels.maximumEntryPriceMicros : levels.minimumEntryPriceMicros,
            ) / microsPerDollar,
          shares: Number(BigInt(intent.quantityAtoms) / quantityScale),
          atr14: atrRatio === undefined ? null : close * atrRatio,
          stop: Number(levels.stopPriceMicros) / microsPerDollar,
          target: Number(levels.profitLimitPriceMicros) / microsPerDollar,
          dueMinute: (fillMinute) =>
            Math.min(
              phaseDeadline(phase, minutes),
              phase === IntradayAlphaPhase.MorningOrb ? fillMinute + levels.maximumHoldingMinutes : minutes,
            ),
        })
      }
    }
  }
  return { cohort, counts, observedCheckpointsPerPhase }
}
