import { MarketCalendarObservationSchema } from '../broker/alpaca/model'
import { qualificationCalendar } from './calendar'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeStrategyProtocolHashResult } from '../contracts'
import {
  JevProtocolSchema,
  RetainedVisualJevProtocolSchema,
  defaultJevProtocolDocument,
  retainedJevProtocolV38Document,
  retainedJevProtocolV39Document,
  jevBehaviorHash,
} from '../jev/protocol'
import { qualificationDeadlines } from './configuration'
import { SystemAssessmentError } from './economics'
import { PolicyDefinitionSchema, scheduledEvaluationFields, validateRegisteredPolicyIdentity } from './policy'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { executionControllerPlanHash } from '../execution/controller'

export const operationalReliabilityPolicy = {
  schemaVersion: 'bayn.operational-reliability-policy.v1',
  program: 'BAYN_OPERATIONAL_RELIABILITY',
  environment: 'PAPER',
  numerator: 999,
  denominator: 1000,
  maximumSafetyViolations: 0,
  scope: 'COMPLETE_NATIVE_POLICY',
  emptyRequiredClass: 'UNDETERMINED',
  emptyRecovery: 'NOT_APPLICABLE_ONLY_WITH_COMPLETE_SOURCE_COVERAGE',
  deadlines: 'ORIGINAL_RUNTIME_DEADLINES_WITHOUT_PERIOD_END_TRUNCATION',
} as const

/** An operating claim has no research controls, profit quota, or minimum sample size. */
export const OperationalRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-registration.v1'),
  program: Schema.Literal('BAYN_OPERATIONAL_RELIABILITY'),
  environment: Schema.Literal('PAPER'),
  policyHash: Sha256Schema,
  attemptIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  priorAttemptHash: Sha256Schema,
  registeredAt: UtcInstantSchema,
  retainedIncidentSources: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
  calendar: Schema.Struct({
    ...scheduledEvaluationFields.calendar.fields,
    referenceMarket: Schema.Literal('NATIVE_POLICY'),
    operatingHours: Schema.Literal('NATIVE'),
    marketCalendar: MarketCalendarObservationSchema,
  }),
  policies: Schema.Tuple([PolicyDefinitionSchema]),
  obligations: scheduledEvaluationFields.obligations,
})
export type OperationalRegistration = typeof OperationalRegistrationSchema.Type

/** Retained periods keep their original strategy binding when receipts are read. */
export const verifyStoredOperationalRegistration = (input: unknown) =>
  Result.gen(function* () {
    const registration = yield* Schema.decodeUnknownResult(
      OperationalRegistrationSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(
        (cause) => new SystemAssessmentError({ message: 'Operational registration is malformed', cause }),
      ),
    )
    const invalid = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    if (registration.policyHash !== (yield* canonicalHashV1Result(operationalReliabilityPolicy)))
      return yield* invalid('Operational registration must preserve 99.9% reliability and zero safety violations')
    const candidate = registration.policies[0]
    yield* validateRegisteredPolicyIdentity(candidate)
    if (candidate.policy !== JevResearchPolicy.Candidate || candidate.capitalAuthorization === undefined)
      return yield* invalid('Operational registration requires the existing sealed native capital generation')
    const runtime = registration.obligations.configuration
    if (
      !Schema.is(JevProtocolSchema)(runtime.protocol) &&
      !Schema.is(RetainedVisualJevProtocolSchema)(runtime.protocol)
    )
      return yield* invalid('Operational registration requires a recognized native protocol')
    const parameterHash = yield* canonicalHashV1Result(runtime.protocol)
    const expectedParameterHash = yield* canonicalHashV1Result(
      runtime.protocol.schemaVersion === 'bayn.jev.protocol.v40'
        ? defaultJevProtocolDocument
        : runtime.protocol.schemaVersion === 'bayn.jev.protocol.v39'
          ? retainedJevProtocolV39Document
          : retainedJevProtocolV38Document,
    )
    const protocolHash = yield* makeStrategyProtocolHashResult({
      name: 'jev',
      behaviorHash: jevBehaviorHash,
      parameterHash,
      parameterSchemaVersion: runtime.protocol.schemaVersion,
    })
    if (
      parameterHash !== expectedParameterHash ||
      candidate.parametersHash !== parameterHash ||
      candidate.strategyHash !== jevBehaviorHash ||
      candidate.protocolHash !== protocolHash ||
      candidate.executionModelHash !== (yield* canonicalHashV1Result(runtime.protocol.executionModel))
    )
      return yield* invalid('Operational schedule must bind the authorized native strategy')
    const deadlines = yield* qualificationDeadlines(runtime)
    for (const key of Object.keys(deadlines) as (keyof typeof deadlines)[])
      if (registration.obligations[key] !== deadlines[key])
        return yield* invalid('Operational deadlines must match the original runtime configuration')
    const markets = runtime.entryMarkets
    if (
      markets === undefined ||
      markets.some((market) => !runtime.protocol.marketProfiles.some((profile) => profile.market === market))
    )
      return yield* invalid('Operational reporting requires the actual entry scope within the authorized protocol')
    if (
      markets.length !== registration.calendar.tradingMarkets.length ||
      markets.some((market) => !registration.calendar.tradingMarkets.includes(market))
    )
      return yield* invalid('Operational reporting must match the compiled runtime entry scope')
    const calendar = registration.calendar.marketCalendar
    const verifiedCalendar = yield* qualificationCalendar(calendar)
    if (registration.calendar.sourceHash !== verifiedCalendar.sourceHash)
      return yield* invalid('Operational reporting requires its verified canonical equity calendar')
    let previousClose: string | undefined
    let previousDate = ''
    for (const session of registration.calendar.sessions) {
      if (
        session.openAt <= registration.registeredAt ||
        session.openAt >= session.closeAt ||
        session.sessionDate <= previousDate ||
        session.openAt.slice(0, 10) !== session.sessionDate ||
        (previousClose !== undefined && session.openAt !== previousClose)
      )
        return yield* invalid('Operational reporting must be prospective, ordered and contiguous without omitted time')
      previousClose = session.closeAt
      previousDate = session.sessionDate
    }
    if (previousClose === undefined) return yield* invalid('Operational registration requires a reporting period')
    const firstOpen = registration.calendar.sessions[0]?.openAt
    if (
      firstOpen === undefined ||
      calendar.requestedRange.start > firstOpen.slice(0, 10) ||
      calendar.requestedRange.end < new Date(Date.parse(previousClose) - 1).toISOString().slice(0, 10)
    )
      return yield* invalid('Operational calendar must cover the complete reporting period')
    return { registration, registrationHash: yield* canonicalHashV1Result(registration) }
  })

/** New periods may only bind the currently executable native protocol. */
export const validateOperationalRegistration = (input: unknown) =>
  verifyStoredOperationalRegistration(input).pipe(
    Result.flatMap((verified) => {
      const runtime = verified.registration.obligations.configuration
      return runtime.controllerPlanHash === executionControllerPlanHash &&
        runtime.schemaVersion !== 'bayn.qualification-runtime.v2'
        ? Result.fail(new SystemAssessmentError({ message: 'Streaming controller requires the streaming runtime' }))
        : Result.succeed(verified)
    }),
    Result.flatMap((verified) =>
      Schema.is(JevProtocolSchema)(verified.registration.obligations.configuration.protocol)
        ? Result.succeed(verified)
        : Result.fail(
            new SystemAssessmentError({ message: 'Operational registration requires the current native protocol' }),
          ),
    ),
  )
