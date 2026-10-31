import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { evaluateSystemAssessment } from './assessment'
import { SystemAssessmentError } from './economics'
import { validateSystemRegistration } from './policy'
import { readSystemSourceCut } from './source-cut'
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
  program: Schema.Literal('BAYN_SYSTEM_QUALIFICATION'),
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

export const readSystemRegistration = (hash: string) =>
  Effect.gen(function* () {
    const registrationHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(RegistrationRows)(
      yield* sql`SELECT payload_text::jsonb AS payload FROM system_qualification_registrations WHERE registration_hash = ${registrationHash}`,
    )
    const row = rows[0]
    if (row === undefined) return yield* new SystemAssessmentError({ message: 'System registration does not exist' })
    const result = yield* Effect.fromResult(validateSystemRegistration(row.payload))
    if (result.registrationHash !== registrationHash)
      return yield* new SystemAssessmentError({ message: 'Stored registration hash differs from its contents' })
    return result.registration
  }).pipe(Effect.mapError(boundaryError('System registration read failed')))

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
    const assessment = yield* Effect.fromResult(evaluateSystemAssessment(bound.input, bound.verifiedSources))
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
    const assessment = yield* Effect.fromResult(
      evaluateSystemAssessment(row.input, new Set(row.assessment.verifiedSourceHashes)),
    )
    if (assessment.assessmentHash !== assessmentHash)
      return yield* new SystemAssessmentError({ message: 'Recomputed assessment differs from its immutable receipt' })
    return assessment
  }).pipe(Effect.mapError(boundaryError('Assessment receipt verification failed')))
