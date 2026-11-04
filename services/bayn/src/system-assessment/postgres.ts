import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { executionControllerPlanHash } from '../execution/controller'
import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { evaluateSystemAssessment } from './assessment'
import { SystemAssessmentError } from './economics'
import { validateSystemRegistration, verifyStoredSystemRegistration, type ScheduledEvaluation } from './policy'
import { OperationalRegistrationSchema, validateOperationalRegistration } from './operational-period'
import {
  evaluateOperationalAssessment,
  OperationalAssessmentInputSchema,
  StoredOperationalAssessmentInputSchema,
  verifyStoredOperationalAssessment,
} from './operational-assessment'
import { readRegisteredFinancialIdentity } from './capital-identity'
import { readSystemSourceCut } from './source-cut'
import {
  readOperationalAssessmentSourceCut,
  readRetainedOperationalAssessmentSourceCut,
} from './operational-source-cut'
import { bindSystemSourceCut } from './bind-source'
import { SystemAssessmentInputSchema } from './assessment'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'
import { bindEntryTimings } from './entry-timing'
import { bindLatencyStressSources } from './latency-report'
import { JevResearchPolicy } from '../jev/acceptance'
import type { VerifiedReplayImage } from './replay-image'
import { readReplayExecutionReceipt, type ReplayExecutionReceiptSchema } from './replay-execution'

export const ProgramHistorySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.system-qualification-history.v1'),
  program: Schema.Literals(['BAYN_SYSTEM_QUALIFICATION', 'BAYN_OPERATIONAL_RELIABILITY']),
  historySourceHash: Sha256Schema,
  auditedAt: UtcInstantSchema,
  attempts: Schema.Array(
    Schema.Struct({
      attemptIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
      planHash: Sha256Schema,
      registeredAt: UtcInstantSchema,
      evidenceHash: Sha256Schema,
    }),
  ),
})

const boundaryError = (message: string) => (cause: unknown) => new SystemAssessmentError({ message, cause })
const HashRow = Schema.Array(Schema.Struct({ registration_hash: Sha256Schema }))
const RegistrationRows = Schema.Array(Schema.Struct({ payload: Schema.Unknown }))

/** The reviewed history origin is write-once; source and candidate changes never create a fresh program. */
export const initializeQualificationHistory = (input: unknown, verifiedSources: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const history = yield* Schema.decodeUnknownEffect(ProgramHistorySchema, strictParseOptions)(input)
    if (
      !verifiedSources.has(history.historySourceHash) ||
      history.attempts.some((a) => !verifiedSources.has(a.evidenceHash))
    )
      return yield* new SystemAssessmentError({ message: 'Prior attempt history requires verified audit evidence' })
    let previousAt = -Infinity
    for (const [index, attempt] of history.attempts.entries()) {
      const at = Date.parse(attempt.registeredAt)
      if (attempt.attemptIndex !== index + 1 || at < previousAt || at > Date.parse(history.auditedAt))
        return yield* new SystemAssessmentError({ message: 'Prior attempts must retain their full ordered history' })
      previousAt = at
    }
    const historyHash = yield* Effect.fromResult(canonicalHashV1Result(history))
    const text = yield* Effect.fromResult(canonicalJsonV1Result(history))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_qualification_origin(program, prior_attempt_count, prior_attempt_hash, history_evidence_text, history_evidence_hash)
      VALUES (${history.program}, ${history.attempts.length}, ${history.attempts.at(-1)?.planHash ?? historyHash}, ${text}, ${historyHash})`
    return {
      historyHash,
      priorAttemptCount: history.attempts.length,
      priorAttemptHash: history.attempts.at(-1)?.planHash ?? historyHash,
    }
  }).pipe(Effect.mapError(boundaryError('Qualification history initialization failed')))

export const registerSystemQualification = (input: unknown, verifiedSources: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const { registration, registrationHash } = yield* Effect.fromResult(validateSystemRegistration(input))
    if (registration.costAllocationPlans.some((plan) => !verifiedSources.has(plan.basisSourceHash)))
      return yield* new SystemAssessmentError({
        message: 'Registration requires verified cost allocation basis artifacts before the first open',
      })
    return yield* persistProspectiveRegistration(registration, registrationHash)
  }).pipe(Effect.mapError(boundaryError('Prospective system registration failed')))

export const registerOperationalPeriod = (input: unknown, verifiedSources: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const { registration, registrationHash } = yield* Effect.fromResult(validateOperationalRegistration(input))
    if (registration.obligations.configuration.controllerPlanHash !== executionControllerPlanHash)
      return yield* new SystemAssessmentError({
        message: 'Operational registration requires the native controller plan',
      })
    if (
      [registration.calendar.sourceHash, ...registration.retainedIncidentSources].some(
        (hash) => !verifiedSources.has(hash),
      )
    )
      return yield* new SystemAssessmentError({
        message: 'Operational registration requires verified scope and retained incident evidence',
      })
    if ((yield* readRegisteredFinancialIdentity(registration.policies[0])) === null)
      return yield* new SystemAssessmentError({
        message: 'Operational registration requires its existing durable capital generation',
      })
    return yield* persistProspectiveRegistration(registration, registrationHash)
  }).pipe(Effect.mapError(boundaryError('Prospective operational registration failed')))

const persistProspectiveRegistration = <
  R extends ScheduledEvaluation & { readonly priorAttemptHash: string; readonly registeredAt: string },
>(
  registration: R,
  registrationHash: string,
) =>
  Effect.gen(function* () {
    const schedule = yield* Effect.fromResult(registeredSchedule(registration))
    if (
      schedule.some(
        (row) =>
          row.scheduleEvidenceHash !==
          (row.class === ObligationClass.Decision
            ? registration.obligations.decisionScheduleHash
            : registration.obligations.reconciliationScheduleHash),
      )
    )
      return yield* new SystemAssessmentError({
        message: 'Registration schedule commitments do not reproduce its calendar and deadlines',
      })
    const text = yield* Effect.fromResult(canonicalJsonV1Result(registration))
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (first === undefined || last === undefined)
      return yield* new SystemAssessmentError({ message: 'Registration requires a complete calendar' })
    const sql = yield* PgClient.PgClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT program FROM system_qualification_origin WHERE program = ${registration.program} FOR UPDATE`
        const existing = yield* Schema.decodeUnknownEffect(HashRow)(
          yield* sql`SELECT registration_hash FROM system_qualification_registrations WHERE registration_hash = ${registrationHash}`,
        )
        if (existing.length > 0) return
        yield* sql`INSERT INTO system_qualification_registrations
      (registration_hash, program, attempt_index, prior_attempt_hash, registered_at, first_open_at, last_close_at, payload_text)
      VALUES (${registrationHash}, ${registration.program}, ${registration.attemptIndex}, ${registration.priorAttemptHash},
        ${registration.registeredAt}, ${first.openAt}, ${last.closeAt}, ${text})`
      }),
    )
    return { registrationHash, registration }
  }).pipe(Effect.mapError(boundaryError('Prospective system registration failed')))

export const readAssessmentRegistration = (hash: string) =>
  Effect.gen(function* () {
    const registrationHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(RegistrationRows)(
      yield* sql`SELECT payload_text::jsonb AS payload FROM system_qualification_registrations WHERE registration_hash = ${registrationHash}`,
    )
    const row = rows[0]
    if (row === undefined) return yield* new SystemAssessmentError({ message: 'System registration does not exist' })
    const result = Schema.is(OperationalRegistrationSchema)(row.payload)
      ? yield* Effect.fromResult(validateOperationalRegistration(row.payload))
      : yield* Effect.fromResult(verifyStoredSystemRegistration(row.payload))
    if (result.registrationHash !== registrationHash)
      return yield* new SystemAssessmentError({ message: 'Stored registration hash differs from its contents' })
    return result.registration
  }).pipe(Effect.mapError(boundaryError('System registration read failed')))

export const readSystemRegistration = (hash: string) =>
  readAssessmentRegistration(hash).pipe(
    Effect.flatMap((registration) =>
      registration.program === 'BAYN_SYSTEM_QUALIFICATION'
        ? Effect.succeed(registration)
        : Effect.fail(
            new SystemAssessmentError({ message: 'An operational period cannot establish economic qualification' }),
          ),
    ),
  )

export const assessAndPersistOperational = (input: unknown, verifiedSources: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(OperationalAssessmentInputSchema, strictParseOptions)(input)
    const cut = yield* readOperationalAssessmentSourceCut(decoded.sourceCutHash, decoded.registration)
    const assessment = yield* Effect.fromResult(evaluateOperationalAssessment(decoded, cut, verifiedSources))
    yield* readAssessmentRegistration(assessment.registrationHash)
    const material = { ...assessment, verifiedSourceHashes: [...verifiedSources].sort() }
    const assessmentHash = yield* Effect.fromResult(canonicalHashV1Result(material))
    const text = yield* Effect.fromResult(canonicalJsonV1Result(material))
    const inputText = yield* Effect.fromResult(canonicalJsonV1Result(decoded))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO operational_assessment_receipts(assessment_hash, registration_hash, source_cut_hash, as_of, verdict, input_text, assessment_text)
      VALUES (${assessmentHash}, ${assessment.registrationHash}, ${assessment.sourceCutHash}, ${assessment.asOf}, ${assessment.verdict}, ${inputText}, ${text})
      ON CONFLICT (assessment_hash) DO NOTHING`
    return yield* readPersistedOperationalAssessment(assessmentHash)
  }).pipe(Effect.mapError(boundaryError('Operational assessment persistence failed')))

export const readPersistedOperationalAssessment = (hash: string) =>
  Effect.gen(function* () {
    const assessmentHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          input: StoredOperationalAssessmentInputSchema,
          verifiedSourceHashes: Schema.Array(Sha256Schema),
        }),
      ),
    )(
      yield* sql`SELECT input_text::jsonb AS input, assessment_text::jsonb->'verifiedSourceHashes' AS "verifiedSourceHashes"
    FROM operational_assessment_receipts WHERE assessment_hash=${assessmentHash}`,
    )
    const row = rows[0]
    if (row === undefined)
      return yield* new SystemAssessmentError({ message: 'Operational assessment receipt does not exist' })
    const readCut =
      row.input.schemaVersion === 'bayn.operational-assessment-input.v1'
        ? readRetainedOperationalAssessmentSourceCut
        : readOperationalAssessmentSourceCut
    const cut = yield* readCut(row.input.sourceCutHash, row.input.registration)
    const assessment = yield* Effect.fromResult(
      verifyStoredOperationalAssessment(row.input, cut, new Set(row.verifiedSourceHashes)),
    )
    yield* readAssessmentRegistration(assessment.registrationHash)
    const material = { ...assessment, verifiedSourceHashes: row.verifiedSourceHashes }
    if ((yield* Effect.fromResult(canonicalHashV1Result(material))) !== assessmentHash)
      return yield* new SystemAssessmentError({
        message: 'Recomputed operational assessment differs from its immutable receipt',
      })
    return { ...material, assessmentHash }
  }).pipe(Effect.mapError(boundaryError('Operational assessment verification failed')))

export const assessAndPersistSystem = (
  input: unknown,
  verifiedSources: ReadonlySet<string>,
  artifacts: ReadonlyMap<string, Uint8Array> = new Map(),
  images: ReadonlyMap<string, VerifiedReplayImage> = new Map(),
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SystemAssessmentInputSchema, strictParseOptions)(input)
    const cut = yield* readSystemSourceCut(decoded.sourceCutHash)
    const candidate = decoded.registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined) return yield* new SystemAssessmentError({ message: 'Missing candidate registration' })
    const timings = yield* Effect.fromResult(
      bindEntryTimings(decoded.entryTimingSources, cut, candidate.sourceRevision, artifacts),
    )
    const executions = new Map<string, typeof ReplayExecutionReceiptSchema.Type>()
    for (const source of decoded.latencyStressSources)
      if (source.executionReceiptHash !== null)
        executions.set(source.executionReceiptHash, yield* readReplayExecutionReceipt(source.executionReceiptHash))
    const stress = yield* Effect.fromResult(
      bindLatencyStressSources(
        decoded.latencyStressSources,
        decoded.registration,
        cut,
        artifacts,
        verifiedSources,
        images,
        executions,
      ),
    )
    const bound = yield* Effect.fromResult(bindSystemSourceCut(decoded, cut, verifiedSources, timings, stress))
    const { version } = yield* Effect.fromResult(verifyStoredSystemRegistration(bound.input.registration))
    const assessment = yield* Effect.fromResult(evaluateSystemAssessment(bound.input, bound.verifiedSources, version))
    yield* readSystemRegistration(assessment.registrationHash)
    const { assessmentHash, ...material } = assessment
    const text = yield* Effect.fromResult(canonicalJsonV1Result(material))
    const inputText = yield* Effect.fromResult(canonicalJsonV1Result(bound.input))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_assessment_receipts(assessment_hash, registration_hash, source_cut_hash, as_of, verdict, input_text, assessment_text)
    VALUES (${assessmentHash}, ${assessment.registrationHash}, ${assessment.sourceCutHash}, ${assessment.asOf}, ${assessment.verdict}, ${inputText}, ${text})
    ON CONFLICT (assessment_hash) DO NOTHING`
    return assessment
  }).pipe(Effect.mapError(boundaryError('System assessment persistence failed')))

export const readPersistedSystemAssessment = (hash: string) =>
  Effect.gen(function* () {
    const assessmentHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          input: Schema.Unknown,
          assessment: Schema.Struct({ verifiedSourceHashes: Schema.Array(Sha256Schema) }),
        }),
      ),
    )(
      yield* sql`SELECT input_text::jsonb AS input, assessment_text::jsonb AS assessment
    FROM system_assessment_receipts WHERE assessment_hash = ${assessmentHash}`,
    )
    const row = rows[0]
    if (row === undefined) return yield* new SystemAssessmentError({ message: 'Assessment receipt does not exist' })
    const decoded = yield* Schema.decodeUnknownEffect(SystemAssessmentInputSchema, strictParseOptions)(row.input)
    const { version } = yield* Effect.fromResult(verifyStoredSystemRegistration(decoded.registration))
    const assessment = yield* Effect.fromResult(
      evaluateSystemAssessment(decoded, new Set(row.assessment.verifiedSourceHashes), version),
    )
    if (assessment.assessmentHash !== assessmentHash)
      return yield* new SystemAssessmentError({ message: 'Recomputed assessment differs from its immutable receipt' })
    return assessment
  }).pipe(Effect.mapError(boundaryError('Assessment receipt verification failed')))
