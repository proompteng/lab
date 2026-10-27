import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { evaluateJevAcceptance, JevNumericalVerdict, JevResearchPolicy } from '../jev/acceptance'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'
import { SystemRegistrationSchema, validateSystemRegistration } from './policy'
import { RealismEvidenceSchema, RealismStatus, measureRealism } from './realism'
import { ReliabilityInputSchema, ReliabilityStatus, measureReliability } from './reliability'
import { SessionEvidenceSchema, assessSession } from './session'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { qualificationCalendar } from './calendar'
import { EntryTimingSourcesSchema } from './entry-timing'
import { LatencyStressSourcesSchema } from './latency-protocol'
import { replayExecutionAssumptions } from './replay-execution'
import { cashFlowEvidenceAssumptions } from './cash-flows'
import { costAttributionRule } from './cost-attribution'
import { validateOperatingCostWindow } from '../operating-cost-window'

export enum ProfitabilityStatus {
  Profitable = 'PROFITABLE',
  NotProfitable = 'NOT_PROFITABLE',
  Undetermined = 'UNDETERMINED',
}
export enum EdgeStatus {
  Established = 'ESTABLISHED_UNDER_PROTOCOL',
  NotEstablished = 'NOT_ESTABLISHED',
  Undetermined = 'UNDETERMINED',
}
export enum QualificationVerdict {
  Qualified = 'QUALIFIED_PAPER',
  Rejected = 'REJECTED',
  Inconclusive = 'INCONCLUSIVE',
}
export enum SafetyViolationKind {
  Unauthorized = 'UNAUTHORIZED_ACTION',
  Duplicate = 'DUPLICATE_ECONOMIC_EFFECT',
  Ledger = 'INVALID_LEDGER_ADMISSION',
  Ownership = 'INVALID_OWNERSHIP',
  Risk = 'RISK_LIMIT_VIOLATION',
  Identity = 'IDENTITY_MISMATCH',
}

export const SystemAssessmentInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.system-assessment-input.v1'),
  registration: SystemRegistrationSchema,
  asOf: UtcInstantSchema,
  registrationReceiptHash: Sha256Schema,
  sourceCutHash: Sha256Schema,
  calendarEvidence: Schema.NullOr(SnapshotCalendarSchema),
  entryTimingSources: EntryTimingSourcesSchema,
  latencyStressSources: LatencyStressSourcesSchema,
  policies: Schema.Array(
    Schema.Struct({
      policy: Schema.Enum(JevResearchPolicy),
      sessions: Schema.Array(SessionEvidenceSchema).check(Schema.isMinLength(20), Schema.isMaxLength(20)),
    }),
  ).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  reliability: ReliabilityInputSchema,
  obligationCoverageHash: Sha256Schema,
  realism: RealismEvidenceSchema,
  safety: Schema.Struct({
    coverage: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
    sourceHash: Sha256Schema,
    registrationHash: Sha256Schema,
    asOf: UtcInstantSchema,
    violations: Schema.Array(
      Schema.Struct({
        kind: Schema.Enum(SafetyViolationKind),
        sourceHash: Sha256Schema,
        occurredAt: UtcInstantSchema,
      }),
    ),
  }),
})

export const evaluateSystemAssessment = (input: unknown, verifiedSources: ReadonlySet<string>) =>
  Result.gen(function* () {
    const data = yield* Schema.decodeUnknownResult(
      SystemAssessmentInputSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(
        (cause) => new SystemAssessmentError({ message: 'System assessment evidence is malformed', cause }),
      ),
    )
    const { registration, registrationHash } = yield* validateSystemRegistration(data.registration)
    yield* validateOperatingCostWindow(
      data.policies.flatMap((policy) => policy.sessions.map((session) => session.operatingCosts)),
    )
    const missing: string[] = []
    const violations: string[] = []
    const requireSource = (hash: string) => {
      if (!verifiedSources.has(hash)) missing.push(`UNVERIFIED_SOURCE:${hash}`)
    }
    requireSource(data.registrationReceiptHash)
    requireSource(data.sourceCutHash)
    if (data.registrationReceiptHash !== registrationHash) violations.push('REGISTRATION_RECEIPT_MISMATCH')
    requireSource(registration.obligations.decisionScheduleHash)
    requireSource(registration.obligations.reconciliationScheduleHash)
    requireSource(registration.obligations.runtimeConfigurationHash)
    if (registration.obligations.configuration.controllerPlanHash === null)
      missing.push('MISSING_CONTROLLER_PLAN_BINDING')
    requireSource(registration.latencyStressProtocolHash)
    requireSource(registration.latencyReplayExecutionModelHash)
    for (const plan of registration.costAllocationPlans) requireSource(plan.basisSourceHash)
    for (const definition of registration.policies)
      for (const hash of [
        definition.imageDigest,
        definition.strategyHash,
        definition.protocolHash,
        definition.parametersHash,
        definition.promptsHash,
        definition.continuationAndExitsHash,
        definition.costAllocationRuleHash,
        definition.executionModelHash,
        definition.riskPolicyHash,
      ])
        requireSource(hash)
    requireSource(data.obligationCoverageHash)
    if (data.calendarEvidence === null) missing.push('MISSING_BROKER_CALENDAR')
    else {
      const observed = qualificationCalendar(data.calendarEvidence)
      if (Result.isFailure(observed)) violations.push('INVALID_BROKER_CALENDAR')
      else {
        requireSource(observed.success.sourceHash)
        if (
          observed.success.sourceHash !== registration.calendar.sourceHash ||
          observed.success.requestedRange.start !== registration.calendar.sessions[0]?.sessionDate ||
          observed.success.requestedRange.end !== registration.calendar.sessions.at(-1)?.sessionDate ||
          (yield* canonicalHashV1Result(observed.success.sessions)) !==
            (yield* canonicalHashV1Result(registration.calendar.sessions))
        )
          violations.push('REGISTERED_CALENDAR_MISMATCH')
      }
    }
    if (Date.parse(data.asOf) < Date.parse(registration.registeredAt))
      violations.push('ASSESSMENT_PREDATES_REGISTRATION')
    const evaluated = []
    const expectedDecisions: string[] = []
    const expectedFills: string[] = []
    if (new Set(data.policies.map((p) => p.policy)).size !== registration.policies.length)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Every registered policy must appear exactly once' }),
      )
    for (const policy of data.policies) {
      const definition = registration.policies.find((p) => p.policy === policy.policy)
      if (definition === undefined)
        return yield* Result.fail(new SystemAssessmentError({ message: 'Unregistered policy' }))
      const sessions = []
      for (const [index, session] of policy.sessions.entries()) {
        if (session.sessionDate !== registration.calendar.sessions[index]?.sessionDate)
          return yield* Result.fail(
            new SystemAssessmentError({ message: 'Omitted, substituted or reordered registered session' }),
          )
        const result = yield* assessSession(session, registration, definition, data.asOf, verifiedSources)
        missing.push(...result.missing.map((reason) => `${policy.policy}:${session.sessionDate}:${reason}`))
        violations.push(...result.violations.map((reason) => `${policy.policy}:${session.sessionDate}:${reason}`))
        sessions.push(result)
        expectedDecisions.push(...(session.financial?.decisionIds ?? []))
        expectedFills.push(...(session.financial?.fillIds ?? []))
        if (session.financial !== null) {
          const definitionHash = yield* canonicalHashV1Result(definition)
          const calendar = registration.calendar.sessions[index]
          for (const id of session.financial.decisionIds) {
            const decision = data.realism.decisions.find((d) => d.decisionId === id)
            if (
              decision !== undefined &&
              (decision.policyDefinitionHash !== definitionHash ||
                decision.authorityGenerationHash !== definition.authorityGenerationHash ||
                calendar === undefined ||
                Date.parse(decision.decisionAt) < Date.parse(calendar.openAt) ||
                Date.parse(decision.decisionAt) > Date.parse(calendar.closeAt))
            )
              violations.push(`DECISION_POLICY_OR_SESSION_MISMATCH:${id}`)
          }
          const fills = data.realism.fills.filter((f) => session.financial?.fillIds.includes(f.fillId))
          if (fills.length === session.financial.fillIds.length) {
            const notional = fills.reduce(
              (sum, f) =>
                sum + (BigInt(f.fillQuantityAtoms) * BigInt(f.fillPriceAtoms) + 500_000_000_000n) / 1_000_000_000_000n,
              0n,
            )
            if (notional.toString() !== session.financial.filledNotionalMicros)
              violations.push(`FILLED_NOTIONAL_MISMATCH:${policy.policy}:${session.sessionDate}`)
            if (session.financial.completedEpisodes * 2 > fills.length)
              violations.push(`EPISODE_COUNT_EXCEEDS_FILLS:${policy.policy}:${session.sessionDate}`)
          }
        }
      }
      evaluated.push({ policy: policy.policy, definitionHash: yield* canonicalHashV1Result(definition), sessions })
    }
    for (const [expected, observed, kind] of [
      [expectedDecisions, data.realism.expectedDecisionIds, 'DECISION'],
      [expectedFills, data.realism.expectedFillIds, 'FILL'],
    ] as const) {
      if (
        expected.length !== observed.length ||
        new Set(expected).size !== expected.length ||
        expected.some((id) => !observed.includes(id))
      )
        violations.push(`${kind}_REALISM_COVERAGE_MISMATCH`)
    }
    const realism = yield* measureRealism(data.realism, verifiedSources)
    missing.push(...realism.missing)
    violations.push(...realism.violations)
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (first === undefined || last === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Empty registered calendar' }))
    if (Date.parse(data.asOf) < Date.parse(last.closeAt)) missing.push('WINDOW_NOT_CLOSED')
    if (data.reliability.asOf !== data.asOf) violations.push('RELIABILITY_EVIDENCE_CUT_MISMATCH')
    for (const obligation of data.reliability.schedule) {
      requireSource(obligation.scheduleEvidenceHash)
      if (
        Date.parse(obligation.dueAt) < Date.parse(first.openAt) ||
        Date.parse(obligation.dueAt) >
          Date.parse(last.closeAt) +
            (obligation.class === ObligationClass.Recovery ? registration.obligations.mutationDeadlineMs : 0)
      )
        violations.push(`OBLIGATION_OUTSIDE_WINDOW:${obligation.obligationId}`)
    }
    for (const completion of data.reliability.completions) requireSource(completion.evidenceHash)
    const reliability = yield* measureReliability(data.reliability)
    const expectedSchedule = yield* registeredSchedule(registration)
    const providedScheduledWork = data.reliability.schedule.filter(
      (o) => o.class === ObligationClass.Decision || o.class === ObligationClass.Reconciliation,
    )
    const byId = (a: { readonly obligationId: string }, b: { readonly obligationId: string }) =>
      a.obligationId.localeCompare(b.obligationId)
    if (
      (yield* canonicalHashV1Result(providedScheduledWork.toSorted(byId))) !==
      (yield* canonicalHashV1Result(expectedSchedule.toSorted(byId)))
    )
      violations.push('SCHEDULED_WORK_DENOMINATOR_MISMATCH')
    for (const obligation of expectedSchedule) {
      const committed =
        obligation.class === ObligationClass.Decision
          ? registration.obligations.decisionScheduleHash
          : registration.obligations.reconciliationScheduleHash
      if (obligation.scheduleEvidenceHash !== committed) violations.push('SCHEDULE_COMMITMENT_MISMATCH')
    }
    requireSource(data.safety.sourceHash)
    if (data.safety.coverage !== 'COMPLETE') missing.push('INCOMPLETE_SAFETY_AUDIT')
    if (data.safety.registrationHash !== registrationHash || data.safety.asOf !== data.asOf)
      violations.push('SAFETY_AUDIT_SCOPE_MISMATCH')
    for (const violation of data.safety.violations) {
      requireSource(violation.sourceHash)
      violations.push(`SAFETY:${violation.kind}`)
    }
    const numericalResult = evaluateJevAcceptance({
      schemaVersion: 'bayn.jev-acceptance-input.v1',
      protocolHash: registration.acceptanceProtocolHash,
      registration: {
        planHash: registrationHash,
        lockedAt: registration.registeredAt,
        attemptIndex: registration.attemptIndex,
        sessions: registration.calendar.sessions,
      },
      policies: evaluated.map((p) => ({
        policy: p.policy,
        definitionHash: p.definitionHash,
        sessions: p.sessions.map((s) => s.numerical),
      })),
    })
    const numerical = Result.isSuccess(numericalResult) ? numericalResult.success : null
    if (Result.isFailure(numericalResult))
      violations.push(
        `NUMERICAL_PROTOCOL:${'message' in numericalResult.failure ? numericalResult.failure.message : numericalResult.failure.reason}`,
      )
    const candidate = evaluated.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Candidate evidence is missing' }))
    const economicComplete = candidate.sessions.every((s) => s.economicEvidenceComplete)
    const actual = economicComplete
      ? candidate.sessions.reduce((total, s) => total + BigInt(s.netEconomicPnlMicros ?? '0'), 0n)
      : null
    const qualification = candidate.sessions.every(
      (s) => s.economicEvidenceComplete && s.qualificationPnlMicros !== null,
    )
      ? candidate.sessions.reduce((total, s) => total + BigInt(s.qualificationPnlMicros ?? '0'), 0n)
      : null
    const profitability =
      actual === null
        ? ProfitabilityStatus.Undetermined
        : actual > 0n
          ? ProfitabilityStatus.Profitable
          : ProfitabilityStatus.NotProfitable
    const confidence = numerical !== null && 'confidence' in numerical ? numerical.confidence : null
    const edge =
      confidence === null || missing.length > 0 || violations.length > 0
        ? EdgeStatus.Undetermined
        : numerical !== null && 'checks' in numerical && numerical.checks.pairedIncrementalLowerBounds
          ? EdgeStatus.Established
          : EdgeStatus.NotEstablished
    const safetyPass =
      data.safety.coverage === 'COMPLETE' &&
      data.safety.violations.length === 0 &&
      verifiedSources.has(data.safety.sourceHash) &&
      data.safety.registrationHash === registrationHash &&
      data.safety.asOf === data.asOf
    const evidenceComplete = missing.length === 0 && violations.length === 0
    const verdict =
      violations.length > 0 ||
      numerical?.verdict === JevNumericalVerdict.Missed ||
      reliability.status === ReliabilityStatus.MissesTarget ||
      realism.status === RealismStatus.Violated ||
      data.safety.violations.length > 0
        ? QualificationVerdict.Rejected
        : evidenceComplete &&
            numerical?.verdict === JevNumericalVerdict.Passed &&
            reliability.status === ReliabilityStatus.MeetsTarget &&
            realism.status === RealismStatus.Supported &&
            safetyPass
          ? QualificationVerdict.Qualified
          : QualificationVerdict.Inconclusive
    const material = {
      schemaVersion: 'bayn.system-assessment.v1' as const,
      registrationHash,
      registrationReceiptHash: data.registrationReceiptHash,
      sourceCutHash: data.sourceCutHash,
      inputHash: yield* canonicalHashV1Result(data),
      asOf: data.asOf,
      environment: registration.environment,
      verifiedSourceHashes: [...verifiedSources].sort(),
      calendar: registration.calendar,
      verdict,
      profitability: {
        status: profitability,
        netEconomicPnlMicros: actual?.toString() ?? null,
        qualificationPnlMicros: qualification?.toString() ?? null,
      },
      edge: { status: edge, confidence, statisticalAssumptions: registration.statisticalAssumptions },
      cashFlowEvidenceAssumptions,
      costAttributionRule,
      costAllocationPlans: registration.costAllocationPlans,
      executionProvenance: {
        receiptHashes: [
          ...new Set(
            data.policies.flatMap((policy) =>
              policy.sessions.flatMap((session) =>
                session.p95LatencyStress === null ? [] : [session.p95LatencyStress.executionReceiptHash],
              ),
            ),
          ),
        ].sort(),
        assumptions: replayExecutionAssumptions,
      },
      reliability,
      realism,
      safety: { pass: safetyPass, ...data.safety },
      evidenceComplete,
      missing,
      violations,
      numerical,
      policies: evaluated,
      authority:
        'Assessment grants no capital or trading authority. PAPER evidence does not establish live execution.' as const,
    }
    return { ...material, assessmentHash: yield* canonicalHashV1Result(material) }
  })

export type SystemAssessment = Extract<
  ReturnType<typeof evaluateSystemAssessment>,
  { readonly _tag: 'Success' }
>['success']
