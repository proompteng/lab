import { Result } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../../broker/alpaca-price'
import type { EquityProviderSession } from '../../equity-hours'
import { OrderSide } from '../../execution/contracts'
import { AlphaV3EvidenceError, regularBounds, sessionSchedule } from './market'
import { AlphaV3Direction, AlphaV3Engine, AlphaV3NoonExit, type IntradayAlphaV3Policy } from './policy'
import type { AlphaV3NoiseSignal, AlphaV3NoonSignal, AlphaV3OrbSignal } from './signals'

const basis = 10_000n
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d
const closingSide = (direction: AlphaV3Direction) =>
  direction === AlphaV3Direction.Long ? OrderSide.Sell : OrderSide.Buy

/** Bound the order inside the entry collar, including at retail tick boundaries. */
export const entryLimitMicros = (policy: IntradayAlphaV3Policy, direction: AlphaV3Direction, reference: bigint) => {
  const bps = BigInt(policy.entryLimitSlippageBps)
  return direction === AlphaV3Direction.Long
    ? quantizeAlpacaLimitPriceMicros((reference * (basis + bps)) / basis, 'DOWN')
    : quantizeAlpacaLimitPriceMicros(ceil(reference * (basis - bps), basis), 'UP')
}

/** Price improvements on shorts can increase gross; reserve the upper opening envelope on either side. */
export const adverseOpenMicros = (policy: IntradayAlphaV3Policy, openingReference: bigint) =>
  quantizeAlpacaLimitPriceMicros(ceil(openingReference * (basis + BigInt(policy.entryLimitSlippageBps)), basis), 'UP')

export const stopLimitCollar = (
  policy: IntradayAlphaV3Policy,
  direction: AlphaV3Direction,
  stopMicros: bigint,
  atr14Micros: bigint,
) => {
  if (stopMicros <= 0n || atr14Micros < 0n) return null
  const minimum = ceil(stopMicros * BigInt(policy.stopLimitSlippageBps), basis)
  const atrFloor = ceil(atr14Micros * BigInt(policy.stopLimitAtrMultiplier * 4), 4n)
  const distanceMicros = minimum > atrFloor ? minimum : atrFloor
  if (distanceMicros >= stopMicros) return null
  const long = direction === AlphaV3Direction.Long
  const limitMicros = long
    ? quantizeAlpacaLimitPriceMicros(stopMicros - distanceMicros, 'DOWN')
    : quantizeAlpacaLimitPriceMicros(stopMicros + distanceMicros, 'UP')
  return limitMicros > 0n ? { limitMicros, distanceMicros } : null
}

type ProtectionSignal =
  | { readonly engine: AlphaV3Engine.Orb; readonly signal: AlphaV3OrbSignal }
  | { readonly engine: AlphaV3Engine.Reversion; readonly signal: AlphaV3NoonSignal }
  | { readonly engine: AlphaV3Engine.Noise; readonly signal: AlphaV3NoiseSignal }

type FlattenReason = 'MaximumHold' | 'fill-through-stop' | 'invalid-native-protection'

export const buildIntradayAlphaV3ExitPlan = (
  policy: IntradayAlphaV3Policy,
  session: EquityProviderSession,
  entry: ProtectionSignal,
  fill: { readonly averagePriceMicros: bigint; readonly shares: bigint; readonly observedAt: string },
) =>
  Result.gen(function* () {
    const filled = fill.averagePriceMicros
    const bounds = regularBounds(session)
    const observed = Date.parse(fill.observedAt)
    if (bounds === null || !Number.isFinite(observed) || observed < bounds.open || filled <= 0n || fill.shares <= 0n) {
      return yield* Result.fail(
        new AlphaV3EvidenceError({ message: 'Exit plan requires an official session and reconciled positive fill' }),
      )
    }
    const { engine, signal } = entry
    const deadline = sessionSchedule(policy, session).maximumHold[engine]
    const terms = {
      symbol: signal.symbol,
      side: closingSide(signal.direction),
      shares: fill.shares,
      maximumHold: { reason: 'MaximumHold' as const, dueAt: new Date(deadline).toISOString() },
    }
    const flatten = (reason: FlattenReason) => ({ ...terms, kind: 'flatten' as const, reason })
    if (observed >= deadline) return flatten('MaximumHold')

    const long = signal.direction === AlphaV3Direction.Long
    const sign = long ? 1n : -1n
    let rawStop: bigint
    if (engine === AlphaV3Engine.Orb) {
      rawStop = entry.signal.rangeStopMicros
      if (sign * (filled - rawStop) <= 0n) return flatten('fill-through-stop')
    } else if (engine === AlphaV3Engine.Reversion && policy.reversion.exit === AlphaV3NoonExit.Bracket) {
      rawStop = filled - sign * ceil(filled * BigInt(policy.reversion.stopBps), basis)
    } else {
      return { ...terms, kind: 'managed' as const, oppositeBandExit: engine === AlphaV3Engine.Noise }
    }

    if (rawStop <= 0n) return flatten('invalid-native-protection')
    const stopMicros = quantizeAlpacaLimitPriceMicros(rawStop, long ? 'DOWN' : 'UP')
    const rewardDistance =
      engine === AlphaV3Engine.Orb
        ? BigInt(policy.orb.rewardRiskMultiple) * sign * (filled - stopMicros)
        : ceil(filled * BigInt(policy.reversion.targetBps), basis)
    const rawTarget = filled + sign * rewardDistance
    if (rawTarget <= 0n) return flatten('invalid-native-protection')
    const targetMicros = quantizeAlpacaLimitPriceMicros(rawTarget, long ? 'UP' : 'DOWN')
    const collar = stopLimitCollar(policy, signal.direction, stopMicros, signal.atr14Micros)
    if (
      collar === null ||
      targetMicros <= 0n ||
      sign * (filled - stopMicros) <= 0n ||
      sign * (targetMicros - filled) <= 0n
    ) {
      return flatten('invalid-native-protection')
    }
    return {
      ...terms,
      kind: 'native-oco' as const,
      stop: { triggerMicros: stopMicros, ...collar },
      target: { limitMicros: targetMicros },
    }
  })

export interface NoontimeLegFill {
  readonly symbol: AlphaV3NoonSignal['symbol']
  readonly direction: AlphaV3Direction
  readonly requestedShares: bigint
  readonly filledShares: bigint
  /** Terminal means no entry or replacement order can still fill. Unknown outcomes are working. */
  readonly entry: 'working' | 'terminal'
  /** Reconcile remaining inventory and cancel any overlapping protection before a residual reduction. */
  readonly remainingShares: bigint
  readonly protection: 'working' | 'terminal'
  /** An unresolved flatten (including an ambiguous acknowledgement) blocks duplicate reductions. */
  readonly reduction: 'working' | 'terminal'
}

/**
 * No replacement risk: the hedge is a reduce-only unwind of actual residual inventory, never another opening leg.
 * Persist aborting before canceling and keep it latched across retries, even if late fills complete the basket.
 */
export const guardIntradayAlphaV3NoonBasket = (
  policy: IntradayAlphaV3Policy,
  input: {
    readonly legs: readonly NoontimeLegFill[]
    readonly aborting: boolean
    readonly entryDeadlineAt: string
    readonly observedAt: string
  },
) =>
  Result.gen(function* () {
    const { legs } = input
    const deadline = Date.parse(input.entryDeadlineAt)
    const observed = Date.parse(input.observedAt)
    const pairs = policy.reversion.pairs
    if (
      !Number.isFinite(deadline) ||
      !Number.isFinite(observed) ||
      legs.length !== 2 * pairs ||
      new Set(legs.map(({ symbol }) => symbol)).size !== legs.length ||
      legs.filter(({ direction }) => direction === AlphaV3Direction.Long).length !== pairs ||
      legs.some(
        ({ requestedShares, filledShares, remainingShares }) =>
          requestedShares <= 0n ||
          filledShares < 0n ||
          filledShares > requestedShares ||
          remainingShares < 0n ||
          remainingShares > filledShares,
      )
    )
      return yield* Result.fail(new AlphaV3EvidenceError({ message: 'Invalid reconciled noon basket state' }))
    const entryWorking = legs.filter(({ entry }) => entry === 'working')
    const incomplete = legs.filter(({ filledShares, requestedShares }) => filledShares < requestedShares)
    const canComplete =
      !input.aborting &&
      observed < deadline &&
      legs.every(
        ({ filledShares, remainingShares, reduction }) => filledShares === remainingShares && reduction === 'terminal',
      )
    if (canComplete && incomplete.length === 0 && entryWorking.length === 0) {
      return { kind: 'complete' as const, aborting: false as const }
    }
    if (canComplete && !incomplete.some(({ entry }) => entry === 'terminal')) {
      return { kind: 'await-fills' as const, aborting: false as const }
    }
    if (entryWorking.length > 0) {
      return {
        kind: 'cancel-entries' as const,
        aborting: true as const,
        symbols: entryWorking.map(({ symbol }) => symbol),
      }
    }
    const protectedLegs = legs.filter(({ protection }) => protection === 'working')
    if (protectedLegs.length > 0) {
      return {
        kind: 'cancel-protection' as const,
        aborting: true as const,
        symbols: protectedLegs.map(({ symbol }) => symbol),
      }
    }
    if (legs.some(({ reduction }) => reduction === 'working')) {
      return { kind: 'await-reductions' as const, aborting: true as const }
    }
    const reductions = legs.flatMap(({ symbol, direction, remainingShares }) =>
      remainingShares === 0n
        ? []
        : [{ symbol, side: closingSide(direction), shares: remainingShares, reduceOnly: true as const }],
    )
    return reductions.length === 0
      ? { kind: 'flat' as const, aborting: true as const }
      : { kind: 'reduce-residuals' as const, aborting: true as const, reductions }
  })
