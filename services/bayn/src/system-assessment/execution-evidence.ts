import { Result, Schema } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import { OrderSchema, OrderSide, OrderStatus, TimeInForce } from '../execution/contracts'
import { isSnapshotExecutionMarketDataBinding, reconstructBoundIntradaySnapshot } from '../shadow-decision-contract'
import { SystemAssessmentError } from './economics'
import { SystemSourceCutSchema, type SystemSourceCut } from './source-cut'
import { ExecutionEvidenceKind, type FillRealismSchema } from './realism'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { resolveExecutionOrderTerms } from './execution-order-terms'

export const ObservedExecutionOrderSchema = Schema.Struct({
  eventId: Sha256Schema,
  occurredAt: UtcInstantSchema,
  order: OrderSchema,
})

export const captureExecutionOrders = (
  decisions: SystemSourceCut['decisions'],
  observations: readonly (typeof ObservedExecutionOrderSchema.Type)[],
  accountId: string,
  authorityGenerationHash: string,
) =>
  Result.gen(function* () {
    const owners = new Map<string, { document: SystemSourceCut['decisions'][number]['document']; symbol: string }>()
    for (const { document } of decisions) {
      for (const [index, intentId] of document.orderedIntentIds.entries()) {
        const target = document.targetPlan.intentTargets[index]
        if (target === undefined || owners.has(intentId))
          return yield* Result.fail(
            new SystemAssessmentError({ message: 'Captured order has ambiguous decision ownership' }),
          )
        owners.set(intentId, { document, symbol: target.symbol })
      }
    }
    const orders = []
    const seen = new Set<string>()
    for (const observation of observations) {
      const order = observation.order
      const owner = order.intentId === undefined ? undefined : owners.get(order.intentId)
      if (
        owner === undefined ||
        owner.document.bindings.accountId !== accountId ||
        owner.document.bindings.authorityGenerationHash !== authorityGenerationHash ||
        order.accountId !== accountId ||
        order.symbol !== owner.symbol ||
        seen.has(order.brokerOrderId)
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Captured order identity differs from its decision or is duplicated' }),
        )
      seen.add(order.brokerOrderId)
      orders.push({
        intentId: order.intentId,
        decisionId: owner.document.contentHash,
        authorityGenerationHash,
        sourceHash: yield* canonicalHashV1Result(observation),
        ...observation,
      })
    }
    return yield* Schema.decodeUnknownResult(SystemSourceCutSchema.fields.orders)(orders)
  })

/** Replace candidate order facts with the exact durable plan and measured broker routing. */
export const bindExecutionEvidence = (
  suppliedFills: readonly (typeof FillRealismSchema.Type)[],
  cut: SystemSourceCut,
  authorityGenerationHash: string,
) =>
  Result.gen(function* () {
    const missing: string[] = []
    const sources = new Set<string>()
    const fills = suppliedFills.filter((f) => !cut.fills.some((actual) => actual.fillId === f.fillId))
    const cumulative = new Map<string, bigint>()
    const totals = new Map<string, bigint>()
    for (const fill of cut.fills)
      totals.set(fill.brokerOrderId, (totals.get(fill.brokerOrderId) ?? 0n) + BigInt(fill.quantityAtoms))
    const orders = new Map(cut.orders.map((row) => [row.order.brokerOrderId, row]))
    if (orders.size !== cut.orders.length)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Duplicate retained broker order' }))
    const children = new Map<string, SystemSourceCut['orders'][number][]>()
    for (const row of cut.orders) {
      if (
        row.sourceHash !==
        (yield* canonicalHashV1Result({ eventId: row.eventId, occurredAt: row.occurredAt, order: row.order }))
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Retained broker order receipt hash differs from its material' }),
        )
      const parent = row.order.parentBrokerOrderId
      if (parent !== undefined) {
        const group = children.get(parent)
        if (group === undefined) children.set(parent, [row])
        else group.push(row)
      }
    }
    const disposed = new Map<string, bigint>()
    for (const actual of cut.fills.toSorted(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.fillId.localeCompare(b.fillId),
    )) {
      const quantity = (cumulative.get(actual.brokerOrderId) ?? 0n) + BigInt(actual.quantityAtoms)
      cumulative.set(actual.brokerOrderId, quantity)
      const supplied = suppliedFills.find((f) => f.fillId === actual.fillId)
      if (supplied === undefined) continue
      if (
        supplied.kind !== ExecutionEvidenceKind.Broker ||
        supplied.intentId !== actual.intentId ||
        supplied.orderId !== actual.brokerOrderId ||
        supplied.decisionId !== actual.decisionId ||
        supplied.fillPriceAtoms !== actual.priceAtoms ||
        supplied.fillQuantityAtoms !== actual.quantityAtoms ||
        supplied.filledAt !== actual.occurredAt ||
        supplied.side !== actual.side ||
        supplied.positionOwnerGenerationHash !== authorityGenerationHash ||
        supplied.sourceHash !== actual.sourceHash
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Candidate fill differs from its actual broker receipt' }),
        )
      sources.add(actual.sourceHash)
      const document = cut.decisions.find((d) => d.document.contentHash === actual.decisionId)?.document
      const index = document?.orderedIntentIds.indexOf(actual.intentId) ?? -1
      const target = document?.targetPlan.intentTargets[index]
      const risk = document?.deltaRisk[index]
      const planner = document?.plannerInput
      if (document === undefined || target === undefined || risk === undefined || planner === undefined) {
        missing.push(`MISSING_DURABLE_ORDER_TERMS:${actual.fillId}`)
        fills.push(supplied)
        continue
      }
      if (!document.dispatchable || document.bindings.authorityGenerationHash !== authorityGenerationHash)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Filled order differs from the admitted decision or generation' }),
        )
      const receipt = orders.get(actual.brokerOrderId)
      const root =
        receipt?.order.parentBrokerOrderId === undefined ? receipt : orders.get(receipt.order.parentBrokerOrderId)
      if (receipt === undefined || root === undefined) {
        missing.push(`MISSING_BROKER_ORDER:${actual.fillId}`)
        fills.push(supplied)
        continue
      }
      const group = children.get(root.order.brokerOrderId) ?? []
      if ([root, ...group].some((row) => row.order.observedAt > cut.asOf)) {
        missing.push(`UNOBSERVED_BROKER_ORDER:${actual.fillId}`)
        fills.push(supplied)
        continue
      }
      const terms = yield* resolveExecutionOrderTerms(actual.brokerOrderId, root, group, document, index)
      if (terms._tag === 'Missing') {
        missing.push(`${terms.reason}:${actual.fillId}`)
        fills.push(supplied)
        continue
      }
      if (terms.order.side !== actual.side)
        return yield* Result.fail(new SystemAssessmentError({ message: 'Filled side differs from its broker order' }))
      if ([root, ...group].some((row) => row.occurredAt > row.order.observedAt))
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Broker order occurrence follows its observation' }),
        )
      const terminal = [OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired].includes(terms.order.status)
      if (
        terminal &&
        (BigInt(terms.order.filledQuantityAtoms) !== totals.get(actual.brokerOrderId) ||
          (terms.order.status === OrderStatus.Filled
            ? terms.order.filledQuantityAtoms !== terms.quantityAtoms
            : BigInt(terms.order.filledQuantityAtoms) >= BigInt(terms.quantityAtoms)))
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Terminal broker order differs from its captured fills' }),
        )
      if (terms.protection !== null && actual.side === OrderSide.Sell) {
        const sold = (disposed.get(root.order.brokerOrderId) ?? 0n) + BigInt(actual.quantityAtoms)
        const available =
          terms.protection === 'Bracket'
            ? (cumulative.get(root.order.brokerOrderId) ?? 0n)
            : BigInt(target.quantityAtoms)
        if (sold > available)
          return yield* Result.fail(
            new SystemAssessmentError({
              message: 'Protective disposals exceed the owned entry fills or sealed position',
            }),
          )
        disposed.set(root.order.brokerOrderId, sold)
      }
      for (const row of [root, ...group]) sources.add(row.sourceHash)
      const binding = document.bindings.executionMarketData
      const rows = document.executionMarketDataRows
      const snapshot =
        binding !== undefined && rows !== undefined && isSnapshotExecutionMarketDataBinding(binding)
          ? reconstructBoundIntradaySnapshot(binding, rows)
          : undefined
      const quote = snapshot?.latestQuotes[target.symbol]
      const quoteSource =
        quote !== undefined && binding !== undefined && isSnapshotExecutionMarketDataBinding(binding)
          ? binding.streaming.records.find(
              (r) =>
                r.sourceTopic === quote.sourceTopic &&
                r.sourcePartition === quote.sourcePartition &&
                r.sourceOffset === quote.sourceOffset,
            )
          : undefined
      const bid = planner.referencePrices.bidPriceMicros[target.symbol]
      const ask = planner.referencePrices.askPriceMicros[target.symbol]
      const routing = cut.mutations
        .filter(
          (m) =>
            m.authorityGenerationHash === authorityGenerationHash &&
            m.event.intentId === actual.intentId &&
            m.event.operation === MutationOperation.Submit,
        )
        .toSorted((a, b) => a.event.sequence - b.event.sequence)
        .find((m) => m.event.routing !== undefined)?.event.routing
      let fill = {
        ...supplied,
        requestedQuantityAtoms: terms.quantityAtoms,
        cumulativeFilledQuantityAtoms: quantity.toString(),
        quantityStepAtoms: planner.precision.quantityIncrementAtoms,
        limitPriceAtoms: (BigInt(terms.limitPriceMicros) * 1000n).toString(),
        priceTickAtoms: (BigInt(planner.precision.priceIncrementMicros) * 1000n).toString(),
        submissionDeadlineAt:
          [document.submissionCutoffAt, document.expiresAt, risk.evaluation.decision.expiresAt].toSorted()[0] ??
          document.submissionCutoffAt,
        supportedCapacityAtoms: null,
        capacitySourceHash: null,
      }
      if (terms.order.timeInForce === TimeInForce.Day && document.executionSession !== undefined)
        fill = {
          ...fill,
          expiresAt:
            [
              document.executionSession.executionSession.closeAt,
              ...(terminal ? [receipt.occurredAt] : []),
            ].toSorted()[0] ?? document.executionSession.executionSession.closeAt,
        }
      else if ([TimeInForce.ImmediateOrCancel, TimeInForce.GoodUntilCanceled].includes(terms.order.timeInForce)) {
        if (!terminal) missing.push(`MISSING_${terms.order.timeInForce}_TERMINAL_ORDER:${actual.fillId}`)
        else {
          fill = { ...fill, expiresAt: receipt.occurredAt }
        }
      } else missing.push(`MISSING_ORDER_EXPIRY:${actual.fillId}`)
      if (routing === undefined || routing.requestDispatchedAt === null)
        missing.push(`MISSING_BROKER_ROUTING:${actual.fillId}`)
      else fill = { ...fill, routingStartedAt: routing.startedAt, requestDispatchedAt: routing.requestDispatchedAt }
      if (
        quote === undefined ||
        quoteSource === undefined ||
        bid === undefined ||
        ask === undefined ||
        binding === undefined ||
        !isSnapshotExecutionMarketDataBinding(binding)
      )
        missing.push(`MISSING_EXECUTION_QUOTE:${actual.fillId}`)
      else {
        sources.add(quoteSource.contentHash)
        fill = {
          ...fill,
          bidPriceAtoms: (BigInt(bid) * 1000n).toString(),
          askPriceAtoms: (BigInt(ask) * 1000n).toString(),
          quoteHash: quoteSource.contentHash,
          quoteAvailableAt: new Date(quoteSource.availableAtMs).toISOString(),
          quoteFreshUntil: new Date(
            Date.parse(quote.eventAt) +
              Math.min(
                binding.maximumQuoteAgeMs,
                risk.facts?.state.entryQuote?.maximumAgeMs ?? binding.maximumQuoteAgeMs,
              ),
          ).toISOString(),
        }
      }
      fills.push(fill)
    }
    return { fills, missing, sources }
  })
