import { Context, Data, Deferred, Effect, Fiber, Layer, ManagedRuntime, Result, Scope } from 'effect'

import { prepareAutonomousApplication, type ApplicationPlanFor } from '../app'
import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusStore,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { advanceExecutionOnce, TransientExecutionFailure, type AdvanceExecutionCommand } from '../execution/advance'
import { decodeExecutionAdvanceStepResult, type ExecutionAdvanceStepResult } from '../execution/controller'
import { canonicalHashV1Result, sha256 } from '../hash'
import {
  type RecoveryFirstCycleAdvance,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverInterpreter,
  type RecoveryFirstRuntime,
} from '../observe-composition'
import { currentOpenTelemetryLogAnnotations } from '../restate-telemetry'
import type { NativeExecutionRuntime, ExecutionControllerConfig } from '../restate-execution-controller'
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

type BoundRecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, import('../cycle/runner').CycleRunnerError>
  readonly maintainReconciliation: Effect.Effect<void>
  readonly nextDelayMs: number
  readonly wait: (advance: RecoveryFirstCycleAdvance) => Effect.Effect<void>
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
  Result.mapError(
    canonicalHashV1Result({
      schemaVersion: 'bayn.execution-controller-plan.v1',
      brokerIdentityHash: plan.config.alpaca.identity.identityHash,
      sourceRevision: plan.config.build.sourceRevision,
      imageDigest: plan.config.build.imageDigest,
      strategy: plan.strategy.provenance.strategy,
      strategyProtocolHash: plan.strategyProtocolHash,
      capitalActivationRequestHash: sha256(plan.config.capitalActivationRequestJson ?? ''),
      authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
      cyclePollIntervalMs: plan.config.cyclePollIntervalMs,
      reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
      operationTimeoutMs: plan.config.operationTimeoutMs,
    }),
    (cause) => runtimeError('binding', 'native execution controller plan could not be hashed', cause),
  ).pipe(
    Result.map((planHash) => ({
      controllerKey: plan.config.alpaca.identity.identityHash,
      operationTimeoutMs: plan.config.operationTimeoutMs,
      planHash,
      sourceRevision: plan.config.build.sourceRevision,
    })),
  )

const bindRecoveryFirstCycleDriver = (
  driver: RecoveryFirstCycleDriver,
): Effect.Effect<BoundRecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.context<RecoveryFirstRuntime>().pipe(
    Effect.map((context) => ({
      advance: Effect.provideContext(driver.advance, context),
      maintainReconciliation: Effect.provideContext(driver.maintainReconciliation, context),
      nextDelayMs: driver.nextDelayMs,
      wait: (advance) => Effect.provideContext(driver.wait(advance), context),
    })),
  )

export const captureRecoveryFirstCycleDriver =
  (
    target: Deferred.Deferred<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError>,
  ): RecoveryFirstCycleDriverInterpreter =>
  (driver) =>
    bindRecoveryFirstCycleDriver(driver).pipe(
      Effect.flatMap((bound) => Deferred.succeed(target, bound)),
      Effect.flatMap((captured) =>
        captured
          ? Effect.never
          : Effect.die(new Error('native execution runtime attempted to publish more than one cycle driver')),
      ),
    )

const projectionFailure = (cause: unknown): TransientExecutionFailure =>
  new TransientExecutionFailure({
    operation: 'advance',
    message: 'execution controller status projection did not complete',
    cause,
  })

const controllerOutcome = (outcome: 'Blocked' | 'Completed'): ExecutionControllerOutcome =>
  outcome === 'Completed' ? ExecutionControllerOutcome.Completed : ExecutionControllerOutcome.Blocked

const replayProjectedAdvance = (
  command: AdvanceExecutionCommand,
  status: ExecutionControllerStatus | null,
): Result.Result<ExecutionAdvanceStepResult | null, TransientExecutionFailure> => {
  if (
    status === null ||
    status.epoch < command.epoch ||
    (status.epoch === command.epoch && status.lastSequence < command.sequence)
  ) {
    return Result.succeed(null)
  }
  if (
    status.controllerKey !== command.controllerKey ||
    status.epoch !== command.epoch ||
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
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> =>
  advanceExecutionOnce(command, driver).pipe(
    Effect.bindTo('outcome'),
    Effect.bind('completedAt', () => currentUtcInstant.pipe(Effect.mapError(projectionFailure))),
    Effect.let(
      'step',
      ({ completedAt, outcome }): ExecutionAdvanceStepResult => ({
        completedAt,
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
          epoch: command.epoch,
          lastSequence: command.sequence,
          lastOutcome: controllerOutcome(outcome._tag),
          lastReceiptHash: outcome.receiptHash,
          completedAt,
          nextDueAt: new Date(Date.parse(completedAt) + outcome.nextDelayMs).toISOString(),
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
): Effect.Effect<ExecutionAdvanceStepResult, TransientExecutionFailure> =>
  statusStore.read(command.controllerKey).pipe(
    Effect.mapError(projectionFailure),
    Effect.flatMap((status) => Effect.fromResult(replayProjectedAdvance(command, status))),
    Effect.flatMap((replayed) =>
      replayed === null ? advanceAndProject(command, driver, statusStore) : Effect.succeed(replayed),
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
  driver: BoundRecoveryFirstCycleDriver,
  statusStore: ExecutionControllerStatusStoreShape,
  runner: ExecutionEffectRunner,
): NativeExecutionRuntime => ({
  advance: (command, signal) =>
    runner.runPromise(executeNativeExecutionAdvance(command, driver, statusStore), { signal }),
  log: (level, message, annotations) => runner.runPromise(logEffect(level, message, annotations)),
})

const startRuntimePreparation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  target: Deferred.Deferred<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError>,
) =>
  makeAutonomousServiceRuntime(plan, {
    interpretCycleDriver: captureRecoveryFirstCycleDriver(target),
  }).pipe(
    Effect.flatMap(({ dependencies, runtime }) =>
      prepareAutonomousApplication(plan.config, plan.strategy, dependencies, runtime),
    ),
    Effect.flatMap(({ cycleFiber }) =>
      Fiber.await(cycleFiber).pipe(
        Effect.flatMap((exit) =>
          Deferred.fail(
            target,
            runtimeError('initialize', 'native execution cycle stopped before the worker was disposed', exit),
          ),
        ),
        Effect.andThen(Effect.never),
      ),
    ),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Deferred.fail(
        target,
        runtimeError('initialize', 'native execution runtime failed before publishing its cycle driver', cause),
      ).pipe(Effect.asVoid),
    ),
  )

export const acquireNativeExecutionRuntime = (
  plan: ApplicationPlanFor<'AutonomousService'>,
): Effect.Effect<NativeExecutionRuntimeResource, NativeExecutionRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* Effect.fromResult(executionControllerConfig(plan))
    const resources = Layer.mergeAll(
      AutonomousWorkerApplicationResourcesLive(plan),
      ExecutionControllerStatusResourceLive(plan.config),
      makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller'),
    )
    const managed = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(resources)),
      (runtime) =>
        Effect.tryPromise({
          try: () => runtime.dispose(),
          catch: (cause) => runtimeError('dispose', 'native execution runtime did not dispose cleanly', cause),
        }).pipe(Effect.ignore),
    )
    const driverReady = yield* Deferred.make<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError>()
    managed.runFork(startRuntimePreparation(plan, driverReady))
    const driver = yield* Deferred.await(driverReady).pipe(
      Effect.timeoutOrElse({
        duration: nativeExecutionRuntimeInitializationTimeoutMs(plan.config.operationTimeoutMs),
        orElse: () =>
          Effect.fail(runtimeError('initialize', 'native execution runtime did not publish its cycle driver in time')),
      }),
    )
    const context = yield* Effect.tryPromise({
      try: () => managed.context(),
      catch: (cause) => runtimeError('initialize', 'native execution runtime resources failed to initialize', cause),
    })
    const statusStore = Context.get(context, ExecutionControllerStatusStore)
    return {
      config,
      runtime: makeNativeExecutionRuntimeAdapter(driver, statusStore, managed),
    }
  })
