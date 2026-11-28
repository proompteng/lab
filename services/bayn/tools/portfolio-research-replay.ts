import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition as policy } from '../src/strategy/intraday-alpha/policy'
import {
  admitPortfolioBasket,
  dispersionMultiplier,
  type IntradayRiskState,
  type PortfolioThrottle,
  sleeveRiskMultipliers,
  trailingSleeveRisk,
  updateIntradayRisk,
  volatilityMultiplier,
} from '../src/strategy/intraday-alpha/portfolio-allocator'
import type { SelectedAlphaLeg } from '../src/strategy/intraday-alpha/signals'
import { type Bar, minuteMs } from './midday-research-data'
import { type Opportunity, type PortfolioSession, sleeveBudgetWeights, sleeves } from './portfolio-research-data'

export const startingEquity = 100_000
export const accountGrossCap = 180_000
export const costs = [2, 5, 10] as const
type Cost = (typeof costs)[number]
const sellFee = 0.21 / 10_000
const entryCollar = policy.entryLimitSlippageBps / 10_000

export interface Trial {
  readonly name: string
  readonly volTarget?: number
  readonly dispersion?: number
  readonly parity?: 'inverse-vol' | 'erc'
  readonly grossCap?: number
  readonly throttle?: PortfolioThrottle
}

const combined = { volTarget: 1, dispersion: 1, parity: 'erc' } as const
export const trialGrid: readonly Trial[] = [
  { name: 'v2-static' },
  { name: 'volatility', volTarget: 1 },
  { name: 'dispersion', dispersion: 1 },
  { name: 'inverse-vol', parity: 'inverse-vol' },
  { name: 'erc', parity: 'erc' },
  { name: 'vol-dispersion', volTarget: 1, dispersion: 1 },
  { name: 'combined', ...combined },
  { name: 'combined-loss', ...combined, throttle: { lossDrawdown: 0.015 } },
  { name: 'combined-profit-lock', ...combined, throttle: { profitTrigger: 0.015, profitGiveback: 0.005 } },
  { name: 'combined-cap-120k', ...combined, grossCap: 120_000 },
  { name: 'combined-vol-0.9', ...combined, volTarget: 0.9 },
  { name: 'combined-vol-1.1', ...combined, volTarget: 1.1 },
  { name: 'combined-dispersion-0.9', ...combined, dispersion: 0.9 },
  { name: 'combined-dispersion-1.1', ...combined, dispersion: 1.1 },
]
export const neighbors = trialGrid.slice(-4).map(({ name }) => name)

export interface PortfolioDay {
  readonly date: string
  readonly net: number | null
  readonly sleeveNet: readonly (number | null)[]
  readonly closedNet: number
  readonly orderLegs: number
  readonly filled: number
  readonly partialBaskets: number
  readonly unresolvedExits: number
  readonly missingBenchmarkChecks: number
  readonly missingEntryPrices: number
  readonly missingHeldBars: number
  readonly unknownExposureMinutes: number
  readonly capConstrained: number
  readonly throttleEntries: number
  readonly profitLockEntries: number
  readonly peakReservedGross: number
  readonly peakMarkedGross: number
  readonly peakUtilization: number
  readonly timeBuckets: readonly number[]
  readonly maxIntradayDrawdown: number
  readonly spyReturn: number | null
  readonly highVol: boolean | null
}

interface WorkingLeg {
  readonly leg: SelectedAlphaLeg
  readonly direction: 1 | -1
  readonly collar: number
  readonly maxPrice: number
  readonly shares: number
}
interface WorkingBasket {
  readonly fillMinute: number
  readonly expiresMs: number
  readonly legs: readonly WorkingLeg[]
}
interface Position extends WorkingLeg {
  readonly entry: number
  readonly stop: number
  readonly stopLimit: number
  readonly target: number
  readonly deadline: number
  triggered: boolean
  continuous: boolean
  mark: number
}

// At most one minute of working entry orders; size and reserve before observing that minute.
const buildOrder = (leg: SelectedAlphaLeg, close: number, dollars: number, scale: number): WorkingLeg => {
  const direction = leg.direction === 'LONG' ? 1 : -1
  const maxPrice = Math.ceil(close * 100 * (1 + entryCollar)) / 100
  const collar = direction === 1 ? maxPrice : Math.floor(close * 100 * (1 - entryCollar)) / 100
  return { leg, direction, collar, maxPrice, shares: Math.floor((dollars * scale) / maxPrice) }
}

const openLeg = (
  order: WorkingLeg,
  open: number,
  slip: number,
  minute: number,
  sessionMinutes: number,
): Position | null => {
  const { leg, direction, collar, maxPrice } = order
  const entry = open * (1 + direction * slip)
  if (entry > maxPrice || direction * (entry - collar) > 0) return null
  const deadline =
    leg.phase === IntradayAlphaPhase.MorningOrb
      ? policy.morningOrb.hardExitMinuteFromOpen
      : leg.phase === IntradayAlphaPhase.MiddayReversion
        ? policy.middayReversion.flattenMinuteFromOpen
        : policy.noiseArea.flattenMinuteFromOpen
  const closeLead = leg.phase === IntradayAlphaPhase.NoiseAreaTrend ? 2 : 5
  const stop = collar * (1 - (direction * leg.protectiveStopBps) / 10_000)
  return {
    ...order,
    entry,
    stop,
    stopLimit: stop * (1 - direction * entryCollar),
    target: collar * (1 + (direction * leg.profitTargetBps) / 10_000),
    deadline: Math.min(minute + leg.maximumHoldingMinutes, deadline, sessionMinutes - closeLead),
    triggered: false,
    continuous: true,
    mark: open,
  }
}

const exitPrice = (position: Position, bar: Bar, minute: number) => {
  const { direction, stop, stopLimit, target } = position
  if (minute > position.deadline) return bar.open
  const adverse = direction === 1 ? bar.low : bar.high
  const favorable = direction === 1 ? bar.high : bar.low
  const signed = (price: number) => direction * price
  // OHLC cannot order a stop and target within the same bar: handle the stop first.
  if (position.triggered || signed(adverse) <= signed(stop)) {
    const activeAtOpen = position.triggered || signed(bar.open) <= signed(stop)
    position.triggered = true
    if (activeAtOpen && signed(bar.open) >= signed(stopLimit)) return bar.open
    if (signed(activeAtOpen ? favorable : bar.close) >= signed(stopLimit) || signed(adverse) >= signed(stopLimit))
      return stopLimit
    return undefined
  }
  // A target beyond the touch is not known executable just from the bar's open after entry.
  if (signed(favorable) >= signed(target)) return target
  return undefined
}

const usageBucket = (gross: number, cap: number) => (gross === 0 ? 0 : Math.min(5, Math.ceil((gross / cap) * 5)))

export const replayPortfolioDay = (
  session: PortfolioSession,
  trial: Trial,
  cost: Cost,
  risk: ReturnType<typeof trailingSleeveRisk>,
  targets: readonly (number | null)[],
  budgets: readonly number[] = sleeveBudgetWeights,
): PortfolioDay => {
  const vol = trial.volTarget
  const parity =
    trial.parity === undefined ? budgets.map(() => 1) : sleeveRiskMultipliers(budgets, risk.covariance, trial.parity)
  const scaling = risk.volatility.map((value, i) => {
    const target = targets[i]
    return (parity[i] ?? 1) * (vol === undefined || target == null ? 1 : volatilityMultiplier(target * vol, value))
  })
  const slip = cost / 20_000
  const grossCap = trial.grossCap ?? accountGrossCap
  const bySleeve = sleeves.map(() => 0)
  const timeBuckets = [0, 0, 0, 0, 0, 0]
  const taken = new Set<string>()
  let working: WorkingBasket | undefined
  let positions: Position[] = []
  let orbDone = false
  let middayDone = false
  let closedNet = 0
  let filled = 0
  let orderLegs = 0
  let partialBaskets = 0
  let missingBenchmarkChecks = 0
  let missingEntryPrices = 0
  let missingHeldBars = 0
  let unknownExposureMinutes = 0
  let capConstrained = 0
  let throttleEntries = 0
  let profitLockEntries = 0
  let riskState: IntradayRiskState = { peakReturn: 0, lossThrottled: false, profitLocked: false }
  let peakMarkedGross = 0
  let peakReservedGross = 0
  let maxIntradayDrawdown = 0

  const permitted = (opportunity: Opportunity | undefined) => {
    if (opportunity === undefined) return []
    const { phase, legs } = opportunity
    if (
      (phase === IntradayAlphaPhase.MorningOrb && orbDone) ||
      (phase === IntradayAlphaPhase.MiddayReversion && middayDone)
    )
      return []
    return legs.filter((leg) => !taken.has(leg.symbol) || phase !== IntradayAlphaPhase.NoiseAreaTrend)
  }

  const executionUnknown = () => missingEntryPrices > 0 || missingHeldBars > 0 || missingBenchmarkChecks > 0
  const settleWorking = ({ fillMinute, legs }: WorkingBasket) => {
    const opened: Position[] = []
    for (const order of legs) {
      const open = session.bars.get(order.leg.symbol)?.get(fillMinute)?.open
      if (open === undefined) {
        missingEntryPrices++
        continue
      }
      const position = openLeg(order, open, slip, fillMinute, session.minutes)
      if (position !== null) opened.push(position)
    }
    if (legs.length > 1 && opened.length > 0 && opened.length < legs.length) partialBaskets++
    filled += opened.length
    working = undefined
    return opened
  }
  const pnlAt = ({ direction, entry, shares }: Position, price: number) => {
    const exit = price * (1 - direction * slip)
    return (direction * (exit - entry) - sellFee * (direction === 1 ? exit : entry)) * shares
  }
  const markRisk = (markedReturn: number) => {
    riskState = updateIntradayRisk(riskState, markedReturn, trial.throttle ?? {})
    maxIntradayDrawdown = Math.max(maxIntradayDrawdown, riskState.peakReturn - markedReturn)
  }

  for (let minute = 0; minute < session.minutes; minute++) {
    if (working?.fillMinute === minute) positions.push(...settleWorking(working))

    let grossAtOpen = 0
    let grossUsed = 0
    let netUsed = 0
    let unrealized = 0
    const addMark = (position: Position) => {
      grossUsed += position.mark * position.shares
      netUsed += position.direction * position.mark * position.shares
      unrealized += pnlAt(position, position.mark)
    }
    positions = positions.filter((position) => {
      const { leg, shares } = position
      const bar = session.bars.get(leg.symbol)?.get(minute)
      if (bar === undefined) {
        missingHeldBars++
        position.continuous = false
        return true
      }

      // Active at the open even if an exit is modeled later in the same minute.
      grossAtOpen += shares * bar.open
      const exit = exitPrice(position, bar, minute)
      if (exit === undefined) {
        position.mark = bar.close
        addMark(position)
        return true
      }
      if (position.continuous) {
        const value = pnlAt(position, exit)
        const i = sleeves.indexOf(leg.phase)
        bySleeve[i] = (bySleeve[i] ?? 0) + value
        closedNet += value
      }
      return false
    })

    if (executionUnknown()) {
      unknownExposureMinutes++
      continue
    }
    peakMarkedGross = Math.max(peakMarkedGross, grossUsed, grossAtOpen)
    const bucket = usageBucket(grossUsed, grossCap)
    timeBuckets[bucket] = (timeBuckets[bucket] ?? 0) + 1
    markRisk((closedNet + unrealized) / startingEquity)

    const decision = session.decisions.get(minute)
    if (decision === undefined) continue
    const { observedMsFromOpen } = decision
    if (observedMsFromOpen < (minute + 1) * minuteMs) throw new Error('Observation precedes the completed bar')
    if (working !== undefined) {
      if (observedMsFromOpen < working.expiresMs) continue
      // The next open can be known by the delayed observation, but its close/range cannot.
      const opened = settleWorking(working)
      positions.push(...opened)
      if (executionUnknown()) continue
      for (const position of opened) addMark(position)
      peakMarkedGross = Math.max(peakMarkedGross, grossUsed)
      markRisk((closedNet + unrealized) / startingEquity)
    }
    if (decision.missingBenchmark) {
      // Do not claim a known no-signal for an unobserved eligible checkpoint.
      if (
        (!orbDone && minute <= policy.morningOrb.entryEndMinuteFromOpen) ||
        (!middayDone &&
          (budgets[1] ?? 0) > 0 &&
          minute >= policy.middayReversion.entryStartMinuteFromOpen &&
          minute <= policy.middayReversion.entryEndMinuteFromOpen) ||
        (taken.size < session.noiseSymbolCount &&
          policy.noiseArea.checkpointMinutesFromOpen.some((point) => point === minute + 1))
      )
        missingBenchmarkChecks++
      continue
    }
    const noise = permitted(decision.noise)
    const opportunity = noise.length > 0 ? decision.noise : decision.equity
    const legs = noise.length > 0 ? noise : permitted(opportunity)
    if (legs.length === 0 || opportunity === undefined) continue
    if (
      positions.some(({ leg }) => leg.phase !== IntradayAlphaPhase.NoiseAreaTrend) &&
      opportunity.phase !== IntradayAlphaPhase.NoiseAreaTrend
    )
      continue
    const index = sleeves.indexOf(opportunity.phase)
    if ((budgets[index] ?? 0) <= 0) continue
    const loss = minute >= policy.middayReversion.entryStartMinuteFromOpen && riskState.lossThrottled
    const profit = minute >= policy.middayReversion.entryStartMinuteFromOpen && riskState.profitLocked
    const dispersion =
      opportunity.phase === IntradayAlphaPhase.MiddayReversion && trial.dispersion !== undefined
        ? dispersionMultiplier(opportunity.dispersion, opportunity.trailingDispersion, trial.dispersion)
        : 1
    const multiplier = (scaling[index] ?? 1) * dispersion * (loss || profit ? 0.5 : 1)
    const requests = legs.map((leg) => ({
      dollars: leg.targetWeight * startingEquity * multiplier,
      direction: leg.direction === 'LONG' ? (1 as const) : (-1 as const),
    }))
    const scale = admitPortfolioBasket(requests, {
      grossCap,
      grossUsed,
      netUsed,
      equity: startingEquity + closedNet + unrealized,
      buyingPowerMultiple: 4,
      netCap: 100_000,
      maxLeg: 40_000,
      workingLong: 0,
      workingShort: 0,
    })
    if (scale < 1) capConstrained++
    if (scale === 0) continue
    const orders = legs.map((leg, i) => {
      const close = session.bars.get(leg.symbol)?.get(minute)?.close
      if (close === undefined) throw new Error(`Missing completed close for selected ${session.date} ${leg.symbol}`)
      return buildOrder(leg, close, requests[i]?.dollars ?? 0, scale)
    })
    if (orders.some(({ shares }) => shares === 0)) continue
    // The completed bar's boundary open is earlier than the delayed observation. A one-minute
    // working window can have at most one eligible open, strictly between observation and expiry.
    const expiresMs = observedMsFromOpen + minuteMs
    const fillMinute = Math.floor(observedMsFromOpen / minuteMs) + 1
    if (fillMinute >= session.minutes || fillMinute * minuteMs >= expiresMs) continue
    working = { fillMinute, expiresMs, legs: orders }
    peakReservedGross = Math.max(
      peakReservedGross,
      grossUsed + orders.reduce((sum, { shares, maxPrice }) => sum + shares * maxPrice, 0),
    )
    orderLegs += orders.length
    if (loss) throttleEntries++
    if (profit) profitLockEntries++
    if (opportunity.phase === IntradayAlphaPhase.MorningOrb) orbDone = true
    else if (opportunity.phase === IntradayAlphaPhase.MiddayReversion) middayDone = true
    else for (const { symbol } of legs) taken.add(symbol)
  }

  const unknown = !session.baselineAvailable || executionUnknown() || positions.length > 0
  return {
    date: session.date,
    net: unknown ? null : closedNet,
    closedNet,
    sleeveNet: sleeves.map((phase, index) =>
      !session.baselineAvailable || executionUnknown() || positions.some(({ leg }) => leg.phase === phase)
        ? null
        : (bySleeve[index] ?? 0),
    ),
    orderLegs,
    filled,
    partialBaskets,
    unresolvedExits: positions.length,
    missingBenchmarkChecks,
    missingEntryPrices,
    missingHeldBars,
    unknownExposureMinutes,
    capConstrained,
    throttleEntries,
    profitLockEntries,
    peakReservedGross,
    peakMarkedGross,
    peakUtilization: Math.max(peakReservedGross, peakMarkedGross) / grossCap,
    timeBuckets,
    maxIntradayDrawdown,
    spyReturn: session.spyReturn,
    highVol: session.highVol,
  }
}
