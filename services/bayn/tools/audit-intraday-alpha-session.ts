import { NodeRuntime } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Data, Effect, Result, Schema } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { forwardPerformanceSnapshot } from '../src/forward-performance/postgres/snapshot'
import { compareIntradayInstants } from '../src/market-data/intraday/time'
import { quantityScale } from '../src/quantity'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { alphaSessionRegularClose, readAlphaSession, type AlphaSessionRows } from './intraday-alpha-session-postgres'

const engines = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const

const workingOrder = (status: OrderStatus) =>
  status === OrderStatus.New || status === OrderStatus.Pending || status === OrderStatus.PartiallyFilled

const signedQty = (side: OrderSide, quantityAtoms: string) =>
  (side === OrderSide.Buy ? 1n : -1n) * BigInt(quantityAtoms)

type Fill = AlphaSessionRows['fills'][number]
type Order = AlphaSessionRows['orders'][number]
type Entry = AlphaSessionRows['entries'][number]
type Leg = Entry['legs'][number]

const fillTotals = (fills: readonly Fill[]) => {
  let quantity = 0n
  let weightedPrice = 0n
  for (const fill of fills) {
    const qty = BigInt(fill.quantityAtoms)
    quantity += qty
    weightedPrice += BigInt(fill.priceAtoms) * qty
  }
  return { quantity, weightedPrice }
}

const priceComparison = (
  side: OrderSide,
  { quantity, weightedPrice }: ReturnType<typeof fillTotals>,
  reference: string | null,
) => {
  if (reference === null || quantity === 0n) return null
  const expected = BigInt(reference) * 1_000n * quantity
  const difference = (side === OrderSide.Buy ? 1n : -1n) * (weightedPrice - expected)
  return {
    adverseMicros: (difference / quantityScale / 1_000n).toString(),
    adverseBps: (Number(difference) / Number(expected)) * 10_000,
  }
}

const summarizeOrderFills = (order: Order, fills: readonly Fill[]) => {
  const totals = fillTotals(fills)
  const { quantity, weightedPrice } = totals
  const versusLimit = priceComparison(order.side, totals, order.limitPriceMicros)
  return {
    orderId: order.orderId,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    requestedQuantityAtoms: order.quantityAtoms,
    filledQuantityAtoms: quantity.toString(),
    brokerFilledQuantityAtoms: order.filledQuantityAtoms,
    // Keep the exact VWAP as a ratio in nanodollar price atoms; the display value truncates sub-atom fractions.
    fillVwapAtoms: quantity === 0n ? null : (weightedPrice / quantity).toString(),
    exactVwapAtoms: quantity === 0n ? null : { numerator: weightedPrice.toString(), denominator: quantity.toString() },
    limitPriceMicros: order.limitPriceMicros,
    versusLimit,
    limitImprovementBps: versusLimit === null ? null : 0 - versusLimit.adverseBps,
  }
}

const stopLimitFailures = (
  orders: readonly Order[],
  rootFills: ReadonlyMap<string, readonly Fill[]>,
  fillsByOrder: ReadonlyMap<string, readonly Fill[]>,
  marks: AlphaSessionRows['stopPositionMarks'],
  episodeEndByOrder: ReadonlyMap<string, string>,
) => {
  const byId = new Map(orders.map((order) => [order.orderId, order]))
  return orders.flatMap((stop) => {
    if (
      stop.parentOrderId === null ||
      stop.orderType !== OrderType.StopLimit ||
      stop.stopPriceMicros === null ||
      stop.limitPriceMicros === null ||
      stop.filledQuantityAtoms !== '0' ||
      fillsByOrder.has(stop.orderId) ||
      (stop.status !== OrderStatus.Expired && stop.status !== OrderStatus.Canceled)
    )
      return []
    const parent = byId.get(stop.parentOrderId)
    const firstFill = rootFills.get(stop.parentOrderId)?.[0]
    if (parent === undefined || firstFill === undefined || parent.side === stop.side || parent.symbol !== stop.symbol)
      return []
    const stopPrice = BigInt(stop.stopPriceMicros)
    const limitPrice = BigInt(stop.limitPriceMicros)
    const buy = stop.side === OrderSide.Buy
    const episodeEnd = episodeEndByOrder.get(parent.orderId)
    let worstMark: (typeof marks)[number] | null = null
    for (const mark of marks) {
      if (
        mark.symbol !== stop.symbol ||
        (buy ? BigInt(mark.quantityAtoms) >= 0n : BigInt(mark.quantityAtoms) <= 0n) ||
        compareIntradayInstants(mark.observedAt, firstFill.sourceAt) < 0 ||
        compareIntradayInstants(mark.observedAt, stop.updatedAt) > 0 ||
        (episodeEnd !== undefined && compareIntradayInstants(mark.observedAt, episodeEnd) >= 0)
      )
        continue
      if (
        worstMark === null ||
        (buy
          ? BigInt(mark.markPriceMicros) > BigInt(worstMark.markPriceMicros)
          : BigInt(mark.markPriceMicros) < BigInt(worstMark.markPriceMicros))
      )
        worstMark = mark
    }
    const price = worstMark === null ? null : BigInt(worstMark.markPriceMicros)
    const breached = price !== null && (buy ? price >= stopPrice : price <= stopPrice)
    const beyondLimit = price !== null && (buy ? price > limitPrice : price < limitPrice)
    return [
      {
        symbol: stop.symbol,
        cycleId: parent.cycleId,
        entryOrderId: parent.orderId,
        stopOrderId: stop.orderId,
        side: stop.side,
        terminalStatus: stop.status,
        terminalAt: stop.updatedAt,
        stopPriceMicros: stop.stopPriceMicros,
        limitPriceMicros: stop.limitPriceMicros,
        worstMark,
        status: price === null ? 'NO_MARK_EVIDENCE' : breached ? 'STOP_BREACHED_UNFILLED' : 'NO_BREACH_OBSERVED',
        beyondLimit,
      },
    ]
  })
}

const sessionBoundary = (closeAt: Date, rows: AlphaSessionRows) => {
  const regular = alphaSessionRegularClose(closeAt, rows.calendarCloses)
  const afterClose = rows.cut.queriedAt > regular.at
  const regularAt = regular.at.toISOString()
  const atCloseInventory = afterClose
    ? rows.inventory
        .filter((position) => BigInt(position.atRegularCloseAtoms) !== 0n)
        .map(({ symbol, atRegularCloseAtoms }) => ({ symbol, quantityAtoms: atRegularCloseAtoms }))
    : []
  const atCloseBySymbol = new Map(atCloseInventory.map(({ symbol, quantityAtoms }) => [symbol, BigInt(quantityAtoms)]))
  const postCloseNonzeroPositions = afterClose
    ? rows.postClosePositions
        .filter(
          (position) =>
            compareIntradayInstants(position.observedAt, regularAt) > 0 && BigInt(position.quantityAtoms) !== 0n,
        )
        .map((position) => {
          const atClose = atCloseBySymbol.get(position.symbol)
          return {
            ...position,
            alsoOpenInLedgerAtRegularClose:
              atClose !== undefined && atClose > 0n === BigInt(position.quantityAtoms) > 0n,
          }
        })
    : []
  const localHour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(regular.at)
  return {
    regularCloseAt: regularAt,
    source: regular.source,
    cliRegularCloseAgrees: regular.at.getTime() === closeAt.getTime(),
    isEarlyClose: Number(localHour) < 16,
    calendarComparisons: rows.calendarCloses.map((calendar) => ({
      ...calendar,
      executionCloseAfterRegularMs: Date.parse(calendar.executionCloseAt) - Date.parse(calendar.regularCloseAt),
    })),
    afterClose,
    atCloseInventory,
    postCloseNonzeroPositions,
    strandedPositions: postCloseNonzeroPositions.filter(
      ({ alsoOpenInLedgerAtRegularClose }) => alsoOpenInLedgerAtRegularClose,
    ),
    closeMarketDataUnavailableTicks:
      rows.controllerTicks.observedTicks === 0 ? null : rows.controllerTicks.closeMarketDataUnavailableTicks,
    observedControllerTicks: rows.controllerTicks.observedTicks,
  }
}

const breakevenHealth = (
  samples: readonly {
    totals: ReturnType<typeof fillTotals>
    side: OrderSide
    signal: string | null
    reference: string | null
  }[],
  evidenceComplete: boolean,
) => {
  let expected = 0n
  let difference = 0n
  let benchmarkedOrders = 0
  let referenceFallbackOrders = 0
  for (const { totals, side, signal, reference } of samples) {
    const benchmark = signal ?? reference
    if (benchmark === null) continue
    const expectedOrder = BigInt(benchmark) * 1_000n * totals.quantity
    expected += expectedOrder
    difference += (side === OrderSide.Buy ? 1n : -1n) * (totals.weightedPrice - expectedOrder)
    benchmarkedOrders++
    if (signal === null) referenceFallbackOrders++
  }
  const oneWayBps = expected === 0n ? null : (Number(difference) / Number(expected)) * 10_000
  const roundTripProxyBps = oneWayBps === null ? null : 2 * oneWayBps
  const complete =
    evidenceComplete && benchmarkedOrders === samples.length && benchmarkedOrders > 0 && referenceFallbackOrders === 0
  const compare = (thresholdHundredths: bigint) => {
    const cost = difference * 2_000_000n
    const threshold = expected * thresholdHundredths
    return {
      breakevenRoundTripBps: Number(thresholdHundredths) / 100,
      verdict: expected === 0n ? 'WARN' : cost > threshold ? 'FAIL' : !complete || cost === threshold ? 'WARN' : 'PASS',
    }
  }
  const v2 = compare(600n)
  const v3 = compare(2192n)
  return {
    basis: 'TWICE_REFERENCE_NOTIONAL_WEIGHTED_REALIZED_ENTRY_BPS_NOT_OBSERVED_ROUND_TRIP_COST',
    oneWayBps,
    roundTripProxyBps,
    benchmarkedOrders,
    unbenchmarkedOrders: samples.length - benchmarkedOrders,
    referenceFallbackOrders,
    complete,
    verdict: v3.verdict === 'FAIL' ? 'FAIL' : v2.verdict === 'PASS' && v3.verdict === 'PASS' ? 'PASS' : 'WARN',
    v2,
    v3,
  }
}

const economics = (fills: readonly AlphaSessionRows['fills'][number][]) => {
  let gross = 0n
  let fees = 0n
  let accountedFills = 0
  for (const { accountingBound, grossMicros, feeMicros } of fills) {
    if (!accountingBound || grossMicros === null || feeMicros === null) continue
    accountedFills++
    gross += BigInt(grossMicros)
    fees += BigInt(feeMicros)
  }
  return {
    fills: fills.length,
    accountedFills,
    knownGrossMicros: gross.toString(),
    knownDirectFillFeesMicros: fees.toString(),
    knownNetAfterDirectFillFeesMicros: (gross - fees).toString(),
  }
}

export const summarizeAlphaSession = (sessionDate: string, closeAt: Date, rows: AlphaSessionRows) => {
  const { entries, inventory, orders, reconciliation, fees } = rows
  const orderById = new Map(orders.map((order) => [order.orderId, order]))
  const entryByCycle = new Map(entries.map((entry) => [entry.cycleId, entry]))
  const byIntent = new Map<string, { entry: Entry; leg: Leg } | null>()
  for (const entry of entries)
    for (const leg of entry.legs) byIntent.set(leg.intentId, byIntent.has(leg.intentId) ? null : { entry, leg })
  const entryMatches = new Map<string, Fill[]>()
  const engineFills = new Map(engines.map((phase) => [phase, new Array<Fill>()]))
  const unattributedFills: Fill[] = []
  const unsupportedSymbols = new Set(
    inventory.filter((row) => BigInt(row.openingAtoms) !== 0n).map((row) => row.symbol),
  )
  const sorted = rows.fills.toSorted(
    (a, b) =>
      compareIntradayInstants(a.sourceAt, b.sourceAt) || (a.fillId < b.fillId ? -1 : a.fillId === b.fillId ? 0 : 1),
  )
  const entryIntent = (fill: Fill) => {
    const order = orderById.get(fill.orderId)
    // A same-side root is required: the opposite-side bracket child can carry the entry's intent ID.
    if (
      order === undefined ||
      order.parentOrderId !== null ||
      order.side !== fill.side ||
      order.symbol !== fill.symbol ||
      order.intentId === null ||
      fill.intentId !== order.intentId
    )
      return undefined
    const match = byIntent.get(order.intentId)
    return match?.leg.side === fill.side && match.leg.symbol === fill.symbol && match.entry.cycleId === order.cycleId
      ? match
      : undefined
  }
  const rootFills = new Map<string, Fill[]>()
  const fillsByOrder = new Map<string, Fill[]>()
  for (const fill of sorted) {
    const observedFills = fillsByOrder.get(fill.orderId) ?? []
    observedFills.push(fill)
    fillsByOrder.set(fill.orderId, observedFills)
    const match = entryIntent(fill)
    if (match === undefined) continue
    const fills = entryMatches.get(match.leg.intentId) ?? []
    fills.push(fill)
    entryMatches.set(match.leg.intentId, fills)
    const orderFills = rootFills.get(fill.orderId) ?? []
    orderFills.push(fill)
    rootFills.set(fill.orderId, orderFills)
  }
  // Follow canonical signed inventory per symbol; do not match an exit by proximity to a strategy decision.
  // Only a unique verified opening basket owns the realized economics of an episode.
  interface Episode {
    qty: bigint
    owner: Entry | undefined
    fills: Fill[]
  }
  const open = new Map<string, Episode>()
  const exitFills = new Map<string, { episode: Episode; entry: Entry; leg: Leg; fills: Fill[] }>()
  const episodeEndByOrder = new Map<string, string>()
  const attribute = (episode: Episode) => {
    const { owner, fills } = episode
    const destination = owner === undefined ? unattributedFills : (engineFills.get(owner.phase) ?? unattributedFills)
    destination.push(...fills)
    if (owner === undefined) return
    for (const fill of fills) {
      const leg = owner.legs.find((item) => item.symbol === fill.symbol && item.side !== fill.side)
      if (leg === undefined) continue
      const group = exitFills.get(fill.orderId)
      if (group === undefined) exitFills.set(fill.orderId, { episode, entry: owner, leg, fills: [fill] })
      else if (group.episode === episode) group.fills.push(fill)
    }
  }
  for (const fill of sorted) {
    const delta = signedQty(fill.side, fill.quantityAtoms)
    if (unsupportedSymbols.has(fill.symbol)) {
      unattributedFills.push(fill)
      continue
    }
    const match = entryIntent(fill)
    const episode = open.get(fill.symbol)
    if (episode === undefined) {
      open.set(fill.symbol, { qty: delta, owner: match?.entry, fills: [fill] })
      continue
    }
    const next = episode.qty + delta
    const addingInventory = episode.qty > 0n === delta > 0n
    const reversal = next !== 0n && episode.qty > 0n !== next > 0n
    if (addingInventory && match?.entry !== episode.owner) episode.owner = undefined
    if ((!addingInventory && match !== undefined) || reversal) episode.owner = undefined
    episode.fills.push(fill)
    episode.qty = next
    if (next === 0n || reversal) {
      for (const member of episode.fills) {
        if (rootFills.has(member.orderId) && !episodeEndByOrder.has(member.orderId))
          episodeEndByOrder.set(member.orderId, fill.sourceAt)
      }
      attribute(episode)
      open.delete(fill.symbol)
      if (reversal) unsupportedSymbols.add(fill.symbol)
    }
  }
  for (const episode of open.values()) attribute(episode)

  const basketReports = entries.map((entry) => {
    const legs = entry.legs.map((leg) => {
      const fills = entryMatches.get(leg.intentId) ?? []
      const totals = fillTotals(fills)
      const { quantity, weightedPrice: priceAtomsTimesQuantity } = totals
      return {
        symbol: leg.symbol,
        side: leg.side,
        intendedQuantityAtoms: leg.quantityAtoms,
        filledQuantityAtoms: quantity.toString(),
        filledNotionalMicros: (priceAtomsTimesQuantity / quantityScale / 1_000n).toString(),
        fillVwapMicros: quantity === 0n ? null : (priceAtomsTimesQuantity / quantity / 1_000n).toString(),
        intendedReferencePriceMicros: leg.referencePriceMicros,
        signalBarCloseMicros: leg.signalBarCloseMicros,
        versusIntendedReference: priceComparison(leg.side, totals, leg.referencePriceMicros),
        versusSignalBarClose: priceComparison(leg.side, totals, leg.signalBarCloseMicros),
      }
    })
    return {
      cycleId: entry.cycleId,
      phase: entry.phase,
      intendedLegs: legs.length,
      filledLegs: legs.filter((leg) => leg.filledQuantityAtoms !== '0').length,
      fullyFilledLegs: legs.filter((leg) => leg.filledQuantityAtoms === leg.intendedQuantityAtoms).length,
      signedFilledEntryNotionalMicros: legs
        .reduce((sum, leg) => sum + (leg.side === OrderSide.Buy ? 1n : -1n) * BigInt(leg.filledNotionalMicros), 0n)
        .toString(),
      legs,
    }
  })
  const boundary = sessionBoundary(closeAt, rows)
  const entrySamples: Parameters<typeof breakevenHealth>[0][number][] = []
  const entryOrders = orders.flatMap((order) => {
    const match = order.intentId === null ? undefined : byIntent.get(order.intentId)
    if (
      match == null ||
      order.parentOrderId !== null ||
      order.cycleId !== match.entry.cycleId ||
      order.symbol !== match.leg.symbol ||
      order.side !== match.leg.side
    )
      return []
    const fills = rootFills.get(order.orderId) ?? []
    const totals = fillTotals(fills)
    const { referencePriceMicros, signalBarCloseMicros } = match.leg
    if (totals.quantity > 0n)
      entrySamples.push({ totals, side: order.side, signal: signalBarCloseMicros, reference: referencePriceMicros })
    return [
      {
        ...summarizeOrderFills(order, fills),
        symbol: order.symbol,
        cycleId: match.entry.cycleId,
        intentId: match.leg.intentId,
        referencePriceMicros,
        signalBarCloseMicros,
        versusIntendedReference: priceComparison(order.side, totals, referencePriceMicros),
        versusSignalBarClose: priceComparison(order.side, totals, signalBarCloseMicros),
      },
    ]
  })
  const exitOrders = [...exitFills].flatMap(([orderId, { entry, leg, fills }]) => {
    const order = orderById.get(orderId)
    // An order crossing inventory episodes, or missing an exact broker identity, has no single exit benchmark.
    if (
      order === undefined ||
      fills.length !== fillsByOrder.get(orderId)?.length ||
      fills.some((fill) => fill.side !== order.side || fill.symbol !== order.symbol)
    )
      return []
    const candidates = rows.closeReferences.filter(
      (reference) =>
        reference.cycleId === entry.cycleId &&
        reference.intentId === order.intentId &&
        reference.symbol === order.symbol &&
        reference.side === order.side,
    )
    const closeReference =
      order.parentOrderId === null &&
      order.cycleId === entry.cycleId &&
      candidates.length === 1 &&
      fills.every((fill) => fill.intentId === order.intentId)
        ? (candidates[0]?.referencePriceMicros ?? null)
        : null
    const parent = order.parentOrderId === null ? undefined : rootFills.get(order.parentOrderId)?.[0]
    const protectiveTrigger =
      parent !== undefined && entryIntent(parent)?.entry === entry
        ? (order.stopPriceMicros ?? order.limitPriceMicros)
        : null
    const totals = fillTotals(fills)
    return [
      {
        ...summarizeOrderFills(order, fills),
        cycleId: entry.cycleId,
        symbol: order.symbol,
        entrySignalBarCloseMicros: leg.signalBarCloseMicros,
        versusEntrySignalBarClose: priceComparison(order.side, totals, leg.signalBarCloseMicros),
        closeReferencePriceMicros: closeReference,
        versusCloseReference: priceComparison(order.side, totals, closeReference),
        protectiveTriggerPriceMicros: protectiveTrigger,
        versusProtectiveTrigger: priceComparison(order.side, totals, protectiveTrigger),
      },
    ]
  })
  const intendedLegs = basketReports.flatMap((basket) => basket.legs)
  const stopLimits = stopLimitFailures(orders, rootFills, fillsByOrder, rows.stopPositionMarks, episodeEndByOrder)
  const byPhase = engines.map((phase) => {
    const baskets = basketReports.filter((basket) => basket.phase === phase)
    const fills = engineFills.get(phase) ?? []
    const subtotal = economics(fills)
    const protectedOrders = orders.filter(
      (order) =>
        entryByCycle.get(order.cycleId ?? '')?.phase === phase &&
        (order.parentOrderId !== null || order.protectionTag !== null),
    )
    const lifecycle = new Map<string, number>()
    for (const order of protectedOrders) {
      const role = order.parentOrderId !== null ? `CHILD_${order.orderType}` : order.protectionTag
      const key = `${role}:${order.status}`
      lifecycle.set(key, (lifecycle.get(key) ?? 0) + 1)
    }
    const cancellations = rows.cancellations.filter(({ cycleId }) => entryByCycle.get(cycleId)?.phase === phase)
    return {
      phase,
      ...subtotal,
      entryAttempts: baskets.length,
      protection: {
        latestOrdersByRoleAndStatus: Object.fromEntries([...lifecycle].sort(([a], [b]) => a.localeCompare(b))),
        verifiedCancelCommands: cancellations.length,
        brokerCancelReceipts: cancellations.filter(({ acknowledged }) => acknowledged).length,
        releaseProofs: cancellations.filter(({ released }) => released).length,
      },
    }
  })
  const midday = basketReports.filter(({ phase }) => phase === IntradayAlphaPhase.MiddayReversion)
  const account = economics(rows.fills)
  const closingFlat = inventory.every((row) => BigInt(row.closingAtoms) === 0n && BigInt(row.closingBasisMicros) === 0n)
  const openingFlat = inventory.every((row) => BigInt(row.openingAtoms) === 0n && BigInt(row.openingBasisMicros) === 0n)
  const workingOrders = orders.filter(({ status }) => workingOrder(status)).length
  const reconciledAfterClose =
    reconciliation !== null &&
    reconciliation.reconciledAt >= closeAt &&
    reconciliation.positionsObservedAt !== null &&
    reconciliation.positionsObservedAt >= closeAt &&
    reconciliation.coversSessionEvidence
  const flatExact =
    closingFlat &&
    workingOrders === 0 &&
    rows.nonterminalIntents === 0 &&
    reconciledAfterClose &&
    reconciliation?.status === 'EXACT' &&
    reconciliation.positionCount === 0 &&
    reconciliation.discrepancies === 0
  const feeDebit = fees.reduce((sum, fee) => (fee.posted ? sum - BigInt(fee.netAmountMicros) : sum), 0n)
  const pendingFees = fees.filter((fee) => !fee.posted).length
  // Session-dated equity FEE activities do not identify the execution or engine. Do not pro-rate
  // them across concurrent sleeves, or infer that an empty fee query means the broker posted $0.
  const unallocatedFeeActivities = fees.length
  const integrityComplete =
    rows.cut.queriedAt >= closeAt &&
    openingFlat &&
    flatExact &&
    rows.unverifiedDecisions === 0 &&
    rows.unaccountedFillEvents === 0 &&
    unattributedFills.length === 0 &&
    account.fills === account.accountedFills
  return {
    schemaVersion: 'bayn.intraday-alpha-session-audit.v1',
    sessionDate,
    timeZone: 'America/New_York',
    regularCloseAt: closeAt.toISOString(),
    queriedAt: rows.cut.queriedAt.toISOString(),
    status:
      rows.cut.queriedAt < closeAt
        ? 'PRE_CLOSE'
        : entries.length === 0 &&
            rows.fills.length === 0 &&
            rows.unverifiedDecisions === 0 &&
            rows.unaccountedFillEvents === 0
          ? 'NO_VERIFIED_V2_EXECUTION'
          : integrityComplete
            ? 'RECONCILED_ATTRIBUTION'
            : 'PARTIAL',
    scope: 'SESSION_DATED_POSTGRES_FORENSICS_NOT_CAPITAL_OR_PROFITABILITY_EVIDENCE',
    engines: byPhase.map((engine) => ({
      ...engine,
      realizedGrossMicros: integrityComplete ? engine.knownGrossMicros : null,
      realizedNetAfterDirectFillFeesMicros: integrityComplete ? engine.knownNetAfterDirectFillFeesMicros : null,
    })),
    account: {
      ...account,
      unallocatedPostedEquityFeeDebitMicros: feeDebit.toString(),
      equityFeeActivities: unallocatedFeeActivities,
      pendingEquityFeeActivities: pendingFees,
      knownNetAfterDirectAndPostedEquityFeesMicros: (
        BigInt(account.knownNetAfterDirectFillFeesMicros) - feeDebit
      ).toString(),
      // There is no per-engine allocation or receipt proving final fee publication for the date.
      allBrokerCostsFinal: false,
      unaccountedFillEvents: rows.unaccountedFillEvents,
      unverifiedDecisions: rows.unverifiedDecisions,
      unattributed: economics(unattributedFills),
    },
    midday: {
      baskets: midday.length,
      intendedFourLegBaskets: midday.filter(({ intendedLegs }) => intendedLegs === 4).length,
      anyFillOnAllFour: midday.filter(({ intendedLegs, filledLegs }) => intendedLegs === 4 && filledLegs === 4).length,
      fullyFilledFourLegBaskets: midday.filter(
        ({ intendedLegs, fullyFilledLegs }) => intendedLegs === 4 && fullyFilledLegs === 4,
      ).length,
    },
    baskets: basketReports,
    inventory: {
      openingLedgerFlat: openingFlat,
      closingLedgerFlat: closingFlat,
      nonzero: inventory.flatMap(({ atRegularCloseAtoms: _atClose, ...position }) =>
        [position.openingAtoms, position.openingBasisMicros, position.closingAtoms, position.closingBasisMicros].some(
          (value) => BigInt(value) !== 0n,
        )
          ? [position]
          : [],
      ),
      workingOrders,
      currentNonterminalIntentsBeforeSessionEnd: rows.nonterminalIntents,
    },
    reconciliation: { ...reconciliation, reconciledAfterClose, flatExact },
    forensics: {
      entryOrders,
      exitOrders,
      partialEntryLegs: intendedLegs.filter(
        ({ filledQuantityAtoms, intendedQuantityAtoms }) =>
          BigInt(filledQuantityAtoms) > 0n && BigInt(filledQuantityAtoms) < BigInt(intendedQuantityAtoms),
      ).length,
      missedEntryLegs: intendedLegs.filter(({ filledQuantityAtoms }) => filledQuantityAtoms === '0').length,
      stopLimits,
      sessionBoundary: boundary,
      breakeven: breakevenHealth(
        entrySamples,
        boundary.afterClose &&
          boundary.source !== 'CLI_CALENDAR_CONFLICT' &&
          rows.unverifiedDecisions === 0 &&
          rows.unaccountedFillEvents === 0 &&
          unattributedFills.length === 0 &&
          entryOrders.every((order) => order.filledQuantityAtoms === order.brokerFilledQuantityAtoms),
      ),
    },
  }
}

class AuditUsageError extends Data.TaggedError('AuditUsageError')<{ readonly message: string }> {}

const argumentsSchema = Schema.Tuple([
  Schema.Literal('--session'),
  IsoDateSchema,
  Schema.Literal('--account'),
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.Literal('--regular-close'),
  Schema.String.check(Schema.isPattern(/^(?:1[0-5]:[0-5]\d|16:00)$/)),
])

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const args = Schema.decodeUnknownResult(argumentsSchema, strictParseOptions)(process.argv.slice(2))
      if (Result.isFailure(args))
        return yield* new AuditUsageError({
          message:
            'Usage: BAYN_POSTGRES_URL=<read-only URL> bun services/bayn/tools/audit-intraday-alpha-session.ts --session YYYY-MM-DD --account <account-id> --regular-close HH:MM (provider calendar, America/New_York)',
        })
      const [, sessionDate, , accountId, , regularClose] = args.success
      const sql = yield* PgClient.PgClient
      const { closeAt, rows } = yield* forwardPerformanceSnapshot(sql).withTransaction(
        readAlphaSession(sql, {
          sessionDate,
          accountId,
          regularClose,
        }),
      )
      yield* Console.log(JSON.stringify(summarizeAlphaSession(sessionDate, closeAt, rows), null, 2))
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- this CLI owns and releases its read-only database pool
      Effect.provide(
        PgClient.layerConfig({
          url: Config.Redacted('BAYN_POSTGRES_URL'),
          maxConnections: Config.succeed(1),
          applicationName: Config.succeed('bayn-alpha-session-audit'),
          connectTimeout: Config.succeed('5 seconds'),
        }),
      ),
    ),
  )
}
