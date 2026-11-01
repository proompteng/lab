import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Layer } from 'effect'
import type { DatabaseClock } from '../../db/clock'

import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import { intentPlanSchemaVersion } from '../../execution/contracts'
import {
  IntentStore,
  makeExecutionIntentFromDecodedPlan,
  type IntentStoreService,
} from '../../execution/intents/domain'
import { WriterFence, WriterFenceError, type WriterFenceService } from '../../execution/writer-fence'
import { isProtectedEntryTarget } from '../../strategy/runtime-decision'
import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanStatus } from '../../target-planner/index'
import { makeCycleBindingPrograms } from './binding-program'
import { makeCycleLifecyclePrograms } from './lifecycle-program'
import {
  CycleStore,
  cycleStoreError,
  isEntryAdmissionViolation,
  type CycleStoreError,
  type CycleStoreShape,
} from './model'
import { makeCycleMutationPrimitives } from './mutations'
import { makeCycleQueries } from './queries'
import { makeCycleReadPrograms } from './read-program'

export const makeCycleStore = (clock?: DatabaseClock) =>
  Effect.map(PgClient.PgClient, (sql) => {
    const queries = makeCycleQueries(sql, clock)
    const mutations = makeCycleMutationPrimitives(sql, queries)

    return {
      ...makeCycleReadPrograms(queries),
      ...makeCycleLifecyclePrograms(sql, queries, mutations),
      ...makeCycleBindingPrograms(sql, queries, mutations),
    } satisfies CycleStoreShape
  })

const fenceMutation = <A>(
  operation: CycleStoreError['operation'],
  effect: Effect.Effect<A, CycleStoreError>,
  fence: WriterFenceService,
): Effect.Effect<A, CycleStoreError> =>
  fence.transaction(effect).pipe(
    Effect.catchCause((failure) =>
      Effect.failCause(
        Cause.map(failure, (cause) => {
          if (!(cause instanceof WriterFenceError)) return cause
          const expired = operation === 'bind-decision' && isEntryAdmissionViolation(cause.cause)
          return cycleStoreError({
            operation,
            failure: expired ? 'entry-expired' : 'query',
            persistenceFailure: expired ? 'constraint' : 'transaction',
            message: expired
              ? 'entry admission expired before its decision binding committed'
              : 'autonomous cycle mutation could not acquire the PostgreSQL writer fence',
            cause,
          })
        }),
      ),
    ),
  )

const commitBoundEntryIntents = (document: CycleDecisionDocument, intents: Pick<IntentStoreService, 'commit'>) =>
  Effect.gen(function* () {
    if (
      document.mode !== legacyExecutionAuthorityToken ||
      !document.dispatchable ||
      !isProtectedEntryTarget(document.strategyDecision) ||
      document.targetPlan.status !== TargetPlanStatus.Planned
    )
      return
    for (const [index, target] of document.targetPlan.intentTargets.entries()) {
      const risk = document.deltaRisk[index]
      if (risk === undefined)
        return yield* cycleStoreError({
          operation: 'bind-decision',
          failure: 'invariant',
          message: 'bound entry intent has no matching risk decision',
        })
      const intent = yield* Effect.fromResult(
        makeExecutionIntentFromDecodedPlan(
          {
            schemaVersion: intentPlanSchemaVersion,
            ...target,
            notionalLimitMicros: risk.notionalLimitMicros,
            limitPriceMicros: risk.limitPriceMicros,
            ...(risk.protection === undefined ? {} : { protection: risk.protection }),
            ...(document.replanGenerationHash === undefined
              ? {}
              : { replanGenerationHash: document.replanGenerationHash }),
          },
          document.bindings.authorityGenerationHash,
        ),
      ).pipe(
        Effect.mapError((cause) =>
          cycleStoreError({
            operation: 'bind-decision',
            failure: 'invariant',
            message: 'bound entry intent could not be reproduced',
            cause,
          }),
        ),
      )
      if (intent.intentId !== document.orderedIntentIds[index])
        return yield* cycleStoreError({
          operation: 'bind-decision',
          failure: 'invariant',
          message: 'bound entry intent differs from its ordered decision identity',
        })
      yield* intents.commit(intent, risk.evaluation.decision).pipe(
        Effect.mapError((cause) =>
          cycleStoreError({
            operation: 'bind-decision',
            failure: 'query',
            message: 'entry intent and decision binding could not commit together',
            cause,
          }),
        ),
      )
    }
  })

export const withWriterFenceCycleStore = (
  store: CycleStoreShape,
  fence: WriterFenceService,
  intents: Pick<IntentStoreService, 'commit'>,
): CycleStoreShape => ({
  ...store,
  acquire: (...args) => fenceMutation('acquire', store.acquire(...args), fence),
  activate: (...args) => fenceMutation('activate', store.activate(...args), fence),
  bindDecision: (cycleId, document, observedAt, evidence) =>
    Effect.try({
      try: () => structuredClone(document),
      catch: (cause) =>
        cycleStoreError({
          operation: 'bind-decision',
          failure: 'decode',
          message: 'decision binding could not retain its private source',
          cause,
        }),
    }).pipe(
      Effect.flatMap((retained) =>
        fenceMutation(
          'bind-decision',
          store
            .bindDecision(cycleId, retained, observedAt, evidence)
            .pipe(
              Effect.tap((receipt) =>
                receipt.cycle.bindings.decisionHash === retained.contentHash
                  ? commitBoundEntryIntents(retained, intents)
                  : Effect.void,
              ),
            ),
          fence,
        ),
      ),
    ),
  finish: (...args) => fenceMutation('finish', store.finish(...args), fence),
  block: (...args) => fenceMutation('block', store.block(...args), fence),
})

export const CycleStoreLive = Layer.effect(CycleStore, makeCycleStore())

/** Execution-only interpreter: every durable cycle mutation crosses the same PostgreSQL writer fence as intents. */
export const WriterFencedCycleStoreLive = Layer.effect(
  CycleStore,
  Effect.all({ store: makeCycleStore(), fence: WriterFence, intents: IntentStore }).pipe(
    Effect.map(({ store, fence, intents }) => withWriterFenceCycleStore(store, fence, intents)),
  ),
)
