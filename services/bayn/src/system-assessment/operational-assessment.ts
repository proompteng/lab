import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { SystemAssessmentInputSchema, completeSafetyAudit } from './assessment'
import { decisionAdmissionWitnesses } from './decision-admissions'
import { SystemAssessmentError } from './economics'
import { registeredFinancialAccounts } from './forward-evidence'
import { bindOperationalObligations } from './operational-obligations'
import { OperationalRegistrationSchema, validateOperationalRegistration } from './operational-period'
import { measureReliability, ReliabilityStatus } from './reliability'
import type { SystemSourceCut } from './source-cut'
import { SystemSourceCutSchema } from './source-cut'
import { BrokerIdentitySchema } from '../broker/identity'

const MutationCoverageSchema = Schema.Struct({
  mutations: SystemSourceCutSchema.fields.mutations,
  accounts: Schema.Array(
    Schema.Struct({
      policy: Schema.Enum(JevResearchPolicy),
      identity: BrokerIdentitySchema,
      forward: Schema.Struct({ unresolvedMutationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
    }),
  ),
})

export const OperationalAssessmentInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-assessment-input.v1'),
  registration: OperationalRegistrationSchema,
  sourceCutHash: Sha256Schema,
  safety: SystemAssessmentInputSchema.fields.safety,
})

export const operationalAssessmentVerdict = (
  reliability: ReliabilityStatus,
  missingEvidenceCount: number,
  safetyComplete: boolean,
  safetyViolations: number,
) =>
  safetyViolations > 0 || reliability === ReliabilityStatus.MissesTarget
    ? ('REJECTED' as const)
    : missingEvidenceCount === 0 && reliability === ReliabilityStatus.MeetsTarget && safetyComplete
      ? ('OPERATIONALLY_RELIABLE_PAPER' as const)
      : ('INCONCLUSIVE' as const)

/** Reproduce counters from committed witnesses; callers cannot submit successful-event totals. */
export const evaluateOperationalAssessment = (
  input: unknown,
  cut: SystemSourceCut,
  verifiedSources: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const data = yield* Schema.decodeUnknownResult(
      OperationalAssessmentInputSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new SystemAssessmentError({ message: 'Operational assessment is malformed', cause })),
    )
    const { registration, registrationHash } = yield* validateOperationalRegistration(data.registration)
    if (
      cut.registrationHash !== registrationHash ||
      (yield* canonicalHashV1Result(cut)) !== data.sourceCutHash ||
      cut.runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash ||
      (yield* canonicalHashV1Result(cut.sourceMaterial)) !== cut.sourceMaterialHash
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Operational source cut differs from its registration' }),
      )
    const missing: string[] = []
    for (const source of [
      registration.calendar.sourceHash,
      ...registration.retainedIncidentSources,
      data.safety.sourceHash,
    ])
      if (!verifiedSources.has(source)) missing.push(`UNVERIFIED_SOURCE:${source}`)
    const lastClose = registration.calendar.sessions.at(-1)?.closeAt
    if (lastClose === undefined || cut.asOf < lastClose) missing.push('OPEN_REPORTING_PERIOD')
    const accounts = yield* registeredFinancialAccounts(registration, cut.financial)
    const account = accounts.get(JevResearchPolicy.Candidate)
    if (account === undefined || account.sessions.some((session) => session.facts === null))
      missing.push('INCOMPLETE_FILL_ACCOUNTING')
    if (
      account !== undefined &&
      account.sessions.some(
        (session) =>
          session.facts !== null && (session.facts.unsettledFillCount > 0 || session.facts.uncertainMutationCount > 0),
      )
    )
      missing.push('UNSETTLED_OR_UNCERTAIN_EXECUTION')
    const admissions = yield* decisionAdmissionWitnesses(cut, registration.policies[0].authorityGenerationHash)
    const bound = yield* bindOperationalObligations(
      { ...cut, durableObservations: [...cut.durableObservations, ...admissions.witnesses] },
      registration,
      data.sourceCutHash,
    )
    const coverage = Schema.decodeUnknownResult(MutationCoverageSchema)(cut.sourceMaterial)
    const coverageAccount = Result.isSuccess(coverage)
      ? coverage.success.accounts.find((account) => account.policy === JevResearchPolicy.Candidate)
      : undefined
    const recoveryEvidenceComplete =
      Result.isSuccess(coverage) &&
      coverageAccount !== undefined &&
      coverageAccount.identity.accountId === registration.policies[0].riskPolicy.accountId &&
      coverageAccount.identity.identityHash ===
        registration.policies[0].capitalAuthorization?.request.broker.identityHash &&
      cut.mutations.every(
        (mutation) => mutation.authorityGenerationHash === registration.policies[0].authorityGenerationHash,
      ) &&
      (yield* canonicalHashV1Result(coverage.success.mutations)) === (yield* canonicalHashV1Result(cut.mutations))
    if (!recoveryEvidenceComplete) missing.push('INCOMPLETE_MUTATION_SOURCE_COVERAGE')
    if (coverageAccount !== undefined && coverageAccount.forward.unresolvedMutationCount > 0)
      missing.push('UNRESOLVED_ACCOUNT_MUTATION')
    const reliability = yield* measureReliability(bound.reliability, false, recoveryEvidenceComplete)
    const safetyPass = completeSafetyAudit(data.safety, registrationHash, cut.asOf, verifiedSources)
    if (!safetyPass && data.safety.violations.length === 0) missing.push('INCOMPLETE_SAFETY_AUDIT')
    const verdict = operationalAssessmentVerdict(
      reliability.status,
      missing.length,
      safetyPass,
      data.safety.violations.length,
    )
    return {
      schemaVersion: 'bayn.operational-assessment.v1' as const,
      registrationHash,
      sourceCutHash: data.sourceCutHash,
      asOf: cut.asOf,
      program: registration.program,
      environment: registration.environment,
      scope: { calendar: registration.calendar, policy: registration.policies[0] },
      reliability,
      safety: { ...data.safety, pass: safetyPass },
      obligationCoverageHash: bound.obligationCoverageHash,
      retainedIncidentSources: registration.retainedIncidentSources,
      missing: [...new Set(missing)],
      verdict,
      economicQualification: 'NOT_ASSESSED' as const,
    }
  })
