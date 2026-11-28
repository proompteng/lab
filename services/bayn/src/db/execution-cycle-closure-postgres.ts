import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Result, Schema } from 'effect'

import { executionCloseRecoveryExpiry, isContinuousMarket, regularEquitySessions } from '../market-hours'
import { WriterFence } from '../execution/writer-fence'
import { canonicalHashV1Result, canonicalJsonEqualV1 } from '../hash'
import { currentUtcInstant } from '../time'
import { verifyJevPortfolioSources } from './jev-position-postgres'
import { deriveProtectionCloseBasis, withCurrentProtectionReleaseProof } from './protection-release'
import {
  ExecutionCycleClosureStore,
  ExecutionCycleClosureStoreError,
  decodeExecutionCycleClosureResult,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from './execution-cycle-closure'

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1)))

const storeError = (
  operation: ExecutionCycleClosureStoreError['operation'],
  failure: ExecutionCycleClosureStoreError['failure'],
  message: string,
  cause?: unknown,
): ExecutionCycleClosureStoreError => new ExecutionCycleClosureStoreError({ operation, failure, message, cause })

const readByCycleId = (
  sql: PgClient.PgClient,
  cycleId: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_closures
    WHERE cycle_id = ${cycleId}
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('read', 'decode', 'execution closure row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('read', 'decode', 'execution closure document failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('read', 'query', 'execution closure read failed', cause),
    ),
  )

const readLatestReplanByCycleId = (
  sql: PgClient.PgClient,
  cycleId: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_close_replans
    WHERE cycle_id = ${cycleId}
    ORDER BY created_at DESC, content_hash COLLATE "C" DESC
    LIMIT 1
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('read-replan', 'decode', 'execution close replan row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('read-replan', 'decode', 'execution close replan failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('read-replan', 'query', 'execution close replan read failed', cause),
    ),
  )

const readReplanByHash = (
  sql: PgClient.PgClient,
  cycleId: string,
  contentHash: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_close_replans
    WHERE cycle_id = ${cycleId}
      AND content_hash = ${contentHash}
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('bind-replan', 'decode', 'execution close replan row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('bind-replan', 'decode', 'execution close replan failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('bind-replan', 'query', 'execution close replan read failed', cause),
    ),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  const verifyExit = (closure: ExecutionCycleClosure, original?: ExecutionCycleClosure) =>
    Effect.gen(function* () {
      const target = closure.document.strategyDecision
      if (target?.schemaVersion !== 'bayn.jev-exit-target.v5') {
        if (original?.document.strategyDecision?.schemaVersion === 'bayn.jev-exit-target.v5')
          return yield* storeError('bind-replan', 'invariant', 'A Jev close replan cannot discard its exit evidence')
        return
      }
      const binding = closure.document.bindings
      const planner = closure.document.plannerInput
      const release = planner?.protectionClose
      if (planner !== undefined && release !== undefined) {
        const current = yield* withCurrentProtectionReleaseProof(
          { proofId: release.proofId, accountId: binding.accountId, cycleId: closure.cycleId },
          planner.maximumInputAgeMs,
          (evidence, trigger) => {
            const proven = deriveProtectionCloseBasis(release.proofId, evidence)
            return Effect.succeed(
              Result.isSuccess(proven) &&
                evidence.entryDecisionHash === closure.entryDecisionHash &&
                canonicalJsonEqualV1(proven.success, release) &&
                canonicalJsonEqualV1(trigger, target),
            )
          },
        ).pipe(Effect.provideService(PgClient.PgClient, sql), Effect.provideService(WriterFence, fence))
        if (original !== undefined || current !== true)
          return yield* storeError(
            'bind',
            'invariant',
            'Jev closure requires the current proof of its own cancellation',
          )
      }
      yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
        yield* sql`
      SELECT EXISTS (
        SELECT 1 FROM reconciliations WHERE reconciliation_id = ${binding.reconciliationId}
          AND account_id = ${binding.accountId} AND expected_hash = ${binding.planningBrokerStateHash}
          AND observed_hash = ${binding.planningBrokerStateHash} AND content_hash = ${binding.reconciliationHash}
          AND status = 'EXACT' AND discrepancies = '[]'::jsonb AND reconciled_at <= ${closure.createdAt}::timestamptz
      ) AS matches
    `,
      )
      if (original !== undefined) {
        const first = yield* Effect.fromResult(canonicalHashV1Result(original.document.strategyDecision))
        const next = yield* Effect.fromResult(canonicalHashV1Result(target))
        const prior = closure.document.replanGenerationHash
        const latest = yield* readLatestReplanByCycleId(sql, closure.cycleId)
        const predecessor = Option.getOrElse(latest, () => original)
        const originalSession = original.document.executionSession
        const regularCloseAt =
          originalSession === undefined || isContinuousMarket(originalSession.calendar)
            ? null
            : (regularEquitySessions(originalSession.calendar).find(
                ({ date }) => date === originalSession.executionSession.date,
              )?.closeAt ?? null)
        const [recovery] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ allowed: Schema.Boolean })]),
        )(
          yield* sql`
            SELECT EXISTS (
              SELECT 1 FROM autonomous_cycles WHERE cycle_id = ${closure.cycleId}
                AND LEAST(execution_close_at, ${regularCloseAt}::timestamptz) <= ${closure.createdAt}::timestamptz
            ) AS allowed
          `,
        )
        const recoveryDeadline =
          originalSession === undefined
            ? null
            : executionCloseRecoveryExpiry(originalSession.calendar, closure.createdAt)
        const boundedRecoveryLease =
          recovery.allowed &&
          closure.expiresAt > closure.createdAt &&
          recoveryDeadline !== null &&
          closure.expiresAt <= recoveryDeadline
        if (
          first !== next ||
          closure.entryDecisionHash !== original.entryDecisionHash ||
          (closure.expiresAt !== original.expiresAt && !boundedRecoveryLease) ||
          prior !== predecessor.contentHash ||
          closure.createdAt <= predecessor.createdAt
        )
          return yield* storeError(
            'bind-replan',
            'invariant',
            'Jev residual close must preserve its committed trigger and exact predecessor',
          )
        return
      }
      const now = yield* currentUtcInstant
      if (
        closure.document.replanGenerationHash !== undefined ||
        now < closure.createdAt ||
        now >= target.commitDeadlineAt
      )
        return yield* storeError('bind', 'invariant', 'The initial Jev exit evidence expired before durable commitment')
      yield* verifyJevPortfolioSources(sql, closure.cycleId, target.evidence.portfolio)
    })
  const store: ExecutionCycleClosureStoreShape = {
    stageProtectionClose: (closure) =>
      fence
        .transaction(
          Effect.gen(function* () {
            const release = closure.document.plannerInput?.protectionClose
            if (release === undefined || closure.document.strategyDecision?.schemaVersion !== 'bayn.jev-exit-target.v5')
              return false
            if (Option.isSome(yield* readByCycleId(sql, closure.cycleId))) return false
            yield* verifyExit(closure)
            yield* sql`
            INSERT INTO protection_release_close_plans(proof_id, cycle_id, document)
            VALUES (${release.proofId}, ${closure.cycleId}, ${sql.json(closure)})
            ON CONFLICT (proof_id) DO NOTHING
          `
            const [row] = yield* sql`SELECT document = ${sql.json(closure)} AS matches
            FROM protection_release_close_plans WHERE proof_id = ${release.proofId}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ matches: Schema.Boolean })))),
            )
            return row?.matches === true
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionCycleClosureStoreError
              ? cause
              : storeError('bind', 'query', 'protection close plan staging failed', cause),
          ),
        ),
    read: (cycleId) => readByCycleId(sql, cycleId),
    readLatestReplan: (cycleId) => readLatestReplanByCycleId(sql, cycleId),
    containsIntent: (intentId) =>
      sql<{ readonly contains: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM intents AS target
          JOIN autonomous_cycle_paper_closures AS closure ON closure.cycle_id = target.cycle_id,
          LATERAL jsonb_array_elements_text(closure.document #> '{document,orderedIntentIds}') AS intent(value)
          WHERE target.intent_id = ${intentId} AND intent.value = target.intent_id
        ) OR EXISTS (
          SELECT 1
          FROM intents AS target
          JOIN autonomous_cycle_paper_close_replans AS replan ON replan.cycle_id = target.cycle_id,
          LATERAL jsonb_array_elements_text(replan.document #> '{document,orderedIntentIds}') AS intent(value)
          WHERE target.intent_id = ${intentId} AND intent.value = target.intent_id
        ) AS contains
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          return row === undefined
            ? Effect.fail(storeError('contains-intent', 'invariant', 'execution closure intent query returned no row'))
            : Effect.succeed(row.contains)
        }),
        Effect.mapError((cause) =>
          cause instanceof ExecutionCycleClosureStoreError
            ? cause
            : storeError('contains-intent', 'query', 'execution closure intent lookup failed', cause),
        ),
      ),
    bindReplan: (closure) =>
      fence
        .transaction(
          Effect.gen(function* () {
            const replay = yield* readReplanByHash(sql, closure.cycleId, closure.contentHash)
            if (Option.isSome(replay)) return replay.value
            const original = yield* readByCycleId(sql, closure.cycleId)
            if (
              closure.document.strategyDecision?.schemaVersion === 'bayn.jev-exit-target.v5' &&
              Option.isNone(original)
            )
              return yield* storeError(
                'bind-replan',
                'invariant',
                'Jev residual close requires an initial committed exit',
              )
            yield* verifyExit(closure, Option.getOrUndefined(original))
            yield* sql`
            INSERT INTO autonomous_cycle_paper_close_replans (
              content_hash,
              cycle_id,
              document,
              created_at,
              expires_at
            ) VALUES (
              ${closure.contentHash},
              ${closure.cycleId},
              ${sql.json(closure)},
              ${closure.createdAt},
              ${closure.expiresAt}
            )
            ON CONFLICT (content_hash) DO NOTHING
          `
            const stored = yield* readReplanByHash(sql, closure.cycleId, closure.contentHash)
            if (Option.isNone(stored)) {
              return yield* storeError(
                'bind-replan',
                'invariant',
                'execution close replan disappeared after its immutable bind',
              )
            }
            if (stored.value.contentHash !== closure.contentHash) {
              return yield* storeError(
                'bind-replan',
                'conflict',
                'execution close replan identity was reused with different content',
              )
            }
            return stored.value
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionCycleClosureStoreError
              ? cause
              : storeError('bind-replan', 'query', 'execution close replan bind failed', cause),
          ),
        ),
    bind: (closure) =>
      fence
        .transaction(
          Effect.gen(function* () {
            const existing = yield* readByCycleId(sql, closure.cycleId)
            if (Option.isSome(existing)) {
              if (existing.value.contentHash !== closure.contentHash)
                return yield* storeError(
                  'bind',
                  'conflict',
                  'Execution closure already has different immutable content',
                )
              return existing.value
            }
            yield* verifyExit(closure)
            const protection = closure.document.plannerInput?.protectionClose
            if (protection !== undefined) {
              yield* sql`SELECT EXISTS(
                SELECT 1 FROM protection_release_close_plans AS plan
                WHERE plan.proof_id = ${protection.proofId} AND plan.document = ${sql.json(closure)}
                  AND system_evidence_source_committed(plan.xmin)
              ) AS matches`.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })])),
                ),
              )
            }
            yield* sql`
            INSERT INTO autonomous_cycle_paper_closures (
              cycle_id,
              document,
              created_at,
              expires_at
            ) VALUES (
              ${closure.cycleId},
              ${sql.json(closure)},
              ${closure.createdAt},
              ${closure.expiresAt}
            )
            ON CONFLICT (cycle_id) DO NOTHING
          `
            const stored = yield* readByCycleId(sql, closure.cycleId)
            if (Option.isNone(stored)) {
              return yield* storeError('bind', 'invariant', 'execution closure disappeared after its immutable bind')
            }
            if (stored.value.contentHash !== closure.contentHash) {
              return yield* storeError(
                'bind',
                'conflict',
                'execution closure identity was reused with different immutable content',
              )
            }
            return stored.value
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionCycleClosureStoreError
              ? cause
              : storeError('bind', 'query', 'execution closure bind failed', cause),
          ),
        ),
  }
  return store
})

export const ExecutionCycleClosureStoreLive = Layer.effect(ExecutionCycleClosureStore, makeStore)
