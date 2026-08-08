import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'
import type { Fragment } from 'effect/unstable/sql/Statement'

import { IntentState, RiskOutcome, TerminalOutcome, type Intent, type RiskDecision } from '../contracts'
import { Sha256Schema as Sha256, strictParseOptions } from '../../schemas'
import { WriterFence, WriterFenceError } from '../writer-fence'
import {
  IntentStore,
  IntentStoreError,
  classifyExistingCommit,
  decideIntentInsert,
  decideIntentTransition,
  decideRiskCommit,
  decodeAuthorityBindingRows,
  decodeStoredIntentRows,
  validateCommitIdentity,
  validateCurrentAuthority,
  validateCurrentClosingAuthority,
  type AuthorityBindingFailure,
  type AuthorityBindingRow,
  type CommitMaterialFailure,
  type ExistingCommitDisposition,
  type ExistingCommitFailure,
  type IntentReceipt,
  type IntentStoreService,
  type PreparedCommit,
  type StoredIntent,
  type StoredRowsFailure,
  type WriteDispositionFailure,
} from './domain'

const decodeIntentIdResult = Schema.decodeUnknownResult(Sha256, strictParseOptions)

const selectRows = (sql: PgClient.PgClient, predicate: Fragment) => sql`
  SELECT
    intent.schema_version,
    intent.intent_id,
    intent.risk_decision_id,
    intent.authority_generation_hash,
    intent.strategy_name,
    intent.cycle_id,
    intent.decision_hash,
    intent.policy_hash,
    intent.account_id,
    intent.client_order_id,
    intent.symbol,
    intent.side,
    intent.order_type,
    intent.time_in_force,
    intent.quantity_micros::text,
    intent.notional_limit_micros::text,
    intent.replan_generation_hash,
    intent.state,
    intent.terminal_outcome,
    intent.state_version::integer,
    to_char(intent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(intent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
    decision.decision_id,
    decision.input_hash,
    decision.policy_hash AS decision_policy_hash,
    decision.outcome,
    decision.reason_codes,
    to_char(decision.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
    to_char(decision.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
  FROM intents AS intent
  LEFT JOIN risk_decisions AS decision ON decision.intent_id = intent.intent_id
  WHERE ${predicate}
`

const storeError = (
  failure: IntentStoreError['failure'],
  operation: IntentStoreError['operation'],
  message: string,
  cause?: unknown,
) => new IntentStoreError({ failure, operation, message, cause })

const renderCommitMaterialFailure = (failure: CommitMaterialFailure): string => {
  switch (failure._tag) {
    case 'IntentDecodeFailed':
      return 'planned intent failed schema decoding'
    case 'RiskDecisionDecodeFailed':
      return 'risk decision failed schema decoding'
    case 'ConstructedIntentDecodeFailed':
      return `constructed ${failure.intentKind} intent failed schema decoding`
    case 'CanonicalizationFailed':
      return `canonical ${failure.material._tag} hashing failed`
    case 'IntentIdentityMismatch':
      return `planned intent ${failure.intentId} does not match its deterministic identity`
    case 'RiskDecisionIdentityMismatch':
      return `risk decision ${failure.decisionId} does not match deterministic identity ${failure.expectedDecisionId}`
    case 'RiskDecisionBindingMismatch':
      return `risk decision is not bound to intent ${failure.intentId} and policy ${failure.policyHash}`
  }
}

const commitMaterialError = (failure: CommitMaterialFailure): IntentStoreError => {
  const kind =
    failure._tag === 'IntentDecodeFailed' ||
    failure._tag === 'RiskDecisionDecodeFailed' ||
    failure._tag === 'ConstructedIntentDecodeFailed'
      ? 'decode'
      : 'invariant'
  return storeError(kind, 'commit', renderCommitMaterialFailure(failure), failure)
}

const existingCommitError = (failure: ExistingCommitFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'CanonicalizationFailed':
      return storeError('invariant', 'commit', `canonical ${failure.material._tag} hashing failed`, failure)
    case 'MultipleIntentConflicts':
      return storeError(
        'conflict',
        'commit',
        `intent uniqueness boundary resolved to ${failure.count} records`,
        failure,
      )
    case 'ImmutableIntentMismatch':
      return storeError(
        'conflict',
        'commit',
        `deterministic intent identity ${failure.intentId} was reused with different content`,
        failure,
      )
    case 'StoredDecisionMismatch':
      return storeError(
        'conflict',
        'commit',
        `stored intent ${failure.intentId} diverges from decision ${failure.decisionId}`,
        failure,
      )
    case 'IncompleteIntentState':
      return storeError('invariant', 'commit', `intent ${failure.intentId} without a decision is not PLANNED`, failure)
  }
}

const authorityError = (failure: AuthorityBindingFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'AuthorityMissing':
      return storeError('invariant', 'commit', 'PAPER authority is not initialized', failure)
    case 'MultipleAuthorityRows':
      return storeError('invariant', 'commit', 'PAPER authority singleton returned multiple rows', failure)
    case 'MaximumAuthorityNotPaper':
      return storeError('invariant', 'commit', 'GitOps maximum authority is not PAPER', failure)
    case 'EffectiveAuthorityNotPaper':
      return storeError('invariant', 'commit', 'effective authority is not PAPER', failure)
    case 'AuthorityKillNotClear':
      return storeError('invariant', 'commit', 'PAPER authority kill is not CLEAR', failure)
    case 'AuthorityGenerationMismatch':
      return storeError('invariant', 'commit', 'intent does not bind the active PAPER generation', failure)
    case 'AuthorityGenerationHistoryMismatch':
      return storeError(
        'invariant',
        'commit',
        `active PAPER generation ${failure.generationHash} has mismatched ${failure.field}`,
        failure,
      )
    case 'ClosingIntentMustSell':
      return storeError('invariant', 'commit', 'a PAPER close intent must be sell-only', failure)
  }
}

const writeDispositionError = (failure: WriteDispositionFailure): IntentStoreError =>
  failure._tag === 'ReturningRowsDecodeFailed'
    ? storeError('decode', 'commit', `${failure.write} RETURNING rows failed schema decoding`, failure)
    : storeError(
        'conflict',
        'commit',
        `${failure.write} did not return the exact expected identity ${failure.expectedId}`,
        failure,
      )

const storedRowsError = (operation: IntentStoreError['operation'], failure: StoredRowsFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'StoredRowsDecodeFailed':
      return storeError('decode', operation, 'stored intent rows failed schema decoding', failure)
    case 'StoredIntentDecodeFailed':
      return storeError('decode', operation, `stored intent ${failure.intentId} failed schema decoding`, failure)
    case 'StoredRiskDecisionDecodeFailed':
      return storeError('decode', operation, `stored decision for ${failure.intentId} failed schema decoding`, failure)
  }
}

const classifyIntentCause = (operation: IntentStoreError['operation'], cause: unknown): IntentStoreError => {
  if (cause instanceof IntentStoreError) return cause
  if (isSqlError(cause)) {
    if (cause.reason._tag === 'UniqueViolation') {
      return storeError('conflict', operation, `intent ${operation} violated a uniqueness boundary`, cause)
    }
    if (cause.reason._tag === 'ConstraintError') {
      return storeError('invariant', operation, `intent ${operation} violated a durable semantic constraint`, cause)
    }
  }
  return storeError('query', operation, `intent ${operation} failed`, cause)
}

const classifyCommitCause = (cause: unknown): IntentStoreError | WriterFenceError =>
  cause instanceof WriterFenceError ? cause : classifyIntentCause('commit', cause)

const runRead = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, IntentStoreError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyIntentCause('read', cause)))

const runCommit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, IntentStoreError | WriterFenceError, R> =>
  effect.pipe(Effect.mapError(classifyCommitCause))

const decodeStoredEffect = (
  operation: IntentStoreError['operation'],
  rows: unknown,
): Effect.Effect<readonly StoredIntent[], IntentStoreError> =>
  Effect.fromResult(decodeStoredIntentRows(rows)).pipe(
    Effect.mapError((failure) => storedRowsError(operation, failure)),
  )

const readById = (
  sql: PgClient.PgClient,
  operation: IntentStoreError['operation'],
  intentId: string,
): Effect.Effect<Option.Option<StoredIntent>, IntentStoreError, never> => {
  const decodedId = Result.mapError(decodeIntentIdResult(intentId), (cause) =>
    storeError('decode', operation, 'invalid intent ID', cause),
  )
  return Effect.fromResult(decodedId).pipe(
    Effect.flatMap((id) =>
      selectRows(sql, sql`intent.intent_id = ${id}`).pipe(
        Effect.mapError((cause) => classifyIntentCause(operation, cause)),
      ),
    ),
    Effect.flatMap((rows) => decodeStoredEffect(operation, rows)),
    Effect.flatMap((records) =>
      records.length <= 1
        ? Effect.succeed(Option.fromNullishOr(records[0]))
        : Effect.fail(storeError('invariant', operation, 'intent ID returned multiple records')),
    ),
  )
}

const readConflicts = (
  sql: PgClient.PgClient,
  intent: Intent,
): Effect.Effect<readonly StoredIntent[], IntentStoreError> =>
  selectRows(
    sql,
    sql`
      intent.intent_id = ${intent.intentId}
      OR (intent.account_id = ${intent.accountId} AND intent.client_order_id = ${intent.clientOrderId})
      OR (
        intent.account_id = ${intent.accountId}
        AND intent.strategy_name = ${intent.strategyName}
        AND intent.cycle_id = ${intent.cycleId}
        AND intent.decision_hash = ${intent.decisionHash}
        AND intent.symbol = ${intent.symbol}
        AND intent.replan_generation_hash IS NOT DISTINCT FROM ${intent.replanGenerationHash ?? null}
      )
    `,
  ).pipe(
    Effect.mapError((cause) => classifyIntentCause('commit', cause)),
    Effect.flatMap((rows) => decodeStoredEffect('commit', rows)),
  )

const readCurrentAuthority = (
  sql: PgClient.PgClient,
): Effect.Effect<readonly AuthorityBindingRow[], IntentStoreError> =>
  sql`
    SELECT
      authority.maximum,
      authority.effective,
      authority.kill_state,
      authority.generation_hash,
      generation.maximum AS generation_maximum,
      generation.account_id AS generation_account_id,
      generation.risk_policy_hash AS generation_risk_policy_hash,
      generation.strategy_name AS generation_strategy_name
    FROM authority_state AS authority
    LEFT JOIN authority_generations AS generation
      ON generation.generation_hash = authority.generation_hash
    WHERE authority.singleton
    FOR UPDATE OF authority
  `.pipe(
    Effect.mapError((cause) => classifyIntentCause('commit', cause)),
    Effect.flatMap((rows) =>
      Effect.fromResult(decodeAuthorityBindingRows(rows)).pipe(
        Effect.mapError((failure) =>
          storeError('decode', 'commit', 'authority binding rows failed schema decoding', failure),
        ),
      ),
    ),
  )

const insertIntent = (sql: PgClient.PgClient, intent: Intent) =>
  sql`
    INSERT INTO intents (
      intent_id,
      schema_version,
      authority_generation_hash,
      strategy_name,
      cycle_id,
      decision_hash,
      policy_hash,
      account_id,
      client_order_id,
      symbol,
      side,
      order_type,
      time_in_force,
      quantity_micros,
      notional_limit_micros,
      replan_generation_hash,
      state,
      created_at,
      updated_at
    ) VALUES (
      ${intent.intentId},
      ${intent.schemaVersion},
      ${intent.authorityGenerationHash},
      ${intent.strategyName},
      ${intent.cycleId},
      ${intent.decisionHash},
      ${intent.policyHash},
      ${intent.accountId},
      ${intent.clientOrderId},
      ${intent.symbol},
      ${intent.side},
      ${intent.orderType},
      ${intent.timeInForce},
      ${intent.quantityMicros},
      ${intent.notionalLimitMicros},
      ${intent.replanGenerationHash ?? null},
      ${intent.state},
      ${intent.createdAt},
      ${intent.createdAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING intent_id
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))

const insertRiskDecision = (sql: PgClient.PgClient, decision: RiskDecision) =>
  sql`
    INSERT INTO risk_decisions (
      decision_id,
      schema_version,
      input_hash,
      intent_id,
      policy_hash,
      outcome,
      reason_codes,
      decided_at,
      expires_at
    ) VALUES (
      ${decision.decisionId},
      ${decision.schemaVersion},
      ${decision.inputHash},
      ${decision.intentId},
      ${decision.policyHash},
      ${decision.outcome},
      ${decision.reasonCodes},
      ${decision.decidedAt},
      ${decision.expiresAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING decision_id
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))

const transitionIntent = (sql: PgClient.PgClient, intent: Intent, decision: RiskDecision) => {
  const approved = decision.outcome === RiskOutcome.Approved
  return sql`
    UPDATE intents
    SET
      risk_decision_id = ${decision.decisionId},
      state = ${approved ? IntentState.Approved : IntentState.Terminal},
      terminal_outcome = ${approved ? null : TerminalOutcome.Blocked},
      state_version = state_version + 1,
      updated_at = CASE
        WHEN ${decision.decidedAt}::timestamptz = created_at
          THEN created_at + interval '1 millisecond'
        ELSE ${decision.decidedAt}::timestamptz
      END
    WHERE intent_id = ${intent.intentId} AND state = ${IntentState.Planned}
    RETURNING intent_id
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))
}

type ResolvedIntent =
  | { readonly _tag: 'Replay'; readonly receipt: IntentReceipt }
  | { readonly _tag: 'Pending'; readonly record: StoredIntent }

const resolveDisposition = (
  disposition: ExistingCommitDisposition,
): Effect.Effect<ResolvedIntent, IntentStoreError> => {
  if (disposition._tag === 'ExactReplay') {
    return Effect.succeed({ _tag: 'Replay', receipt: disposition.receipt })
  }
  if (disposition._tag === 'CompleteIntent') {
    return Effect.succeed({ _tag: 'Pending', record: disposition.record })
  }
  return Effect.fail(storeError('conflict', 'commit', 'inserted intent cannot be read back'))
}

const reclassifyAfterInsert = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<ResolvedIntent, IntentStoreError> =>
  readConflicts(sql, prepared.intent).pipe(
    Effect.flatMap((records) =>
      Effect.fromResult(classifyExistingCommit(records, prepared)).pipe(Effect.mapError(existingCommitError)),
    ),
    Effect.flatMap(resolveDisposition),
  )

const resolveIntent = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
  closing = false,
): Effect.Effect<ResolvedIntent, IntentStoreError> =>
  Effect.gen(function* () {
    const records = yield* readConflicts(sql, prepared.intent)
    const disposition = yield* Effect.fromResult(classifyExistingCommit(records, prepared)).pipe(
      Effect.mapError(existingCommitError),
    )
    if (disposition._tag === 'ExactReplay') {
      return { _tag: 'Replay', receipt: disposition.receipt } satisfies ResolvedIntent
    }

    const authorityRows = yield* readCurrentAuthority(sql)
    yield* Effect.fromResult(
      closing
        ? validateCurrentClosingAuthority(authorityRows, prepared.intent)
        : validateCurrentAuthority(authorityRows, prepared.intent),
    ).pipe(Effect.mapError(authorityError))
    if (disposition._tag === 'CompleteIntent') {
      return { _tag: 'Pending', record: disposition.record } satisfies ResolvedIntent
    }

    const insertedRows = yield* insertIntent(sql, prepared.intent)
    yield* Effect.fromResult(decideIntentInsert(insertedRows, prepared.intent.intentId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    return yield* reclassifyAfterInsert(sql, prepared)
  })

const persistDecision = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<IntentReceipt, IntentStoreError> =>
  Effect.gen(function* () {
    const decisionRows = yield* insertRiskDecision(sql, prepared.decision)
    yield* Effect.fromResult(decideRiskCommit(decisionRows, prepared.decision.decisionId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    const transitionRows = yield* transitionIntent(sql, prepared.intent, prepared.decision)
    yield* Effect.fromResult(decideIntentTransition(transitionRows, prepared.intent.intentId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    const stored = yield* readById(sql, 'commit', prepared.intent.intentId)
    if (Option.isNone(stored)) {
      return yield* Effect.fail(storeError('invariant', 'commit', 'committed intent cannot be read back'))
    }
    const verified = yield* Effect.fromResult(classifyExistingCommit([stored.value], prepared)).pipe(
      Effect.mapError(existingCommitError),
    )
    if (verified._tag !== 'ExactReplay') {
      return yield* Effect.fail(storeError('invariant', 'commit', 'committed intent readback is incomplete'))
    }
    return { record: verified.receipt.record, deduplicated: false }
  })

const commitTransaction = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
  closing = false,
): Effect.Effect<IntentReceipt, IntentStoreError> =>
  resolveIntent(sql, prepared, closing).pipe(
    Effect.flatMap((resolved) =>
      resolved._tag === 'Replay' ? Effect.succeed(resolved.receipt) : persistDecision(sql, prepared),
    ),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  return {
    commit: (intent, decision) =>
      runCommit(
        Effect.fromResult(validateCommitIdentity(intent, decision)).pipe(
          Effect.mapError(commitMaterialError),
          Effect.flatMap((prepared) => fence.transaction(commitTransaction(sql, prepared))),
        ),
      ),
    commitClosing: (intent, decision) =>
      runCommit(
        Effect.fromResult(validateCommitIdentity(intent, decision)).pipe(
          Effect.mapError(commitMaterialError),
          Effect.flatMap((prepared) => fence.transaction(commitTransaction(sql, prepared, true))),
        ),
      ),
    read: (intentId) => runRead(readById(sql, 'read', intentId)),
  } satisfies IntentStoreService
})

export const IntentStoreLive = Layer.effect(IntentStore, makeStore)
