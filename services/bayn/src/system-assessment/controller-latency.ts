import { Result } from 'effect'

import { BrokerEnvironment, type BrokerIdentity } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import type { SystemSourceCut } from './source-cut'

/** Nearest-rank empirical p95, kept distinct from the frozen bootstrap's percentile estimator. */
export const nearestRank95 = (values: readonly number[]): number | null => {
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null
  return values.toSorted((a, b) => a - b)[Math.ceil((95 * values.length) / 100) - 1] ?? null
}

export const controllerClockDurations = (clock: {
  readonly issuedAt: string
  readonly observedAt: string
  readonly completedAt: string
  readonly witnessedAt: string
}) => {
  const issued = Date.parse(clock.issuedAt)
  const observed = Date.parse(clock.observedAt)
  const completed = Date.parse(clock.completedAt)
  const witnessed = Date.parse(clock.witnessedAt)
  if (!(issued <= observed && observed <= completed && completed <= witnessed)) return undefined
  return {
    commandThroughCompletionMs: completed - issued,
    commandThroughDurableVisibilityMs: witnessed - issued,
  }
}

/** Observed controller work, including failed and waiting passes. This is not a portfolio stress result. */
export const measureControllerLatency = (
  registration: SystemRegistration,
  cut: SystemSourceCut,
  identity: BrokerIdentity,
) =>
  Result.gen(function* () {
    const registrationHash = yield* canonicalHashV1Result(registration)
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const accountBindingHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.inference-cost-account.v1',
      accountId: identity.accountId,
    })
    if (
      cut.registrationHash !== registrationHash ||
      cut.runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash ||
      identity.environment !== BrokerEnvironment.Sandbox ||
      candidate?.accountBindingHash !== accountBindingHash ||
      cut.financial.find((account) => account.policy === JevResearchPolicy.Candidate)?.accountBindingHash !==
        accountBindingHash
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Controller timing scope differs from its source cut' }),
      )
    const missing: string[] = []
    const violations: string[] = []
    const windows = (yield* registeredSchedule(registration)).filter((item) => item.class === ObligationClass.Decision)
    const windowByDue = new Map(windows.map((item) => [item.dueAt, item]))
    const firstDueBySession = new Map(
      registration.calendar.sessions.map((session) => [
        session.sessionDate,
        windows.find((item) => session.openAt <= item.dueAt && item.dueAt < session.closeAt)?.dueAt,
      ]),
    )
    const witnesses = new Map<string, SystemSourceCut['durableObservations'][number]>()
    for (const witness of cut.durableObservations) {
      if (witness.kind !== 'CONTROLLER' || !witness.correct || witness.witnessedAt > cut.asOf) continue
      const key = `${witness.sourceHash}:${witness.sourceAt}`
      const previous = witnesses.get(key)
      if (previous === undefined || witness.witnessedAt < previous.witnessedAt) witnesses.set(key, witness)
    }
    const covered = new Set<string>()
    const samples = []
    const seen = new Map<string, string>()
    if (registration.obligations.configuration.controllerPlanHash === null) missing.push('MISSING_CONTROLLER_PLAN')
    for (const pass of cut.controllerPasses) {
      const contentHash = yield* canonicalHashV1Result(pass)
      const previous = seen.get(pass.receiptHash)
      if (previous !== undefined) {
        if (previous !== contentHash) violations.push(`CONFLICTING_CONTROLLER_RECEIPT:${pass.receiptHash}`)
        continue
      }
      seen.set(pass.receiptHash, contentHash)
      if (
        pass.controllerKey !== identity.identityHash ||
        pass.planHash !== registration.obligations.configuration.controllerPlanHash
      ) {
        violations.push(`CONTROLLER_IDENTITY_MISMATCH:${pass.receiptHash}`)
        continue
      }
      const issuedAt = pass.observation.executionIssuedAt
      if (
        (issuedAt !== undefined && issuedAt > pass.observation.observedAt) ||
        pass.observation.observedAt > pass.completedAt ||
        pass.completedAt > cut.asOf
      ) {
        violations.push(`INVALID_COMMAND_CLOCK:${pass.receiptHash}`)
        continue
      }
      const session = registration.calendar.sessions.find(
        (session) =>
          session.openAt <= (issuedAt ?? pass.completedAt) && (issuedAt ?? pass.completedAt) < session.closeAt,
      )
      if (session === undefined) continue
      if (issuedAt === undefined) {
        missing.push(`MISSING_COMMAND_CLOCK:${pass.receiptHash}`)
        continue
      }
      // A retry carries its first issuedAt. It cannot cover a later unstarted schedule window.
      const firstDue = firstDueBySession.get(session.sessionDate)
      if (firstDue !== undefined && issuedAt >= firstDue) {
        const interval = registration.obligations.decisionIntervalMs
        const dueMs =
          Date.parse(firstDue) + Math.floor((Date.parse(issuedAt) - Date.parse(firstDue)) / interval) * interval
        const window = windowByDue.get(new Date(dueMs).toISOString())
        if (window !== undefined) covered.add(window.obligationId)
      }
      const witness = witnesses.get(`${pass.receiptHash}:${pass.completedAt}`)
      if (witness === undefined) {
        missing.push(`MISSING_DURABLE_CONTROLLER_COMPLETION:${pass.receiptHash}`)
        continue
      }
      const durations = controllerClockDurations({
        issuedAt,
        observedAt: pass.observation.observedAt,
        completedAt: pass.completedAt,
        witnessedAt: witness.witnessedAt,
      })
      if (durations === undefined) {
        violations.push(`INVALID_CONTROLLER_WITNESS_CLOCK:${pass.receiptHash}`)
        continue
      }
      samples.push({
        sessionDate: session.sessionDate,
        receiptHash: pass.receiptHash,
        issuedAt,
        observedAt: pass.observation.observedAt,
        completedAt: pass.completedAt,
        witnessedAt: witness.witnessedAt,
        result: pass.observation.result,
        disposition: pass.observation.result === 'SUCCESS' ? pass.observation.outcome : pass.observation.failure,
        ...durations,
      })
    }
    const eligible = windows.filter((window) => window.dueAt <= cut.asOf)
    const unobservedWindows = eligible.filter((window) => !covered.has(window.obligationId))
    if (unobservedWindows.length > 0) missing.push('UNOBSERVED_SCHEDULED_WINDOWS')
    if (
      eligible.length !== windows.length ||
      registration.calendar.sessions.some((session) => session.closeAt > cut.asOf)
    )
      missing.push('REGISTERED_WINDOW_NOT_COMPLETE')
    if (samples.length === 0) missing.push('NO_MEASURED_CONTROLLER_PASSES')
    const complete = missing.length === 0 && violations.length === 0
    const material = {
      schemaVersion: 'bayn.controller-latency.v1',
      registrationHash,
      sourceCutHash: yield* canonicalHashV1Result(cut),
      controllerKey: identity.identityHash,
      asOf: cut.asOf,
      status: violations.length > 0 ? 'VIOLATED' : complete ? 'MEASURED' : 'INCOMPLETE',
      estimator: 'EMPIRICAL_NEAREST_RANK_95',
      p95CommandThroughCompletionMs: complete
        ? nearestRank95(samples.map((sample) => sample.commandThroughCompletionMs))
        : null,
      p95CommandThroughDurableVisibilityMs: complete
        ? nearestRank95(samples.map((sample) => sample.commandThroughDurableVisibilityMs))
        : null,
      scheduledWindowCount: windows.length,
      observedWindowCount: covered.size,
      unobservedWindows,
      samples: samples.toSorted(
        (a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.receiptHash.localeCompare(b.receiptHash),
      ),
      missing,
      violations,
      limitations: [
        'Controller-command latency includes waiting and failure outcomes; it is not a successful-entry-only sample.',
        'Durable visibility is an upper bound established by a later committed observer, including observer delay.',
        'A command in a scheduled window does not establish correct decision work or operational reliability.',
        'Controller latency is not a calibrated full-batch latency distribution or a portfolio latency stress profit. Neither qualification nor a stress verdict follows from this report.',
      ],
    }
    return { ...material, evidenceHash: yield* canonicalHashV1Result(material) }
  })
