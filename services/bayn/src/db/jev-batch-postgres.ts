import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from '../jev/batch'
import { JevBatchExpired, JevBatchStore, type JevBatchEvidence } from '../jev/batch-evaluation'
import { decodeJevEvaluationReceipt, decodeJevEvaluationRequest } from '../jev/evidence'
import {
  decodeJevResolution,
  makeJevResolution,
  JevResolutionStatus,
  type JevEvaluationEvidence,
} from '../jev/resolution'
import { reproduceJevTradingSignalBatchEvidence } from '../jev/trading-signals'
import { Sha256Schema, SymbolSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { withObservedStage } from '../telemetry'
import { readJevEvaluationEvidence } from './jev-evaluation-read'
import { recordReproducedJevObservation } from './candidate-observation-postgres'
import type { JevObservation } from '../jev/observation'

const StoredRow = Schema.Struct({ plan: Schema.Unknown, result: Schema.NullOr(Schema.Unknown) })
const StoredEvaluationRow = Schema.Struct({
  request_id: Sha256Schema,
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
})
const OneBatch = Schema.Tuple([Schema.Struct({ batch_id: Sha256Schema })])

export const makeJevBatchStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const persistError = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'jev-batch',
      message: 'Jev batch evidence could not be durably verified',
      cause,
    })
  const requireAutocommit = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* persistError('Jev batches must commit independently before inference or decision use')
  })

  const read = (input: string) =>
    Effect.gen(function* () {
      const batchId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(StoredRow),
        strictParseOptions,
      )(
        yield* sql`
        SELECT plan.payload AS plan, result.payload AS result
        FROM jev_batch_plans AS plan LEFT JOIN jev_batch_results AS result USING (batch_id)
        WHERE plan.batch_id = ${batchId}
      `,
      )
      const row = rows[0]
      if (row === undefined) return null
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(row.plan))
      if (plan.batchId !== batchId) return yield* persistError('Stored Jev batch identity differs')
      if (row.result === null) return { plan, result: null } satisfies JevBatchEvidence
      const result = yield* Effect.fromResult(decodeJevBatchResult(plan, row.result))
      const { evidence: evidenceByRequestId } = yield* readJevEvaluationEvidence(
        sql,
        result.candidates.flatMap((candidate) =>
          candidate.status === JevCandidateResultStatus.Excluded ? [] : [candidate.requestId],
        ),
      )
      for (const candidate of result.candidates) {
        if (candidate.status === JevCandidateResultStatus.Excluded) continue
        const evidence = evidenceByRequestId.get(candidate.requestId) ?? null
        if (candidate.status === JevCandidateResultStatus.Unattempted) {
          if (evidence !== null) return yield* persistError('A sealed unattempted candidate has a request claim')
        } else if (
          evidence?.resolution?.resolutionHash !== candidate.resolution.resolutionHash ||
          (candidate.receipt !== null && evidence.receipt?.receiptHash !== candidate.receipt.receiptHash)
        )
          return yield* persistError('Jev batch differs from its independently committed candidate evidence')
      }
      return { plan, result } satisfies JevBatchEvidence
    }).pipe(Effect.mapError(persistError))

  const begin = (input: JevBatchPlan, suppliedObservation: JevObservation) =>
    Effect.gen(function* () {
      yield* requireAutocommit
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(input))
      if ((yield* Effect.fromResult(canonicalHashV1Result(suppliedObservation))) !== plan.observationHash)
        return yield* persistError('Jev admission observation differs from its sealed plan')
      yield* Effect.annotateCurrentSpan({
        'bayn.jev.batch_id': plan.batchId,
        'bayn.cycle.id': plan.cycleId,
        'bayn.jev.observed_at': plan.observedAt,
        'bayn.jev.expires_at': plan.expiresAt,
      })
      const observations = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ payload: Schema.Unknown })),
        strictParseOptions,
      )(yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${plan.observationHash}`)
      const storedObservation = observations[0]
      const observation = storedObservation === undefined ? suppliedObservation : storedObservation.payload
      if ((yield* Effect.fromResult(canonicalHashV1Result(observation))) !== plan.observationHash)
        return yield* persistError('Jev batch observation bytes differ from their stored hash')
      // Decoding can retain source aliases. Keep the verified graph private while
      // admission awaits existing evidence and transactional source checks.
      const ownedObservation = yield* Effect.try(() => structuredClone(observation))
      const reproduced = yield* Effect.fromResult(reproduceJevTradingSignalBatchEvidence(ownedObservation, plan))
      const existing = yield* read(plan.batchId)
      if (existing !== null) {
        yield* Effect.annotateCurrentSpan('bayn.jev.admission.status', 'recorded')
        return { ...existing, dispatches: [] }
      }
      const checkWindow = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const checkedAt = utcInstantFromEpochMillis(now)
        yield* Effect.annotateCurrentSpan({
          'bayn.jev.admission.checked_at': checkedAt,
          'bayn.jev.admission.lag_ms': now - Date.parse(plan.observedAt),
        })
        if (now < Date.parse(plan.observedAt))
          return yield* persistError('Jev batch clock regressed before observation')
        if (now >= Date.parse(plan.expiresAt)) {
          yield* Effect.annotateCurrentSpan('bayn.jev.admission.status', 'expired')
          return yield* new JevBatchExpired({
            batchId: plan.batchId,
            cycleId: plan.cycleId,
            observedAt: plan.observedAt,
            expiresAt: plan.expiresAt,
            checkedAt,
          })
        }
        return checkedAt
      })
      yield* checkWindow
      const dispatches = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* recordReproducedJevObservation(sql, reproduced.observation)
          const checkedAt = yield* checkWindow
          yield* Effect.annotateCurrentSpan('bayn.jev.admission.status', 'new')
          if (plan.candidates.every((candidate) => candidate.status === JevCandidatePlanStatus.Excluded)) {
            const result = yield* Effect.fromResult(
              makeJevBatchResult(plan, {
                schemaVersion: 'bayn.jev-batch-result.v1',
                batchId: plan.batchId,
                completedAt: checkedAt,
                candidates: plan.candidates.map(({ symbol }) => ({
                  symbol,
                  status: JevCandidateResultStatus.Excluded,
                })),
              }),
            )
            // With no inference claims to wait for, admission can commit the plan and
            // final result together. RETURNING keeps a racing retry from rewriting an
            // existing plan or result, including unfinished plans from older workers.
            yield* sql`
          WITH admitted AS (
            INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
            VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})
            ON CONFLICT DO NOTHING
            RETURNING batch_id
          )
          INSERT INTO jev_batch_results (batch_id, result_hash, payload)
          SELECT admitted.batch_id, ${result.resultHash}, ${sql.json(result)} FROM admitted
        `
          } else {
            const inserted = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ batch_id: Sha256Schema })),
              strictParseOptions,
            )(
              yield* sql`
        INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
        VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})
        ON CONFLICT DO NOTHING RETURNING batch_id
      `,
            )
            if (inserted.length === 0) return []
            const requests = plan.candidates.flatMap((candidate) =>
              candidate.status === JevCandidatePlanStatus.Requested ? [candidate.request] : [],
            )
            yield* sql`INSERT INTO jev_evaluation_requests ${sql.insert(
              requests.map((request) => ({
                request_id: request.requestId,
                cycle_id: request.cycleId,
                authority_generation_hash: request.authorityGenerationHash,
                payload: sql.json(request),
              })),
            )}`
            return requests.map((request) => ({ request, claimedAt: checkedAt }))
          }
          return []
        }),
      )
      const saved = yield* read(plan.batchId)
      if (saved === null) return yield* persistError('Committed Jev batch plan is missing')
      return { ...saved, dispatches }
    }).pipe(
      Effect.mapError((cause) => (cause instanceof JevBatchExpired ? cause : persistError(cause))),
      withObservedStage('bayn.jev.batch-admission', { dependency: 'postgresql' }),
    )

  const recordResult = (plan: JevBatchPlan, result: JevBatchResult) =>
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ payload: Schema.Unknown })),
        strictParseOptions,
      )(
        yield* sql`INSERT INTO jev_batch_results (batch_id, result_hash, payload)
          VALUES (${plan.batchId}, ${result.resultHash}, ${sql.json(result)})
          ON CONFLICT (batch_id) DO NOTHING RETURNING payload`,
      )
      const row = rows[0]
      if (row !== undefined) {
        const recorded = yield* Effect.fromResult(decodeJevBatchResult(plan, row.payload))
        if (recorded.resultHash !== result.resultHash)
          return yield* persistError('Recorded Jev batch result differs from its submitted evidence')
        return { plan, result: recorded } satisfies JevBatchEvidence
      }
      const saved = yield* read(plan.batchId)
      if (saved === null || saved.result === null)
        return yield* persistError('A competing Jev batch result did not commit')
      return saved
    })

  const finish = (input: string) =>
    Effect.gen(function* () {
      yield* requireAutocommit
      const batchId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      // An all-excluded admission or single-request receipt may have committed the
      // final batch atomically. Its immutable result needs no new durability wait.
      const committed = yield* read(batchId)
      if (committed !== null && committed.result !== null) return committed
      if (committed !== null) {
        const requests = committed.plan.candidates.flatMap((candidate) =>
          candidate.status === JevCandidatePlanStatus.Requested ? [candidate.request.requestId] : [],
        )
        const { evidence, observationHashes } = yield* readJevEvaluationEvidence(sql, requests)
        const candidates: JevBatchResult['candidates'][number][] = []
        for (const candidate of committed.plan.candidates) {
          if (candidate.status === JevCandidatePlanStatus.Excluded) {
            candidates.push({ symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded })
            continue
          }
          const recorded = evidence.get(candidate.request.requestId)
          if (recorded === undefined || recorded.resolution === null) break
          candidates.push({
            symbol: candidate.symbol,
            status: JevCandidateResultStatus.Resolved,
            requestId: candidate.request.requestId,
            receipt: recorded.receipt,
            resolution: recorded.resolution,
          })
        }
        if (requests.length > 0 && candidates.length === committed.plan.candidates.length) {
          if (!observationHashes.includes(committed.plan.observationHash))
            return yield* persistError('Jev batch observation is not among its verified candidate sources')
          const now = yield* Clock.currentTimeMillis
          if (now < Date.parse(committed.plan.observedAt))
            return yield* persistError('Jev batch clock regressed before observation')
          const result = yield* Effect.fromResult(
            makeJevBatchResult(committed.plan, {
              schemaVersion: 'bayn.jev-batch-result.v1',
              batchId,
              completedAt: utcInstantFromEpochMillis(now),
              candidates,
            }),
          )
          // The plan, observation, requests and resolutions are already committed
          // immutable evidence. Only unresolved claims require recovery locks.
          return yield* recordResult(committed.plan, result)
        }
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(
            OneBatch,
            strictParseOptions,
          )(
            yield* sql`
          SELECT batch_id FROM jev_batch_plans WHERE batch_id = ${batchId} FOR NO KEY UPDATE
        `,
          )
          const saved = yield* read(batchId)
          if (saved === null) return yield* persistError('Jev batch plan is missing during finalization')
          if (saved.result !== null) return saved
          const observations = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]),
            strictParseOptions,
          )(
            yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${saved.plan.observationHash}`,
          )
          if ((yield* Effect.fromResult(canonicalHashV1Result(observations[0].payload))) !== saved.plan.observationHash)
            return yield* persistError('Jev batch observation bytes differ from their stored hash')
          const requested = saved.plan.candidates.flatMap((candidate) =>
            candidate.status === JevCandidatePlanStatus.Requested
              ? [{ requestId: candidate.request.requestId, symbol: candidate.symbol }]
              : [],
          )
          const requestIds = requested.map((candidate) => candidate.requestId)
          if (requested.length > 0) {
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  content_hash: Sha256Schema,
                  payload: Schema.Unknown,
                  matching_symbols: Schema.Array(SymbolSchema),
                }),
              ),
              strictParseOptions,
            )(
              yield* sql`
                SELECT observation.content_hash, observation.payload,
                  ARRAY(
                    SELECT candidate.symbol
                    FROM jsonb_array_elements_text(observation.payload->'manifest'->'candidateSymbols') AS candidate(symbol)
                    WHERE candidate.symbol IN ${sql.in(requested.map((candidate) => candidate.symbol))}
                      AND NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements(observation.payload->'manifest'->'candidateExclusions') AS excluded
                        WHERE excluded->>'symbol' = candidate.symbol
                      )
                  ) AS matching_symbols
                FROM intraday_candidate_observations AS observation
                WHERE observation.cycle_id = ${saved.plan.cycleId}
                  AND observation.observed_at = ${saved.plan.observedAt}::timestamptz
                  AND observation.payload->>'authorityGenerationHash' = ${saved.plan.authorityGenerationHash}
                  AND observation.payload->>'observedAt' = ${saved.plan.observedAt}
                  AND observation.payload->'manifest'->>'observedAt' = ${saved.plan.observedAt}
                  AND observation.payload->'manifest'->>'snapshotId' = ${saved.plan.snapshotId}
              `,
            )
            const matched = new Set<string>()
            for (const row of rows) {
              if (row.matching_symbols.length === 0) continue
              if ((yield* Effect.fromResult(canonicalHashV1Result(row.payload))) !== row.content_hash)
                return yield* persistError('Jev candidate observation content differs from its committed identity')
              for (const symbol of row.matching_symbols) matched.add(symbol)
            }
            if (requested.some((candidate) => !matched.has(candidate.symbol)))
              return yield* persistError('Jev batch request has no matching persisted candidate observation')
          }
          const rows =
            requestIds.length === 0
              ? []
              : yield* Effect.gen(function* () {
                  yield* sql`
                    SELECT request_id FROM jev_evaluation_requests
                    WHERE request_id IN ${sql.in(requestIds)} FOR UPDATE
                  `
                  return yield* Schema.decodeUnknownEffect(
                    Schema.Array(StoredEvaluationRow),
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
                })
          const evidenceByRequestId = new Map<string, JevEvaluationEvidence>()
          for (const row of rows) {
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
            if (request.requestId !== row.request_id) return yield* persistError('Stored Jev request identity differs')
            const receipt =
              row.receipt === null ? null : yield* Effect.fromResult(decodeJevEvaluationReceipt(request, row.receipt))
            const resolution =
              row.resolution === null
                ? null
                : yield* Effect.fromResult(decodeJevResolution(request, receipt, row.resolution))
            if (receipt !== null && resolution === null)
              return yield* persistError('A Jev receipt has no committed resolution')
            evidenceByRequestId.set(request.requestId, { request, receipt, resolution })
          }
          const pending = []
          for (const planned of saved.plan.candidates) {
            if (planned.status === JevCandidatePlanStatus.Excluded) continue
            const evidence = evidenceByRequestId.get(planned.request.requestId) ?? null
            pending.push({ planned, evidence })
          }
          const now = yield* Clock.currentTimeMillis
          if (now < Date.parse(saved.plan.observedAt))
            return yield* persistError('Jev batch clock regressed before observation')
          const expired = now >= Date.parse(saved.plan.expiresAt)
          if (!expired && pending.some(({ evidence }) => evidence?.resolution == null)) return saved
          const completedAt = utcInstantFromEpochMillis(now)
          const candidates: JevBatchResult['candidates'][number][] = []
          for (const planned of saved.plan.candidates) {
            if (planned.status === JevCandidatePlanStatus.Excluded) {
              candidates.push({ symbol: planned.symbol, status: JevCandidateResultStatus.Excluded })
              continue
            }
            const found = pending.find((entry) => entry.planned.symbol === planned.symbol)
            if (found === undefined) return yield* persistError('Jev finalization lost a planned candidate')
            if (found.evidence === null) {
              candidates.push({
                symbol: planned.symbol,
                status: JevCandidateResultStatus.Unattempted,
                requestId: planned.request.requestId,
              })
              continue
            }
            let resolution = found.evidence.resolution
            if (resolution === null) {
              resolution = yield* Effect.fromResult(
                makeJevResolution(planned.request, found.evidence.receipt, {
                  schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                  requestId: planned.request.requestId,
                  status: JevResolutionStatus.Abandoned,
                  abandonedAt: completedAt,
                }),
              )
              yield* sql`INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
              VALUES (${resolution.requestId}, ${resolution.resolutionHash}, ${sql.json(resolution)})`
            }
            candidates.push({
              symbol: planned.symbol,
              status: JevCandidateResultStatus.Resolved,
              requestId: planned.request.requestId,
              receipt: found.evidence.receipt,
              resolution,
            })
          }
          const result = yield* Effect.fromResult(
            makeJevBatchResult(saved.plan, {
              schemaVersion: 'bayn.jev-batch-result.v1',
              batchId,
              completedAt,
              candidates,
            }),
          )
          return yield* recordResult(saved.plan, result)
        }),
      )
    }).pipe(Effect.mapError(persistError))

  const pending = (cycleId: string, authorityGenerationHash?: string) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(Sha256Schema)(cycleId)
      if (authorityGenerationHash !== undefined)
        yield* Schema.decodeUnknownEffect(Sha256Schema)(authorityGenerationHash)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ batch_id: Sha256Schema })),
        strictParseOptions,
      )(
        yield* sql`
          SELECT plan.batch_id FROM jev_batch_plans AS plan
          LEFT JOIN jev_batch_results AS result USING (batch_id)
          WHERE plan.cycle_id = ${cycleId}
            AND ${authorityGenerationHash === undefined ? sql`true` : sql`plan.authority_generation_hash = ${authorityGenerationHash}`}
            AND result.batch_id IS NULL
          ORDER BY plan.payload->>'observedAt', plan.batch_id COLLATE "C"
        `,
      )
      return rows.map((row) => row.batch_id)
    }).pipe(Effect.mapError(persistError))

  return { read, pending, begin, finish } satisfies typeof JevBatchStore.Service
})

export const JevBatchStoreLive = Layer.effect(JevBatchStore, makeJevBatchStore)
