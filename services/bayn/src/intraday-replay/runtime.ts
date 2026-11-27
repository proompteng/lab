import { DecisionConstruction } from '../decision-construction'
import {
  constructExecutionDecision as buildExecutionDecision,
  constructObserveShadowDecision as buildObserveShadowDecision,
} from '../shadow-decision'
import { buildResearchMutationCycleDecision, type ResearchAlphaBaselineLoader } from './decision-builder'
import type { AnyReplayAlphaBaselineUse } from './alpha-baseline-use'
import { makeCandidateObservationStore } from '../db/candidate-observation-postgres'
import { makeJevBatchStore } from '../db/jev-batch-postgres'
import { makeJevEvaluationStore } from '../db/jev-evaluation-postgres'
import { makeEntryInferenceJournal } from '../db/entry-inference-postgres'
import { makeJevPositionStore } from '../db/jev-position-postgres'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevPositionStore } from '../jev/portfolio'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { PgClient } from '@effect/sql-pg'
import { Context, Effect } from 'effect'
import { operationTimeoutOrElse } from '../operation-timeout'

import { BrokerRead } from '../broker/alpaca/model'
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
} from '../db/execution-store/contract'
import { ExecutionCycleClosureStore } from '../db/execution-cycle-closure'
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { readFinalExecutionRiskContext, verifyBrokerStateVersion } from '../db/reconciliation'
import { readCurrentProtectionClose, readProtectionSubmit } from '../db/protection-release'
import { CycleStore } from '../cycle/store/model'
import { makeCycleStore, withWriterFenceCycleStore } from '../cycle/store/postgres'
import { BrokerAccess, grantedCapitalAuthority, makeExecutionAuthority } from '../execution/authority'
import {
  makeResearchCapitalActivationRequest,
  makeResearchCapitalPlanHash,
  researchCapitalGrantProof,
  researchCapitalGenerationIsBoundToRequest,
} from '../execution/configuration'
import { Authority, KillState } from '../execution/contracts'
import { recoverTerminalGenerationToObserve } from '../blocked-generation-recovery'
import {
  executionGenerationNeedsRecovery,
  makeGenerationCycleDriver,
  makeRebindingCycleDriver,
} from '../composition/generation-cycle'
import { refreshResearchCapitalActivationReconciliation } from '../composition/capital-activation'
import { BlockedCycleIntentStore } from '../execution/intents/blocked-cycle'
import { IntentStore } from '../execution/intents/domain'
import { MutationStore } from '../execution/mutations/model'
import { makeTradingEngine } from '../composition/trading-engine'
import { WriterFence } from '../execution/writer-fence'
import type { ExecutionProgramDependencies } from '../execution/runtime-program'
import { capitalGrantFromLegacyGeneration, capitalGrantKey } from '../execution/mandate'
import { canonicalHashV1Result } from '../hash'
import { makeStrategyProtocolHashResult } from '../contracts'
import { makeSimulatedMarketData } from '../market-data/streaming/simulation-service'
import type { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import { strategyExecutionRiskPolicy } from '../execution/risk-policy'
import type { StrategyRuntime } from '../strategy'
import { runReconciliation } from '../simulation-reconciliation/broker-reconciler-program'
import { ReconciliationError } from '../simulation-reconciliation/broker-reconciler-model'
import { ReconciliationClock } from '../reconciler'
import { CapitalActivationReconciliationNotExact, operationalError, OperationalError } from '../errors'
import { currentUtcInstant } from '../time'
import { makeReplayAdmissionClock } from './admission-clock'
import { ReplayBrokerFailure, type makeReplayBroker } from './broker'
import { makeReplayDecisionLatency } from './decision-latency'

const replayGenerationRecoveryError = (cause: unknown): OperationalError =>
  operationalError({
    component: 'strategy',
    operation: 'replay-generation-recovery',
    message: 'Replay generation recovery failed',
    cause,
  })

export const reconcileReplayForActivation = <R>(
  now: ExecutionProgramDependencies['currentUtcInstant'],
  reconcile: Effect.Effect<unknown, OperationalError, R>,
): Effect.Effect<void, OperationalError, R> =>
  now.pipe(
    Effect.andThen(reconcile),
    Effect.andThen(now),
    Effect.asVoid,
    Effect.mapError((cause) =>
      cause instanceof OperationalError &&
      cause.operation === 'capital-activation' &&
      cause.cause instanceof CapitalActivationReconciliationNotExact
        ? cause
        : replayGenerationRecoveryError(cause),
    ),
  )

export interface ReplayExecutionRuntimeInput {
  readonly loadAlphaBaseline?: (
    ...args: [...Parameters<ResearchAlphaBaselineLoader>, commandIssuedAt: string]
  ) => ReturnType<ResearchAlphaBaselineLoader>
  readonly recordAlphaBaselineUse?: (use: AnyReplayAlphaBaselineUse) => Effect.Effect<void, OperationalError>
  readonly decisionTrigger?: 'polling' | 'streaming'
  readonly decisionLatencyStress: Parameters<typeof makeReplayDecisionLatency>[1]
  readonly currentUtcInstant: ExecutionProgramDependencies['currentUtcInstant']
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
      input.broker.sourceManifestHash !== input.source.sourceManifestHash ||
      input.clock.accountId !== identity.accountId ||
      input.clock.sourceManifestHash !== input.source.sourceManifestHash
    )
      return yield* new ReplayBrokerFailure({ message: 'Replay runtime requires its synthetic sandbox account' })
    const sql = yield* PgClient.PgClient
    const fence = yield* WriterFence
    const admissionClock = yield* makeReplayAdmissionClock(input.clock)
    const intentStore = admissionClock.intents(yield* IntentStore)
    const mutationStore = admissionClock.mutations(yield* MutationStore)
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
    const cycleStore = withWriterFenceCycleStore(yield* makeCycleStore(input.clock), fence, intentStore)
    const marketData = yield* makeSimulatedMarketData(input.source, input.cursor)
    const candidateObservationStore = yield* makeCandidateObservationStore
    const jevClient = yield* JevClient
    const entryInferenceJournal = yield* makeEntryInferenceJournal
    const jevEvaluations = yield* makeJevEvaluationStore
    const latency = makeReplayDecisionLatency(
      input.currentUtcInstant,
      input.decisionLatencyStress,
      input.recordAlphaBaselineUse !== undefined,
    )
    const recordAlphaBaselineUse = input.recordAlphaBaselineUse
    const loadAlphaBaseline = input.loadAlphaBaseline
    const jevBatches = latency.wrapStore(
      yield* makeJevBatchStore.pipe(Effect.provideService(JevEvaluationStore, jevEvaluations)),
    )
    const jevPositions = yield* makeJevPositionStore
    const riskPolicy = yield* Effect.fromResult(strategyExecutionRiskPolicy(identity.accountId, input.strategy))
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
    const initialAuthority = yield* store.authorityGeneration.readOrInitializeObserveAuthority({
      generationHash: sourceGenerationHash,
      maximum: Authority.Observe,
    })
    const reconciliationTime = input.currentUtcInstant.pipe(
      Effect.mapError(
        (cause) =>
          new ReconciliationError({
            operation: 'clock',
            failure: { _tag: 'Clock' },
            message: 'Replay reconciliation clock could not advance',
            cause,
          }),
      ),
    )
    const reconcile = runReconciliation({ read: input.broker.read, store, fence, now: reconciliationTime }).pipe(
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
    yield* input.currentUtcInstant
    const activated =
      initialAuthority.maximum === Authority.Execution
        ? initialAuthority
        : yield* store.capitalGrantLifecycle.activateResearchCapitalGrant(
            researchCapitalGrantProof(request),
            initialAuthority.generationHash,
          )
    const resources = Context.make(BrokerRead, input.broker.read).pipe(
      Context.add(DecisionConstruction, { observe: buildObserveShadowDecision, execution: buildExecutionDecision }),
      Context.add(ReconciliationClock, reconciliationTime),
      Context.add(CandidateObservationStore, latency.wrapObservations(candidateObservationStore)),
      Context.add(JevClient, jevClient),
      Context.add(EntryInferenceJournal, entryInferenceJournal),
      Context.add(JevEvaluationStore, jevEvaluations),
      Context.add(JevBatchStore, jevBatches),
      Context.add(JevPositionStore, jevPositions),
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
    const readAuthorityState = store.authorityGeneration.readAuthorityState
    const readAuthority = readAuthorityState.pipe(Effect.mapError(replayGenerationRecoveryError))
    const reconcileForActivation = reconcileReplayForActivation(
      input.currentUtcInstant,
      refreshResearchCapitalActivationReconciliation(reconcile, input.reconciliationPassTimeoutMs),
    )
    const settle = recoverTerminalGenerationToObserve({
      accountId: identity.accountId,
      blockedIntents: blockedCycleIntentStore,
      authorityStore: store.authorityGeneration,
      writerFence: fence,
      reconcileAfterSettlement: reconcileForActivation,
    })
    const startGeneration = (generationHash: string) =>
      Effect.gen(function* () {
        const generation = yield* store.authorityGeneration.readResearchAuthorityGeneration(generationHash)
        if (generation === undefined)
          return yield* new ReplayBrokerFailure({ message: 'Activated replay research generation is unavailable' })
        yield* Effect.fromResult(
          researchCapitalGenerationIsBoundToRequest(request, generation.previousGenerationHash, generation),
        )
        const mode = executionGenerationNeedsRecovery(yield* readAuthority)
          ? ('CloseOnly' as const)
          : ('Mutation' as const)
        const authority = yield* Effect.fromResult(
          makeExecutionAuthority({
            observedAt: yield* currentUtcInstant,
            brokerIdentity: identity,
            brokerAccess: BrokerAccess.Mutation,
            capitalAuthority: grantedCapitalAuthority(generationHash),
            strategy: input.strategy.provenance.strategy,
          }),
        )
        const engine = yield* makeTradingEngine({
          buildDecision: (decision) =>
            buildResearchMutationCycleDecision(
              decision,
              loadAlphaBaseline === undefined
                ? undefined
                : (query, observedAt) =>
                    latency.currentCommandIssuedAt.pipe(
                      Effect.flatMap((commandIssuedAt) => loadAlphaBaseline(query, observedAt, commandIssuedAt)),
                    ),
              recordAlphaBaselineUse === undefined
                ? undefined
                : (use) =>
                    latency.currentCommandIssuedAt.pipe(
                      Effect.flatMap((commandIssuedAt) => recordAlphaBaselineUse({ ...use, commandIssuedAt })),
                    ),
            ),
          authority,
          riskPolicyHash: generation.riskPolicyHash,
          cycle: {
            accountId: identity.accountId,
            authorityGenerationHash: generationHash,
            strategy: input.strategy,
            intradayMarketData: marketData,
            executionCycleClosureStore: closures,
            readProtectionClose: (reference, maxAgeMs) =>
              readCurrentProtectionClose(reference, identity.accountId, maxAgeMs).pipe(
                Effect.provideService(PgClient.PgClient, sql),
                Effect.provideService(WriterFence, fence),
              ),
            blockedCycleIntentStore,
            reconciliationIntervalMs: input.reconciliationIntervalMs,
            reconciliationPassTimeoutMs: input.reconciliationPassTimeoutMs,
          },
          executionMode: mode,
          execution: {
            currentUtcInstant: input.currentUtcInstant,
            verifyBrokerStateVersion: (version, intentId, requireCryptoEntryFeeBound) =>
              verifyBrokerStateVersion(sql, identity.accountId, version, intentId, requireCryptoEntryFeeBound),
            brokerRead: input.broker.read,
            brokerMutation: input.broker.mutation,
            intentStore,
            mutationStore,
            writerFence: fence,
            persistedCapitalGrants,
            readFinalExecutionRiskContext: (observedAt) =>
              readFinalExecutionRiskContext(sql, identity.accountId, observedAt),
            readProtectionSubmit: (intentId, proofId) =>
              readProtectionSubmit(intentId, proofId, 'transmission').pipe(
                Effect.provideService(PgClient.PgClient, sql),
                Effect.provideService(WriterFence, fence),
              ),
          },
        })
        const startup = yield* engine.startCycle({
          cycleBindingId: capitalGrantKey(capitalGrantFromLegacyGeneration(generation)),
          recordPass: input.recordPass,
        })
        const driver = yield* startup.pipe(Effect.provideContext(resources))
        return yield* makeGenerationCycleDriver(
          {
            generationHash,
            mode,
            readAuthority,
            reconcileWhenHeld: reconcileForActivation,
            settle,
          },
          driver,
        ).pipe(Effect.provideContext(resources))
      }).pipe(Effect.mapError(replayGenerationRecoveryError))
    const driver = yield* makeRebindingCycleDriver(
      yield* startGeneration(activated.generationHash),
      Effect.gen(function* () {
        const current = yield* readAuthority
        let generationHash = current.generationHash
        if (
          current.maximum === Authority.Observe &&
          current.effective === Authority.Observe &&
          current.kill === KillState.Clear
        ) {
          yield* reconcileForActivation
          const next = yield* store.capitalGrantLifecycle.activateResearchCapitalGrant(
            researchCapitalGrantProof(request),
            current.generationHash,
          )
          generationHash = next.generationHash
        }
        return yield* startGeneration(generationHash)
      }).pipe(Effect.mapError(replayGenerationRecoveryError)),
      latency.runPass,
    )
    return {
      authorityGenerationHash: activated.generationHash,
      cycleStore,
      mutations: mutationStore,
      store,
      marketData,
      // Retained v11 studies keep their polling cadence; native replay preserves the owner's next wake.
      advance: driver.advance.pipe(
        Effect.provideContext(resources),
        Effect.map((pass) =>
          input.decisionTrigger === 'streaming'
            ? pass
            : {
                ...pass,
                nextDelayMs: Math.min(input.pollIntervalMs, pass.nextDelayMs ?? input.pollIntervalMs),
              },
        ),
      ),
      nextDelayMs: input.pollIntervalMs,
      reconcile,
      decisionLatencyEvidence: latency.evidence,
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
