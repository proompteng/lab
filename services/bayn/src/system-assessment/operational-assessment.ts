import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentInputSchema, completeSafetyAudit } from './assessment'
import { decisionAdmissionWitnesses } from './decision-admissions'
import { controllerBuildMatchesRegistration } from './decision-work'
import { SystemAssessmentError } from './economics'
import { registeredFinancialAccounts } from './forward-evidence'
import { bindOperationalObligations } from './operational-obligations'
import { OperationalRegistrationSchema, validateOperationalRegistration } from './operational-period'
import { measureReliability, ReliabilityStatus } from './reliability'
import type { SystemSourceCut } from './source-cut'
import { SystemSourceCutSchema } from './source-cut'
import { BrokerIdentitySchema } from '../broker/identity'
import { AccountingTransactionSchema } from '../accounting/schema'
import { StoredCashSettlementSchema } from '../accounting/cash-settlement'
import { cashSettlementMatches } from './cash-settlements'

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
const CapturedAccount = MutationCoverageSchema.fields.accounts.value
const AccountingCoverageSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      ...CapturedAccount.fields,
      forward: Schema.Struct({
        ...CapturedAccount.fields.forward.fields,
        accountingReceiptsExact: Schema.Boolean,
        ledgerExact: Schema.Boolean,
        missingLedgerAccountCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        accountTransactions: Schema.Array(AccountingTransactionSchema),
        accountCashSettlements: Schema.Array(StoredCashSettlementSchema),
        accountPositionCounts: Schema.Struct({ reconciledAt: UtcInstantSchema }),
      }),
    }),
  ),
})

const { sourceHash: _safetySource, ...safetyMaterialFields } = SystemAssessmentInputSchema.fields.safety.fields
const OperationalSafetyMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-safety-audit.v1'),
  ...safetyMaterialFields,
  auditEvidenceHash: Sha256Schema,
})

export const makeOperationalSafetyAudit = (input: unknown) =>
  Schema.decodeUnknownResult(
    OperationalSafetyMaterialSchema,
    strictParseOptions,
  )(input).pipe(
    Result.flatMap((material) =>
      canonicalHashV1Result(material).pipe(Result.map((sourceHash) => ({ ...material, sourceHash }))),
    ),
  )

export const OperationalAssessmentInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-assessment-input.v1'),
  registration: OperationalRegistrationSchema,
  sourceCutHash: Sha256Schema,
  safety: Schema.Struct({ ...OperationalSafetyMaterialSchema.fields, sourceHash: Sha256Schema }),
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
    for (const pass of cut.controllerPasses)
      if (!controllerBuildMatchesRegistration(pass, registration))
        missing.push(`UNBOUND_CONTROLLER_BUILD:${pass.receiptHash}`)
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
    const accounting = Schema.decodeUnknownResult(AccountingCoverageSchema)(cut.sourceMaterial)
    const accountingAccount = Result.isSuccess(accounting)
      ? accounting.success.accounts.find((row) => row.policy === JevResearchPolicy.Candidate)
      : undefined
    if (
      account === undefined ||
      accountingAccount === undefined ||
      accountingAccount.identity.accountId !== registration.policies[0].riskPolicy.accountId ||
      accountingAccount.identity.identityHash !==
        registration.policies[0].capitalAuthorization?.request.broker.identityHash ||
      !accountingAccount.forward.accountingReceiptsExact ||
      !accountingAccount.forward.ledgerExact ||
      accountingAccount.forward.missingLedgerAccountCount !== 0 ||
      accountingAccount.forward.accountTransactions.some(
        (trade) =>
          !cashSettlementMatches(
            trade,
            accountingAccount.forward.accountCashSettlements.find((s) => s.data.transactionId === trade.transactionId),
            accountingAccount.identity.accountId,
            accountingAccount.forward.accountPositionCounts.reconciledAt,
          ),
      )
    )
      missing.push('INCOMPLETE_FILL_ACCOUNTING')
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
    const { sourceHash, ...auditMaterial } = data.safety
    const auditBound =
      sourceHash === (yield* canonicalHashV1Result(auditMaterial)) && verifiedSources.has(data.safety.auditEvidenceHash)
    if (!auditBound) missing.push('UNBOUND_SAFETY_AUDIT')
    const safetyPass = auditBound && completeSafetyAudit(data.safety, registrationHash, cut.asOf, verifiedSources)
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
