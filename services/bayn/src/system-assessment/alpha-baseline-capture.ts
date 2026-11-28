import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import {
  reproduceRecordedAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from '../observe-composition/alpha-baseline-preparation'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import { registeredAlphaObservationSessions } from './calendar'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'
import { isAlphaBinding, validateResearchStrategyBinding } from './strategy-binding'

const invalid = (message: string) => Result.fail(new SystemAssessmentError({ message }))

/** Only the independently registered candidate owns this acquisition inventory. */
export const registeredAlphaBaselineCaptureScope = (registration: SystemRegistration) =>
  Result.gen(function* () {
    if (registration.schemaVersion !== 'bayn.system-registration.v7')
      return yield* invalid('Prepared alpha baselines require their prospective v7 registration')
    const candidate = registration.policies.find((definition) => definition.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined) return yield* invalid('Prepared alpha capture has no registered candidate')
    const binding = yield* validateResearchStrategyBinding(candidate.strategyBinding)
    const sessions = yield* registeredAlphaObservationSessions(registration.calendar)
    return {
      candidate,
      binding,
      sessions,
      providerSessions: registration.calendar.marketCalendar.providerSessions,
      imageRepository: candidate.capitalAuthorization?.buildLineage.activation.imageRepository ?? null,
    }
  })

/** Retention is not availability: unwitnessed records remain visible with their actual server time. */
export const verifyRegisteredAlphaBaselinePreparations = (
  registration: SystemRegistration,
  records: readonly unknown[],
  asOf: string,
) =>
  Result.gen(function* () {
    const cut = yield* Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(asOf)
    const scope = yield* registeredAlphaBaselineCaptureScope(registration)
    if (!isAlphaBinding(scope.binding)) {
      if (records.length !== 0)
        return yield* invalid('Another candidate engine cannot supply an alpha preparation inventory')
      return [] as readonly RecordedAlphaBaselinePreparation[]
    }
    const policyHash = yield* canonicalHashV1Result(scope.binding.parameters)
    const hashes = new Set<string>()
    const scopes = new Set<string>()
    const retained: RecordedAlphaBaselinePreparation[] = []
    for (const raw of records) {
      const record = yield* reproduceRecordedAlphaBaselinePreparation(raw)
      const payload = record.payload
      if (payload.calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2')
        return yield* invalid('Prepared alpha capture requires the actual provider equity calendar')
      const session = scope.sessions.find((item) => item.sessionDate === payload.sessionDate)
      const native = payload.calendar.sessions.find((item) => item.date === payload.sessionDate)
      const provider = payload.calendar.providerSessions.find((item) => item.date === payload.sessionDate)
      const registeredProvider = scope.providerSessions.find((item) => item.date === payload.sessionDate)
      if (
        hashes.has(record.contentHash) ||
        scopes.has(record.scopeHash) ||
        payload.accountId !== scope.candidate.riskPolicy.accountId ||
        payload.authorityGenerationHash !== scope.candidate.authorityGenerationHash ||
        payload.executionBuild.sourceRevision !== scope.candidate.sourceRevision ||
        payload.executionBuild.imageDigest !== `sha256:${scope.candidate.imageDigest}` ||
        (scope.imageRepository !== null && payload.executionBuild.imageRepository !== scope.imageRepository) ||
        (yield* canonicalHashV1Result(payload.policy)) !== policyHash ||
        session === undefined ||
        native?.openAt !== session.openAt ||
        native.closeAt !== session.closeAt ||
        provider === undefined ||
        registeredProvider === undefined ||
        (yield* canonicalHashV1Result(provider)) !== (yield* canonicalHashV1Result(registeredProvider)) ||
        payload.acquisition.startedAt < registration.registeredAt ||
        record.recordedAt > cut
      )
        return yield* invalid('Prepared alpha source differs from its registered owner, policy, build, calendar or cut')
      hashes.add(record.contentHash)
      scopes.add(record.scopeHash)
      retained.push({ contentHash: record.contentHash, payload, recordedAt: record.recordedAt })
    }
    return retained
  }).pipe(
    Result.mapError(
      (cause) => new SystemAssessmentError({ message: 'Registered alpha preparation capture is invalid', cause }),
    ),
  )
