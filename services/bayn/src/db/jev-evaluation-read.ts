import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { decodeJevEvaluationReceipt, decodeJevEvaluationRequest, type JevEvaluationRequest } from '../jev/evidence'
import { decodeJevResolution, type JevEvaluationEvidence } from '../jev/resolution'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { withObservedStage } from '../telemetry'

const StoredRow = Schema.Struct({
  request_id: Sha256Schema,
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
})
const ObservationRow = Schema.Struct({
  content_hash: Sha256Schema,
  payload: Schema.Unknown,
  matching_request_ids: Schema.Array(Sha256Schema),
})

const jevEvaluationReadError = (cause: unknown) =>
  operationalError({
    component: 'database',
    operation: 'jev-evaluation',
    message: 'Jev evaluation evidence could not be durably verified',
    cause,
  })

export const requireJevCandidateObservations = (sql: PgClient.PgClient, requests: readonly JevEvaluationRequest[]) =>
  Effect.gen(function* () {
    if (requests.length === 0) return []
    const requested = requests.map((request) => ({
      request_id: request.requestId,
      cycle_id: request.cycleId,
      observed_at: request.observedAt,
      authority_generation_hash: request.authorityGenerationHash,
      snapshot_id: request.snapshotId,
      symbol: request.symbol,
    }))
    // Bind the decoded request identities rather than rereading mutable query
    // inputs. Group by the observation's primary key so shared source bytes cross
    // the database boundary once, with their exact matching requests retained.
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(ObservationRow),
      strictParseOptions,
    )(
      yield* sql`
        SELECT observation.content_hash, observation.payload,
          array_agg(requested.request_id ORDER BY requested.request_id COLLATE "C") AS matching_request_ids
        FROM jsonb_to_recordset(${sql.json(requested)}::jsonb) AS requested(
          request_id text, cycle_id text, observed_at text,
          authority_generation_hash text, snapshot_id text, symbol text
        )
        JOIN intraday_candidate_observations AS observation
          ON observation.cycle_id = requested.cycle_id
          AND observation.observed_at = requested.observed_at::timestamptz
          AND observation.payload->>'authorityGenerationHash' = requested.authority_generation_hash
          AND observation.payload->>'observedAt' = requested.observed_at
          AND observation.payload->'manifest'->>'observedAt' = requested.observed_at
          AND observation.payload->'manifest'->>'snapshotId' = requested.snapshot_id
          AND observation.payload->'manifest'->'candidateSymbols' ? requested.symbol
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(observation.payload->'manifest'->'candidateExclusions') AS excluded
            WHERE excluded->>'symbol' = requested.symbol
          )
        GROUP BY observation.content_hash
        ORDER BY observation.content_hash COLLATE "C"
      `,
    )
    const matched = new Set<string>()
    for (const row of rows) {
      if ((yield* Effect.fromResult(canonicalHashV1Result(row.payload))) !== row.content_hash)
        return yield* jevEvaluationReadError('Jev candidate observation content differs from its committed identity')
      for (const requestId of row.matching_request_ids) matched.add(requestId)
    }
    if (requests.some((request) => !matched.has(request.requestId)))
      return yield* jevEvaluationReadError(
        'Jev request has no matching persisted candidate observation for its cycle, generation, snapshot, symbol and time',
      )
    return rows
  }).pipe(withObservedStage('bayn.jev.observation-integrity', { dependency: 'postgresql' }))

export const readJevEvaluationEvidence = (sql: PgClient.PgClient, input: readonly string[]) =>
  Effect.gen(function* () {
    const requestIds = [
      ...new Set(yield* Schema.decodeUnknownEffect(Schema.Array(Sha256Schema), strictParseOptions)(input)),
    ]
    const evidence = new Map<string, JevEvaluationEvidence>()
    if (requestIds.length === 0) return evidence
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(StoredRow),
      strictParseOptions,
    )(
      yield* sql`
        SELECT request.request_id, request.payload AS request, receipt.payload AS receipt,
          resolution.payload AS resolution
        FROM jev_evaluation_requests AS request
        LEFT JOIN jev_evaluation_receipts AS receipt USING (request_id)
        LEFT JOIN jev_evaluation_resolutions AS resolution USING (request_id)
        WHERE request.request_id IN ${sql.in(requestIds)}
      `,
    )
    const decoded = []
    for (const row of rows) {
      const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
      if (request.requestId !== row.request_id)
        return yield* jevEvaluationReadError('Stored Jev request identity differs')
      decoded.push({ row, request })
    }
    yield* requireJevCandidateObservations(
      sql,
      decoded.map(({ request }) => request),
    )
    for (const { row, request } of decoded) {
      const receipt =
        row.receipt === null ? null : yield* Effect.fromResult(decodeJevEvaluationReceipt(request, row.receipt))
      const resolution =
        row.resolution === null ? null : yield* Effect.fromResult(decodeJevResolution(request, receipt, row.resolution))
      if (receipt !== null && resolution === null)
        return yield* jevEvaluationReadError('A Jev receipt has no committed resolution')
      evidence.set(request.requestId, { request, receipt, resolution })
    }
    return evidence
  }).pipe(Effect.mapError(jevEvaluationReadError))
