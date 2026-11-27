import { Result } from 'effect'

import { adverseOpenMicros, entryLimitMicros } from './exit-plan'
import { AlphaV3EvidenceError } from './market'
import {
  AlphaV3Allocation,
  AlphaV3Direction,
  AlphaV3Engine,
  type AlphaV3Symbol,
  type IntradayAlphaV3Policy,
} from './policy'
import type { AlphaV3Entries, AlphaV3Signal } from './signals'

export interface AlphaV3Reservation {
  readonly symbol: AlphaV3Symbol
  readonly engine: AlphaV3Engine
  /** Reconciled fillable entry + held gross, retained until confirmed released. */
  readonly reservedGrossMicros: bigint
}

export interface AlphaV3Order extends AlphaV3Reservation {
  readonly direction: AlphaV3Direction
  readonly shares: bigint
  readonly entryLimitMicros: bigint
  readonly reservationPriceMicros: bigint
}

const priority = [AlphaV3Engine.Orb, AlphaV3Engine.Noise, AlphaV3Engine.Reversion] as const
const min = (first: bigint, ...rest: readonly bigint[]) => rest.reduce((a, b) => (b < a ? b : a), first)

const weightParts = (allocation: AlphaV3Allocation, engine: AlphaV3Engine) =>
  allocation === AlphaV3Allocation.Equal ? ([1n, 3n] as const) : ([engine === AlphaV3Engine.Orb ? 2n : 1n, 4n] as const)

export const alphaV3SleeveBudgets = (policy: IntradayAlphaV3Policy) => {
  const cap = BigInt(policy.sharedGrossCapMicros)
  const parts = (engine: AlphaV3Engine) => {
    const [num, den] = weightParts(policy.allocation, engine)
    return (cap * num) / den
  }
  return {
    [AlphaV3Engine.Orb]: parts(AlphaV3Engine.Orb),
    [AlphaV3Engine.Noise]: parts(AlphaV3Engine.Noise),
    [AlphaV3Engine.Reversion]: parts(AlphaV3Engine.Reversion),
  }
}

/** Admit only against contemporaneously observed, executable opening references, never signal lookahead. */
export const allocateIntradayAlphaV3 = (
  policy: IntradayAlphaV3Policy,
  input: {
    readonly entries: AlphaV3Entries
    readonly occupied: readonly AlphaV3Reservation[]
    readonly openingReferences: ReadonlyMap<AlphaV3Symbol, bigint>
  },
) =>
  Result.gen(function* () {
    const budgets = alphaV3SleeveBudgets(policy)
    const cap = BigInt(policy.sharedGrossCapMicros)
    const occupied = new Set<AlphaV3Symbol>()
    const reserved = {
      [AlphaV3Engine.Orb]: 0n,
      [AlphaV3Engine.Reversion]: 0n,
      [AlphaV3Engine.Noise]: 0n,
    }
    let total = 0n
    for (const holding of input.occupied) {
      if (holding.reservedGrossMicros <= 0n || occupied.has(holding.symbol)) {
        return yield* Result.fail(
          new AlphaV3EvidenceError({ message: `Invalid or duplicate reservation: ${holding.symbol}` }),
        )
      }
      occupied.add(holding.symbol)
      reserved[holding.engine] += holding.reservedGrossMicros
      total += holding.reservedGrossMicros
    }
    if (total > cap)
      return yield* Result.fail(new AlphaV3EvidenceError({ message: 'Existing reservations exceed shared gross cap' }))

    const orders: AlphaV3Order[] = []
    const skipped: {
      readonly engine: AlphaV3Engine
      readonly symbols: readonly AlphaV3Symbol[]
      readonly reason: string
    }[] = []
    const record = (group: readonly AlphaV3Order[]) => {
      for (const order of group) {
        orders.push(order)
        occupied.add(order.symbol)
        reserved[order.engine] += order.reservedGrossMicros
        total += order.reservedGrossMicros
      }
    }
    const available = (engine: AlphaV3Engine) => min(cap - total, budgets[engine] - reserved[engine])
    const price = (signal: AlphaV3Signal) => {
      if (signal.referenceMicros <= 0n) return null
      const open = input.openingReferences.get(signal.symbol)
      if (open === undefined || open <= 0n) return null
      const limit = entryLimitMicros(policy, signal.direction, signal.referenceMicros)
      if (limit <= 0n || (signal.direction === AlphaV3Direction.Long ? open > limit : open < limit)) return null
      const openReserve = adverseOpenMicros(policy, open)
      const signalReserve = adverseOpenMicros(policy, signal.referenceMicros)
      return { open, limit, reservationPrice: openReserve > signalReserve ? openReserve : signalReserve }
    }
    const order = (
      engine: AlphaV3Engine,
      signal: AlphaV3Signal,
      pricing: NonNullable<ReturnType<typeof price>>,
      shares: bigint,
    ): AlphaV3Order => ({
      engine,
      symbol: signal.symbol,
      direction: signal.direction,
      shares,
      entryLimitMicros: pricing.limit,
      reservationPriceMicros: pricing.reservationPrice,
      reservedGrossMicros: pricing.reservationPrice * shares,
    })

    for (const engine of priority) {
      const orb = input.entries[AlphaV3Engine.Orb]
      const group = engine === AlphaV3Engine.Orb ? (orb === null ? [] : [orb]) : input.entries[engine]
      const basket = engine === AlphaV3Engine.Reversion
      if (group.length === 0) continue
      if (
        new Set(group.map(({ symbol }) => symbol)).size !== group.length ||
        (basket &&
          (group.length !== policy.reversion.pairs * 2 ||
            group.filter(({ direction }) => direction === AlphaV3Direction.Long).length !== policy.reversion.pairs))
      ) {
        return yield* Result.fail(new AlphaV3EvidenceError({ message: `Invalid ${engine} signal group` }))
      }
      const [weight, divisor] = weightParts(policy.allocation, engine)
      const proposed: AlphaV3Order[] = []
      const dollarsPerLeg = available(engine) / BigInt(group.length)
      for (const signal of group) {
        const proposedOrder = () => {
          if (occupied.has(signal.symbol)) return 'occupied-symbol'
          const pricing = price(signal)
          if (pricing === null) return 'missing-open-or-outside-entry-collar'
          if (basket) {
            const shares = dollarsPerLeg / pricing.reservationPrice
            return shares > 0n ? order(engine, signal, pricing, shares) : 'insufficient-gross'
          }
          const sleeve = engine === AlphaV3Engine.Orb ? policy.orb : policy.noise
          const levels = orb?.symbol === signal.symbol && engine === AlphaV3Engine.Orb ? orb : null
          const sign = signal.direction === AlphaV3Direction.Long ? 1n : -1n
          const riskDistance =
            levels === null ? signal.atr14Micros : sign * (signal.referenceMicros - levels.rangeStopMicros)
          if (riskDistance <= 0n || (levels !== null && sign * (pricing.open - levels.rangeStopMicros) <= 0n))
            return 'invalid-risk-or-open-through-stop'
          const riskLegs = engine === AlphaV3Engine.Noise ? BigInt(policy.trendSymbols.length) : BigInt(policy.orb.top)
          const risk = (BigInt(sleeve.riskBudgetMicros) * weight) / (divisor * riskLegs)
          const symbolCap = (BigInt(sleeve.perSymbolCapMicros) * weight) / divisor
          const shares = min(risk / riskDistance, min(available(engine), symbolCap) / pricing.reservationPrice)
          return shares > 0n ? order(engine, signal, pricing, shares) : 'insufficient-gross-or-risk'
        }
        const next = proposedOrder()
        if (typeof next === 'string') {
          skipped.push({ engine, symbols: basket ? group.map(({ symbol }) => symbol) : [signal.symbol], reason: next })
          if (basket) break
        } else if (basket) proposed.push(next)
        else record([next])
      }
      if (basket && proposed.length === group.length) record(proposed)
    }

    return { orders, skipped, sleeveBudgetsMicros: budgets, totalReservedGrossMicros: total }
  })
