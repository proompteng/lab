import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevOutcome,
  type JevEvaluationRequest,
} from '../jev/evidence'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { decodeJevResolution, type JevEvaluationEvidence } from '../jev/resolution'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { withObservedStage } from '../telemetry'

const StoredRow = Schema.Struct({
  request_id: Sha256Schema,
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  handoff: Schema.NullOr(Schema.Unknown),
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
    const scopes = [
      ...new Map(requests.map((request) => [`${request.cycleId}/${request.observedAt}`, request])).values(),
    ]
    // Expose the exact indexed scopes independently of recordset estimates so
    // PostgreSQL can bound the source lookup before checking request membership.
    const scope = sql.or(
      scopes.map(
        (request) => sql`observation.cycle_id = ${request.cycleId}
          AND observation.observed_at = ${request.observedAt}::timestamptz`,
      ),
    )
    // Parse shared source metadata once instead of detoasting its JSON for every candidate.
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(ObservationRow),
      strictParseOptions,
    )(
      yield* sql`
        WITH scoped_observations AS MATERIALIZED (
          SELECT observation.content_hash, observation.cycle_id, observation.observed_at,
            observation.payload->>'authorityGenerationHash' AS authority_generation_hash,
            observation.payload->>'observedAt' AS payload_observed_at,
            observation.payload->'manifest'->>'observedAt' AS manifest_observed_at,
            observation.payload->'manifest'->>'snapshotId' AS snapshot_id,
            observation.payload->'manifest'->'candidateSymbols' AS candidate_symbols,
            observation.payload->'manifest'->'candidateExclusions' AS candidate_exclusions
          FROM intraday_candidate_observations AS observation
          WHERE ${scope}
        ), matched AS (
          SELECT observation.content_hash,
            array_agg(requested.request_id ORDER BY requested.request_id COLLATE "C") AS matching_request_ids
          FROM jsonb_to_recordset(${sql.json(requested)}::jsonb) AS requested(
            request_id text, cycle_id text, observed_at text,
            authority_generation_hash text, snapshot_id text, symbol text
          )
          JOIN scoped_observations AS observation
            ON observation.cycle_id = requested.cycle_id
            AND observation.observed_at = requested.observed_at::timestamptz
            AND observation.authority_generation_hash = requested.authority_generation_hash
            AND observation.payload_observed_at = requested.observed_at
            AND observation.manifest_observed_at = requested.observed_at
            AND observation.snapshot_id = requested.snapshot_id
            AND observation.candidate_symbols ? requested.symbol
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(observation.candidate_exclusions) AS excluded
              WHERE excluded->>'symbol' = requested.symbol
            )
          GROUP BY observation.content_hash
        )
        SELECT observation.content_hash, observation.payload, matched.matching_request_ids
        FROM matched JOIN intraday_candidate_observations AS observation USING (content_hash)
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
    const observationHashes: string[] = []
    if (requestIds.length === 0) return { evidence, observationHashes }
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(StoredRow),
      strictParseOptions,
    )(
      yield* sql`
        SELECT request.request_id, request.payload AS request, receipt.payload AS receipt, handoff.payload AS handoff,
          resolution.payload AS resolution
        FROM jev_evaluation_requests AS request
        LEFT JOIN jev_evaluation_receipts AS receipt USING (request_id)
        LEFT JOIN jev_inference_handoffs AS handoff USING (request_id)
        LEFT JOIN jev_evaluation_resolutions AS resolution USING (request_id)
        WHERE request.request_id IN ${sql.in(requestIds)}
      `,
    )
    const decoded = []
    for (const row of rows) {
      // Reproduction is synchronous CPU work. Let other connections service their
      // sockets between candidates without changing any database/deadline budget.
      yield* Effect.yieldNow
      const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
      if (request.requestId !== row.request_id)
        return yield* jevEvaluationReadError('Stored Jev request identity differs')
      decoded.push({ row, request })
    }
    const observations = yield* requireJevCandidateObservations(
      sql,
      decoded.map(({ request }) => request),
    )
    observationHashes.push(...observations.map((observation) => observation.content_hash))
    for (const { row, request } of decoded) {
      yield* Effect.yieldNow
      const receipt =
        row.receipt === null ? null : yield* Effect.fromResult(decodeJevEvaluationReceipt(request, row.receipt))
      if (receipt?.outcome.status === JevOutcome.Completed) {
        // Receipt decoding already reproduces its entire handoff. Require the independent stored
        // copy to contain exactly those verified bytes instead of reproducing the same source twice.
        if (
          row.handoff === null ||
          (yield* Effect.fromResult(canonicalHashV1Result(row.handoff))) !==
            (yield* Effect.fromResult(canonicalHashV1Result(receipt.outcome.completion.handoff)))
        )
          return yield* jevEvaluationReadError('Entry receipt differs from its committed provider handoff')
      } else if (row.handoff !== null)
        yield* Effect.fromResult(
          decodeEntryHandoff(
            {
              requestId: request.requestId,
              input: request.request,
              observedAt: request.observedAt,
              expiresAt: request.expiresAt,
            },
            row.handoff,
          ),
        )
      const resolution =
        row.resolution === null ? null : yield* Effect.fromResult(decodeJevResolution(request, receipt, row.resolution))
      if (receipt !== null && resolution === null)
        return yield* jevEvaluationReadError('A Jev receipt has no committed resolution')
      evidence.set(request.requestId, { request, receipt, resolution })
    }
    return { evidence, observationHashes }
  }).pipe(Effect.mapError(jevEvaluationReadError))
