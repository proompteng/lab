import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { jevFirstSignalDueMs } from '../jev/observation-query'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'
import { ObligationClass } from './reliability'

/** Generate the denominator before execution, including obligations for work that never starts. */
export const registeredSchedule = (registration: SystemRegistration) =>
  Result.gen(function* () {
    const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Candidate schedule requires a registered policy' }),
      )
    const definitionHash = yield* canonicalHashV1Result(candidate)
    const obligations = []
    for (const [kind, interval, deadline] of [
      [
        ObligationClass.Decision,
        registration.obligations.decisionIntervalMs,
        registration.obligations.decisionWindowMs,
      ],
      [
        ObligationClass.Reconciliation,
        registration.obligations.reconciliationIntervalMs,
        registration.obligations.reconciliationFreshnessMs,
      ],
    ] as const) {
      const schedule = []
      for (const session of registration.calendar.sessions) {
        const close = Date.parse(session.closeAt)
        const open = Date.parse(session.openAt)
        const firstDue =
          kind === ObligationClass.Decision
            ? jevFirstSignalDueMs(open, registration.obligations.configuration.protocol)
            : open
        for (let due = firstDue; due < close; due += interval) {
          const dueAt = new Date(due).toISOString()
          const deadlineAt = new Date(Math.min(due + deadline, close)).toISOString()
          const obligationId = yield* canonicalHashV1Result({
            program: registration.program,
            attemptIndex: registration.attemptIndex,
            definitionHash,
            class: kind,
            dueAt,
            deadlineAt,
          })
          schedule.push({ obligationId, class: kind, dueAt, deadlineAt })
        }
      }
      const scheduleEvidenceHash = yield* canonicalHashV1Result({
        schemaVersion: 'bayn.scheduled-work.v1',
        obligations: schedule,
      })
      obligations.push(...schedule.map((obligation) => ({ ...obligation, scheduleEvidenceHash })))
    }
    return obligations
  })
