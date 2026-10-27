import { Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import { TimeInForce } from '../execution/contracts'
import { isSnapshotExecutionMarketDataBinding, reconstructBoundIntradaySnapshot } from '../shadow-decision-contract'
import { SystemAssessmentError } from './economics'
import type { SystemSourceCut } from './source-cut'
import { ExecutionEvidenceKind, type FillRealismSchema } from './realism'

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
      else missing.push(`MISSING_ORDER_EXPIRY:${actual.fillId}`)
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
