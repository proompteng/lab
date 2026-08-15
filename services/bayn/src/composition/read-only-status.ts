import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Ref, Result, Schedule } from 'effect'

import { makeApplicationPlan, type ApplicationPlanFor } from '../app'
import { BrokerSession } from '../broker/alpaca'
import type { LoadedRuntimeConfig } from '../config'
import { CycleObservability } from '../cycle/store'
import { readForwardPerformanceReceiptByGeneration } from '../db/forward-performance-receipt-postgres'
import { EvidenceStore } from '../db/evidence-store'
import type { AuthorityGenerationStoreShape } from '../db/execution-store'
import { makeAuthorityPostgres } from '../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../db/execution-store/observe-authority'
import { ExecutionControllerStatusStore } from '../execution/controller-status'
import { BrokerAccess } from '../execution/authority'
import {
  capitalActivationRequiresQualificationEvidence,
  isResearchCapitalActivationRequest,
} from '../execution/configuration'
import { checkHealth } from '../health'
import { serveHttp } from '../http'
import { Journal } from '../ledger'
import { MarketData } from '../market-data'
import { initialState, type RuntimeState } from '../runtime-state'
import { runStartup } from '../startup'
import { currentUtcInstant } from '../time'
import { runtimeBroker } from './lifecycle'
import {
  capitalActivationOperationalError,
  capitalActivationRequestIsCurrent,
  completedCapitalActivation,
  decodeConfiguredCapitalActivation,
  pendingCapitalActivation,
  readBoundCapitalActivationGeneration,
  readCompletedExecutionLifecycle,
  readOnlyExecutionPolicy,
  realizedCapitalActivation,
  type ConfiguredCapitalActivation,
} from './capital-activation'

const readOnlyPlan = (plan: ApplicationPlanFor<'AutonomousService'>): ApplicationPlanFor<'AutonomousService'> => {
  const config = {
    ...plan.config,
    execution: readOnlyExecutionPolicy(plan),
  } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
  return makeApplicationPlan({
    config,
    protocol: plan.protocol,
    parameterHash: plan.parameterHash,
    strategy: plan.strategy,
    strategyProtocolHash: plan.strategyProtocolHash,
  }) as ApplicationPlanFor<'AutonomousService'>
}

const configuredCapitalActivation = (
  serialized: string | undefined,
): Result.Result<ConfiguredCapitalActivation | null, string> =>
  serialized === undefined ? Result.succeed(null) : decodeConfiguredCapitalActivation(serialized)

const readReceiptHash = (sql: PgClient.PgClient, authorityGenerationHash: string) =>
  readForwardPerformanceReceiptByGeneration(sql, authorityGenerationHash).pipe(
    Effect.map(Option.map((receipt) => receipt.receiptHash)),
    Effect.mapError((cause) =>
      capitalActivationOperationalError('completed execution lifecycle receipt read failed', cause),
    ),
  )

export interface ReadOnlyCapitalActivationStore {
  readonly authority: AuthorityGenerationStoreShape
  readonly readReceiptHash: (authorityGenerationHash: string) => ReturnType<typeof readReceiptHash>
}

const makeReadOnlyCapitalActivationStore = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  sql: PgClient.PgClient,
): ReadOnlyCapitalActivationStore => ({
  authority: makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), plan.config.alpaca.identity),
  readReceiptHash: (generationHash) => readReceiptHash(sql, generationHash),
})

const logActivationUnavailable = (reason: string): Effect.Effect<void> =>
  Effect.logWarning('Bayn read-only capital projection remains unavailable').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      component: 'capital-activation',
      mode: 'read-only-status',
      reason,
    }),
  )

export const refreshReadOnlyCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  configured: Result.Result<ConfiguredCapitalActivation | null, string>,
  state: Ref.Ref<RuntimeState>,
  store: ReadOnlyCapitalActivationStore,
): Effect.Effect<void> => {
  const publishUnavailable = (reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const request = Result.isSuccess(configured) ? (configured.success?.request ?? null) : null
      yield* pendingCapitalActivation(state, request, 'PREPARATION_FAILED')
      yield* logActivationUnavailable(reason)
    })

  return Effect.gen(function* () {
    if (Result.isFailure(configured)) {
      yield* pendingCapitalActivation(state, null, 'REQUEST_INVALID')
      return yield* logActivationUnavailable('REQUEST_INVALID')
    }
    if (configured.success === null) {
      if (plan.config.execution.brokerAccess === BrokerAccess.Mutation) {
        yield* pendingCapitalActivation(state, null, 'REQUEST_INVALID')
        yield* logActivationUnavailable('REQUEST_MISSING')
      }
      return
    }

    const observePlan = readOnlyPlan(plan)
    const { request, buildContinuation } = configured.success
    const current = yield* Ref.get(state)
    const observedAt = yield* currentUtcInstant
    const currentRequest = capitalActivationRequestIsCurrent(request, observePlan, current.evidence, observedAt, {
      allowCloseRecovery: true,
      buildContinuation,
    })
    if (Result.isFailure(currentRequest)) {
      yield* pendingCapitalActivation(state, request, 'PREPARATION_FAILED')
      return yield* logActivationUnavailable('REQUEST_NOT_CURRENT')
    }

    const completed = yield* readCompletedExecutionLifecycle(
      observePlan,
      request,
      buildContinuation,
      store.authority,
      store.readReceiptHash,
    )
    if (completed !== undefined) {
      return yield* completedCapitalActivation(state, request, completed.authorityGenerationHash, completed.receiptHash)
    }
    const generation = yield* readBoundCapitalActivationGeneration(
      observePlan,
      request,
      buildContinuation,
      store.authority,
    )
    yield* realizedCapitalActivation(
      state,
      request,
      generation.generationHash,
      isResearchCapitalActivationRequest(request) ? 'Research' : 'Qualified',
    )
  }).pipe(
    Effect.timeoutOrElse({
      duration: plan.config.operationTimeoutMs,
      orElse: () => publishUnavailable('DURABLE_PROJECTION_TIMEOUT'),
    }),
    Effect.catch(() => publishUnavailable('DURABLE_PROJECTION_UNAVAILABLE')),
    Effect.withLogSpan('read-only-capital-projection'),
  )
}

export const refreshReadOnlyQualification = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  configured: Result.Result<ConfiguredCapitalActivation | null, string>,
  state: Ref.Ref<RuntimeState>,
  dependencies: {
    readonly marketData: import('../market-data').MarketDataService
    readonly journal: import('../ledger').JournalService
    readonly evidenceStore: import('../db/evidence-store').EvidenceStoreService
  },
): Effect.Effect<void> => {
  const request =
    Result.isSuccess(configured) &&
    configured.success !== null &&
    !isResearchCapitalActivationRequest(configured.success.request)
      ? configured.success.request
      : null
  const runId = plan.config.qualificationRunId
  if (runId === undefined) {
    return request === null
      ? Effect.void
      : pendingCapitalActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE').pipe(
          Effect.andThen(logActivationUnavailable('QUALIFICATION_BINDING_MISMATCH')),
        )
  }
  if (request !== null && request.qualification.runId !== runId) {
    return pendingCapitalActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE').pipe(
      Effect.andThen(logActivationUnavailable('QUALIFICATION_BINDING_MISMATCH')),
    )
  }
  return Ref.get(state).pipe(
    Effect.flatMap((current) => {
      if (current.evidence?.evaluation.runId === runId || current.status === 'FAILED') return Effect.void
      return runStartup(plan.config, state, plan.strategy, dependencies).pipe(
        Effect.catch(() =>
          pendingCapitalActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE').pipe(
            Effect.andThen(logActivationUnavailable('QUALIFICATION_EVIDENCE_UNAVAILABLE')),
          ),
        ),
      )
    }),
  )
}

export const readOnlyCycleObservationId = (
  configured: Result.Result<ConfiguredCapitalActivation | null, string>,
  qualificationRunId: string | undefined,
  observeGenerationHash: string,
): string | undefined => {
  if (Result.isFailure(configured)) return qualificationRunId
  if (configured.success === null) return qualificationRunId ?? observeGenerationHash
  const request = configured.success.request
  return isResearchCapitalActivationRequest(request) ? request.grant.planHash : request.qualification.runId
}

export const readOnlyQualificationEvidenceRequired = (
  configured: Result.Result<ConfiguredCapitalActivation | null, string>,
): boolean =>
  Result.isFailure(configured) || capitalActivationRequiresQualificationEvidence(configured.success?.request ?? null)

export const readOnlyExecutionControllerBinding = (
  plan: ApplicationPlanFor<'AutonomousService'>,
): { readonly controllerKey: string; readonly planHash: string } | undefined => {
  const planHash = plan.config.expectedExecutionControllerPlanHash
  return planHash === undefined
    ? undefined
    : {
        controllerKey: plan.config.alpaca.identity.identityHash,
        planHash,
      }
}

export const runReadOnlyAutonomousStatusService = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const cycleObservability = yield* CycleObservability
    const controllerStatus = yield* ExecutionControllerStatusStore
    const brokerSession = yield* BrokerSession
    const observePlan = readOnlyPlan(plan)
    const configured = configuredCapitalActivation(plan.config.capitalActivationRequestJson)
    const activationStore = makeReadOnlyCapitalActivationStore(observePlan, sql)
    const qualificationEvidenceRequired = readOnlyQualificationEvidenceRequired(configured)
    const controller = readOnlyExecutionControllerBinding(plan)
    const state = yield* Ref.make(
      initialState({
        qualificationEvidenceRequired,
        broker: {
          expectedAccountId: plan.config.alpaca.expectedAccountId,
          executionEligible: false,
          executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
        },
        autonomousCycleLoopConfigured: true,
        autonomousCycleLoopOwner: 'Restate',
        ...(controller === undefined ? {} : { executionController: controller }),
      }),
    )
    const dependencies = { marketData, journal, evidenceStore, cycleObservability }
    yield* refreshReadOnlyQualification(observePlan, configured, state, dependencies)
    yield* refreshReadOnlyCapitalActivation(plan, configured, state, activationStore)
    yield* serveHttp(
      observePlan.config,
      state,
      observePlan.strategy.provenance,
      observePlan.config.build.verification,
      evidenceStore.read,
    )

    const healthPass = refreshReadOnlyQualification(observePlan, configured, state, dependencies).pipe(
      Effect.andThen(refreshReadOnlyCapitalActivation(plan, configured, state, activationStore)),
      Effect.andThen(Ref.get(state)),
      Effect.flatMap((current) =>
        checkHealth(
          observePlan.config,
          state,
          dependencies,
          runtimeBroker(observePlan, brokerSession.read, current.capitalActivation?._tag === 'Realized'),
          undefined,
          readOnlyCycleObservationId(
            configured,
            observePlan.config.qualificationRunId,
            observePlan.config.alpaca.authorityGenerationHash,
          ),
          qualificationEvidenceRequired,
          controller === undefined
            ? undefined
            : { controllerKey: controller.controllerKey, read: controllerStatus.read },
        ),
      ),
    )
    yield* healthPass.pipe(
      Effect.repeat(Schedule.spaced(observePlan.config.healthIntervalMs)),
      Effect.forkScoped({ startImmediately: true }),
    )
    return yield* Effect.never
  }).pipe(Effect.scoped)
