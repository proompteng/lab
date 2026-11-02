import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { MutationEventType } from '../execution/mutations/model'
import { SystemAssessmentError } from './economics'
import { executionOrderPlans } from './execution-plans'
import type { SystemSourceCut } from './source-cut'

export const decisionPersistenceAssumptions = [
  'PostgreSQL admission receipts attest that the bound immutable decision transaction was already committed.',
  'Mutation admission commits before the producer starts broker routing; ambient transaction admission is rejected.',
  'Routing timestamps retain the original mutation producer clock and identify an upper bound on decision commitment.',
] as const

/** A committed admission followed by routing supplies an upper bound, not an invented commit timestamp. */
export const decisionAdmissionWitnesses = (cut: SystemSourceCut, generationHash: string) =>
  Result.gen(function* () {
    const plans = yield* executionOrderPlans(cut.decisions, cut.protectionIntents)
    const sources = new Set<string>()
    const witnesses: SystemSourceCut['durableObservations'][number][] = []
    const documents = new Map(cut.decisions.map(({ document }) => [document.contentHash, document]))
    const events = new Map(cut.mutations.map((row) => [row.event.eventId, row]))
    const routing = new Map<string, SystemSourceCut['mutations'][number]>()
    for (const row of cut.mutations) {
      const { event } = row
      if (event.routing === undefined) continue
      const previous = routing.get(event.mutationId)
      if (
        previous === undefined ||
        (previous.event.routing !== undefined && event.routing.startedAt < previous.event.routing.startedAt)
      )
        routing.set(event.mutationId, row)
    }
    const retained = new Set<string>()
    for (const receipt of cut.decisionAdmissions) {
      const { sourceHash, ...material } = receipt
      const key = `${receipt.eventId}:${receipt.decisionId}`
      const document = documents.get(receipt.decisionId)
      const admitted = events.get(receipt.eventId)
      const plan = admitted === undefined ? undefined : plans.get(admitted.event.intentId)
      if (
        retained.has(key) ||
        sourceHash !== (yield* canonicalHashV1Result(material)) ||
        receipt.observedAt > cut.asOf ||
        document === undefined ||
        admitted === undefined ||
        admitted.event.eventType !== MutationEventType.SubmitStarted ||
        admitted.event.sequence !== 1 ||
        admitted.authorityGenerationHash !== generationHash ||
        document.bindings.authorityGenerationHash !== generationHash ||
        admitted.strategyDecisionHash !== document.bindings.strategyDecisionHash ||
        plan === undefined ||
        plan.document.contentHash !== document.contentHash ||
        (plan.protectionIntent !== null && plan.createdAt > admitted.event.occurredAt) ||
        (plan.protectionIntent !== null && admitted.event.occurredAt > plan.submissionDeadlineAt) ||
        admitted.event.occurredAt < document.createdAt
      )
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'Decision admission receipt differs from its committed source or mutation',
          }),
        )
      retained.add(key)
      sources.add(sourceHash)
      const outcome = routing.get(admitted.event.mutationId)
      const route = outcome?.event.routing
      if (outcome === undefined || route === undefined) continue
      if (
        outcome.authorityGenerationHash !== generationHash ||
        outcome.event.intentId !== admitted.event.intentId ||
        outcome.strategyDecisionHash !== admitted.strategyDecisionHash ||
        outcome.event.requestHash !== admitted.event.requestHash ||
        outcome.event.sequence <= admitted.event.sequence ||
        route.startedAt < admitted.event.occurredAt ||
        route.startedAt > cut.asOf
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Decision admission does not precede its routed mutation' }),
        )
      if (plan.protectionIntent !== null)
        witnesses.push({
          kind: 'DECISION',
          sourceHash: plan.decisionId,
          sourceAt: plan.createdAt,
          witnessedAt: route.startedAt,
          correct: true,
        })
      witnesses.push({
        kind: 'DECISION',
        sourceHash: document.contentHash,
        sourceAt: document.createdAt,
        witnessedAt: route.startedAt,
        correct: true,
      })
    }
    return { sources, witnesses }
  })
