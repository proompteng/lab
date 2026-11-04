import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { MutationEventType } from '../execution/mutations/model'
import type { SystemSourceCut } from './source-cut'
import type { ScheduledEvaluation } from './policy'
import { SystemAssessmentError } from './economics'
import { ObligationClass, ObligationOutcome, type ObligationCompletionSchema } from './reliability'
import { registeredSchedule } from './schedule'
import {
  accountProtectionWork,
  closedEntryWindowWork,
  decisionDocumentWork,
  entryAbstentionWork,
  positionHoldWork,
} from './decision-work'
import { earliestDurableWitnesses, indexObligationWitnesses } from './obligation-witnesses'
import { JevResearchPolicy } from '../jev/acceptance'

/** Freeze dynamic denominators at the first admission/uncertainty, never at the most recent retry. */
export const mutationObligations = (cut: SystemSourceCut, registration: ScheduledEvaluation) =>
  Result.gen(function* () {
    const lastClose = registration.calendar.sessions.at(-1)?.closeAt
    if (lastClose === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing registered window' }))
    const schedule = []
    const grouped = new Map<string, SystemSourceCut['mutations'][number]['event'][]>()
    for (const { event } of cut.mutations) {
      const events = grouped.get(event.mutationId)
      if (events === undefined) grouped.set(event.mutationId, [event])
      else events.push(event)
    }
    for (const [mutationId, retained] of grouped) {
      const events = retained.toSorted((a, b) => a.sequence - b.sequence)
      const start = events.find(
        (e) => e.eventType === MutationEventType.SubmitStarted || e.eventType === MutationEventType.CancelStarted,
      )
      if (start === undefined || start.occurredAt > lastClose) continue
      const deadlineAt = new Date(
        Date.parse(start.occurredAt) + registration.obligations.mutationDeadlineMs,
      ).toISOString()
      const scheduleEvidenceHash = yield* canonicalHashV1Result(start)
      schedule.push({
        obligationId: yield* canonicalHashV1Result({
          registrationHash: cut.registrationHash,
          mutationId,
          class: ObligationClass.Mutation,
        }),
        class: ObligationClass.Mutation,
        dueAt: start.occurredAt,
        deadlineAt,
        scheduleEvidenceHash,
      })
      const firstOutcome = events.find((e) => e.sequence > start.sequence)
      const recovered = events.some((e) =>
        [
          MutationEventType.RecoveryFound,
          MutationEventType.RecoveryNotFound,
          MutationEventType.RecoveryUnknown,
        ].includes(e.eventType),
      )
      const uncertain =
        firstOutcome === undefined ||
        [MutationEventType.SubmitUnknown, MutationEventType.CancelUnknown, MutationEventType.RecoveryUnknown].includes(
          firstOutcome.eventType,
        )
      const uncertainAt =
        uncertain && firstOutcome !== undefined
          ? firstOutcome.occurredAt
          : recovered
            ? new Date(Date.parse(start.occurredAt) + start.consistencyDelayMs).toISOString()
            : deadlineAt
      if (
        (uncertain || recovered || (firstOutcome !== undefined && firstOutcome.occurredAt > deadlineAt)) &&
        uncertainAt <= cut.asOf
      ) {
        const dueAt = uncertainAt < deadlineAt ? uncertainAt : deadlineAt
        schedule.push({
          obligationId: yield* canonicalHashV1Result({
            registrationHash: cut.registrationHash,
            mutationId,
            class: ObligationClass.Recovery,
          }),
          class: ObligationClass.Recovery,
          dueAt,
          deadlineAt: new Date(Date.parse(dueAt) + registration.obligations.recoveryDeadlineMs).toISOString(),
          scheduleEvidenceHash,
        })
      }
    }
    return schedule
  })

export const bindOperationalObligations = (
  cut: SystemSourceCut,
  registration: ScheduledEvaluation,
  sourceCutHash: string,
) =>
  Result.gen(function* () {
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Operational evidence requires its registered candidate' }),
      )
    const controllerReceipts = new Map<string, string>()
    for (const pass of cut.controllerPasses) {
      const hash = yield* canonicalHashV1Result(pass)
      const previous = controllerReceipts.get(pass.receiptHash)
      if (previous !== undefined && previous !== hash)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Controller receipt has conflicting retained contents' }),
        )
      controllerReceipts.set(pass.receiptHash, hash)
    }
    const earliestWitnesses = earliestDurableWitnesses(cut)
    const sources = new Set<string>()
    const dynamic = yield* mutationObligations(cut, registration)
    for (const row of dynamic) sources.add(row.scheduleEvidenceHash)
    const schedule = [...(yield* registeredSchedule(registration)), ...dynamic]
    for (const row of schedule) sources.add(row.scheduleEvidenceHash)
    const completions: (typeof ObligationCompletionSchema.Type)[] = []
    const controllerWork = new Map<string, { sourceAt: string; completedAt: string; correct: boolean }>()
    for (const pass of cut.controllerPasses) {
      const witness = earliestWitnesses.get(`CONTROLLER:${pass.receiptHash}:${pass.completedAt}`)
      if (witness === undefined) continue
      const work =
        (yield* positionHoldWork(pass, registration, cut.decisions, witness.witnessedAt)) ??
        (yield* entryAbstentionWork(pass, registration, witness.witnessedAt)) ??
        (yield* accountProtectionWork(pass, registration, witness.witnessedAt)) ??
        (yield* closedEntryWindowWork(pass, registration, witness.witnessedAt))
      if (work !== undefined) controllerWork.set(pass.receiptHash, { ...work, completedAt: pass.completedAt })
    }
    const documentWork = new Map(
      cut.decisions.map(({ document }) => [
        document.contentHash,
        document.bindings.accountId === candidate.riskPolicy.accountId &&
        document.bindings.authorityGenerationHash === candidate.authorityGenerationHash &&
        document.bindings.policyHash === candidate.riskPolicyHash &&
        document.bindings.strategyProtocolHash === candidate.protocolHash
          ? decisionDocumentWork(document, registration)
          : undefined,
      ]),
    )
    const indexedWitnesses = yield* indexObligationWitnesses(cut, registration, schedule, controllerWork, documentWork)
    for (const obligation of schedule) {
      const witnesses = indexedWitnesses.get(obligation.obligationId) ?? []
      const selected =
        witnesses.find((w) => w.correct && w.witness.witnessedAt <= obligation.deadlineAt) ?? witnesses[0]
      if (selected === undefined) continue
      const evidenceHash = yield* canonicalHashV1Result(selected.witness)
      sources.add(evidenceHash)
      completions.push({
        obligationId: obligation.obligationId,
        outcome: selected.correct ? ObligationOutcome.Correct : ObligationOutcome.Failed,
        completedAt: selected.witness.witnessedAt,
        evidenceHash,
      })
    }
    const obligationCoverageHash = yield* canonicalHashV1Result({ cutHash: sourceCutHash, schedule, completions })
    sources.add(obligationCoverageHash)
    return {
      reliability: { asOf: cut.asOf, schedule, completions },
      obligationCoverageHash,
      sourceHashes: [...sources],
    }
  })
