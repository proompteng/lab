import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Ref,
  Result,
  Scope,
  ScopedRef,
} from 'effect'

import { prepareAutonomousApplication, type ApplicationPlanFor } from '../app'
import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusStore,
  executionControllerStatusHasCompletion,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { advanceExecutionOnce, TransientExecutionFailure, type AdvanceExecutionCommand } from '../execution/advance'
import {
  decodeExecutionAdvanceStepResult,
  type ExecutionControllerBinding,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerState,
} from '../execution/controller'
import { sha256 } from '../hash'
import {
  type RecoveryFirstCycleAdvance,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
  type RecoveryFirstRuntime,
} from '../observe-composition'
import { currentOpenTelemetryLogAnnotations } from '../restate/restate-telemetry'
import type { NativeExecutionRuntime, ExecutionControllerConfig } from '../restate/restate-execution-controller'
import { currentUtcInstant } from '../time'
import { makeConfiguredTelemetryRuntimeLayer } from '../telemetry'
import { makeAutonomousServiceRuntime } from './autonomous-runtime'
import { AutonomousWorkerApplicationResourcesLive, ExecutionControllerStatusResourceLive } from './resources'

export class NativeExecutionRuntimeError extends Data.TaggedError('NativeExecutionRuntimeError')<{
  readonly operation: 'binding' | 'dispose' | 'initialize'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface NativeExecutionRuntimeResource {
  readonly config: ExecutionControllerConfig
  readonly runtime: NativeExecutionRuntime
}

export const nativeExecutionRuntimeInitializationTimeoutMs = (operationTimeoutMs: number): number =>
  operationTimeoutMs * 5

/**
 * Restate's durable controller identity describes the orchestration protocol, not a deployable worker revision.
 * Trading authority, strategy, market-data and risk bindings remain validated by each execution pass.
 */
export const executionControllerPlanHash = sha256('bayn.execution-controller-plan.v2')

export type BoundRecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, import('../cycle/runner').CycleRunnerError>
  readonly nextDelayMs: number
}

export class PublishedExecutionCycleDriver extends Context.Service<
  PublishedExecutionCycleDriver,
  RecoveryFirstCycleDriverSlot
>()('@proompteng/bayn/composition/native-execution-runtime/PublishedExecutionCycleDriver') {}

export type RecoveryFirstCycleDriverSlotState =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Ready'; readonly driver: BoundRecoveryFirstCycleDriver }
  | { readonly _tag: 'Failed'; readonly error: NativeExecutionRuntimeError }

export interface RecoveryFirstCycleDriverSlot {
  readonly state: Ref.Ref<RecoveryFirstCycleDriverSlotState>
  readonly ready: Deferred.Deferred<void, NativeExecutionRuntimeError>
}

interface ExecutionEffectRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }) => Promise<A>
}

const runtimeError = (
  operation: NativeExecutionRuntimeError['operation'],
  message: string,
  cause?: unknown,
): NativeExecutionRuntimeError => new NativeExecutionRuntimeError({ operation, message, cause })

export const executionControllerConfig = (
  plan: ApplicationPlanFor<'AutonomousService'>,
): Result.Result<ExecutionControllerConfig, NativeExecutionRuntimeError> =>
  Result.succeed({
    controllerKey: plan.config.alpaca.identity.identityHash,
    operationTimeoutMs: plan.config.operationTimeoutMs,
    planHash: executionControllerPlanHash,
    sourceRevision: plan.config.build.sourceRevision,
  })

const bindRecoveryFirstCycleDriver = (
  driver: RecoveryFirstCycleDriver,
): Effect.Effect<BoundRecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.context<RecoveryFirstRuntime>().pipe(
    Effect.map((context) => ({
      advance: Effect.provideContext(driver.advance, context),
      nextDelayMs: driver.nextDelayMs,
    })),
  )

export const captureRecoveryFirstCycleDriver =
  (slot: RecoveryFirstCycleDriverSlot): RecoveryFirstCycleDriverOwner =>
  (driver) =>
    bindRecoveryFirstCycleDriver(driver).pipe(
      Effect.flatMap((bound) =>
        Ref.set(slot.state, { _tag: 'Ready', driver: bound }).pipe(
          Effect.andThen(Deferred.succeed(slot.ready, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Ref.update(slot.state, (state) =>
              state._tag === 'Ready' && state.driver === bound ? ({ _tag: 'Pending' } as const) : state,
            ),
          ),
        ),
      ),
    )

export const failRecoveryFirstCycleDriverSlot = (
  slot: RecoveryFirstCycleDriverSlot,
  error: NativeExecutionRuntimeError,
): Effect.Effect<void> =>
  Ref.set(slot.state, { _tag: 'Failed', error }).pipe(Effect.andThen(Deferred.fail(slot.ready, error)), Effect.asVoid)

export const readRecoveryFirstCycleDriverSlot = (
  slot: RecoveryFirstCycleDriverSlot,
): Effect.Effect<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError> =>
  Ref.get(slot.state).pipe(
    Effect.flatMap((state) => {
      switch (state._tag) {
        case 'Ready':
          return Effect.succeed(state.driver)
        case 'Failed':
          return Effect.fail(state.error)
        case 'Pending':
          return Effect.fail(runtimeError('initialize', 'native execution runtime driver is unavailable'))
      }
    }),
  )

const projectionFailure = (cause: unknown): TransientExecutionFailure =>
  new TransientExecutionFailure({
    operation: 'advance',
    message: 'execution controller status projection did not complete',
    cause,
  })

const controllerOutcome = (outcome: 'Blocked' | 'Completed'): ExecutionControllerOutcome =>
  outcome === 'Completed' ? ExecutionControllerOutcome.Completed : ExecutionControllerOutcome.Blocked

const legacyUnboundControllerPlanHash = '0'.repeat(64)

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

export const projectExecutionControllerState = (
  controllerKey: string,
  state: ExecutionControllerState,
  statusStore: ExecutionControllerStatusStoreShape,
): Effect.Effect<void, TransientExecutionFailure> => {
  const completion = state.lastCompletion
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
          ...(completion.lastPass === undefined ? {} : { lastPass: completion.lastPass }),
        }),
  })
}

const replayProjectedAdvance = (
  command: AdvanceExecutionCommand,
  status: ExecutionControllerStatus | null,
  planHash: string,
): Result.Result<ExecutionAdvanceStepResult | null, TransientExecutionFailure> => {
  if (status === null || status.epoch < command.epoch) return Result.succeed(null)
  const legacyPlanCanBind =
    status.planHash === legacyUnboundControllerPlanHash && status.nextSequence <= command.sequence
  if (
    status.controllerKey !== command.controllerKey ||
    (status.planHash !== planHash && !legacyPlanCanBind) ||
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
  if (status.nextDueAt === undefined) {
    return Result.fail(projectionFailure('replayed controller status does not retain its next due time'))
  }
  return Result.mapError(
    decodeExecutionAdvanceStepResult({
      completedAt: status.completedAt,
      ...(status.lastPass === undefined ? {} : { observation: status.lastPass }),
      outcome: {
        _tag: status.lastOutcome,
        receiptHash: status.lastReceiptHash,
        nextDelayMs: Date.parse(status.nextDueAt) - Date.parse(status.completedAt),
      },
    }),
    projectionFailure,
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
          nextDelayMs: outcome.nextDelayMs,
        },
      }),
    ),
    Effect.tap(({ completedAt, outcome }) =>
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
          nextDueAt: new Date(Date.parse(completedAt) + outcome.nextDelayMs).toISOString(),
          lastPass: outcome.observation,
        })
        .pipe(
          Effect.flatMap((projection) =>
            projection._tag === 'Stale'
              ? Effect.fail(projectionFailure('controller status rejected a stale execution completion'))
              : Effect.void,
          ),
          Effect.mapError(projectionFailure),
        ),
    ),
    Effect.map(({ step }) => step),
  )

export const executeNativeExecutionAdvance = (
  command: AdvanceExecutionCommand,
  driver: BoundRecoveryFirstCycleDriver,
  statusStore: ExecutionControllerStatusStoreShape,
  planHash: string,
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> =>
  statusStore.read(command.controllerKey).pipe(
    Effect.mapError(projectionFailure),
    Effect.flatMap((status) => Effect.fromResult(replayProjectedAdvance(command, status, planHash))),
    Effect.flatMap((replayed) =>
      replayed === null ? advanceAndProject(command, driver, statusStore, planHash) : Effect.succeed(replayed),
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

export const makeNativeExecutionRuntimeAdapter = (
  driver: Effect.Effect<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError>,
  statusStore: ExecutionControllerStatusStoreShape,
  runner: ExecutionEffectRunner,
  planHash: string,
): NativeExecutionRuntime => ({
  advance: (command, signal) =>
    runner.runPromise(
      driver.pipe(Effect.flatMap((current) => executeNativeExecutionAdvance(command, current, statusStore, planHash))),
      { signal },
    ),
  log: (level, message, annotations) => runner.runPromise(logEffect(level, message, annotations)),
  projectState: (controllerKey, state, signal) =>
    runner.runPromise(projectExecutionControllerState(controllerKey, state, statusStore), { signal }),
})

const startRuntimePreparation = (plan: ApplicationPlanFor<'AutonomousService'>, slot: RecoveryFirstCycleDriverSlot) =>
  makeAutonomousServiceRuntime(plan, {
    ownCycleDriver: captureRecoveryFirstCycleDriver(slot),
  }).pipe(
    Effect.flatMap(({ dependencies, runtime }) =>
      prepareAutonomousApplication(plan.config, plan.strategy, dependencies, runtime),
    ),
    Effect.flatMap(({ cycleFiber }) =>
      Fiber.await(cycleFiber).pipe(
        Effect.flatMap((exit) =>
          failRecoveryFirstCycleDriverSlot(
            slot,
            runtimeError('initialize', 'native execution cycle stopped before the worker was disposed', exit),
          ),
        ),
      ),
    ),
    Effect.scoped,
    Effect.catchCause((cause) =>
      failRecoveryFirstCycleDriverSlot(
        slot,
        runtimeError('initialize', 'native execution runtime preparation failed', cause),
      ),
    ),
  )

export const awaitNativeExecutionRuntimeDriver = (
  slot: RecoveryFirstCycleDriverSlot,
  operationTimeoutMs: number,
): Effect.Effect<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError> =>
  Deferred.await(slot.ready).pipe(
    Effect.timeoutOrElse({
      duration: nativeExecutionRuntimeInitializationTimeoutMs(operationTimeoutMs),
      orElse: () =>
        Effect.fail(runtimeError('initialize', 'native execution runtime did not publish its cycle driver in time')),
    }),
    Effect.andThen(readRecoveryFirstCycleDriverSlot(slot)),
  )

export const makePublishedExecutionCycleDriverLive = <R>(
  operationTimeoutMs: number,
  prepare: (slot: RecoveryFirstCycleDriverSlot) => Effect.Effect<void, never, R>,
) =>
  Layer.effect(
    PublishedExecutionCycleDriver,
    Effect.gen(function* () {
      const slot: RecoveryFirstCycleDriverSlot = {
        state: yield* Ref.make<RecoveryFirstCycleDriverSlotState>({ _tag: 'Pending' }),
        ready: yield* Deferred.make<void, NativeExecutionRuntimeError>(),
      }
      yield* prepare(slot).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* awaitNativeExecutionRuntimeDriver(slot, operationTimeoutMs)
      return slot
    }),
  )

export const PublishedExecutionCycleDriverLive = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  makePublishedExecutionCycleDriverLive(plan.config.operationTimeoutMs, (slot) => startRuntimePreparation(plan, slot))

type NativeExecutionManagedServices = PublishedExecutionCycleDriver | ExecutionControllerStatusStore

type NativeExecutionManagedRuntime<R, E> = ManagedRuntime.ManagedRuntime<R | NativeExecutionManagedServices, E>
type NativeExecutionProjectionRuntime<R, E> = ManagedRuntime.ManagedRuntime<R | ExecutionControllerStatusStore, E>

const runManagedNativeExecutionAdvance = <R, E>(
  executionRunner: NativeExecutionManagedRuntime<R, E>,
  command: AdvanceExecutionCommand,
  signal: AbortSignal,
  planHash: string,
): Promise<ExecutionAdvanceStepResult> =>
  executionRunner.runPromise(
    Effect.all({ driverSlot: PublishedExecutionCycleDriver, statusStore: ExecutionControllerStatusStore }).pipe(
      Effect.flatMap(({ driverSlot, statusStore }) =>
        readRecoveryFirstCycleDriverSlot(driverSlot).pipe(
          Effect.flatMap((driver) => executeNativeExecutionAdvance(command, driver, statusStore, planHash)),
        ),
      ),
    ),
    { signal },
  )

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

export const makeManagedNativeExecutionRuntimeAdapter = <R, E>(
  executionRunner: NativeExecutionManagedRuntime<R, E>,
  logRunner: ExecutionEffectRunner,
  planHash: string,
): NativeExecutionRuntime => ({
  advance: (command, signal) => runManagedNativeExecutionAdvance(executionRunner, command, signal, planHash),
  log: (level, message, annotations) => logRunner.runPromise(logEffect(level, message, annotations)),
  projectState: (controllerKey, state, signal) =>
    runManagedControllerStateProjection(executionRunner, controllerKey, state, signal),
})

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

export const initializeNativeExecutionRuntime = <R, E>(
  executionRunner: NativeExecutionManagedRuntime<R, E>,
): Effect.Effect<void, NativeExecutionRuntimeError> =>
  Effect.promise((signal) =>
    executionRunner.runPromiseExit(PublishedExecutionCycleDriver.pipe(Effect.asVoid), { signal }),
  ).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.failCause(
            Cause.map(exit.cause, (cause) =>
              runtimeError('initialize', 'native execution controller runtime bootstrap failed', cause),
            ),
          ),
    ),
  )

export const initializeNativeExecutionRuntimeForBinding = <R, E>(
  executionRunner: NativeExecutionManagedRuntime<R, E>,
  previousBinding: ExecutionControllerBinding | undefined,
): Effect.Effect<void, NativeExecutionRuntimeError> =>
  previousBinding === undefined ? initializeNativeExecutionRuntime(executionRunner) : Effect.void

export const makeRecoveringManagedNativeExecutionRuntimeAdapter = <R, E, ProjectionR, ProjectionE>(
  executionRuntimes: ScopedRef.ScopedRef<NativeExecutionManagedRuntime<R, E>>,
  executionResources: Layer.Layer<R | NativeExecutionManagedServices, E>,
  projectionRunner: NativeExecutionProjectionRuntime<ProjectionR, ProjectionE>,
  hostRunner: ExecutionEffectRunner,
  planHash: string,
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
    advance: (command, signal) => {
      const executionRunner = ScopedRef.getUnsafe(executionRuntimes)
      return executionRunner
        .runPromise(Effect.void, { signal })
        .catch(replaceFailedRuntime)
        .then(() =>
          runManagedNativeExecutionAdvance(executionRunner, command, signal, planHash).catch((cause: unknown) =>
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

export const acquireNativeExecutionRuntime = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  previousBinding?: ExecutionControllerBinding,
): Effect.Effect<NativeExecutionRuntimeResource, NativeExecutionRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const baseConfig = yield* Effect.fromResult(executionControllerConfig(plan))
    const config: ExecutionControllerConfig =
      previousBinding === undefined ? baseConfig : { ...baseConfig, previousBinding }
    const sharedResources = Layer.mergeAll(
      AutonomousWorkerApplicationResourcesLive(plan),
      ExecutionControllerStatusResourceLive(plan.config),
      makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller'),
    )
    const executionResources = Layer.merge(
      sharedResources,
      PublishedExecutionCycleDriverLive(plan).pipe(Layer.provide(sharedResources)),
    )
    // Restate must register a replacement endpoint before its operator drains the previous version. For an exact
    // predecessor-bound rotation, keep execution-driver preparation lazy until the first durable tick so the new
    // endpoint becomes ready without performing trading-state startup before activation transfers controller ownership.
    // Fresh startup has no predecessor to drain, so it still acquires the execution driver eagerly and fails closed
    // before exposing an unusable endpoint. PostgreSQL write exclusion itself is transaction-scoped.
    const managed = yield* ScopedRef.fromAcquire(ownManagedRuntime(ManagedRuntime.make(executionResources)))
    yield* initializeNativeExecutionRuntimeForBinding(ScopedRef.getUnsafe(managed), previousBinding)
    const projectionManaged = yield* ownManagedRuntime(
      ManagedRuntime.make(ExecutionControllerStatusResourceLive(plan.config)),
    )
    yield* initializeNativeExecutionProjectionRuntime(projectionManaged)
    const logManaged = yield* ownManagedRuntime(
      ManagedRuntime.make(makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller')),
    )
    return {
      config,
      runtime: makeRecoveringManagedNativeExecutionRuntimeAdapter(
        managed,
        executionResources,
        projectionManaged,
        logManaged,
        config.planHash,
      ),
    }
  })
