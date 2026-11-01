import { Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import type { BrokerIdentity } from '../broker/identity'
import { allowsOutcomeEvent } from '../execution/mutations/decisions'
import { MutationEventType, type MutationEvent } from '../execution/mutations/model'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { decodeJevBatchPlan, decodeJevBatchResult, JevBatchPlanVersion } from '../jev/batch'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { jevProtocolIdentityMatches } from '../shadow-decision-contract'
import { measureControllerLatency, nearestRank95 } from './controller-latency'
import { sourceFitsRegisteredSession } from './decision-work'
import type { SystemRegistration } from './policy'
import type { SystemSourceCut } from './source-cut'

const submissionResolved = (event: MutationEvent) =>
  event.eventType === MutationEventType.SubmitAccepted ||
  event.eventType === MutationEventType.SubmitRejected ||
  event.eventType === MutationEventType.SubmitDenied ||
  event.eventType === MutationEventType.RecoveryFound ||
  event.eventType === MutationEventType.RecoveryNotFound

export const fullBatchClockDuration = (clock: {
  readonly issuedAt: string
  readonly observedAt: string
  readonly batchCompletedAt: string
  readonly durableCompletions: readonly string[]
}) => {
  const issued = Date.parse(clock.issuedAt)
  const observed = Date.parse(clock.observedAt)
  const batch = Date.parse(clock.batchCompletedAt)
  const completions = clock.durableCompletions.map((at) => Date.parse(at))
  if (
    !(issued <= observed && observed <= batch) ||
    completions.length === 0 ||
    completions.some((at) => !Number.isSafeInteger(at) || at < batch)
  )
    return undefined
  const duration = completions.reduce((latest, at) => Math.max(latest, at), batch) - issued
  return Number.isSafeInteger(duration) ? duration : undefined
}

/** Offline conservative timing bounds. A measured duration is not a successful service outcome or stress profit. */
export const measureFullBatchLatency = (
  registration: SystemRegistration,
  cut: SystemSourceCut,
  identity: BrokerIdentity,
) =>
  Result.gen(function* () {
    const controller = yield* measureControllerLatency(registration, cut, identity)
    const missing = [...controller.missing]
    const violations = [...controller.violations]
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const passByReceipt = new Map<string, SystemSourceCut['controllerPasses'][number]>()
    for (const pass of cut.controllerPasses)
      if (!passByReceipt.has(pass.receiptHash)) passByReceipt.set(pass.receiptHash, pass)
    const passes = controller.samples.flatMap((sample) => {
      const pass = passByReceipt.get(sample.receiptHash)
      if (pass === undefined) return []
      if (pass.observation.jevObservationReferences?.complete !== true)
        missing.push(`INCOMPLETE_BATCH_REFERENCES:${pass.receiptHash}`)
      return [{ ...sample, observation: pass.observation }]
    })
    const passesByObservation = new Map<string, typeof passes>()
    for (const pass of passes)
      for (const hash of new Set(pass.observation.jevObservationReferences?.hashes ?? [])) {
        const related = passesByObservation.get(hash)
        if (related === undefined) passesByObservation.set(hash, [pass])
        else related.push(pass)
      }
    const decisionsByBatch = Map.groupBy(cut.decisions, ({ document }) =>
      document.strategyDecision?.schemaVersion === 'bayn.jev-entry-target.v7'
        ? document.strategyDecision.evidence.batchPlan.batchId
        : null,
    )
    const mutationsByIntent = Map.groupBy(cut.mutations, (mutation) => mutation.event.intentId)
    const witnesses = new Map<string, string>()
    for (const witness of cut.durableObservations) {
      if (!witness.correct || witness.witnessedAt > cut.asOf) continue
      if (witness.witnessedAt < witness.sourceAt) {
        violations.push(`INVALID_DURABLE_CLOCK:${witness.sourceHash}`)
        continue
      }
      const key = `${witness.kind}:${witness.sourceHash}:${witness.sourceAt}`
      const previous = witnesses.get(key)
      if (previous === undefined || witness.witnessedAt < previous) witnesses.set(key, witness.witnessedAt)
    }
    const witnessed = (kind: SystemSourceCut['durableObservations'][number]['kind'], hash: string, at: string) => {
      const end = witnesses.get(`${kind}:${hash}:${at}`)
      if (end === undefined) missing.push(`MISSING_DURABLE_${kind}:${hash}`)
      return end
    }
    const samples = []
    const seen = new Map<string, string>()
    const observationHashes = new Set(cut.batches.map((batch) => batch.plan.observationHash))
    for (const pass of passes)
      for (const hash of pass.observation.jevObservationReferences?.hashes ?? [])
        if (!observationHashes.has(hash)) missing.push(`MISSING_REFERENCED_BATCH:${hash}`)
    for (const batch of cut.batches) {
      const batchHash = yield* canonicalHashV1Result(batch)
      const previous = seen.get(batch.plan.batchId)
      if (previous !== undefined) {
        if (previous !== batchHash) violations.push(`CONFLICTING_BATCH:${batch.plan.batchId}`)
        continue
      }
      seen.set(batch.plan.batchId, batchHash)
      const missingBefore = missing.length
      const violationsBefore = violations.length
      const plan = decodeJevBatchPlan(batch.plan)
      if (Result.isFailure(plan) || plan.success.schemaVersion !== JevBatchPlanVersion.V8) {
        violations.push(`INVALID_BATCH_PLAN:${batch.plan.batchId}`)
        continue
      }
      const { observation } = batch
      if (observation === null) {
        missing.push(`MISSING_BATCH_OBSERVATION:${plan.success.batchId}`)
        continue
      }
      const reproduced = makeJevTradingSignalBatch({
        observation,
        expiresAt: plan.success.expiresAt,
        planVersion: plan.success.schemaVersion,
      })
      if (
        Result.isFailure(reproduced) ||
        reproduced.success.batchId !== plan.success.batchId ||
        observation.portfolio.brokerState.account.accountId !== identity.accountId ||
        candidate === undefined ||
        observation.authorityGenerationHash !== candidate.authorityGenerationHash ||
        !jevProtocolIdentityMatches(observation.protocol, candidate.protocolHash) ||
        !sourceFitsRegisteredSession(observation.manifest, registration, observation.observedAt)
      ) {
        violations.push(`BATCH_SCOPE_OR_CONTENT_MISMATCH:${plan.success.batchId}`)
        continue
      }
      const related = passesByObservation.get(plan.success.observationHash) ?? []
      const start = related
        .filter((pass) => pass.issuedAt <= plan.success.observedAt && plan.success.observedAt <= pass.completedAt)
        .toSorted((a, b) => a.issuedAt.localeCompare(b.issuedAt))[0]
      if (start === undefined) missing.push(`MISSING_ORIGINAL_BATCH_COMMAND:${plan.success.batchId}`)
      if (batch.result === null) {
        missing.push(`UNFINISHED_BATCH:${plan.success.batchId}`)
        continue
      }
      const result = decodeJevBatchResult(plan.success, batch.result)
      if (Result.isFailure(result) || batch.result.completedAt > cut.asOf) {
        violations.push(`INVALID_BATCH_RESULT:${plan.success.batchId}`)
        continue
      }
      const batchCompletedAt = batch.result.completedAt
      const endTimes = [batchCompletedAt]
      const batchWitness = witnessed('BATCH', batch.result.resultHash, batch.result.completedAt)
      if (batchWitness !== undefined) endTimes.push(batchWitness)
      const finishedPass = related
        .filter((pass) => pass.completedAt >= batchCompletedAt)
        .toSorted((a, b) => a.completedAt.localeCompare(b.completedAt))[0]
      if (finishedPass === undefined) missing.push(`MISSING_BATCH_COMPLETION_COMMAND:${plan.success.batchId}`)
      else endTimes.push(finishedPass.witnessedAt)
      const decisions = decisionsByBatch.get(plan.success.batchId) ?? []
      if (decisions.length > 1) violations.push(`MULTIPLE_BATCH_DECISIONS:${plan.success.batchId}`)
      const failed = batch.result.candidates.some(
        (candidate) =>
          candidate.status === 'UNATTEMPTED' ||
          (candidate.status === 'RESOLVED' &&
            (candidate.resolution.status !== 'RECORDED' || candidate.receipt?.outcome.status !== 'COMPLETED')),
      )
      const expired = batch.result.completedAt >= plan.success.expiresAt
      const abstained = related.some(
        (pass) =>
          pass.observation.result === 'SUCCESS' &&
          pass.observation.entryAbstention?.schemaVersion === 'bayn.jev-entry-target.v7' &&
          pass.observation.entryAbstention.evidence.batchPlan.batchId === plan.success.batchId &&
          pass.observation.entryAbstention.selectedSymbols.length === 0,
      )
      if (decisions.length === 0 && !failed && !expired && !abstained)
        missing.push(`MISSING_BATCH_DECISION:${plan.success.batchId}`)
      const mutationIds: string[] = []
      for (const { document } of decisions) {
        const strategy = document.strategyDecision
        if (
          document.bindings.accountId !== identity.accountId ||
          document.bindings.authorityGenerationHash !== candidate.authorityGenerationHash ||
          strategy?.schemaVersion !== 'bayn.jev-entry-target.v7' ||
          strategy.evidence.batchResult.resultHash !== batch.result.resultHash ||
          document.createdAt < batch.result.completedAt ||
          document.createdAt > cut.asOf
        )
          violations.push(`BATCH_DECISION_SCOPE_MISMATCH:${document.contentHash}`)
        const decisionWitness = witnessed('DECISION', document.contentHash, document.createdAt)
        if (decisionWitness !== undefined) endTimes.push(decisionWitness)
        if (!document.dispatchable) {
          if (document.orderedIntentIds.some((intentId) => mutationsByIntent.has(intentId)))
            violations.push(`BLOCKED_BATCH_HAS_MUTATIONS:${document.contentHash}`)
          continue
        }
        for (const intentId of document.orderedIntentIds) {
          const events = (mutationsByIntent.get(intentId) ?? [])
            .filter((mutation) => mutation.event.operation === MutationOperation.Submit)
            .toSorted((a, b) => a.event.sequence - b.event.sequence)
          let previous: MutationEvent | undefined
          for (const mutation of events) {
            const { event } = mutation
            if (
              mutation.authorityGenerationHash !== candidate.authorityGenerationHash ||
              mutation.strategyDecisionHash !== document.bindings.strategyDecisionHash ||
              event.sequence !== (previous?.sequence ?? 0) + 1 ||
              event.occurredAt < (previous?.occurredAt ?? document.createdAt) ||
              event.occurredAt > cut.asOf ||
              (previous === undefined
                ? event.eventType !== MutationEventType.SubmitStarted
                : event.mutationId !== previous.mutationId ||
                  event.requestHash !== previous.requestHash ||
                  !allowsOutcomeEvent(previous.eventType, event.eventType))
            )
              violations.push(`INVALID_BATCH_SUBMISSION_HISTORY:${intentId}`)
            const routing = event.routing
            if (
              routing !== undefined &&
              !(
                document.createdAt <= routing.startedAt &&
                routing.startedAt <= routing.completedAt &&
                routing.completedAt <= event.occurredAt &&
                (routing.requestDispatchedAt === null ||
                  (routing.startedAt <= routing.requestDispatchedAt &&
                    routing.requestDispatchedAt <= routing.completedAt))
              )
            )
              violations.push(`INVALID_BATCH_ROUTING_CLOCK:${event.eventId}`)
            if (
              (event.eventType === MutationEventType.SubmitAccepted ||
                event.eventType === MutationEventType.SubmitRejected ||
                event.eventType === MutationEventType.SubmitUnknown) &&
              routing === undefined
            )
              missing.push(`MISSING_BATCH_ROUTING:${event.eventId}`)
            const visible = witnessed('MUTATION', event.eventId, event.occurredAt)
            if (visible !== undefined) endTimes.push(visible)
            previous = event
          }
          if (previous === undefined || !submissionResolved(previous))
            missing.push(`UNRESOLVED_BATCH_SUBMISSION:${intentId}`)
          else mutationIds.push(previous.mutationId)
        }
      }
      const completedAt = endTimes.toSorted().at(-1)
      const durationMs =
        start === undefined
          ? undefined
          : fullBatchClockDuration({
              issuedAt: start.issuedAt,
              observedAt: plan.success.observedAt,
              batchCompletedAt,
              durableCompletions: endTimes,
            })
      if (start !== undefined && durationMs === undefined)
        violations.push(`INVALID_FULL_BATCH_CLOCK:${plan.success.batchId}`)
      if (
        start !== undefined &&
        completedAt !== undefined &&
        durationMs !== undefined &&
        missing.length === missingBefore &&
        violations.length === violationsBefore
      )
        samples.push({
          batchId: plan.success.batchId,
          observationHash: plan.success.observationHash,
          sessionDate: start.sessionDate,
          receiptHash: start.receiptHash,
          startedAt: start.issuedAt,
          observedAt: plan.success.observedAt,
          batchCompletedAt: batch.result.completedAt,
          completedAt,
          durationMs,
          failed,
          expired,
          abstained,
          decisionHashes: decisions.map(({ document }) => document.contentHash),
          mutationIds,
        })
    }
    if (seen.size === 0) missing.push('NO_ADMITTED_BATCHES')
    const complete = missing.length === 0 && violations.length === 0
    const material = {
      schemaVersion: 'bayn.full-batch-latency.v1',
      registrationHash: controller.registrationHash,
      sourceCutHash: controller.sourceCutHash,
      controllerEvidenceHash: controller.evidenceHash,
      asOf: cut.asOf,
      status: violations.length > 0 ? 'VIOLATED' : complete ? 'MEASURED' : 'INCOMPLETE',
      estimator: 'EMPIRICAL_NEAREST_RANK_95',
      p95FullBatchMs: complete ? nearestRank95(samples.map((sample) => sample.durationMs)) : null,
      admittedBatchCount: seen.size,
      measuredBatchCount: samples.length,
      samples: samples.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt) || a.batchId.localeCompare(b.batchId)),
      missing: [...new Set(missing)],
      violations: [...new Set(violations)],
      limitations: [
        'Durations include the original command, retained inference, decision persistence, submission and required recovery; first durable witnesses include observer delay.',
        'A resolved failure remains a timing sample. Unfinished or unsupported work withholds the complete percentile.',
        'Commands without an admitted batch remain in the separately bound controller distribution and reliability denominator.',
        'This calibration does not establish a portfolio latency stress profit or economic qualification.',
      ],
    }
    return { ...material, evidenceHash: yield* canonicalHashV1Result(material) }
  })
