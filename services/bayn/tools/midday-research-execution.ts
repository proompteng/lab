import { quantizeAlpacaLimitPriceMicros } from '../src/broker/alpaca-price'
import { intradayAlphaDefinition } from '../src/strategy/intraday-alpha/policy'
import { checkpoints, type Session, type Tape } from './midday-research-data'
import { type RankedLeg, type Selection } from './midday-research-signal'
import { sum } from './midday-research-statistics'

export const startingCapitalUsd = 100_000
const bps = 10_000
const sellFeeBps = 0.21
const observedAdverseBps = 1
const requoteExtraBps = 10

export type Cost = 2 | 5 | 10 | 'IEX'
export type Protection = 'independent' | 'flatten' | 'requote'
export type Sizing = 'equal-dollar' | 'beta-dollar'
export type Collar =
  | { readonly family: 'fixed'; readonly value: number }
  | { readonly family: 'spread'; readonly value: number }
  | { readonly family: 'atr'; readonly value: number }

interface Price {
  readonly price: number
  readonly reference: number
  readonly minute: number
}

interface Order {
  readonly leg: RankedLeg
  readonly tape: Tape
  readonly limit: number
  readonly collar: number
  readonly shares: number
}

type Filled = Order & { readonly entry: Price }

const snap = (price: number, direction: 'UP' | 'DOWN') =>
  Number(quantizeAlpacaLimitPriceMicros(BigInt(Math.round(price * 1_000_000)), direction)) / 1_000_000

const entryLimit = (leg: RankedLeg, collar: number) => {
  const direction = leg.direction === 1 ? 'UP' : 'DOWN'
  return snap(snap(leg.row.close, direction) * (1 + (leg.direction * collar) / bps), direction)
}

export const legCollarBps = ({ row }: RankedLeg, collar: Collar): number | undefined => {
  switch (collar.family) {
    case 'fixed':
      return collar.value
    case 'spread':
      return row.completedQuote === undefined ? undefined : Math.max(15, collar.value * row.completedQuote.medianBps)
    case 'atr':
      return row.atrBps === undefined ? undefined : collar.value * row.atrBps
  }
}

export const targetNotionals = (legs: readonly RankedLeg[], sizing: Sizing, grossScale: number) => {
  if (legs.length === 1) return [startingCapitalUsd * checkpoints.fallbackSingleLegWeight * grossScale]
  const [long, short] = legs
  if (long?.direction !== 1 || short?.direction !== -1 || legs.length !== 2)
    throw new Error('Expected an ordered long/short pair')
  const equal = startingCapitalUsd * checkpoints.targetWeightPerLeg * grossScale
  if (sizing === 'equal-dollar') return [equal, equal]
  const longBeta = long.row.beta20
  const shortBeta = short.row.beta20
  if (longBeta === undefined || shortBeta === undefined) throw new Error('Beta sizing requires two causal betas')
  return [(2 * equal * shortBeta) / (longBeta + shortBeta), (2 * equal * longBeta) / (longBeta + shortBeta)]
}

export const executionPrice = (tape: Tape, minute: number, direction: 1 | -1, cost: Cost): Price | undefined => {
  if (cost === 'IEX') {
    const quote = tape.quotes.get(minute)
    if (quote === undefined) return undefined
    const reference = (quote.firstAsk + quote.firstBid) / 2
    const touch = direction === 1 ? quote.firstAsk : quote.firstBid
    return { reference, price: touch * (1 + (direction * observedAdverseBps) / bps), minute }
  }
  const bar = tape.bars.get(minute)
  if (bar === undefined) return undefined
  return { reference: bar.open, price: bar.open * (1 + (direction * cost) / (2 * bps)), minute }
}

const tryFill = (order: Order, entry: Price | undefined, limit: number): Filled | undefined => {
  if (entry === undefined || order.leg.direction * (entry.price - limit) > 0) return undefined
  return { ...order, limit, entry }
}

const executeExit = (
  fill: Filled,
  minutes: number,
  cost: Cost,
  options: { readonly flattenFrom?: number; readonly before?: number } = {},
) => {
  const direction = fill.leg.direction
  const stop = snap(
    fill.limit * (1 - (direction * checkpoints.protectiveStopBps) / bps),
    direction === 1 ? 'DOWN' : 'UP',
  )
  const stopLimit = snap(
    stop * (1 - (direction * intradayAlphaDefinition.entryLimitSlippageBps) / bps),
    direction === 1 ? 'UP' : 'DOWN',
  )
  const target = snap(
    fill.limit * (1 + (direction * checkpoints.profitTargetBps) / bps),
    direction === 1 ? 'UP' : 'DOWN',
  )
  const deadline = Math.min(checkpoints.flattenMinuteFromOpen, minutes - 5)
  const touchesStop = (minute: number) => {
    const bar = fill.tape.bars.get(minute)
    return bar !== undefined && (direction === 1 ? bar.low <= stop : bar.high >= stop)
  }
  // The entry bucket can establish a possible stop trigger once completed, but cannot price that stop.
  let stopActive = touchesStop(fill.entry.minute)
  for (let minute = fill.entry.minute + 1; minute < (options.before ?? minutes); minute++) {
    const exit = executionPrice(fill.tape, minute, direction === 1 ? -1 : 1, cost)
    if (exit !== undefined) {
      if (minute >= (options.flattenFrom ?? minutes) || minute > deadline) return exit
      if (stopActive ? direction * (exit.price - stopLimit) >= 0 : direction * (exit.price - target) >= 0) return exit
    }
    // A stop touched during this minute can only route a limit into the following bucket.
    stopActive ||= touchesStop(minute)
  }
  return undefined
}

export interface DayResult {
  readonly status:
    | 'no-signal'
    | 'benchmark-unavailable'
    | 'baseline-unavailable'
    | 'traded'
    | 'no-fill'
    | 'unresolved-exit'
  readonly minute: number | null
  readonly netUsd: number | null
  readonly selected: number
  readonly filled: number
  readonly initialFilled: number
  readonly noEntryEvidence: number
  readonly entriesUnavailable: number
  readonly flattenCount: number
  readonly rescueCount: number
  readonly unresolvedOrphans: number
  readonly unresolvedExitSymbols: readonly string[]
  readonly maxOrphanExitDelayMinutes: number
  readonly initialOneSided: boolean
  readonly oneSided: boolean
  readonly initialResidualUsd: number
  readonly residualUsd: number
  readonly betaResidualUsd: number | null
  readonly orphanUsd: number
  readonly peakDirectionalBoundUsd: number
  readonly peakPairOrphanUsd: number
  readonly peakPairOrphanBetaUsd: number | null
  readonly executionCostUsd: number
  readonly adverseMarkoutUsd: number | null
  readonly modeledFeesUsd: number
}

export const noTrade = (status: 'no-signal' | 'benchmark-unavailable' | 'baseline-unavailable'): DayResult => ({
  status,
  minute: null,
  netUsd: status === 'no-signal' ? 0 : null,
  selected: 0,
  filled: 0,
  initialFilled: 0,
  noEntryEvidence: 0,
  entriesUnavailable: 0,
  flattenCount: 0,
  rescueCount: 0,
  unresolvedOrphans: 0,
  unresolvedExitSymbols: [],
  maxOrphanExitDelayMinutes: 0,
  initialOneSided: false,
  oneSided: false,
  initialResidualUsd: 0,
  residualUsd: 0,
  betaResidualUsd: 0,
  orphanUsd: 0,
  peakDirectionalBoundUsd: 0,
  peakPairOrphanUsd: 0,
  peakPairOrphanBetaUsd: 0,
  executionCostUsd: 0,
  adverseMarkoutUsd: null,
  modeledFeesUsd: 0,
})

const entryNotional = (leg: Filled) => leg.shares * leg.entry.price
const signedExposure = (fills: readonly Filled[]) =>
  Math.abs(sum(fills.map((leg) => leg.leg.direction * entryNotional(leg))))
const oneSided = (fills: readonly Filled[]) =>
  fills.length > 0 && fills.every(({ leg }) => leg.direction === fills[0]?.leg.direction)

export const executeBasket = (input: {
  readonly session: Session
  readonly minute: number
  readonly selection: Selection
  readonly cost: Cost
  readonly collar: Collar
  readonly protection: Protection
  readonly sizing: Sizing
}): DayResult => {
  const { session, selection, minute, cost, collar, protection } = input
  const first = minute + 1
  const independent = protection === 'independent'
  const initial: Filled[] = []
  const fills: Filled[] = []
  const retained: Filled[] = []
  let netUsd = 0
  let executionCostUsd = 0
  let modeledFeesUsd = 0
  let orphanUsd = 0
  let peakPairOrphanUsd = 0
  let peakPairOrphanBetaUsd = 0
  let missingPeakBeta = false
  const unresolvedExitSymbols: string[] = []
  let maxOrphanExitDelayMinutes = 0
  let unresolvedOrphans = 0
  let flattenCount = 0
  let rescueCount = 0
  let noEntryEvidence = 0
  let entriesUnavailable = 0
  let adverseMarkoutUsd = 0
  let markoutCount = 0

  for (const group of selection.groups) {
    const notionals = targetNotionals(group, input.sizing, selection.grossScale)
    const orders = group.flatMap((leg, index): Order[] => {
      const tape = session.tapes.get(leg.row.symbol)
      const legCollar = legCollarBps(leg, collar)
      const notional = notionals[index]
      if (
        tape === undefined ||
        legCollar === undefined ||
        notional === undefined ||
        (cost === 'IEX' && leg.row.completedQuote === undefined)
      )
        return []
      const limit = entryLimit(leg, legCollar)
      const shares = Math.floor(notional / limit)
      return shares > 0 ? [{ leg, tape, limit, collar: legCollar, shares }] : []
    })
    // Check both legs before sending either order. This is not an atomic fill assumption.
    if (!independent && (group.length !== 2 || orders.length !== 2)) {
      entriesUnavailable += group.length
      continue
    }
    entriesUnavailable += group.length - orders.length
    const initialFills = orders.flatMap((order) => {
      const price = executionPrice(order.tape, first, order.leg.direction, cost)
      if (price === undefined) noEntryEvidence++
      const fill = tryFill(order, price, order.limit)
      return fill === undefined ? [] : [fill]
    })
    initial.push(...initialFills)
    const groupFills = [...initialFills]
    if (protection === 'requote' && initialFills.length === 1) {
      const missing = orders.find(({ leg }) => leg.row.symbol !== initialFills[0]?.leg.row.symbol)
      if (missing !== undefined && (cost !== 'IEX' || missing.tape.quotes.has(first))) {
        const price = executionPrice(missing.tape, first + 1, missing.leg.direction, cost)
        if (price === undefined) noEntryEvidence++
        const fill = tryFill(missing, price, entryLimit(missing.leg, missing.collar + requoteExtraBps))
        if (fill !== undefined) {
          groupFills.push(fill)
          rescueCount++
        }
      }
    }
    fills.push(...groupFills)
    // Same-minute quote order across symbols is unknown. Bound transient leg risk without pretending simultaneous fills.
    for (const fill of groupFills) {
      peakPairOrphanUsd = Math.max(peakPairOrphanUsd, entryNotional(fill))
      if (fill.leg.row.beta20 === undefined) missingPeakBeta = true
      else peakPairOrphanBetaUsd = Math.max(peakPairOrphanBetaUsd, fill.leg.row.beta20 * entryNotional(fill))
    }
    const orphan = groupFills.length === 1
    const workEnd = first + (protection === 'requote' && initialFills.length === 1 ? 2 : 1)
    const original = initialFills.length === 1 ? initialFills[0] : undefined
    const exitDuringRescue =
      original !== undefined && groupFills.length === 2
        ? executeExit(original, session.minutes, cost, { before: workEnd })
        : undefined
    for (const fill of groupFills) {
      // If the first leg closed while a rescue order worked, the newly filled partner is now the orphan.
      const orphaned = orphan || (exitDuringRescue !== undefined && fill !== original)
      const flatten = !independent && orphaned
      const exit =
        (fill === original ? exitDuringRescue : undefined) ??
        executeExit(fill, session.minutes, cost, flatten ? { flattenFrom: workEnd } : {})

      const direction = fill.leg.direction
      const quantity = fill.shares
      executionCostUsd += quantity * direction * (fill.entry.price - fill.entry.reference)
      const nextQuote = cost === 'IEX' ? fill.tape.quotes.get(fill.entry.minute + 1) : undefined
      if (nextQuote !== undefined) {
        adverseMarkoutUsd +=
          quantity * direction * (fill.entry.reference - (nextQuote.firstAsk + nextQuote.firstBid) / 2)
        markoutCount++
      }
      if (exit === undefined || (!flatten && exit.minute >= workEnd)) {
        retained.push(fill)
        if (orphaned) orphanUsd += entryNotional(fill)
      }
      if (exit === undefined) {
        unresolvedExitSymbols.push(fill.leg.row.symbol)
        if (flatten) unresolvedOrphans++
        continue
      }
      if (flatten && exit.minute >= workEnd) {
        flattenCount++
        maxOrphanExitDelayMinutes = Math.max(maxOrphanExitDelayMinutes, exit.minute - workEnd)
      }
      executionCostUsd += quantity * direction * (exit.reference - exit.price)
      const fee = (quantity * (direction === 1 ? exit.price : fill.entry.price) * sellFeeBps) / bps
      modeledFeesUsd += fee
      netUsd += direction * quantity * (exit.price - fill.entry.price) - fee
    }
  }
  const betaResidualUsd = retained.some(({ leg }) => leg.row.beta20 === undefined)
    ? null
    : Math.abs(sum(retained.map((fill) => fill.leg.direction * entryNotional(fill) * (fill.leg.row.beta20 ?? 0))))
  return {
    status: unresolvedExitSymbols.length > 0 ? 'unresolved-exit' : fills.length > 0 ? 'traded' : 'no-fill',
    minute,
    netUsd: unresolvedExitSymbols.length > 0 ? null : netUsd,
    selected: selection.groups.reduce((count, group) => count + group.length, 0),
    filled: fills.length,
    initialFilled: initial.length,
    noEntryEvidence,
    entriesUnavailable,
    flattenCount,
    rescueCount,
    unresolvedOrphans,
    unresolvedExitSymbols: unresolvedExitSymbols.sort(),
    maxOrphanExitDelayMinutes,
    initialOneSided: oneSided(initial),
    oneSided: oneSided(retained),
    initialResidualUsd: signedExposure(initial),
    residualUsd: signedExposure(retained),
    betaResidualUsd,
    orphanUsd,
    peakDirectionalBoundUsd: Math.max(
      sum(fills.filter(({ leg }) => leg.direction === 1).map(entryNotional)),
      sum(fills.filter(({ leg }) => leg.direction === -1).map(entryNotional)),
    ),
    peakPairOrphanUsd,
    peakPairOrphanBetaUsd: missingPeakBeta ? null : peakPairOrphanBetaUsd,
    executionCostUsd,
    adverseMarkoutUsd: markoutCount > 0 ? adverseMarkoutUsd : null,
    modeledFeesUsd,
  }
}
