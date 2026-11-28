import { isIntradayAlphaTarget } from '../strategy/runtime-decision'
import { Result, Schema } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import type { BrokerIdentity } from '../broker/identity'
import { allowsOutcomeEvent } from '../execution/mutations/decisions'
import { MutationEventType, type MutationEvent } from '../execution/mutations/model'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { strictParseOptions } from '../schemas'
import { IntradayAlphaTargetSchema } from '../strategy/intraday-alpha/decision'
import { reproduceIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { earliestAlphaObservationWitness } from './alpha-observation-witness'
import { measureControllerLatency, nearestRank95 } from './controller-latency'
import { controllerBuildMatchesRegistration, sourceFitsRegisteredSession } from './decision-work'
import { SystemAssessmentError } from './economics'
import { measureFullBatchLatency } from './full-batch-latency'
import { isStrategyBoundSystemRegistration, type ScheduledEvaluation } from './policy'
import type { SystemSourceCut } from './source-cut'
import { isAlphaBinding, ResearchStrategyEngine, validateResearchStrategyBinding } from './strategy-binding'

const submissionResolved = (event: MutationEvent) =>
  event.eventType === MutationEventType.SubmitAccepted ||
  event.eventType === MutationEventType.SubmitRejected ||
  event.eventType === MutationEventType.SubmitDenied ||
  event.eventType === MutationEventType.RecoveryFound ||
  event.eventType === MutationEventType.RecoveryNotFound

/** Alpha has observations and decisions, not Jev inference batches. All admitted work stays in the denominator. */
export const measureAlphaDecisionLatency = (
  registration: ScheduledEvaluation,
  cut: SystemSourceCut,
  identity: BrokerIdentity,
) =>
  Result.gen(function* () {
    const controller = yield* measureControllerLatency(registration, cut, identity)
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    if (
      !isStrategyBoundSystemRegistration(registration) ||
      cut.schemaVersion === 'bayn.system-source-cut.v4' ||
      (registration.schemaVersion === 'bayn.system-registration.v7') !==
        (cut.schemaVersion === 'bayn.system-source-cut.v6') ||
      candidate === undefined ||
      !('strategyBinding' in candidate)
    )
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Alpha calibration requires its matching registered engine and source cut',
        }),
      )
    const binding = yield* validateResearchStrategyBinding(candidate.strategyBinding)
    if (!isAlphaBinding(binding))
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Alpha calibration cannot evaluate another engine' }),
      )
    const missing = [...controller.missing]
    const violations = [...controller.violations]
    const passByReceipt = new Map(cut.controllerPasses.map((pass) => [pass.receiptHash, pass]))
    const passes = controller.samples.flatMap((sample) => {
      const pass = passByReceipt.get(sample.receiptHash)
      if (pass === undefined) return []
      if (pass.observation.executionBuild === undefined) {
        missing.push(`MISSING_ALPHA_CONTROLLER_BUILD:${pass.receiptHash}`)
        return []
      }
      if (!controllerBuildMatchesRegistration(pass, registration)) {
        violations.push(`ALPHA_CONTROLLER_BUILD_MISMATCH:${pass.receiptHash}`)
        return []
      }
      if (pass.observation.alphaObservationReferences?.complete !== true)
        missing.push(`INCOMPLETE_ALPHA_REFERENCES:${pass.receiptHash}`)
      return [{ ...sample, observation: pass.observation }]
    })
    const passesByObservation = new Map<string, typeof passes>()
    for (const pass of passes)
      for (const hash of pass.observation.alphaObservationReferences?.hashes ?? []) {
        const related = passesByObservation.get(hash)
        if (related === undefined) passesByObservation.set(hash, [pass])
        else related.push(pass)
      }
    const decisionsByObservation = new Map<string, SystemSourceCut['decisions'][number][]>()
    for (const decision of cut.decisions) {
      const target = decision.document.strategyDecision
      if (!isIntradayAlphaTarget(target)) continue
      const hash = yield* canonicalHashV1Result(target.evidence.observation)
      const related = decisionsByObservation.get(hash)
      if (related === undefined) decisionsByObservation.set(hash, [decision])
      else related.push(decision)
    }
    const mutationsByIntent = Map.groupBy(cut.mutations, (mutation) => mutation.event.intentId)
    const alphaWitnesses = Map.groupBy(
      cut.durableObservations.flatMap((witness) =>
        witness.kind === 'ALPHA_OBSERVATION' ? [{ ...witness, kind: 'ALPHA_OBSERVATION' as const }] : [],
      ),
      (witness) => witness.sourceHash,
    )
    const durable = new Map<string, string>()
    for (const witness of cut.durableObservations) {
      if (!witness.correct || witness.witnessedAt > cut.asOf) continue
      if (witness.witnessedAt < witness.sourceAt) {
        violations.push(`INVALID_DURABLE_CLOCK:${witness.sourceHash}`)
        continue
      }
      const key = `${witness.kind}:${witness.sourceHash}:${witness.sourceAt}`
      const previous = durable.get(key)
      if (previous === undefined || previous > witness.witnessedAt) durable.set(key, witness.witnessedAt)
    }
    const witnessed = (kind: 'DECISION' | 'MUTATION', hash: string, at: string) => {
      const end = durable.get(`${kind}:${hash}:${at}`)
      if (end === undefined) missing.push(`MISSING_DURABLE_${kind}:${hash}`)
      return end
    }
    const seen = new Map<string, string>()
    const samples = []
    for (const retained of cut.alphaObservations) {
      const { payload: observation, contentHash: observationHash } = retained
      const contentHash = yield* canonicalHashV1Result(observation)
      const previous = seen.get(observationHash)
      if (previous !== undefined) {
        if (previous !== contentHash) violations.push(`CONFLICTING_ALPHA_OBSERVATION:${observationHash}`)
        continue
      }
      seen.set(observationHash, contentHash)
      const missingBefore = missing.length
      const violationsBefore = violations.length
      const reproduced = reproduceIntradayAlphaObservation(observation)
      if (
        contentHash !== observationHash ||
        Result.isFailure(reproduced) ||
        observation.portfolio.brokerState.account.accountId !== identity.accountId ||
        observation.authorityGenerationHash !== candidate.authorityGenerationHash ||
        (yield* canonicalHashV1Result(observation.protocol)) !==
          (yield* canonicalHashV1Result(binding.parameters.sharedProtocol)) ||
        !sourceFitsRegisteredSession(observation.manifest, registration, observation.observedAt) ||
        observation.observedAt > cut.asOf
      ) {
        violations.push(`ALPHA_OBSERVATION_SCOPE_OR_CONTENT_MISMATCH:${observationHash}`)
        continue
      }
      const witness = yield* earliestAlphaObservationWitness(
        { ...cut, alphaObservations: [retained], durableObservations: alphaWitnesses.get(observationHash) ?? [] },
        observationHash,
      )
      const endTimes: string[] = []
      if (witness === null) missing.push(`MISSING_DURABLE_ALPHA_OBSERVATION:${observationHash}`)
      else endTimes.push(witness.witnessedAt)
      const related = passesByObservation.get(observationHash) ?? []
      const start = related
        .filter((pass) => pass.issuedAt <= observation.observedAt && observation.observedAt <= pass.completedAt)
        .toSorted((a, b) => a.issuedAt.localeCompare(b.issuedAt))[0]
      if (start === undefined) missing.push(`MISSING_ORIGINAL_ALPHA_COMMAND:${observationHash}`)
      const decisions = decisionsByObservation.get(observationHash) ?? []
      if (
        new Set(decisions.map(({ document }) => document.contentHash)).size !== decisions.length ||
        decisions.length > 1
      )
        violations.push(`MULTIPLE_ALPHA_DECISIONS:${observationHash}`)
      const abstentions = related.flatMap((pass) => {
        const target = pass.observation.result === 'SUCCESS' ? pass.observation.entryAbstention : undefined
        return isIntradayAlphaTarget(target) ? [{ pass, target }] : []
      })
      for (const { pass, target } of abstentions) {
        const decoded = Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target)
        if (
          Result.isFailure(decoded) ||
          (yield* canonicalHashV1Result(target.evidence.observation)) !== observationHash ||
          (yield* canonicalHashV1Result(target.policy)) !== binding.strategy.parameterHash ||
          target.decidedAt > pass.completedAt ||
          target.decidedAt < observation.observedAt
        )
          violations.push(`INVALID_ALPHA_ABSTENTION:${pass.receiptHash}`)
      }
      if (decisions.length > 0 && abstentions.length > 0)
        violations.push(`CONFLICTING_ALPHA_DISPOSITION:${observationHash}`)
      const failedPasses = related.filter((pass) => pass.observation.result === 'FAILURE')
      if (decisions.length === 0 && abstentions.length === 0 && failedPasses.length === 0)
        missing.push(`UNRESOLVED_ALPHA_OBSERVATION:${observationHash}`)
      const decisionTimes = decisions.map(({ document }) => document.createdAt)
      const targetTimes = abstentions.map(({ target }) => target.decidedAt)
      const informationCompletedAt = [...decisionTimes, ...targetTimes, ...failedPasses.map((pass) => pass.completedAt)]
        .toSorted()
        .at(-1)
      const completion = related
        .filter((pass) => informationCompletedAt !== undefined && pass.completedAt >= informationCompletedAt)
        .toSorted((a, b) => a.completedAt.localeCompare(b.completedAt))[0]
      if (completion === undefined) missing.push(`MISSING_ALPHA_COMPLETION_COMMAND:${observationHash}`)
      else endTimes.push(completion.witnessedAt)
      const mutationIds: string[] = []
      for (const { document } of decisions) {
        const target = document.strategyDecision
        if (
          document.bindings.accountId !== identity.accountId ||
          document.bindings.authorityGenerationHash !== candidate.authorityGenerationHash ||
          document.bindings.strategyProtocolHash !== binding.protocolHash ||
          !isIntradayAlphaTarget(target) ||
          (yield* canonicalHashV1Result(target.policy)) !== binding.strategy.parameterHash ||
          (yield* canonicalHashV1Result(target.evidence.observation)) !== observationHash ||
          Result.isFailure(Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target)) ||
          document.createdAt < target.decidedAt ||
          document.createdAt > cut.asOf
        )
          violations.push(`ALPHA_DECISION_SCOPE_MISMATCH:${document.contentHash}`)
        const decisionWitness = witnessed('DECISION', document.contentHash, document.createdAt)
        if (decisionWitness !== undefined) endTimes.push(decisionWitness)
        if (!document.dispatchable) {
          if (document.orderedIntentIds.some((intentId) => mutationsByIntent.has(intentId)))
            violations.push(`BLOCKED_ALPHA_HAS_MUTATIONS:${document.contentHash}`)
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
              violations.push(`INVALID_ALPHA_SUBMISSION_HISTORY:${intentId}`)
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
              violations.push(`INVALID_ALPHA_ROUTING_CLOCK:${event.eventId}`)
            if (
              (event.eventType === MutationEventType.SubmitAccepted ||
                event.eventType === MutationEventType.SubmitRejected ||
                event.eventType === MutationEventType.SubmitUnknown) &&
              routing === undefined
            )
              missing.push(`MISSING_ALPHA_ROUTING:${event.eventId}`)
            const visible = witnessed('MUTATION', event.eventId, event.occurredAt)
            if (visible !== undefined) endTimes.push(visible)
            previous = event
          }
          if (previous === undefined || !submissionResolved(previous))
            missing.push(`UNRESOLVED_ALPHA_SUBMISSION:${intentId}`)
          else mutationIds.push(previous.mutationId)
        }
      }
      const completedAt = endTimes.toSorted().at(-1)
      const durationMs =
        start === undefined || completedAt === undefined
          ? undefined
          : Date.parse(completedAt) - Date.parse(start.issuedAt)
      if (
        start !== undefined &&
        (durationMs === undefined ||
          !Number.isSafeInteger(durationMs) ||
          durationMs < 0 ||
          informationCompletedAt === undefined ||
          informationCompletedAt < observation.observedAt ||
          completedAt === undefined ||
          completedAt < informationCompletedAt)
      )
        violations.push(`INVALID_ALPHA_COMPLETION_CLOCK:${observationHash}`)
      if (
        start !== undefined &&
        completedAt !== undefined &&
        informationCompletedAt !== undefined &&
        durationMs !== undefined &&
        missing.length === missingBefore &&
        violations.length === violationsBefore
      )
        samples.push({
          observationHash,
          sessionDate: start.sessionDate,
          receiptHash: start.receiptHash,
          startedAt: start.issuedAt,
          observedAt: observation.observedAt,
          informationCompletedAt,
          completedAt,
          durationMs,
          failed: failedPasses.length > 0,
          abstained: abstentions.length > 0,
          decisionHashes: decisions.map(({ document }) => document.contentHash),
          mutationIds,
        })
    }
    for (const hash of passesByObservation.keys())
      if (!seen.has(hash)) missing.push(`MISSING_REFERENCED_ALPHA_OBSERVATION:${hash}`)
    for (const hash of decisionsByObservation.keys())
      if (!seen.has(hash)) missing.push(`MISSING_ALPHA_DECISION_OBSERVATION:${hash}`)
    for (const hash of alphaWitnesses.keys())
      if (!seen.has(hash)) missing.push(`MISSING_WITNESSED_ALPHA_OBSERVATION:${hash}`)
    if (seen.size === 0) missing.push('NO_ADMITTED_ALPHA_OBSERVATIONS')
    const complete = missing.length === 0 && violations.length === 0
    const material = {
      schemaVersion: 'bayn.native-alpha-decision-latency.v1',
      engine: binding.engine,
      strategyBindingHash: yield* canonicalHashV1Result(binding),
      registrationHash: controller.registrationHash,
      sourceCutHash: controller.sourceCutHash,
      controllerEvidenceHash: controller.evidenceHash,
      asOf: cut.asOf,
      status: violations.length > 0 ? 'VIOLATED' : complete ? 'MEASURED' : 'INCOMPLETE',
      estimator: 'EMPIRICAL_NEAREST_RANK_95',
      // The common intervention field retains its original meaning: command through complete durable execution.
      p95FullBatchMs: complete ? nearestRank95(samples.map((sample) => sample.durationMs)) : null,
      admittedObservationCount: seen.size,
      measuredObservationCount: samples.length,
      samples: samples.toSorted(
        (a, b) => a.startedAt.localeCompare(b.startedAt) || a.observationHash.localeCompare(b.observationHash),
      ),
      missing: [...new Set(missing)],
      violations: [...new Set(violations)],
      limitations: [
        'Includes original command, independently witnessed observation, decision or abstention, submission and required recovery.',
        'Resolved failures remain samples; incomplete sources, unreferenced observations and unresolved work withhold the complete percentile.',
        'All registered controller windows remain in the separately bound reliability denominator.',
        'This measures timing and does not establish a latency stress profit or economic qualification.',
      ],
    }
    return { ...material, evidenceHash: yield* canonicalHashV1Result(material) }
  })

export const measureRegisteredDecisionLatency = (
  registration: ScheduledEvaluation,
  cut: SystemSourceCut,
  identity: BrokerIdentity,
) =>
  Result.gen(function* () {
    if (isStrategyBoundSystemRegistration(registration)) {
      const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
      if (candidate === undefined || !('strategyBinding' in candidate))
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Engine-bound calibration requires its candidate binding' }),
        )
      const binding = yield* validateResearchStrategyBinding(candidate.strategyBinding)
      if (isAlphaBinding(binding)) return yield* measureAlphaDecisionLatency(registration, cut, identity)
      if (binding.engine !== ResearchStrategyEngine.Jev)
        return yield* Result.fail(new SystemAssessmentError({ message: 'Unsupported candidate calibration engine' }))
    }
    return yield* measureFullBatchLatency(registration, cut, identity)
  })
