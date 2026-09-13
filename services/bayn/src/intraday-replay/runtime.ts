import { PgClient } from '@effect/sql-pg'
import { Context, Effect } from 'effect'
import { operationTimeoutOrElse } from '../operation-timeout'

import { BrokerRead } from '../broker/alpaca'
import { BrokerEnvironment } from '../broker/identity'
import type { RecordAutonomousCyclePass } from '../app'
import type { SimulatedExecutionClock } from './clock'
import { makeExecutionPersistence } from '../db/execution-store/postgres'
import type { ExecutionStoreRuntimeConfig } from '../db/execution-store/contract'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from '../db/execution-store'
import { ExecutionCycleClosureStore } from '../db/execution-cycle-closure'
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { readFinalExecutionRiskContext } from '../db/reconciliation'
import { CycleStore } from '../cycle/store'
import { makeCycleStore, withWriterFenceCycleStore } from '../cycle/store/postgres'
import { BrokerAccess, grantedCapitalAuthority, makeExecutionAuthority } from '../execution/authority'
import {
  makeResearchCapitalActivationRequest,
  makeResearchCapitalPlanHash,
  researchCapitalGrantProof,
} from '../execution/configuration'
import { Authority } from '../execution/contracts'
import { BlockedCycleIntentStore, IntentStore } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import { makeExecutionProgram } from '../execution/runtime-program'
import { WriterFence } from '../execution/writer-fence'
import { capitalGrantFromLegacyGeneration, capitalGrantKey } from '../execution/mandate'
import { canonicalHashV1Result } from '../hash'
import { makeStrategyProtocolHashResult } from '../contracts'
import { makeSimulatedMarketData } from '../market-data/streaming/simulation-service'
import type { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import { loadStrategyExecutionRiskPolicy, makeMutationAutonomousCycleStartup } from '../observe-composition/startup'
import type { StrategyRuntime } from '../strategy'
import { runReconciliation } from '../simulation-reconciliation/broker-reconciler-program'
import { operationalError, type OperationalError } from '../errors'
import { currentUtcInstant } from '../time'
import { ReplayBrokerFailure, type makeReplayBroker } from './broker'

export interface ReplayExecutionRuntimeInput {
  readonly config: ExecutionStoreRuntimeConfig
  readonly strategy: StrategyRuntime
  readonly broker: Effect.Success<ReturnType<typeof makeReplayBroker>>
  readonly source: typeof SimulatedSnapshotSourceSchema.Type
  readonly cursor: Effect.Effect<HistoricalMarketCursor, OperationalError>
  readonly clock: SimulatedExecutionClock
  readonly recordPass: RecordAutonomousCyclePass
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
  readonly reconciliationPassTimeoutMs: number
}

/** Production persistence, activation, decision, risk, coordinator and recovery with isolated simulated broker ports. */
export const makeReplayExecutionRuntime = (input: ReplayExecutionRuntimeInput) =>
  Effect.gen(function* () {
    const identity = input.config.execution.brokerIdentity
    if (
      identity === undefined ||
      identity.environment !== BrokerEnvironment.Sandbox ||
      identity.accountId !== `replay-${input.source.runId}` ||
      input.broker.accountId !== identity.accountId ||
      input.clock.accountId !== identity.accountId ||
      input.clock.sourceManifestHash !== input.source.sourceManifestHash
    )
      return yield* new ReplayBrokerFailure({ message: 'Replay runtime requires its synthetic sandbox account' })
    const sql = yield* PgClient.PgClient
    const fence = yield* WriterFence
    const intentStore = yield* IntentStore
    const mutationStore = yield* MutationStore
    const blockedCycleIntentStore = yield* BlockedCycleIntentStore
    const closures = yield* ExecutionCycleClosureStore
    const persistedCapitalGrants = yield* PersistedCapitalGrantStore
    const sourceGenerationHash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.replay-observe-generation.v1',
        runId: input.source.runId,
      }),
    )
    const store = yield* makeExecutionPersistence(
      {
        ...input.config,
        alpaca: { expectedAccountId: identity.accountId, authorityGenerationHash: sourceGenerationHash },
      },
      input.clock,
    )
    const cycleStore = withWriterFenceCycleStore(yield* makeCycleStore(input.clock), fence)
    const marketData = yield* makeSimulatedMarketData(input.source, input.cursor)
    const riskPolicy = yield* loadStrategyExecutionRiskPolicy(identity.accountId, input.strategy)
    const plan = {
      schemaVersion: 'bayn.research-execution-plan.v1' as const,
      activation: {
        sourceRevision: input.config.build.sourceRevision,
        imageRepository: input.config.build.imageRepository,
        imageDigest: input.config.build.imageDigest,
      },
      strategy: {
        ...input.strategy.provenance.strategy,
        protocolHash: yield* Effect.fromResult(makeStrategyProtocolHashResult(input.strategy.provenance.strategy)),
      },
      broker: {
        environment: BrokerEnvironment.Sandbox as const,
        accountId: identity.accountId,
        identityHash: identity.identityHash,
      },
      riskPolicyHash: yield* Effect.fromResult(canonicalHashV1Result(riskPolicy)),
      limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
    }
    const planHash = yield* Effect.fromResult(makeResearchCapitalPlanHash(plan))
    const request = yield* Effect.fromResult(
      makeResearchCapitalActivationRequest({
        ...plan,
        schemaVersion: 'bayn.research-execution-mandate.v1',
        grant: { _tag: 'Research', planHash },
      }),
    )
    yield* store.authorityGeneration.readOrInitializeObserveAuthority({
      generationHash: sourceGenerationHash,
      maximum: Authority.Observe,
    })
    const reconcile = runReconciliation({ read: input.broker.read, store, fence, now: currentUtcInstant }).pipe(
      operationTimeoutOrElse({
        duration: input.reconciliationPassTimeoutMs,
        orElse: () =>
          Effect.fail(
            new ReplayBrokerFailure({
              message: `Replay reconciliation exceeded ${input.reconciliationPassTimeoutMs}ms`,
            }),
          ),
      }),
    )
    yield* reconcile
    const activated = yield* store.capitalGrantLifecycle.activateResearchCapitalGrant(
      researchCapitalGrantProof(request),
      sourceGenerationHash,
    )
    const generation = yield* store.authorityGeneration.readResearchAuthorityGeneration(activated.generationHash)
    if (generation === undefined)
      return yield* new ReplayBrokerFailure({ message: 'Activated replay research generation is unavailable' })
    const authority = yield* Effect.fromResult(
      makeExecutionAuthority({
        observedAt: yield* currentUtcInstant,
        brokerIdentity: identity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: grantedCapitalAuthority(activated.generationHash),
        strategy: input.strategy.provenance.strategy,
      }),
    )
    const executionProgram = yield* Effect.fromResult(
      makeExecutionProgram(authority, {
        brokerRead: input.broker.read,
        brokerMutation: input.broker.mutation,
        intentStore,
        mutationStore,
        writerFence: fence,
        persistedCapitalGrants,
        riskPolicy,
        currentUtcInstant,
        readFinalExecutionRiskContext: (observedAt) =>
          readFinalExecutionRiskContext(sql, identity.accountId, observedAt),
        isCloseOnlyIntent: closures.containsIntent,
      }),
    )
    const resources = Context.make(BrokerRead, input.broker.read).pipe(
      Context.add(CycleStore, cycleStore),
      Context.add(BrokerEventStore, store.events),
      Context.add(FillAccountingStore, store.accounting),
      Context.add(ValuationStore, store.valuation),
      Context.add(ReconciliationStore, store.reconciliation),
      Context.add(AuthorityGenerationStore, store.authorityGeneration),
      Context.add(AuthorityRestrictionStore, store.authorityRestriction),
      Context.add(WriterFence, fence),
      Context.add(IntentStore, intentStore),
      Context.add(MutationStore, mutationStore),
    )
    const startup = yield* makeMutationAutonomousCycleStartup({
      accountId: identity.accountId,
      authorityGenerationHash: activated.generationHash,
      strategy: input.strategy,
      intradayMarketData: marketData,
      executionProgram,
      executionCycleClosureStore: closures,
      blockedCycleIntentStore,
      pollIntervalMs: input.pollIntervalMs,
      reconciliationIntervalMs: input.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: input.reconciliationPassTimeoutMs,
    })({ cycleBindingId: capitalGrantKey(capitalGrantFromLegacyGeneration(generation)), recordPass: input.recordPass })
    const driver = yield* startup.pipe(Effect.provideContext(resources))
    return {
      authorityGenerationHash: activated.generationHash,
      cycleStore,
      store,
      marketData,
      advance: driver.advance.pipe(Effect.provideContext(resources)),
      nextDelayMs: driver.nextDelayMs,
      reconcile,
    }
  }).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'replay-runtime',
        message: 'Simulated execution runtime failed to initialize',
        cause,
      }),
    ),
  )
