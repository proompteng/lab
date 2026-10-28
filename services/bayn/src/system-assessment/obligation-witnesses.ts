import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { MutationEventType } from '../execution/mutations/model'
import type { SystemRegistration } from './policy'
import { ObligationClass, type ScheduledObligationSchema } from './reliability'
import type { SystemSourceCut } from './source-cut'

type Witness = SystemSourceCut['durableObservations'][number]
type Obligation = typeof ScheduledObligationSchema.Type
type Work = { readonly sourceAt: string; readonly correct: boolean }

export const earliestDurableWitnesses = (cut: SystemSourceCut) => {
  const earliest = new Map<string, Witness>()
  for (const witness of cut.durableObservations) {
    if (!witness.correct || witness.witnessedAt > cut.asOf) continue
    if (witness.kind !== 'CONTROLLER' && witness.kind !== 'DECISION') continue
    const key =
      witness.kind === 'CONTROLLER'
        ? `CONTROLLER:${witness.sourceHash}:${witness.sourceAt}`
        : `DECISION:${witness.sourceHash}`
    const previous = earliest.get(key)
    if (previous === undefined || witness.witnessedAt < previous.witnessedAt) earliest.set(key, witness)
  }
  return earliest
}

/** Join each witness once to its scheduled time bucket or admitted mutation identity. */
export const indexObligationWitnesses = (
  cut: SystemSourceCut,
  registration: SystemRegistration,
  schedule: readonly Obligation[],
  controllerWork: ReadonlyMap<string, Work & { readonly completedAt: string }>,
  documentWork: ReadonlyMap<string, Work | undefined>,
) =>
  Result.gen(function* () {
    const periodic = new Map(
      [ObligationClass.Decision, ObligationClass.Reconciliation].map((kind) => [
        kind,
        schedule.filter((obligation) => obligation.class === kind).toSorted((a, b) => a.dueAt.localeCompare(b.dueAt)),
      ]),
    )
    const dynamic = new Map(schedule.map((obligation) => [obligation.obligationId, obligation]))
    const mutations = new Map(cut.mutations.map(({ event }) => [event.eventId, event]))
    const mutationObligations = new Map<string, string>()
    const indexed = new Map<string, { witness: Witness; correct: boolean }[]>()
    const append = (obligation: Obligation, witness: Witness, correct: boolean) => {
      const rows = indexed.get(obligation.obligationId)
      if (rows === undefined) indexed.set(obligation.obligationId, [{ witness, correct }])
      else rows.push({ witness, correct })
    }
    for (const witness of cut.durableObservations) {
      if (witness.witnessedAt > cut.asOf) continue
      if (witness.kind === 'MUTATION') {
        const event = mutations.get(witness.sourceHash)
        if (event === undefined) continue
        const final = [
          MutationEventType.SubmitAccepted,
          MutationEventType.SubmitRejected,
          MutationEventType.SubmitDenied,
          MutationEventType.CancelAccepted,
          MutationEventType.RecoveryFound,
          MutationEventType.RecoveryNotFound,
        ].includes(event.eventType)
        const uncertain = [MutationEventType.SubmitUnknown, MutationEventType.CancelUnknown].includes(event.eventType)
        for (const kind of [ObligationClass.Mutation, ObligationClass.Recovery]) {
          if (!final && !(kind === ObligationClass.Mutation && uncertain)) continue
          const key = `${event.mutationId}:${kind}`
          let obligationId = mutationObligations.get(key)
          if (obligationId === undefined) {
            obligationId = yield* canonicalHashV1Result({
              registrationHash: cut.registrationHash,
              mutationId: event.mutationId,
              class: kind,
            })
            mutationObligations.set(key, obligationId)
          }
          const obligation = dynamic.get(obligationId)
          if (obligation !== undefined && witness.sourceAt >= obligation.dueAt)
            append(obligation, witness, witness.correct)
        }
        continue
      }
      const work = witness.kind === 'CONTROLLER' ? controllerWork.get(witness.sourceHash) : undefined
      const decision = witness.kind === 'DECISION' ? documentWork.get(witness.sourceHash) : undefined
      const kind =
        work !== undefined || witness.kind === 'DECISION'
          ? ObligationClass.Decision
          : witness.kind === 'RECONCILIATION'
            ? ObligationClass.Reconciliation
            : undefined
      if (kind === undefined) continue
      if (kind === ObligationClass.Decision && work === undefined && decision === undefined) continue
      const sourceAt = work?.sourceAt ?? decision?.sourceAt ?? witness.sourceAt
      const obligations = periodic.get(kind) ?? []
      let low = 0
      let high = obligations.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        const obligation = obligations[middle]
        if (obligation !== undefined && obligation.dueAt <= sourceAt) low = middle + 1
        else high = middle
      }
      const obligation = obligations[low - 1]
      const interval =
        kind === ObligationClass.Decision
          ? registration.obligations.decisionIntervalMs
          : registration.obligations.reconciliationIntervalMs
      if (obligation === undefined || Date.parse(sourceAt) >= Date.parse(obligation.dueAt) + interval) continue
      const correct =
        witness.correct &&
        (work !== undefined
          ? work.correct && work.completedAt === witness.sourceAt
          : decision !== undefined
            ? decision.correct
            : true)
      append(obligation, witness, correct)
    }
    return indexed
  })
