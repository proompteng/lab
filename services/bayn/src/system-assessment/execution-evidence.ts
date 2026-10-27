import { Result, Schema } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import { OrderStatus, TimeInForce } from '../execution/contracts'
import { isSnapshotExecutionMarketDataBinding, reconstructBoundIntradaySnapshot } from '../shadow-decision-contract'
import { SystemAssessmentError } from './economics'
import { SystemSourceCutSchema, type SystemSourceCut } from './source-cut'
import { ExecutionEvidenceKind, type FillRealismSchema } from './realism'
import type { ForwardPerformanceExecutionEvidence } from '../forward-performance/model'
import { canonicalHashV1Result } from '../hash'

export const captureExecutionOrders = (
  executions: readonly ForwardPerformanceExecutionEvidence[],
  accountId: string,
  authorityGenerationHash: string,
) =>
  Result.gen(function* () {
    const orders = []
    for (const execution of executions) {
      const order = execution.terminalOrder
      if (order === undefined) continue
      if (
        execution.accountId !== accountId ||
        order.accountId !== accountId ||
        order.intentId !== execution.intentId ||
        order.symbol !== execution.symbol ||
        order.side !== execution.side
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Captured terminal order identity differs from its execution' }),
        )
      orders.push({
        intentId: order.intentId,
        decisionId: execution.decisionDocumentHash,
        authorityGenerationHash,
        sourceHash: yield* canonicalHashV1Result(order),
        side: order.side,
        quantityAtoms: order.quantityAtoms ?? null,
        filledQuantityAtoms: order.filledQuantityAtoms,
        status: order.status,
        occurredAt: order.occurredAt,
        observedAt: order.observedAt,
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
      totals.set(fill.intentId, (totals.get(fill.intentId) ?? 0n) + BigInt(fill.quantityAtoms))
    const orders = new Map(cut.orders.map((order) => [order.intentId, order]))
    if (orders.size !== cut.orders.length)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Duplicate retained terminal order' }))
    for (const actual of cut.fills.toSorted(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.fillId.localeCompare(b.fillId),
    )) {
      const quantity = (cumulative.get(actual.intentId) ?? 0n) + BigInt(actual.quantityAtoms)
      cumulative.set(actual.intentId, quantity)
      const supplied = suppliedFills.find((f) => f.fillId === actual.fillId)
      if (supplied === undefined) continue
      if (
        supplied.kind !== ExecutionEvidenceKind.Broker ||
        supplied.intentId !== actual.intentId ||
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
      if (target.side !== actual.side || document.bindings.authorityGenerationHash !== authorityGenerationHash)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Filled order differs from the admitted decision or generation' }),
        )
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
        requestedQuantityAtoms: target.quantityAtoms,
        cumulativeFilledQuantityAtoms: quantity.toString(),
        quantityStepAtoms: planner.precision.quantityIncrementAtoms,
        limitPriceAtoms: (BigInt(risk.limitPriceMicros) * 1000n).toString(),
        priceTickAtoms: (BigInt(planner.precision.priceIncrementMicros) * 1000n).toString(),
        submissionDeadlineAt:
          [document.submissionCutoffAt, document.expiresAt, risk.evaluation.decision.expiresAt].toSorted()[0] ??
          document.submissionCutoffAt,
        supportedCapacityAtoms: null,
        capacitySourceHash: null,
      }
      if (target.timeInForce === TimeInForce.Day && document.executionSession !== undefined)
        fill = { ...fill, expiresAt: document.executionSession.executionSession.closeAt }
      else if (target.timeInForce === TimeInForce.ImmediateOrCancel) {
        const order = orders.get(actual.intentId)
        if (
          order === undefined ||
          ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired].includes(order.status) ||
          order.observedAt > cut.asOf
        )
          missing.push(`MISSING_IOC_TERMINAL_ORDER:${actual.fillId}`)
        else {
          if (
            order.decisionId !== actual.decisionId ||
            order.authorityGenerationHash !== authorityGenerationHash ||
            order.side !== target.side ||
            order.quantityAtoms !== target.quantityAtoms ||
            BigInt(order.filledQuantityAtoms) !== totals.get(actual.intentId) ||
            (order.status === OrderStatus.Filled
              ? order.filledQuantityAtoms !== target.quantityAtoms
              : BigInt(order.filledQuantityAtoms) >= BigInt(target.quantityAtoms)) ||
            order.occurredAt > order.observedAt
          )
            return yield* Result.fail(
              new SystemAssessmentError({ message: 'IOC terminal order differs from the admitted order or fills' }),
            )
          sources.add(order.sourceHash)
          fill = { ...fill, expiresAt: order.occurredAt }
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
