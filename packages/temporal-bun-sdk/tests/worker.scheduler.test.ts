import { expect, test } from 'bun:test'
import { Effect, Fiber, Ref } from 'effect'
import * as Deferred from 'effect/Deferred'
import * as FiberStatus from 'effect/FiberStatus'

import { makeWorkerScheduler } from '../src/worker/concurrency'

const workflowEnvelope = (
  start: Deferred.Deferred<void>,
  complete: Deferred.Deferred<void>,
  release?: Deferred.Deferred<void>,
) => ({
  taskToken: new Uint8Array([1]),
  execute: () =>
    Effect.gen(function* () {
      yield* Deferred.succeed(start, undefined)
      if (release) {
        yield* Deferred.await(release)
      }
      yield* Deferred.succeed(complete, undefined)
    }),
})

test('workflow scheduler enforces concurrency limits', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scheduler = yield* makeWorkerScheduler({ workflowConcurrency: 2, activityConcurrency: 1 })
      const activeRef = yield* Ref.make(0)
      const peakRef = yield* Ref.make(0)
      const completions = [
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
      ]

      const tasks = completions.map((completion, index) => ({
        taskToken: new Uint8Array([index]),
        execute: () =>
          Effect.gen(function* () {
            yield* Ref.update(activeRef, (current) => current + 1)
            const current = yield* Ref.get(activeRef)
            yield* Ref.update(peakRef, (peak) => (current > peak ? current : peak))
            yield* Effect.sleep('50 millis')
            yield* Ref.update(activeRef, (current) => current - 1)
            yield* Deferred.succeed(completion, undefined)
          }),
      }))

      yield* Effect.acquireUseRelease(
        scheduler.start,
        () =>
          Effect.gen(function* () {
            for (const task of tasks) {
              yield* scheduler.enqueueWorkflow(task)
            }
            yield* Effect.forEach(completions, (deferred) => Deferred.await(deferred))
            const peak = yield* Ref.get(peakRef)
            yield* Effect.sync(() => {
              expect(peak).toBeLessThanOrEqual(2)
              expect(peak).toBeGreaterThanOrEqual(1)
            })
          }),
        () => scheduler.stop,
      )
    }),
  )
})

test('stop waits for in-flight workflow tasks to finish', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scheduler = yield* makeWorkerScheduler({ workflowConcurrency: 1, activityConcurrency: 1 })
      const started = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      yield* scheduler.start
      yield* scheduler.enqueueWorkflow(workflowEnvelope(started, completed, release))

      yield* Deferred.await(started)

      const stopFiber = yield* Effect.fork(scheduler.stop)

      yield* Effect.sleep('20 millis')
      const statusBefore = yield* Fiber.status(stopFiber)
      yield* Effect.sync(() => {
        expect(FiberStatus.isDone(statusBefore)).toBeFalse()
      })

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(completed)
      yield* Fiber.await(stopFiber)

      const isCompleted = yield* Deferred.isDone(completed)
      yield* Effect.sync(() => {
        expect(isCompleted).toBeTrue()
      })
    }),
  )
})

test('records scheduler metrics for workflow and activity tasks', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const workflowStarted = makeMetricCounter()
      const workflowCompleted = makeMetricCounter()
      const activityStarted = makeMetricCounter()
      const activityCompleted = makeMetricCounter()

      const scheduler = yield* makeWorkerScheduler({
        workflowConcurrency: 1,
        activityConcurrency: 1,
        metrics: {
          workflowTaskStarted: workflowStarted.counter,
          workflowTaskCompleted: workflowCompleted.counter,
          activityTaskStarted: activityStarted.counter,
          activityTaskCompleted: activityCompleted.counter,
        },
      })

      yield* scheduler.start

      let workflowRuns = 0
      let activityRuns = 0

      yield* scheduler.enqueueWorkflow({
        taskToken: new Uint8Array([1]),
        execute: () =>
          Effect.gen(function* () {
            yield* Effect.sleep('5 millis')
            workflowRuns += 1
          }),
      })

      yield* scheduler.enqueueActivity({
        taskToken: new Uint8Array([2]),
        handler: async () => {
          activityRuns += 1
        },
        args: [],
      })

      yield* Effect.sleep('20 millis')
      yield* scheduler.stop

      yield* Effect.sync(() => {
        expect(workflowRuns).toBe(1)
        expect(activityRuns).toBe(1)
        expect(workflowStarted.read()).toBe(1)
        expect(workflowCompleted.read()).toBe(1)
        expect(activityStarted.read()).toBe(1)
        expect(activityCompleted.read()).toBe(1)
      })
    }),
  )
})

const makeMetricCounter = () => {
  let count = 0
  return {
    counter: {
      inc: (value = 1) =>
        Effect.sync(() => {
          count += value
        }),
    },
    read: () => count,
  }
}
