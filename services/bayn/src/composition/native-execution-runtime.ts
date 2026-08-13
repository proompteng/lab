import { Context, Data, Deferred, Effect, Fiber, Layer, ManagedRuntime, Ref, Result, Scope } from 'effect'

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

export type BoundRecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, import('../cycle/runner').CycleRunnerError>
  readonly maintainReconciliation: Effect.Effect<void>
  readonly nextDelayMs: number
  readonly wait: (advance: RecoveryFirstCycleAdvance) => Effect.Effect<void>
}

export interface RecoveryFirstCycleDriverSlot {
  readonly current: Ref.Ref<BoundRecoveryFirstCycleDriver | null>
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
  Result.mapError(
    canonicalHashV1Result({
      schemaVersion: 'bayn.execution-controller-plan.v1',
      brokerIdentityHash: plan.config.alpaca.identity.identityHash,
      sourceRevision: plan.config.build.sourceRevision,
      imageDigest: plan.config.build.imageDigest,
      strategy: plan.strategy.provenance.strategy,
      strategyProtocolHash: plan.strategyProtocolHash,
      qualificationRunId: plan.config.qualificationRunId ?? null,
      marketData: {
        snapshotId: plan.config.clickhouse.snapshotId,
        publicationAsOf: plan.config.clickhouse.publicationAsOf,
        calendarVersion: plan.config.clickhouse.calendarVersion,
        bounds: plan.config.clickhouse.bounds,
      },
      capitalActivationRequestHash: sha256(plan.config.capitalActivationRequestJson ?? ''),
      authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
      executionPolicy: {
        brokerAccess: plan.config.execution.brokerAccess,
        capitalAuthority: plan.config.execution.capitalAuthority._tag,
        persistedCapitalGrantHash:
          'persistedGrantHash' in plan.config.execution.capitalAuthority
            ? (plan.config.execution.capitalAuthority.persistedGrantHash ?? null)
            : null,
      },
      accounting: {
        tigerBeetleClusterId: plan.config.tigerBeetle.clusterId.toString(),
        tigerBeetleLedger: plan.config.tigerBeetle.ledger,
      },
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
  (slot: RecoveryFirstCycleDriverSlot): RecoveryFirstCycleDriverInterpreter =>
  (driver) =>
    bindRecoveryFirstCycleDriver(driver).pipe(
      Effect.tap((bound) => Ref.set(slot.current, bound)),
      Effect.tap(() => Deferred.succeed(slot.ready, undefined)),
      Effect.andThen(Effect.never),
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
  driver: Effect.Effect<BoundRecoveryFirstCycleDriver, NativeExecutionRuntimeError>,
  statusStore: ExecutionControllerStatusStoreShape,
  runner: ExecutionEffectRunner,
): NativeExecutionRuntime => ({
  advance: (command, signal) =>
    runner.runPromise(
      driver.pipe(Effect.flatMap((current) => executeNativeExecutionAdvance(command, current, statusStore))),
      { signal },
    ),
  log: (level, message, annotations) => runner.runPromise(logEffect(level, message, annotations)),
})

const startRuntimePreparation = (plan: ApplicationPlanFor<'AutonomousService'>, slot: RecoveryFirstCycleDriverSlot) =>
  makeAutonomousServiceRuntime(plan, {
    interpretCycleDriver: captureRecoveryFirstCycleDriver(slot),
  }).pipe(
    Effect.flatMap(({ dependencies, runtime }) =>
      prepareAutonomousApplication(plan.config, plan.strategy, dependencies, runtime),
    ),
    Effect.flatMap(({ cycleFiber }) =>
      Fiber.await(cycleFiber).pipe(
        Effect.flatMap((exit) =>
          Deferred.fail(
            slot.ready,
            runtimeError('initialize', 'native execution cycle stopped before the worker was disposed', exit),
          ),
        ),
        Effect.andThen(Effect.never),
      ),
    ),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Deferred.fail(
        slot.ready,
        runtimeError('initialize', 'native execution runtime failed before publishing its cycle driver', cause),
      ).pipe(Effect.asVoid),
    ),
  )

export const acquireScopedManagedRuntime = <R, E>(
  managed: ManagedRuntime.ManagedRuntime<R, E>,
  preparation: Effect.Effect<unknown, never, R>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(Effect.succeed(managed), (runtime) => runtime.disposeEffect)
    yield* Effect.acquireRelease(
      Effect.sync(() => owned.runFork(preparation)),
      (fiber) => Fiber.interrupt(fiber),
    )
  })

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
    Effect.andThen(
      Ref.get(slot.current).pipe(
        Effect.flatMap((driver) =>
          driver === null
            ? Effect.fail(runtimeError('initialize', 'native execution runtime signaled readiness without a driver'))
            : Effect.succeed(driver),
        ),
      ),
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
    const driverSlot: RecoveryFirstCycleDriverSlot = {
      current: yield* Ref.make<BoundRecoveryFirstCycleDriver | null>(null),
      ready: yield* Deferred.make<void, NativeExecutionRuntimeError>(),
    }
    const managed = ManagedRuntime.make(resources)
    yield* acquireScopedManagedRuntime(managed, startRuntimePreparation(plan, driverSlot))
    yield* awaitNativeExecutionRuntimeDriver(driverSlot, plan.config.operationTimeoutMs)
    const context = yield* Effect.tryPromise({
      try: () => managed.context(),
      catch: (cause) => runtimeError('initialize', 'native execution runtime resources failed to initialize', cause),
    })
    const statusStore = Context.get(context, ExecutionControllerStatusStore)
    return {
      config,
      runtime: makeNativeExecutionRuntimeAdapter(
        Ref.get(driverSlot.current).pipe(
          Effect.flatMap((driver) =>
            driver === null
              ? Effect.fail(runtimeError('initialize', 'native execution runtime driver is unavailable'))
              : Effect.succeed(driver),
          ),
        ),
        statusStore,
        managed,
      ),
    }
  })
