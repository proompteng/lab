import { Cause, Effect, Exit, Fiber, Ref } from 'effect'
import * as Queue from 'effect/Queue'
import * as TSemaphore from 'effect/TSemaphore'
import type { Logger } from '../observability/logger'
import type { Counter } from '../observability/metrics'

export interface WorkerSchedulerOptions {
  readonly workflowConcurrency: number
  readonly activityConcurrency: number
  readonly hooks?: WorkerSchedulerHooks
  readonly logger?: Logger
  readonly metrics?: WorkerSchedulerMetrics
}

export interface WorkerSchedulerHooks {
  readonly onWorkflowStart?: (task: WorkflowTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly onWorkflowComplete?: (task: WorkflowTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly onActivityStart?: (task: ActivityTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly onActivityComplete?: (task: ActivityTaskEnvelope) => Effect.Effect<void, unknown, never>
}

export interface WorkflowTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly execute: () => Effect.Effect<unknown, unknown, never>
}

export interface ActivityTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly handler: (...args: unknown[]) => unknown | Promise<unknown>
  readonly args: unknown[]
}

export interface WorkerSchedulerMetrics {
  readonly workflowTaskStarted?: Counter
  readonly workflowTaskCompleted?: Counter
  readonly activityTaskStarted?: Counter
  readonly activityTaskCompleted?: Counter
}

export interface WorkerScheduler {
  readonly start: Effect.Effect<void, unknown, never>
  readonly stop: Effect.Effect<void, unknown, never>
  readonly enqueueWorkflow: (task: WorkflowTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly enqueueActivity: (task: ActivityTaskEnvelope) => Effect.Effect<void, unknown, never>
}

const DEFAULT_CAPACITY_MULTIPLIER = 4

const sanitizeConcurrency = (value: number): number => (value > 0 ? Math.floor(value) : 1)

const computeCapacity = (concurrency: number): number =>
  Math.max(DEFAULT_CAPACITY_MULTIPLIER * concurrency, concurrency, 1)

const logTaskFailure = (
  label: string,
  cause: Cause.Cause<unknown>,
  logger?: Logger,
): Effect.Effect<void, never, never> => {
  if (!logger) {
    return Effect.void
  }
  return logger.log('error', `${label} task failed`, {
    cause: Cause.pretty(cause),
  })
}

const recordMetric = (counter?: Counter): Effect.Effect<void, never, never> => (counter ? counter.inc() : Effect.void)

export const makeWorkerScheduler = (options: WorkerSchedulerOptions): Effect.Effect<WorkerScheduler, unknown, never> =>
  Effect.gen(function* () {
    const workflowConcurrency = sanitizeConcurrency(options.workflowConcurrency)
    const activityConcurrency = sanitizeConcurrency(options.activityConcurrency)
    const hooks = options.hooks ?? {}

    let workflowQueue = yield* Queue.bounded<WorkflowTaskEnvelope>(computeCapacity(workflowConcurrency))
    let activityQueue = yield* Queue.bounded<ActivityTaskEnvelope>(computeCapacity(activityConcurrency))

    const workflowSemaphore = TSemaphore.unsafeMake(workflowConcurrency)
    const activitySemaphore = TSemaphore.unsafeMake(activityConcurrency)

    const runningRef = yield* Ref.make(false)
    const workflowActiveRef = yield* Ref.make(0)
    const activityActiveRef = yield* Ref.make(0)
    const workflowFiberRef = yield* Ref.make<ReadonlyArray<Fiber.RuntimeFiber<void, unknown>>>([])
    const activityFiberRef = yield* Ref.make<ReadonlyArray<Fiber.RuntimeFiber<void, unknown>>>([])

    const logHookFailure = (hook: string, error: unknown) =>
      options.logger
        ? options.logger.log('warn', 'worker scheduler hook failed', {
            hook,
            error: error instanceof Error ? error.message : String(error),
          })
        : Effect.void

    const runWorkflowTask = (task: WorkflowTaskEnvelope): Effect.Effect<void, unknown, never> => {
      const finalizer = hooks.onWorkflowComplete
        ? hooks.onWorkflowComplete(task).pipe(Effect.catchAll((error) => logHookFailure('workflowComplete', error)))
        : Effect.void
      return Effect.ensuring(
        Effect.gen(function* () {
          if (hooks.onWorkflowStart) {
            yield* hooks.onWorkflowStart(task)
          }
          yield* recordMetric(options.metrics?.workflowTaskStarted)
          yield* task.execute()
          yield* recordMetric(options.metrics?.workflowTaskCompleted)
        }),
        finalizer,
      )
    }

    const runActivityTask = (task: ActivityTaskEnvelope): Effect.Effect<void, unknown, never> => {
      const finalizer = hooks.onActivityComplete
        ? hooks.onActivityComplete(task).pipe(Effect.catchAll((error) => logHookFailure('activityComplete', error)))
        : Effect.void
      return Effect.ensuring(
        Effect.gen(function* () {
          if (hooks.onActivityStart) {
            yield* hooks.onActivityStart(task)
          }
          yield* recordMetric(options.metrics?.activityTaskStarted)
          yield* Effect.tryPromise(async () => await task.handler(...task.args))
          yield* recordMetric(options.metrics?.activityTaskCompleted)
        }),
        finalizer,
      )
    }

    const makeWorkerLoop = <Envelope>(
      queue: Queue.Queue<Envelope>,
      semaphore: TSemaphore.TSemaphore,
      activeRef: Ref.Ref<number>,
      label: 'workflow' | 'activity',
      runner: (task: Envelope) => Effect.Effect<void, unknown, never>,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        while (true) {
          const task = yield* Queue.take(queue)
          yield* Ref.update(activeRef, (count) => count + 1)
          const execute = Effect.scoped(
            TSemaphore.withPermitScoped(semaphore).pipe(
              Effect.zipRight(runner(task).pipe(Effect.ensuring(Ref.update(activeRef, (count) => count - 1)))),
            ),
          )
          yield* Effect.catchAllCause(execute, (cause) =>
            Cause.isInterruptedOnly(cause) ? Effect.void : logTaskFailure(label, cause, options.logger),
          )
        }
      }).pipe(Effect.catchAllCause((cause) => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause))))

    const workflowLoop = () =>
      makeWorkerLoop(workflowQueue, workflowSemaphore, workflowActiveRef, 'workflow', runWorkflowTask)
    const activityLoop = () =>
      makeWorkerLoop(activityQueue, activitySemaphore, activityActiveRef, 'activity', runActivityTask)

    const enqueueWorkflow: WorkerScheduler['enqueueWorkflow'] = (task) =>
      Effect.gen(function* () {
        const offered = yield* workflowQueue.offer(task)
        if (!offered) {
          yield* Effect.fail(new Error('Workflow scheduler is no longer accepting tasks'))
        }
      })

    const enqueueActivity: WorkerScheduler['enqueueActivity'] = (task) =>
      Effect.gen(function* () {
        const offered = yield* activityQueue.offer(task)
        if (!offered) {
          yield* Effect.fail(new Error('Activity scheduler is no longer accepting tasks'))
        }
      })

    const spawnWorkers = (
      count: number,
      factory: () => Effect.Effect<void, never, never>,
    ): Effect.Effect<ReadonlyArray<Fiber.RuntimeFiber<void, unknown>>, unknown, never> =>
      Effect.gen(function* () {
        const fibers: Fiber.RuntimeFiber<void, unknown>[] = []
        for (let index = 0; index < count; index += 1) {
          const fiber = yield* Effect.forkDaemon(factory())
          fibers.push(fiber)
        }
        return fibers
      })

    const start: WorkerScheduler['start'] = Effect.uninterruptible(
      Effect.gen(function* () {
        const alreadyRunning = yield* Ref.get(runningRef)
        if (alreadyRunning) {
          return
        }
        yield* Ref.set(runningRef, true)
        const workflowFibers = yield* spawnWorkers(workflowConcurrency, workflowLoop)
        const activityFibers = yield* spawnWorkers(activityConcurrency, activityLoop)
        yield* Ref.set(workflowFiberRef, workflowFibers)
        yield* Ref.set(activityFiberRef, activityFibers)
      }),
    )

    const awaitDrain = (ref: Ref.Ref<number>): Effect.Effect<void, never, never> =>
      Effect.flatMap(Ref.get(ref), (count) =>
        count === 0 ? Effect.void : Effect.flatMap(Effect.sleep('5 millis'), () => awaitDrain(ref)),
      )

    const joinFibers = (fibers: ReadonlyArray<Fiber.RuntimeFiber<void, unknown>>): Effect.Effect<void, never, never> =>
      Effect.forEach(
        fibers,
        (fiber) =>
          Fiber.await(fiber).pipe(
            Effect.flatMap(
              Exit.matchEffect({
                onFailure: (cause) =>
                  Cause.isInterruptedOnly(cause)
                    ? Effect.void
                    : logTaskFailure('scheduler shutdown', cause, options.logger),
                onSuccess: () => Effect.void,
              }),
            ),
          ),
        { concurrency: 'unbounded' },
      ).pipe(Effect.asVoid)

    const stop: WorkerScheduler['stop'] = Effect.uninterruptible(
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef)
        if (!running) {
          return
        }
        yield* Ref.set(runningRef, false)
        yield* workflowQueue.shutdown
        yield* activityQueue.shutdown
        const workflowFibers = yield* Ref.get(workflowFiberRef)
        const activityFibers = yield* Ref.get(activityFiberRef)
        yield* joinFibers(workflowFibers)
        yield* joinFibers(activityFibers)
        yield* Ref.set(workflowFiberRef, [])
        yield* Ref.set(activityFiberRef, [])
        yield* awaitDrain(workflowActiveRef)
        yield* awaitDrain(activityActiveRef)
        workflowQueue = yield* Queue.bounded<WorkflowTaskEnvelope>(computeCapacity(workflowConcurrency))
        activityQueue = yield* Queue.bounded<ActivityTaskEnvelope>(computeCapacity(activityConcurrency))
      }),
    )

    return {
      start,
      stop,
      enqueueWorkflow,
      enqueueActivity,
    }
  })
