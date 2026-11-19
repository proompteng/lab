import { buildMutationShadowCycleDecision } from '../observe-composition/decision-builder'
import { Context, Effect, Layer } from 'effect'

import { makeApplicationPlan, type ApplicationPlan } from '../app'
import { operationalError } from '../errors'
import { recoverTerminalGenerationToObserve } from '../blocked-generation-recovery'
import { makeMutation } from '../broker/alpaca-mutations/interpreter'
import { readFinalExecutionRiskContext, verifyBrokerStateVersion } from '../db/reconciliation'
import { readCurrentProtectionClose, readProtectionSubmit } from '../db/protection-release'
import { WriterFence } from '../execution/writer-fence'
import { PgClient } from '@effect/sql-pg'
import { Authority } from '../execution/contracts'
import { resolvePreparedExecutionAuthority, resolvePreparedExecutionPolicy } from '../execution/runtime-authority'
import { capitalGrantFromLegacyGeneration, capitalGrantKey } from '../execution/mandate'
import { runOnce } from '../reconciler'
import { boundedReconciliationPass } from '../observe-composition/decision-builder'
import { IntradayMarketData } from '../market-data/intraday/model'
import { currentUtcInstant } from '../time'
import { withObservedStage } from '../telemetry'
import { autonomousRuntimeServices, makeAutonomousCycleResources } from './autonomous-runtime-resources'
import { AutonomousRuntimeResourcesLive, type JevRuntimeServices } from './resources'
import { observeCycleGenerationHash } from '../execution/capital-grant-algebra'
import { makeObserveAutonomousCycleStartup } from '../observe-composition/startup'
import { BrokerMutationError } from '../broker/alpaca-mutations/model'
import { makeTradingEngine } from './trading-engine'
import {
  executionGenerationNeedsRecovery,
  makeGenerationCycleDriver,
  makeRebindingCycleDriver,
} from './generation-cycle'
import {
  capitalActivationOperationalError,
  configuredCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readOnlyExecutionPolicy,
  refreshResearchCapitalActivationReconciliation,
} from './capital-activation'

export const makeExecutionCycleDriver = (
  plan: ApplicationPlan,
  preparationTimeoutMs: number,
  inferenceContext: Context.Context<JevRuntimeServices>,
) =>
  Effect.gen(function* () {
    const configured = yield* Effect.fromResult(configuredCapitalActivation(plan)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const marketData = yield* IntradayMarketData
    const observePlan = makeApplicationPlan({
      ...plan,
      config: {
        ...plan.config,
        execution: { ...readOnlyExecutionPolicy(plan), brokerIdentity: plan.config.alpaca.identity },
      },
    })
    const runtimeContext = yield* Layer.build(AutonomousRuntimeResourcesLive(observePlan, inferenceContext))
    const services = yield* autonomousRuntimeServices.pipe(Effect.provideContext(runtimeContext))
    const cycleResources = makeAutonomousCycleResources(services, marketData, plan.config.operationTimeoutMs)
    const context = Context.merge(yield* Layer.build(cycleResources), runtimeContext)
    const reconcile = runOnce.pipe(Effect.provideContext(context))
    const settle = recoverTerminalGenerationToObserve({
      accountId: plan.config.alpaca.expectedAccountId,
      blockedIntents: services.blockedCycleIntentStore,
      authorityStore: services.authorityGenerationStore,
      writerFence: services.writerFence,
      reconcileAfterSettlement: refreshResearchCapitalActivationReconciliation(
        reconcile,
        plan.config.operationTimeoutMs,
      ).pipe(Effect.asVoid),
    })
    const readAuthority = services.authorityGenerationStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('generation recovery authority read failed', cause)),
    )
    const prepare = Effect.gen(function* () {
      if (configured === null) {
        yield* settle
        const authority = yield* services.authorityGenerationStore
          .readOrInitializeObserveAuthority({
            generationHash: plan.config.alpaca.authorityGenerationHash,
            maximum: Authority.Observe,
          })
          .pipe(
            Effect.mapError((cause) =>
              capitalActivationOperationalError('OBSERVE authority initialization failed', cause),
            ),
          )
        const generationHash = yield* Effect.fromResult(observeCycleGenerationHash(authority)).pipe(
          Effect.mapError((message) => capitalActivationOperationalError(message)),
        )
        const start = yield* makeObserveAutonomousCycleStartup({
          accountId: observePlan.config.alpaca.expectedAccountId,
          authorityGenerationHash: generationHash,
          reconciliationIntervalMs: observePlan.config.alpaca.reconciliationIntervalMs,
          reconciliationPassTimeoutMs: observePlan.config.operationTimeoutMs,
          strategy: observePlan.strategy,
          intradayMarketData: marketData,
        })({
          cycleBindingId: generationHash,
          recordPass: () => Effect.void,
        }).pipe(Effect.provideContext(context))
        return { driver: yield* start.pipe(Effect.provideContext(context)), needsRebind: Effect.succeed(false) }
      }
      const generation = yield* prepareOrRecoverResearchCapitalActivation(
        observePlan,
        configured.request,
        configured.buildContinuation ?? null,
        configured.buildLineage ?? null,
        services.authorityGenerationStore,
        services.capitalGrantLifecycleStore,
        reconcile,
        plan.config.operationTimeoutMs,
      )
      const authorityState = yield* readAuthority
      const restricted =
        authorityState.generationHash === generation.generationHash && executionGenerationNeedsRecovery(authorityState)
      const policy = yield* Effect.fromResult(
        resolvePreparedExecutionPolicy({
          configured: plan.config.execution,
          brokerIdentity: plan.config.alpaca.identity,
          preparedGenerationHash: generation.generationHash,
        }),
      ).pipe(
        Effect.mapError((cause) => capitalActivationOperationalError('prepared execution policy is invalid', cause)),
      )
      const authority = yield* resolvePreparedExecutionAuthority({
        executionPolicy: policy,
        brokerIdentity: plan.config.alpaca.identity,
        strategy: plan.strategy.provenance.strategy,
        observedAt: yield* currentUtcInstant,
        readPersistedCapitalGrant: services.persistedCapitalGrants.read,
      }).pipe(
        Effect.mapError((cause) => capitalActivationOperationalError('prepared execution authority is invalid', cause)),
      )
      const brokerMutation = yield* makeMutation(services.session, authority, services.alpacaHttpClient).pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerMutationError
            ? operationalError({ component: 'config', operation: 'broker-mutation', message: cause.message, cause })
            : operationalError({
                component: 'config',
                operation: 'execution-program',
                message: 'execution program requires validated mutation authority and risk policy',
                cause,
              }),
        ),
      )
      const mode = restricted ? 'CloseOnly' : 'Mutation'
      const engine = yield* makeTradingEngine({
        buildDecision: buildMutationShadowCycleDecision,
        authority,
        riskPolicyHash: generation.riskPolicyHash,
        cycle: {
          accountId: plan.config.alpaca.expectedAccountId,
          authorityGenerationHash: generation.generationHash,
          strategy: plan.strategy,
          intradayMarketData: marketData,
          executionCycleClosureStore: services.executionCycleClosureStore,
          readProtectionClose: (reference, maximumObservationAgeMs) =>
            readCurrentProtectionClose(reference, plan.config.alpaca.expectedAccountId, maximumObservationAgeMs).pipe(
              Effect.provideService(PgClient.PgClient, services.pgClient),
              Effect.provideService(WriterFence, services.writerFence),
            ),
          blockedCycleIntentStore: services.blockedCycleIntentStore,
          reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
          reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
        },
        executionMode: mode,
        execution: {
          currentUtcInstant,
          verifyBrokerStateVersion: (version, intentId, requireCryptoEntryFeeBound) =>
            verifyBrokerStateVersion(
              services.pgClient,
              plan.config.alpaca.expectedAccountId,
              version,
              intentId,
              requireCryptoEntryFeeBound,
            ),
          brokerRead: services.session.read,
          brokerMutation,
          persistedCapitalGrants: services.persistedCapitalGrants,
          readFinalExecutionRiskContext: (observedAt) =>
            readFinalExecutionRiskContext(services.pgClient, plan.config.alpaca.expectedAccountId, observedAt),
          readProtectionSubmit: (intentId, proofId) =>
            readProtectionSubmit(intentId, proofId, 'transmission').pipe(
              Effect.provideService(PgClient.PgClient, services.pgClient),
              Effect.provideService(WriterFence, services.writerFence),
            ),
          intentStore: services.intentStore,
          mutationStore: services.mutationStore,
          writerFence: services.writerFence,
        },
      })
      const start = yield* engine.startCycle({
        cycleBindingId: capitalGrantKey(capitalGrantFromLegacyGeneration(generation)),
        recordPass: () => Effect.void,
      })
      const driver = yield* start.pipe(Effect.provideContext(context))
      return yield* makeGenerationCycleDriver(
        {
          generationHash: generation.generationHash,
          mode,
          readAuthority,
          reconcileWhenHeld: boundedReconciliationPass(plan.config.operationTimeoutMs).pipe(
            Effect.provideContext(context),
            Effect.asVoid,
            Effect.mapError((cause) =>
              capitalActivationOperationalError('restricted authority reconciliation failed', cause),
            ),
          ),
          settle,
        },
        driver,
      )
    })
    const boundedPreparation = prepare.pipe(
      Effect.timeoutOrElse({
        duration: preparationTimeoutMs,
        orElse: () => Effect.fail(capitalActivationOperationalError('execution generation preparation timed out')),
      }),
      withObservedStage('bayn.execution.generation.prepare'),
    )
    const initial = yield* boundedPreparation
    return { driver: yield* makeRebindingCycleDriver(initial, boundedPreparation), context }
  })
