import { NodeRuntime } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Data, Effect, Result, Schema } from 'effect'

import { OrderSide, OrderStatus } from '../src/execution/contracts'
import { forwardPerformanceSnapshot } from '../src/forward-performance/postgres/snapshot'
import { quantityScale } from '../src/quantity'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { readAlphaSession, type AlphaSessionRows } from './intraday-alpha-session-postgres'

const engines = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const

const workingOrder = (status: OrderStatus) =>
  status === OrderStatus.New || status === OrderStatus.Pending || status === OrderStatus.PartiallyFilled

const signedQty = (side: OrderSide, quantityAtoms: string) =>
  (side === OrderSide.Buy ? 1n : -1n) * BigInt(quantityAtoms)

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
  type Fill = AlphaSessionRows['fills'][number]
  type Leg = AlphaSessionRows['entries'][number]['legs'][number]
  type Entry = AlphaSessionRows['entries'][number]
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
    (a, b) => a.sourceAt.localeCompare(b.sourceAt) || (a.fillId < b.fillId ? -1 : a.fillId === b.fillId ? 0 : 1),
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
    return match?.leg.side === fill.side && match.leg.symbol === fill.symbol ? match : undefined
  }
  for (const fill of sorted) {
    const match = entryIntent(fill)
    if (match === undefined) continue
    const fills = entryMatches.get(match.leg.intentId) ?? []
    fills.push(fill)
    entryMatches.set(match.leg.intentId, fills)
  }
  // Follow canonical signed inventory per symbol; do not match an exit by proximity to a strategy decision.
  // Only a unique verified opening basket owns the realized economics of an episode.
  interface Episode {
    qty: bigint
    owner: Entry | undefined
    fills: Fill[]
  }
  const open = new Map<string, Episode>()
  const attribute = ({ owner, fills }: Episode) => {
    const destination = owner === undefined ? unattributedFills : (engineFills.get(owner.phase) ?? unattributedFills)
    destination.push(...fills)
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
      attribute(episode)
      open.delete(fill.symbol)
      if (reversal) unsupportedSymbols.add(fill.symbol)
    }
  }
  for (const episode of open.values()) attribute(episode)

  const basketReports = entries.map((entry) => {
    const legs = entry.legs.map((leg) => {
      const fills = entryMatches.get(leg.intentId) ?? []
      let quantity = 0n
      let priceAtomsTimesQuantity = 0n
      for (const fill of fills) {
        const qty = BigInt(fill.quantityAtoms)
        quantity += qty
        priceAtomsTimesQuantity += BigInt(fill.priceAtoms) * qty
      }
      const sign = leg.side === OrderSide.Buy ? 1n : -1n
      const slippage = (reference: string | null) => {
        if (reference === null || quantity === 0n) return null
        const expected = BigInt(reference) * 1_000n * quantity
        const difference = sign * (priceAtomsTimesQuantity - expected)
        return {
          adverseMicros: (difference / quantityScale / 1_000n).toString(),
          adverseBps: (Number(difference) / Number(expected)) * 10_000,
        }
      }
      return {
        symbol: leg.symbol,
        side: leg.side,
        intendedQuantityAtoms: leg.quantityAtoms,
        filledQuantityAtoms: quantity.toString(),
        filledNotionalMicros: (priceAtomsTimesQuantity / quantityScale / 1_000n).toString(),
        fillVwapMicros: quantity === 0n ? null : (priceAtomsTimesQuantity / quantity / 1_000n).toString(),
        intendedReferencePriceMicros: leg.referencePriceMicros,
        signalBarCloseMicros: leg.signalBarCloseMicros,
        versusIntendedReference: slippage(leg.referencePriceMicros),
        versusSignalBarClose: slippage(leg.signalBarCloseMicros),
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
      nonzero: inventory,
      workingOrders,
      currentNonterminalIntentsBeforeSessionEnd: rows.nonterminalIntents,
    },
    reconciliation: { ...reconciliation, reconciledAfterClose, flatExact },
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
