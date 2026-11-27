import { Result } from 'effect'

import { quantizeInstrumentPriceMicros } from '../src/broker/alpaca-price'
import { OrderSide, OrderType } from '../src/execution/contracts'
import { deriveExecutionIntentPricing } from '../src/execution/intent-pricing'
import { cashSpotLimitTimeInForce } from '../src/execution/order-terms'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import { MarketKind } from '../src/instruments'
import {
  buildTrailingBaseline,
  type PriorSessionCheckpointSummary,
  type PriorSessionDailySummary,
} from '../src/market-data/intraday/trailing-baseline'
import { quantityScale } from '../src/quantity'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { isBalancedMiddayBasket } from '../src/strategy/intraday-alpha/decision'
import { makeIntradayAlphaFundedExitPlan } from '../src/strategy/intraday-alpha/exit-plan'
import {
  IntradayAlphaPhase,
  intradayAlphaStrategyIdentity,
  makeIntradayAlphaPolicy,
} from '../src/strategy/intraday-alpha/policy'
import {
  extractIntradayAlphaCandidates,
  selectIntradayAlphaLegs,
  type ActiveAlphaPhase,
  type SelectedAlphaLeg,
} from '../src/strategy/intraday-alpha/signals'
import { retainedIntradayExecutionModel } from '../src/strategy/intraday-market'
import { TargetPlanStatus } from '../src/target-planner'
import { minuteMs, readBar, sessionBars, type Session } from './sip-bayn21-data'
import {
  buildReplaySnapshot,
  makeEntryPortfolio,
  makeShortEligibility,
  planReplayTargets,
  type ReplayCalendar,
} from './verify-intraday-alpha-replay'

const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = makeIntradayAlphaPolicy(protocol)
export const liveIdentity = Result.getOrThrow(intradayAlphaStrategyIdentity(policy))
export const equityUsd = 100_000
export const capUsd = 180_000
const sellFeeRate = 0.21 / 10_000
const accountId = 'alpha-replay-verifier'
const observationHash = 'b'.repeat(64)
export const phases = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const
const [orb, midday, noise] = phases

export interface Architecture {
  readonly sleeves: readonly ActiveAlphaPhase[]
  readonly sizing: 'fixed' | 'dispersion' | 'volatility' | 'both'
  readonly pairs: 2 | 3
  readonly bracket: 'live' | 300 | 500 | 800 | 'eod'
}

export const liveArchitecture: Architecture = { sleeves: phases, sizing: 'fixed', pairs: 2, bracket: 'live' }

export interface Scenario {
  readonly architecture: Architecture
  readonly collar: 10 | 15 | 20 | 25 | 35
  readonly stopBuffer: 10 | 25 | 50
  readonly lag: 1 | 2
  readonly cost: 2 | 5 | 10
}

const clampScale = (value: number) => Math.max(0.5, Math.min(1.5, value))
export const sampleDeviation = (values: readonly number[]) => {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
}

type Extraction = Result.Result.Success<ReturnType<typeof extractIntradayAlphaCandidates>>
type Snapshot = ReturnType<typeof buildReplaySnapshot>
type Eligibility = ReturnType<typeof makeShortEligibility>
interface Frame {
  readonly minute: number
  readonly snapshot: Snapshot
  readonly eligibility: Eligibility
  readonly noise: Extraction | undefined
  readonly equity: Extraction | undefined
  readonly plans: Map<string, readonly Order[]>
}

interface Order {
  readonly leg: SelectedAlphaLeg
  readonly shares: number
  readonly reference: number
  readonly liveLimit: number
  readonly stop: number
  readonly liveStopLimit: number
  readonly target: number
}

type Funding = NonNullable<Result.Result.Success<ReturnType<typeof makeIntradayAlphaFundedExitPlan>>>
interface DailyHistory {
  readonly date: string
  readonly daily: PriorSessionDailySummary[]
  readonly checkpoints: PriorSessionCheckpointSummary[]
  readonly spyClose: number | undefined
}

export const createReplay = (calendar: ReplayCalendar) => {
  const history: DailyHistory[] = []
  const priorSessionsBySymbol = new Map<string, number>()
  return (session: Session) => {
    const allBars = sessionBars(session)
    const baseline = buildTrailingBaseline({
      sessionDate: session.date,
      symbols: policy.candidateSymbols,
      noiseAreaSymbols: policy.noiseAreaSymbols,
      lookbackSessions: policy.trailingBaseline.lookbackSessions,
      minimumSessions: policy.trailingBaseline.minimumSessions,
      dailyRows: history.flatMap(({ daily }) => daily),
      checkpointRows: history.flatMap(({ checkpoints }) => checkpoints),
    })
    // Midday does not ordinarily require ATR. SNDK is explicitly excluded in *all*
    // sleeves until it has supplied 14 usable prior sessions on this very tape.
    const sndkReady = (priorSessionsBySymbol.get('SNDK') ?? 0) >= policy.trailingBaseline.lookbackSessions
    if (Result.isFailure(baseline) && history.length >= policy.trailingBaseline.minimumSessions) throw baseline.failure

    const spyCloses = history.slice(-15).map(({ spyClose }) => spyClose)
    const spyReturns = spyCloses.flatMap((close, i) => {
      const previous = spyCloses[i - 1]
      return previous === undefined || close === undefined ? [] : [close / previous - 1]
    })
    const realizedVol = Math.sqrt(252) * sampleDeviation(spyReturns)
    const volatilityScale = spyReturns.length === 14 && realizedVol > 0 ? clampScale(0.15 / realizedVol) : null

    const daily: PriorSessionDailySummary[] = []
    const checkpoints: PriorSessionCheckpointSummary[] = []
    for (const [symbol, bars] of allBars) {
      if (symbol === policy.benchmarkSymbol || bars.length < 200) continue
      const first = bars[0]
      const last = bars.at(-1)
      if (first === undefined || last === undefined) continue
      let high = first.high
      let low = first.low
      for (const bar of bars) {
        high = Math.max(high, bar.high)
        low = Math.min(low, bar.low)
      }
      daily.push({ symbol, sessionDate: session.date, open: first.open, high, low, close: last.close })
      priorSessionsBySymbol.set(symbol, (priorSessionsBySymbol.get(symbol) ?? 0) + 1)
      if (policy.noiseAreaSymbols.includes(symbol)) {
        for (const minute of policy.noiseArea.checkpointMinutesFromOpen) {
          if (minute > session.minutes) continue
          const close = bars.findLast((bar) => bar.eventMs < session.openMs + minute * minuteMs)?.close
          if (close !== undefined)
            checkpoints.push({ symbol, sessionDate: session.date, minuteFromOpen: minute, close })
        }
      }
    }
    history.push({
      date: session.date,
      daily,
      checkpoints,
      spyClose: readBar(session, policy.benchmarkSymbol, session.minutes - 1)?.close,
    })
    // The first true range in the 14-session window needs one earlier close. Use
    // the same bounded calendar lookback as the retained verifier, including thin histories.
    const cutoff = Date.parse(session.date) - Math.max(35, policy.trailingBaseline.lookbackSessions * 3) * 86_400_000
    while (history.length > 15 && Date.parse(history[0].date) < cutoff) history.shift()
    if (!sndkReady) allBars.delete('SNDK')

    const frames = new Map<number, Frame>()
    const decisionMinutes = Array.from({ length: session.minutes }, (_, minute) => minute).filter(
      (minute) =>
        policy.noiseArea.checkpointMinutesFromOpen.includes(minute + 1) ||
        (minute >= policy.morningOrb.entryStartMinuteFromOpen && minute <= policy.morningOrb.entryEndMinuteFromOpen) ||
        (minute >= policy.middayReversion.entryStartMinuteFromOpen &&
          minute <= policy.middayReversion.entryEndMinuteFromOpen),
    )
    const frameAt = (minute: number) => {
      const existing = frames.get(minute)
      if (existing !== undefined) return existing
      const snapshot = buildReplaySnapshot({
        sessionDate: session.date,
        calendar,
        sessionOpenMs: session.openMs,
        rangeEndMs: session.openMs + (minute + 1) * minuteMs,
        symMap: allBars,
        quoteModel: { slippageRtBps: 2 },
      })
      const eligibility = makeShortEligibility(snapshot.manifest.observedAt)
      const inputs = {
        snapshot,
        policy,
        accountId,
        equityShortEligibility: eligibility,
      }
      const extract = (noiseAreaTakenSymbols: readonly string[]) =>
        Result.isSuccess(baseline)
          ? Result.getOrThrow(
              extractIntradayAlphaCandidates({ ...inputs, noiseAreaTakenSymbols, trailingBaseline: baseline.success }),
            )
          : undefined
      const noisePool = policy.noiseArea.checkpointMinutesFromOpen.includes(minute + 1) ? extract([]) : undefined
      const frame: Frame = {
        minute,
        snapshot,
        eligibility,
        noise: noisePool?.context.phase === noise ? noisePool : undefined,
        equity: extract(policy.noiseAreaSymbols),
        plans: new Map(),
      }
      frames.set(minute, frame)
      return frame
    }
    return { session, decisionMinutes, frameAt, sndkReady, baselineReady: Result.isSuccess(baseline), volatilityScale }
  }
}
type PreparedSession = ReturnType<ReturnType<typeof createReplay>>

const side = (leg: SelectedAlphaLeg) => (leg.direction === 'LONG' ? 1 : -1)
const adverse = (price: number, direction: number, cost: number) => price * (1 + (direction * cost) / 20_000)

export const modeledEntryLimit = (symbol: string, direction: number, close: number, bps: number) => {
  const rounding = direction === 1 ? 'UP' : 'DOWN'
  const referencePriceMicros = quantizeInstrumentPriceMicros(
    symbol,
    Result.getOrThrow(priceNumberToMicros(close, 'signal close', rounding)),
    rounding,
  )
  return (
    Number(
      Result.getOrThrow(
        deriveExecutionIntentPricing({
          symbol,
          side: direction === 1 ? OrderSide.Buy : OrderSide.Sell,
          orderType: OrderType.Limit,
          timeInForce: cashSpotLimitTimeInForce(MarketKind.Equity),
          quantityAtoms: quantityScale,
          referencePriceMicros,
          limitSlippageBps: BigInt(bps),
        }),
      ).expectedExecutionPriceMicros,
    ) / 1_000_000
  )
}

export const modeledStopLimit = (symbol: string, direction: number, stop: number, bps: number) => {
  const micros = BigInt(Math.round(stop * 1_000_000))
  const product = micros * BigInt(10_000 - direction * bps)
  return (
    Number(
      quantizeInstrumentPriceMicros(
        symbol,
        (product + (direction === 1 ? 9_999n : 0n)) / 10_000n,
        direction === 1 ? 'UP' : 'DOWN',
      ),
    ) / 1_000_000
  )
}

type ExecutionBar = Pick<NonNullable<ReturnType<typeof readBar>>, 'open' | 'high' | 'low' | 'close'>
export const followExit = (input: {
  readonly barAt: (minute: number) => ExecutionBar | undefined
  readonly direction: number
  readonly start: number
  readonly due: number
  readonly end: number
  readonly stop: number
  readonly limit: number
  readonly target: number
  readonly cost: number
  readonly eodOnly: boolean
}) => {
  const { barAt, direction, start, due, end, stop, limit, target, cost, eodOnly } = input
  let active = false
  let blockedMinutes = 0
  let missingMinutes = 0
  let ambiguousBars = 0
  const now = (minute: number, price: number, reason: 'timed' | 'target' | 'stop') => ({
    minute,
    price,
    reason,
    blockedMinutes,
    missingMinutes,
    ambiguousBars,
  })
  const stopTouched = (price: number) => direction * (price - stop) <= 0
  const clears = (price: number) => direction * (price - limit) >= 0
  const marketExit = (price: number) => adverse(price, -direction, cost)
  for (let minute = start; minute < end; minute++) {
    const bar = barAt(minute)
    if (bar === undefined) {
      missingMinutes++
      continue
    }
    if (minute > due) return now(minute, marketExit(bar.open), 'timed')
    if (eodOnly) continue
    const worst = direction === 1 ? bar.low : bar.high
    const best = direction === 1 ? bar.high : bar.low
    const targetTouched = direction * (best - target) >= 0
    if (active || stopTouched(worst)) {
      if (!active && targetTouched) ambiguousBars++
      const atOpen = active || stopTouched(bar.open)
      active = true
      const slippedOpen = marketExit(bar.open)
      if (atOpen && clears(slippedOpen)) return now(minute, slippedOpen, 'stop')
      // The close is after an intrabar trigger. The favorable extreme is only
      // usable when activation at the start of this minute is established.
      if (!atOpen && clears(marketExit(worst))) return now(minute, marketExit(worst), 'stop')
      if (clears(marketExit(atOpen ? best : bar.close))) return now(minute, limit, 'stop')
      blockedMinutes++
    } else if (targetTouched) {
      const slippedOpen = marketExit(bar.open)
      return now(minute, direction * (slippedOpen - target) >= 0 ? slippedOpen : target, 'target')
    }
  }
  return { minute: end, price: null, reason: 'unresolved' as const, blockedMinutes, missingMinutes, ambiguousBars }
}

const planOrders = (
  frame: Frame,
  replay: PreparedSession,
  legs: readonly SelectedAlphaLeg[],
  active: readonly Trade[],
) => {
  const key = JSON.stringify([
    legs.map(({ symbol, direction, targetWeight, protectiveStopBps, profitTargetBps }) => [
      symbol,
      direction,
      targetWeight,
      protectiveStopBps,
      profitTargetBps,
    ]),
    active.map(({ symbol, direction, shares, entryPrice }) => [symbol, direction, shares, entryPrice]),
  ])
  const existing = frame.plans.get(key)
  if (existing !== undefined) return existing
  const { session } = replay
  const eventMs = session.openMs + frame.minute * minuteMs
  const eventAt = new Date(eventMs).toISOString()
  const currentBars = new Map(
    active.flatMap(({ symbol }) => {
      const bar = readBar(session, symbol, frame.minute)
      return bar === undefined
        ? []
        : [[symbol, new Map([[frame.minute, { ...bar, symbol, eventMs, eventAt }]])] as const]
    }),
  )
  if (active.some(({ symbol }) => !currentBars.has(symbol))) return []
  const observedAt = frame.snapshot.manifest.observedAt
  const portfolio = makeEntryPortfolio(
    observedAt,
    equityUsd,
    active.map((trade) => ({
      ...trade,
      direction: trade.direction === 1 ? 'LONG' : 'SHORT',
      entryMinute: 0,
      exitMinute: trade.exit.minute,
      stopPriceMicros: '0',
      stopLimitPriceMicros: '0',
      profitLimitPriceMicros: '0',
    })),
    currentBars,
    frame.minute,
    new Map(),
  )
  const fundingPolicy =
    session.date < '2026-07-01'
      ? { ...policy, sharedProtocol: { ...protocol, executionModel: retainedIntradayExecutionModel } }
      : policy
  const funded = new Map<string, { readonly leg: SelectedAlphaLeg; readonly funding: Funding }>()
  for (const leg of legs) {
    const funding = Result.getOrThrow(
      makeIntradayAlphaFundedExitPlan({
        policy: fundingPolicy,
        observation: { observedAt, snapshot: frame.snapshot, portfolio, contentHash: observationHash },
        leg,
      }),
    )
    if (funding !== null) funded.set(leg.symbol, { leg, funding })
  }
  const orders: Order[] = []
  if (funded.size > 0 && funded.size === legs.length) {
    const selected = [...funded.entries()].sort(([a], [b]) => a.localeCompare(b))
    const planned = planReplayTargets({
      sessionDate: session.date,
      selectedSymbols: selected.map(([symbol]) => symbol),
      completedBar: (symbol) => readBar(session, symbol, frame.minute),
      portfolio,
      targetWeights: Object.fromEntries(selected.map(([symbol, { funding }]) => [symbol, funding.signedWeight])),
      maxBuy: Object.fromEntries(
        selected.map(([symbol, { funding, leg }]) => [
          symbol,
          leg.direction === 'LONG' ? funding.plan.maximumQuantityAtoms : '0',
        ]),
      ),
      maxSell: Object.fromEntries(
        selected.map(([symbol, { funding, leg }]) => [
          symbol,
          leg.direction === 'SHORT' ? funding.plan.maximumQuantityAtoms : '0',
        ]),
      ),
      eligibility: frame.eligibility,
      observedAt,
      orderExpiresAt: new Date(Date.parse(observedAt) + minuteMs).toISOString(),
      disjoint: active.length > 0,
    })
    if (
      planned.status === TargetPlanStatus.Planned &&
      (legs[0]?.phase !== midday ||
        isBalancedMiddayBasket(
          planned,
          selected.map(([symbol]) => symbol),
        ))
    ) {
      for (const intent of planned.intentTargets) {
        const item = funded.get(intent.symbol)
        const reference = planned.targets.find(({ symbol }) => symbol === intent.symbol)?.referencePriceMicros
        if (item === undefined || reference === undefined)
          throw new Error(`Planner returned unbound intent ${intent.symbol}`)
        const {
          leg,
          funding: {
            plan: { levels },
          },
        } = item
        orders.push({
          leg,
          shares: Number(BigInt(intent.quantityAtoms) / quantityScale),
          reference: Number(reference) / 1_000_000,
          liveLimit:
            Number(
              'maximumEntryPriceMicros' in levels ? levels.maximumEntryPriceMicros : levels.minimumEntryPriceMicros,
            ) / 1_000_000,
          stop: Number(levels.stopPriceMicros) / 1_000_000,
          liveStopLimit: Number(levels.stopLimitPriceMicros) / 1_000_000,
          target: Number(levels.profitLimitPriceMicros) / 1_000_000,
        })
      }
    }
  }
  frame.plans.set(key, orders)
  return orders
}

export interface Trade {
  readonly symbol: string
  readonly phase: ActiveAlphaPhase
  readonly direction: number
  readonly shares: number
  readonly entryPrice: number
  readonly entryMinute: number
  readonly exit: ReturnType<typeof followExit>
  readonly net: number | null
  readonly fee: number | null
  readonly linearCostPerBps: number
}

export interface Outcome {
  readonly trades: Trade[]
  readonly middaySelected: number
  readonly middayFilled: number
  readonly missingEntryPrices: number
  readonly benchmarkBlocks: number
  readonly plannerBlocks: number
  readonly capBlocks: number
  readonly maxGrossUsd: number
}

const phaseDeadline = (phase: ActiveAlphaPhase, sessionMinutes: number) => {
  if (phase === noise)
    return Math.min(
      policy.noiseArea.flattenMinuteFromOpen,
      sessionMinutes - (390 - policy.noiseArea.flattenMinuteFromOpen),
    )
  const deadline =
    phase === orb ? policy.morningOrb.hardExitMinuteFromOpen : policy.middayReversion.flattenMinuteFromOpen
  return Math.min(deadline, sessionMinutes - protocol.flattenBeforeCloseMinutes)
}

export const simulate = (replay: PreparedSession, scenario: Scenario, omit?: string): Outcome => {
  const { session, decisionMinutes, frameAt, baselineReady, volatilityScale } = replay
  const { architecture, lag, collar, stopBuffer, cost } = scenario
  const trades: Trade[] = []
  let middaySelected = 0
  let middayFilled = 0
  let missingEntryPrices = 0
  let benchmarkBlocks = 0
  let plannerBlocks = 0
  let capBlocks = 0
  let maxGrossUsd = 0
  const enabled = new Set(architecture.sleeves)
  const noiseCommitted = new Set<string>()
  let orbCommitted = false
  let middayCommitted = false
  const sizeByVol = architecture.sizing === 'volatility' || architecture.sizing === 'both'

  for (const minute of decisionMinutes) {
    if (!baselineReady || (sizeByVol && volatilityScale === null)) break
    const active = trades.filter((trade) => trade.exit.minute > minute)
    const equityOccupied = active.some((trade) => trade.phase !== noise)
    const mayNoise =
      enabled.has(noise) &&
      policy.noiseArea.checkpointMinutesFromOpen.includes(minute + 1) &&
      policy.noiseAreaSymbols.some((symbol) => symbol !== omit && !noiseCommitted.has(symbol))
    const mayOrb =
      enabled.has(orb) &&
      !orbCommitted &&
      !equityOccupied &&
      minute >= policy.morningOrb.entryStartMinuteFromOpen &&
      minute <= policy.morningOrb.entryEndMinuteFromOpen
    const mayMidday =
      enabled.has(midday) &&
      !middayCommitted &&
      !equityOccupied &&
      minute >= policy.middayReversion.entryStartMinuteFromOpen &&
      minute <= policy.middayReversion.entryEndMinuteFromOpen
    if (!mayNoise && !mayOrb && !mayMidday) continue
    const frame = frameAt(minute)
    // Enforce the benchmark at any visit, even if it prevents ranking every candidate.
    if (readBar(session, policy.benchmarkSymbol, minute) === undefined) {
      benchmarkBlocks++
      continue
    }
    const available = (candidate: { readonly symbol: string }) =>
      candidate.symbol !== omit && !noiseCommitted.has(candidate.symbol)
    let pool = mayNoise ? frame.noise : undefined
    if (pool === undefined || ![...pool.longPool, ...pool.shortPool].some(available)) pool = frame.equity
    if (pool === undefined) continue
    const phase = pool.context.phase
    if (
      phase === IntradayAlphaPhase.OutsideWindow ||
      (phase === orb && !mayOrb) ||
      (phase === midday && !mayMidday) ||
      (phase === noise && !mayNoise)
    )
      continue
    const entryMinute = minute + lag
    // No entry after the latest possible regular-session liquidation decision.
    const deadline = phaseDeadline(phase, session.minutes)
    if (entryMinute >= deadline) continue
    const longPool = pool.longPool.filter(available)
    const shortPool = pool.shortPool.filter(available)
    const selection = { context: pool.context, policy, longPool, shortPool, vetoedSymbols: new Set<string>() }
    let legs = selectIntradayAlphaLegs(selection)
    if (phase === midday && architecture.pairs === 3) {
      if (legs.length !== 4) continue
      const used = new Set(legs.map(({ symbol }) => symbol))
      const remaining = (candidate: { readonly symbol: string }) => !used.has(candidate.symbol)
      // Restrict the second selection to one ranked candidate per side.
      // The live selector returns its final legs in symbol order, not rank order.
      const extra = selectIntradayAlphaLegs({
        ...selection,
        longPool: longPool.filter(remaining).slice(0, 1),
        shortPool: shortPool.filter(remaining).slice(0, 1),
      })
      if (extra.length !== 2) continue
      legs = [...legs, ...extra].map((leg) => ({ ...leg, targetWeight: 0.12 }))
    }
    if (legs.length === 0) continue
    let scale = sizeByVol ? (volatilityScale ?? 1) : 1
    if (phase === midday && (architecture.sizing === 'dispersion' || architecture.sizing === 'both'))
      scale *= clampScale(sampleDeviation(longPool.map(({ relVwapDevBps }) => relVwapDevBps)) / 100)
    if (scale !== 1 || (phase === midday && typeof architecture.bracket === 'number')) {
      const maximum = phase === noise ? policy.noiseArea.maximumWeightPerLeg : policy.maximumSymbolWeight
      const bps = phase === midday && typeof architecture.bracket === 'number' ? architecture.bracket : undefined
      legs = legs.map((leg) => ({
        ...leg,
        // Match the precision of live risk weights before entering fixed point.
        targetWeight: Math.round(Math.min(maximum, leg.targetWeight * scale) * 10_000) / 10_000,
        protectiveStopBps: bps ?? leg.protectiveStopBps,
        profitTargetBps: bps ?? leg.profitTargetBps,
      }))
    }
    const heldGross = active.reduce((sum, trade) => {
      const close = readBar(session, trade.symbol, minute)?.close
      return close === undefined ? Infinity : sum + trade.shares * Math.max(close, trade.entryPrice)
    }, 0)
    if (heldGross === Infinity) {
      plannerBlocks++
      continue
    }
    const orders = planOrders(frame, replay, legs, active)
    if (orders.length === 0) {
      plannerBlocks++
      continue
    }

    const entries = orders.map((order) => {
      const { leg } = order
      const bar = readBar(session, leg.symbol, minute)
      if (bar === undefined) throw new Error(`No completed close for ${leg.symbol}`)
      const limit = collar === 10 ? order.liveLimit : modeledEntryLimit(leg.symbol, side(leg), bar.close, collar)
      return { order, limit, reserve: order.shares * Math.max(limit, order.reference) }
    })
    if (heldGross + entries.reduce((sum, order) => sum + order.reserve, 0) > capUsd) {
      capBlocks++
      continue
    }
    if (phase === orb) orbCommitted = true
    if (phase === midday) {
      middayCommitted = true
      middaySelected = orders.length
    }
    if (phase === noise) for (const { leg } of orders) noiseCommitted.add(leg.symbol)
    // Unfilled intents still use their quotas; the 60-second working window
    // resolves no later than the next minute's decision.
    let grossAtFill = heldGross
    for (const { order, limit } of entries) {
      const { leg, shares, stop, target } = order
      const direction = side(leg)
      const open = readBar(session, leg.symbol, entryMinute)?.open
      if (open === undefined) {
        missingEntryPrices++
        continue
      }
      const entryPrice = adverse(open, direction, cost)
      if (direction * (entryPrice - limit) > 0) continue
      if (grossAtFill + entryPrice * shares > capUsd) {
        capBlocks++
        continue
      }
      grossAtFill += entryPrice * shares
      if (phase === midday) middayFilled++
      const exit = followExit({
        barAt: (at) => readBar(session, leg.symbol, at),
        direction,
        start: entryMinute,
        due: Math.min(entryMinute + leg.maximumHoldingMinutes, deadline),
        end: session.minutes,
        stop,
        limit: stopBuffer === 10 ? order.liveStopLimit : modeledStopLimit(leg.symbol, direction, stop, stopBuffer),
        target,
        cost,
        eodOnly: phase === midday && architecture.bracket === 'eod',
      })
      const fee = exit.price === null ? null : sellFeeRate * shares * (direction === 1 ? exit.price : entryPrice)
      const net = exit.price === null || fee === null ? null : direction * shares * (exit.price - entryPrice) - fee
      const linearCostPerBps = (shares * (open + (exit.price ?? 0))) / 20_000
      trades.push({
        symbol: leg.symbol,
        phase,
        direction,
        shares,
        entryPrice,
        entryMinute,
        exit,
        fee,
        net,
        linearCostPerBps,
      })
    }
    maxGrossUsd = Math.max(maxGrossUsd, grossAtFill)
  }
  return {
    trades,
    middaySelected,
    middayFilled,
    missingEntryPrices,
    benchmarkBlocks,
    plannerBlocks,
    capBlocks,
    maxGrossUsd,
  }
}
