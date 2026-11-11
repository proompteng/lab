import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Metric,
  Option,
  Result,
  Scope,
  ScopedRef,
  type Tracer,
} from 'effect'

import type { ApplicationPlan } from '../app'
import { operationalError, type OperationalError } from '../errors'
import type { CycleRunnerError } from '../cycle/runner/model'
import type { ExecutionBuild } from '../build'
import {
  maximumRetainedJevObservationReferences,
  type RetainedAutonomousCyclePassObservation,
} from '../cycle/runner/pass-observation'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevInferenceWorkStore, executeJevInferenceWork } from '../jev/inference-work'
import type { JevInferenceCompletion, JevInferenceJob } from '../jev/inference-work'
import type { EntryInferenceRuntime } from '../restate/restate-entry-inference'
import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusStore,
  executionControllerStatusHasCompletion,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusStoreError,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { advanceExecutionOnce, TransientExecutionFailure, type AdvanceExecutionCommand } from '../execution/advance'
import {
  decodeExecutionAdvanceStepResult,
  executionControllerPlanHash,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerState,
} from '../execution/controller'
import { type RecoveryFirstCycleAdvance, type RecoveryFirstRuntime } from '../observe-composition/model'
import { currentOpenTelemetryLogAnnotations, currentOpenTelemetryParentSpan } from '../restate/restate-telemetry'
import type { NativeExecutionRuntime, ExecutionControllerConfig } from '../restate/restate-execution-controller'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { makeConfiguredTelemetryRuntimeLayer } from '../telemetry'
import { makeExecutionCycleDriver } from './autonomous-runtime'
import { nativeActivationPreflight } from './native-activation-preflight'
import {
  AutonomousWorkerApplicationResourcesLive,
  ExecutionControllerStatusResourceLive,
  WorkerMarketProjectionLive,
} from './resources'
import { KafkaMarketProjection } from '../market-data/streaming/kafka'
import { kafkaHandoffReadiness, KafkaHandoffReadiness } from '../market-data/streaming/bootstrap'
import { AuthorityGenerationStore } from '../db/execution-store/contract'
import { IntradayMarketData } from '../market-data/intraday/model'
import { restoreJevObservation } from '../jev/observation'
import { KillState } from '../execution/contracts'

export class NativeExecutionRuntimeError extends Data.TaggedError('NativeExecutionRuntimeError')<{
  readonly operation: 'binding' | 'dispose' | 'initialize'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface NativeExecutionRuntimeResource {
  readonly config: ExecutionControllerConfig
  readonly runtime: NativeExecutionRuntime
  readonly inferenceRuntime: EntryInferenceRuntime
  readonly readMarketReadiness: () => Promise<boolean>
  readonly startMarketWakeups: typeof KafkaMarketProjection.Service.startWakeups
}

export const nativeExecutionRuntimeInitializationTimeoutMs = (operationTimeoutMs: number): number =>
  operationTimeoutMs * 5

export type BoundRecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, CycleRunnerError | OperationalError>
  readonly nextDelayMs: number
  readonly inference?: {
    readonly pending: Effect.Effect<readonly JevInferenceJob[], OperationalError>
    readonly execute: (jobId: string) => Effect.Effect<JevInferenceCompletion | null, OperationalError>
  }
}

export class ExecutionCycleDriver extends Context.Service<ExecutionCycleDriver, BoundRecoveryFirstCycleDriver>()(
  '@proompteng/bayn/composition/native-execution-runtime/ExecutionCycleDriver',
) {}

interface ExecutionEffectRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }) => Promise<A>
}

const runtimeError = (
  operation: NativeExecutionRuntimeError['operation'],
  message: string,
  cause?: unknown,
): NativeExecutionRuntimeError => new NativeExecutionRuntimeError({ operation, message, cause })

export const executionControllerConfig = (
  plan: ApplicationPlan,
): Result.Result<ExecutionControllerConfig, NativeExecutionRuntimeError> =>
  Result.succeed({
    controllerKey: plan.config.alpaca.identity.identityHash,
    operationTimeoutMs: plan.config.operationTimeoutMs,
    planHash: executionControllerPlanHash,
    sourceRevision: plan.config.build.sourceRevision,
  })

const pendingInferenceForAuthority = (context: Context.Context<RecoveryFirstRuntime>) =>
  Effect.gen(function* () {
    const work = Context.getOption(context, JevInferenceWorkStore)
    if (Option.isNone(work)) return []
    const authority = yield* Context.get(context, AuthorityGenerationStore).readAuthorityState.pipe(
      Effect.mapError((cause) =>
        operationalError({
          component: 'database',
          operation: 'jev-batch',
          message: 'inference authority read failed',
          cause,
        }),
      ),
    )
    return yield* work.value.pending(authority.generationHash)
  })

export const executionReceiptDelayMs = (completedAt: string, nextWakeAt?: string): number =>
  nextWakeAt === undefined ? 1 : Math.min(86_400_000, Math.max(1, Date.parse(nextWakeAt) - Date.parse(completedAt)))

export const bindRecoveryFirstCycleDriver = (
  driver: {
    readonly advance: Effect.Effect<
      RecoveryFirstCycleAdvance,
      CycleRunnerError | OperationalError,
      RecoveryFirstRuntime
    >
    readonly nextDelayMs: number
  },
  executionBuild: ExecutionBuild,
  accountId?: string,
): Effect.Effect<BoundRecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.context<RecoveryFirstRuntime>().pipe(
    Effect.map((context) => ({
      advance: Effect.gen(function* () {
        const hashes = new Set<string>()
        let complete = true
        const observe = <A, E, R>(effect: Effect.Effect<A, E, R>, reference: (value: A) => string | null) =>
          effect.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                try {
                  if (Exit.isFailure(exit)) {
                    complete = false
                    return
                  }
                  const hash = reference(exit.value)
                  if (hash === null) return
                  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
                    complete = false
                    return
                  }
                  if (hashes.has(hash)) return
                  if (hashes.size === maximumRetainedJevObservationReferences) {
                    complete = false
                    return
                  }
                  hashes.add(hash)
                } catch {
                  // Evidence collection must not change the store result or trading behavior.
                  complete = false
                }
              }),
            ),
          )
        let observedContext = context
        const observations = Context.getOption(context, CandidateObservationStore)
        if (Option.isSome(observations)) {
          const store = observations.value
          observedContext = Context.add(observedContext, CandidateObservationStore, {
            record: (observation, policy) =>
              observe(store.record(observation, policy), () =>
                observation.payload.schemaVersion === 'bayn.jev-observation.v1' ? observation.contentHash : null,
              ),
            latestJevWindowEnd: (input) => observe(store.latestJevWindowEnd(input), () => null),
          })
        } else complete = false
        const batches = Context.getOption(context, JevBatchStore)
        if (Option.isSome(batches)) {
          const store = batches.value
          observedContext = Context.add(observedContext, JevBatchStore, {
            read: (batchId) =>
              observe(store.read(batchId), (batch) => (batch === null ? null : batch.plan.observationHash)),
            pending: (cycleId, generation) => observe(store.pending(cycleId, generation), () => null),
            begin: (plan, observation, options) =>
              observe(
                Effect.gen(function* () {
                  const source = yield* Effect.fromResult(restoreJevObservation(observation)).pipe(
                    Effect.mapError((cause) =>
                      operationalError({
                        component: 'market-data',
                        operation: 'jev-batch',
                        message: 'admitted source could not be restored',
                        cause,
                      }),
                    ),
                  )
                  const marketData = Context.getOption(context, IntradayMarketData)
                  if (Option.isNone(marketData))
                    return yield* operationalError({
                      component: 'market-data',
                      operation: 'jev-batch',
                      message: 'deferred inference requires the current market source verifier',
                    })
                  const sourceReference = yield* marketData.value.verifyReference(source.snapshot)
                  return yield* store.begin(plan, source.observation, {
                    ...options,
                    deferProviderDispatch: true,
                    sourceReference,
                  })
                }),
                (batch) => batch.plan.observationHash,
              ),
            finish: (batchId) => observe(store.finish(batchId), (batch) => batch.plan.observationHash),
            complete: (plan, observation, result) =>
              observe(store.complete(plan, observation, result), (batch) => batch.plan.observationHash),
          })
        } else complete = false
        const advanced = yield* Effect.provideContext(driver.advance, observedContext)
        const work = Context.getOption(context, JevInferenceWorkStore)
        let recoveryAt: number | undefined
        if (Option.isSome(work)) {
          if (accountId === undefined)
            return yield* operationalError({
              component: 'config',
              operation: 'jev-batch',
              message: 'inference settlement requires its immutable account binding',
            })
          const settled = yield* work.value.settleExpired(accountId)
          if (settled.nextAttemptAt !== undefined) recoveryAt = Date.parse(settled.nextAttemptAt)
          else if (settled.failed > 0 || settled.remaining)
            recoveryAt = (yield* Clock.currentTimeMillis) + (settled.failed > 0 ? 30_000 : 1)
        }
        const pending = yield* pendingInferenceForAuthority(context)
        const expiry = pending.reduce<number | undefined>((earliest, job) => {
          const at = Date.parse(job.expiresAt)
          return earliest === undefined ? at : Math.min(earliest, at)
        }, recoveryAt)
        const nextWakeAt =
          expiry === undefined
            ? advanced.nextWakeAt
            : utcInstantFromEpochMillis(
                Math.min(expiry, advanced.nextWakeAt === undefined ? expiry : Date.parse(advanced.nextWakeAt)),
              )
        return {
          ...advanced,
          ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
          observation: {
            ...advanced.observation,
            executionBuild,
            jevObservationReferences: { hashes: [...hashes].sort(), complete },
          },
        }
      }),
      nextDelayMs: driver.nextDelayMs,
      ...(Option.isSome(Context.getOption(context, JevInferenceWorkStore))
        ? {
            inference: {
              pending: pendingInferenceForAuthority(context),
              execute: (jobId: string) => {
                const work = Context.getOption(context, JevInferenceWorkStore)
                if (Option.isNone(work))
                  return Effect.fail(
                    operationalError({
                      component: 'config',
                      operation: 'jev-batch',
                      message: 'inference work store disappeared',
                    }),
                  )
                return Effect.provideContext(
                  executeJevInferenceWork(
                    jobId,
                    Effect.gen(function* () {
                      const job = yield* work.value.read(jobId)
                      const authority = yield* Context.get(context, AuthorityGenerationStore).readAuthorityState
                      return (
                        job !== null &&
                        job.authorityGenerationHash === authority.generationHash &&
                        authority.kill === KillState.Clear &&
                        authority.effective === authority.maximum
                      )
                    }),
                  ),
                  Context.add(context, JevInferenceWorkStore, work.value),
                ).pipe(
                  Effect.mapError((cause) =>
                    operationalError({
                      component: 'strategy',
                      operation: 'jev-batch',
                      message: 'admitted inference failed',
                      cause,
                    }),
                  ),
                )
              },
            },
          }
        : {}),
    })),
  )

const projectionFailure = (cause: unknown): TransientExecutionFailure =>
  new TransientExecutionFailure({
    operation: 'advance',
    message: 'execution controller status projection did not complete',
    cause,
  })

const controllerOutcome = (outcome: 'Blocked' | 'Completed' | 'Waiting'): ExecutionControllerOutcome => {
  switch (outcome) {
    case 'Completed':
      return ExecutionControllerOutcome.Completed
    case 'Blocked':
      return ExecutionControllerOutcome.Blocked
    case 'Waiting':
      return ExecutionControllerOutcome.Waiting
  }
}

const persistControllerStatus = (
  statusStore: ExecutionControllerStatusStoreShape,
  status: ExecutionControllerStatus,
): Effect.Effect<void, TransientExecutionFailure> =>
  statusStore.project(status).pipe(
    Effect.flatMap((projection) =>
      projection._tag === 'Stale'
        ? Effect.fail(projectionFailure('controller status rejected a stale execution projection'))
        : Effect.void,
    ),
    Effect.mapError(projectionFailure),
  )

const retainedProjectedPass = (
  controllerKey: string,
  state: ExecutionControllerState,
  stored: ExecutionControllerStatus | null,
): RetainedAutonomousCyclePassObservation | undefined => {
  const completion = state.lastCompletion
  if (
    completion === undefined ||
    stored === null ||
    !executionControllerStatusHasCompletion(stored) ||
    stored.controllerKey !== controllerKey ||
    stored.planHash !== state.planHash ||
    stored.epoch !== state.epoch ||
    stored.lastSequence !== completion.sequence ||
    stored.lastOutcome !== completion.outcome ||
    stored.lastReceiptHash !== completion.receiptHash ||
    stored.completedAt !== completion.completedAt
  ) {
    return undefined
  }
  return stored.lastPass
}

export const projectExecutionControllerState = (
  controllerKey: string,
  state: ExecutionControllerState,
  statusStore: ExecutionControllerStatusStoreShape,
): Effect.Effect<void, TransientExecutionFailure> =>
  statusStore.read(controllerKey).pipe(
    Effect.mapError(projectionFailure),
    Effect.flatMap((stored) => {
      const completion = state.lastCompletion
      const lastPass = retainedProjectedPass(controllerKey, state, stored)
      return persistControllerStatus(statusStore, {
        schemaVersion: 1,
        controllerKey,
        planHash: state.planHash,
        active: state.active,
        epoch: state.epoch,
        nextSequence: state.nextSequence,
        ...(completion === undefined
          ? {}
          : {
              lastSequence: completion.sequence,
              lastOutcome: completion.outcome,
              lastReceiptHash: completion.receiptHash,
              completedAt: completion.completedAt,
              ...(state.nextDueAt === undefined ? {} : { nextDueAt: state.nextDueAt }),
              ...(lastPass === undefined ? {} : { lastPass }),
            }),
      })
    }),
  )

const replayProjectedAdvance = (
  command: AdvanceExecutionCommand,
  status: ExecutionControllerStatus | null,
  planHash: string,
): Result.Result<ExecutionAdvanceStepResult | null, TransientExecutionFailure> => {
  if (status === null || status.epoch < command.epoch) return Result.succeed(null)
  if (
    status.controllerKey !== command.controllerKey ||
    status.planHash !== planHash ||
    status.epoch !== command.epoch
  ) {
    return Result.fail(projectionFailure('controller status has already advanced beyond this execution command'))
  }
  if (status.nextSequence <= command.sequence) return Result.succeed(null)
  if (
    status.nextSequence !== command.sequence + 1 ||
    !executionControllerStatusHasCompletion(status) ||
    status.lastSequence !== command.sequence
  ) {
    return Result.fail(projectionFailure('controller status has already advanced beyond this execution command'))
  }
  return Result.mapError(
    decodeExecutionAdvanceStepResult({
      completedAt: status.completedAt,
      ...(status.lastPass === undefined ? {} : { observation: status.lastPass }),
      outcome: {
        _tag: status.lastOutcome,
        receiptHash: status.lastReceiptHash,
        nextDelayMs: executionReceiptDelayMs(status.completedAt, status.nextDueAt),
        ...(status.nextDueAt !== undefined ? { nextWakeAt: status.nextDueAt } : {}),
      },
    }),
    projectionFailure,
  )
}

const readProjectedAdvance = (
  command: AdvanceExecutionCommand,
  statusStore: ExecutionControllerStatusStoreShape,
  planHash: string,
): Effect.Effect<ExecutionAdvanceStepResult | null, TransientExecutionFailure> =>
  statusStore.read(command.controllerKey).pipe(
    Effect.mapError(projectionFailure),
    Effect.flatMap((status) => Effect.fromResult(replayProjectedAdvance(command, status, planHash))),
  )

const recoverPersistedProjectionWinner = (
  command: AdvanceExecutionCommand,
  statusStore: ExecutionControllerStatusStoreShape,
  planHash: string,
  cause: ExecutionControllerStatusStoreError,
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> => {
  if (cause.failure !== 'conflict' && cause.failure !== 'query') {
    return Effect.fail(projectionFailure(cause))
  }
  return readProjectedAdvance(command, statusStore, planHash).pipe(
    Effect.flatMap((replayed) =>
      replayed === null
        ? Effect.fail(projectionFailure(cause))
        : Effect.logWarning('Bayn execution replay adopted the persisted completion winner').pipe(
            Effect.annotateLogs({
              controllerKey: command.controllerKey,
              epoch: command.epoch,
              sequence: command.sequence,
              sourceRevision: command.sourceRevision,
              receiptHash: replayed.outcome.receiptHash,
            }),
            Effect.as(replayed),
          ),
    ),
  )
}

const advanceAndProject = (
  command: AdvanceExecutionCommand,
  driver: BoundRecoveryFirstCycleDriver,
  statusStore: ExecutionControllerStatusStoreShape,
  planHash: string,
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> =>
  advanceExecutionOnce(command, driver).pipe(
    Effect.bindTo('outcome'),
    Effect.bind('completedAt', () => currentUtcInstant.pipe(Effect.mapError(projectionFailure))),
    Effect.let(
      'step',
      ({ completedAt, outcome }): ExecutionAdvanceStepResult => ({
        completedAt,
        observation: outcome.observation,
        outcome: {
          _tag: controllerOutcome(outcome._tag),
          receiptHash: outcome.receiptHash,
          nextDelayMs: executionReceiptDelayMs(completedAt, outcome.nextWakeAt),
          ...(outcome.nextWakeAt === undefined ? {} : { nextWakeAt: outcome.nextWakeAt }),
        },
      }),
    ),
    Effect.flatMap(({ completedAt, outcome, step }) =>
      statusStore
        .project({
          schemaVersion: 1,
          controllerKey: command.controllerKey,
          planHash,
          active: true,
          epoch: command.epoch,
          nextSequence: command.sequence + 1,
          lastSequence: command.sequence,
          lastOutcome: controllerOutcome(outcome._tag),
          lastReceiptHash: outcome.receiptHash,
          completedAt,
          ...(step.outcome.nextWakeAt === undefined ? {} : { nextDueAt: step.outcome.nextWakeAt }),
          lastPass: outcome.observation,
        })
        .pipe(
          Effect.flatMap((projection) =>
            projection._tag === 'Stale'
              ? Effect.fail(projectionFailure('controller status rejected a stale execution completion'))
              : Effect.succeed(step),
          ),
          Effect.catchTag('ExecutionControllerStatusStoreError', (cause) =>
            recoverPersistedProjectionWinner(command, statusStore, planHash, cause),
          ),
        ),
    ),
  )

export const executeNativeExecutionAdvance = (
  command: AdvanceExecutionCommand,
  driver: BoundRecoveryFirstCycleDriver,
  statusStore: ExecutionControllerStatusStoreShape,
  planHash: string,
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> =>
  readProjectedAdvance(command, statusStore, planHash).pipe(
    Effect.flatMap((replayed) =>
      replayed === null ? advanceAndProject(command, driver, statusStore, planHash) : Effect.succeed(replayed),
    ),
    Effect.flatMap((step) =>
      driver.inference === undefined
        ? Effect.succeed(step)
        : driver.inference.pending.pipe(
            Effect.mapError(projectionFailure),
            Effect.map((inferenceJobs) => ({ ...step, inferenceJobs })),
          ),
    ),
  )

const logEffect = (
  level: Parameters<NativeExecutionRuntime['log']>[0],
  message: string,
  annotations: Readonly<Record<string, string | number | boolean>>,
): Effect.Effect<void> => {
  const log = level === 'info' ? Effect.logInfo : level === 'warning' ? Effect.logWarning : Effect.logError
  return log(message).pipe(
    Effect.annotateLogs({
      ...annotations,
      ...currentOpenTelemetryLogAnnotations(),
      service: 'bayn-execution-controller',
    }),
  )
}

export const makeExecutionCycleDriverLive = <E, R>(
  operationTimeoutMs: number,
  prepare: Effect.Effect<BoundRecoveryFirstCycleDriver, E, R>,
) =>
  Layer.effect(
    ExecutionCycleDriver,
    prepare.pipe(
      Effect.mapError((cause) => runtimeError('initialize', 'native execution runtime preparation failed', cause)),
      Effect.timeoutOrElse({
        duration: nativeExecutionRuntimeInitializationTimeoutMs(operationTimeoutMs),
        orElse: () => Effect.fail(runtimeError('initialize', 'native execution driver preparation timed out')),
      }),
    ),
  )

export const ExecutionCycleDriverLive = (plan: ApplicationPlan) =>
  makeExecutionCycleDriverLive(
    plan.config.operationTimeoutMs,
    makeExecutionCycleDriver(plan, nativeExecutionRuntimeInitializationTimeoutMs(plan.config.operationTimeoutMs)).pipe(
      Effect.flatMap(({ driver, context }) =>
        bindRecoveryFirstCycleDriver(
          driver,
          {
            sourceRevision: plan.config.build.sourceRevision,
            imageRepository: plan.config.build.imageRepository,
            imageDigest: plan.config.build.imageDigest,
          },
          plan.config.alpaca.expectedAccountId,
        ).pipe(Effect.provideContext(context)),
      ),
    ),
  )

type NativeExecutionManagedServices = ExecutionCycleDriver | ExecutionControllerStatusStore

type NativeExecutionManagedRuntime<R, E> = ManagedRuntime.ManagedRuntime<R | NativeExecutionManagedServices, E>
type NativeExecutionProjectionRuntime<R, E> = ManagedRuntime.ManagedRuntime<R | ExecutionControllerStatusStore, E>

const runManagedNativeExecutionAdvance = <R, E>(
  executionRunner: NativeExecutionManagedRuntime<R, E>,
  command: AdvanceExecutionCommand,
  signal: AbortSignal,
  planHash: string,
  parent: Tracer.ExternalSpan | undefined,
): Promise<ExecutionAdvanceStepResult> => {
  const advance = Effect.all({
    driver: ExecutionCycleDriver,
    statusStore: ExecutionControllerStatusStore,
  }).pipe(
    Effect.flatMap(({ driver, statusStore }) => executeNativeExecutionAdvance(command, driver, statusStore, planHash)),
  )
  return executionRunner.runPromise(parent === undefined ? advance : advance.pipe(Effect.withParentSpan(parent)), {
    signal,
  })
}

const runManagedControllerStateProjection = <R, E>(
  projectionRunner: NativeExecutionProjectionRuntime<R, E>,
  controllerKey: string,
  state: ExecutionControllerState,
  signal: AbortSignal,
): Promise<void> =>
  projectionRunner.runPromise(
    ExecutionControllerStatusStore.pipe(
      Effect.flatMap((statusStore) => projectExecutionControllerState(controllerKey, state, statusStore)),
    ),
    { signal },
  )

const ownManagedRuntime = <R, E>(
  managed: ManagedRuntime.ManagedRuntime<R, E>,
): Effect.Effect<ManagedRuntime.ManagedRuntime<R, E>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.succeed(managed), (runtime) => runtime.disposeEffect)

export const initializeNativeExecutionProjectionRuntime = <R, E>(
  projectionRunner: NativeExecutionProjectionRuntime<R, E>,
): Effect.Effect<void, NativeExecutionRuntimeError> =>
  Effect.promise((signal) =>
    projectionRunner.runPromiseExit(ExecutionControllerStatusStore.pipe(Effect.asVoid), { signal }),
  ).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.failCause(
            Cause.map(exit.cause, (cause) =>
              runtimeError('initialize', 'native execution controller persistence bootstrap failed', cause),
            ),
          ),
    ),
  )

export const makeRecoveringManagedNativeExecutionRuntimeAdapter = <R, E, ProjectionR, ProjectionE>(
  executionRuntimes: ScopedRef.ScopedRef<NativeExecutionManagedRuntime<R, E>>,
  executionResources: Layer.Layer<R | NativeExecutionManagedServices, E>,
  projectionRunner: NativeExecutionProjectionRuntime<ProjectionR, ProjectionE>,
  hostRunner: ExecutionEffectRunner,
  planHash: string,
  prepareActivation: NativeExecutionRuntime['prepareActivation'],
): NativeExecutionRuntime => {
  const replaceFailedRuntime = (cause: unknown): Promise<never> =>
    hostRunner
      .runPromise(
        ScopedRef.set(executionRuntimes, ownManagedRuntime(ManagedRuntime.make(executionResources))).pipe(
          Effect.uninterruptible,
        ),
      )
      .then(() => {
        throw cause
      })

  return {
    prepareActivation,
    advance: (command, signal) => {
      const parent = currentOpenTelemetryParentSpan()
      const executionRunner = ScopedRef.getUnsafe(executionRuntimes)
      return executionRunner
        .runPromise(Effect.void, { signal })
        .catch(replaceFailedRuntime)
        .then(() =>
          runManagedNativeExecutionAdvance(executionRunner, command, signal, planHash, parent).catch((cause: unknown) =>
            cause instanceof NativeExecutionRuntimeError && cause.operation === 'initialize'
              ? replaceFailedRuntime(cause)
              : Promise.reject(cause),
          ),
        )
    },
    log: (level, message, annotations) => hostRunner.runPromise(logEffect(level, message, annotations)),
    projectState: (controllerKey, state, signal) =>
      runManagedControllerStateProjection(projectionRunner, controllerKey, state, signal),
  }
}

export const prewarmNativeMarketProjection = <E, R>(projection: Layer.Layer<KafkaMarketProjection, E, R>) =>
  Layer.build(projection).pipe(
    Effect.map((context) => {
      const market = Context.get(context, KafkaMarketProjection)
      return { market, layer: Layer.succeed(KafkaMarketProjection, market) }
    }),
    Effect.mapError((cause) => runtimeError('initialize', 'read-only market projection prewarm failed', cause)),
  )

export const awaitNativeMarketProjectionReady = (projection: typeof KafkaMarketProjection.Service) =>
  Effect.gen(function* () {
    while (true) {
      const status = yield* projection.status
      const now = yield* Clock.currentTimeMillis
      const readiness = kafkaHandoffReadiness(status, now)
      if (readiness === KafkaHandoffReadiness.Ready) return
      if (readiness !== KafkaHandoffReadiness.Waiting)
        return yield* runtimeError(
          'initialize',
          'successor market history is unavailable; predecessor was not deactivated',
          {
            readiness,
            ...status,
          },
        )
      yield* Effect.sleep(
        status.bootstrapDeadlineAtMs === null
          ? 1000
          : Math.max(1, Math.min(1000, status.bootstrapDeadlineAtMs - now + 1)),
      )
    }
  })

export const acquireNativeExecutionRuntime = (
  plan: ApplicationPlan,
): Effect.Effect<NativeExecutionRuntimeResource, NativeExecutionRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* Effect.fromResult(executionControllerConfig(plan))
    const metricIdentity = Layer.mergeAll(
      Layer.succeed(Metric.CurrentMetricAttributes, yield* Metric.CurrentMetricAttributes),
      Layer.succeed(Metric.MetricRegistry, yield* Metric.MetricRegistry),
    )
    const { layer: prewarmedProjection, market } = yield* prewarmNativeMarketProjection(
      WorkerMarketProjectionLive(plan),
    )
    const sharedResources = Layer.merge(
      AutonomousWorkerApplicationResourcesLive(plan, prewarmedProjection),
      ExecutionControllerStatusResourceLive(plan.config),
    ).pipe(
      Layer.provideMerge(makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller')),
      Layer.provideMerge(metricIdentity),
    )
    const executionResources = Layer.merge(
      sharedResources,
      ExecutionCycleDriverLive(plan).pipe(Layer.provide(sharedResources)),
    )
    // Kafka is independently supervised in the server scope; bootstrap readiness still gates signal reads.
    // Bootstrap publishes the independent broker observation before activating this lazy execution driver.
    // Endpoint registration itself neither acquires trading state nor grants execution authority.
    const managed = yield* ScopedRef.fromAcquire(ownManagedRuntime(ManagedRuntime.make(executionResources)))

    const projectionManaged = yield* ownManagedRuntime(
      ManagedRuntime.make(ExecutionControllerStatusResourceLive(plan.config).pipe(Layer.provideMerge(metricIdentity))),
    )
    yield* initializeNativeExecutionProjectionRuntime(projectionManaged)
    const logManaged = yield* ownManagedRuntime(
      ManagedRuntime.make(makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller')),
    )
    const runtime = makeRecoveringManagedNativeExecutionRuntimeAdapter(
      managed,
      executionResources,
      projectionManaged,
      logManaged,
      config.planHash,
      (signal) =>
        projectionManaged.runPromise(
          awaitNativeMarketProjectionReady(market).pipe(Effect.andThen(nativeActivationPreflight(plan))),
          { signal },
        ),
    )
    return {
      config,
      runtime,
      inferenceRuntime: {
        executeInference: (jobId, signal) =>
          ScopedRef.getUnsafe(managed).runPromise(
            ExecutionCycleDriver.pipe(
              Effect.flatMap(
                (
                  driver,
                ): Effect.Effect<JevInferenceCompletion | null, NativeExecutionRuntimeError | OperationalError> =>
                  driver.inference === undefined
                    ? Effect.fail(runtimeError('binding', 'native execution driver has no admitted inference port'))
                    : driver.inference.execute(jobId),
              ),
            ),
            { signal },
          ),
      },
      readMarketReadiness: () => projectionManaged.runPromise(market.status.pipe(Effect.map((status) => status.ready))),
      startMarketWakeups: market.startWakeups,
    }
  })
