import { Effect, type Fiber, type Scheduler } from 'effect'

import type { ActivityResolution, NexusOperationResolution } from './context'
import type { WorkflowUpdateInvocation } from './executor'
import type { WorkflowSignalDeliveryInput } from './inbound'
import { runOutsideWorkflowLogContext } from './log'

export type WorkflowActivationJob =
  | { readonly type: 'activity'; readonly id: string; readonly resolution: ActivityResolution }
  | { readonly type: 'nexus'; readonly id: string; readonly resolution: NexusOperationResolution }
  | { readonly type: 'timer'; readonly id: string }
  | { readonly type: 'signal'; readonly delivery: WorkflowSignalDeliveryInput }

export interface WorkflowActivation {
  readonly jobs: readonly WorkflowActivationJob[]
  readonly updates?: readonly WorkflowUpdateInvocation[]
}

export class WorkflowMailbox<A> {
  readonly #values = new Map<string, A[]>()
  readonly #waiters = new Map<string, Set<(value: A) => void>>()

  deliver(key: string, value: A): void {
    const waiters = this.#waiters.get(key)
    const waiter = waiters?.values().next().value
    if (waiter) {
      waiters?.delete(waiter)
      waiter(value)
    } else {
      const values = this.#values.get(key) ?? []
      values.push(value)
      this.#values.set(key, values)
    }
  }

  take(key: string): Effect.Effect<A> {
    return Effect.callback<A>((resume) => {
      const values = this.#values.get(key)
      if (values?.length) {
        resume(Effect.succeed(values.shift()!))
        return
      }
      const waiters = this.#waiters.get(key) ?? new Set<(value: A) => void>()
      const waiter = (value: A) => resume(Effect.succeed(value))
      waiters.add(waiter)
      this.#waiters.set(key, waiters)
      return Effect.sync(() => {
        waiters.delete(waiter)
      })
    })
  }

  takeAll(key: string): Effect.Effect<readonly A[]> {
    return Effect.flatMap(this.take(key), (first) =>
      Effect.sync(() => [first, ...(this.#values.get(key)?.splice(0) ?? [])]),
    )
  }
}

class WorkflowScheduler implements Scheduler.Scheduler, Scheduler.SchedulerDispatcher {
  readonly executionMode = 'async' as const
  closed = false
  #running = false
  #tasks = new Map<number, Array<() => void>>()

  get hasTasks(): boolean {
    return this.#tasks.size > 0
  }

  shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    // Effect 4 callbacks resume synchronously. Keep them inside the activation drain,
    // including late callbacks after disposal, without interrupting durable waits.
    return this.closed || !this.#running || fiber.currentOpCount >= fiber.cache.maxOpsBeforeYield
  }

  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return this
  }

  scheduleTask(task: () => void, priority: number): void {
    if (this.closed) return
    const bucket = this.#tasks.get(priority) ?? []
    bucket.push(task)
    this.#tasks.set(priority, bucket)
  }

  step(): void {
    const tasks = this.#tasks
    this.#tasks = new Map()
    this.#running = true
    try {
      for (const priority of [...tasks.keys()].sort((a, b) => a - b)) {
        for (const task of tasks.get(priority)!) task()
      }
    } finally {
      this.#running = false
    }
  }

  flush(): void {
    while (this.hasTasks) this.step()
  }

  close(): void {
    this.closed = true
    this.#tasks.clear()
  }
}

export class WorkflowActivationRuntime {
  readonly #scheduler = new WorkflowScheduler()

  fork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
    if (this.#scheduler.closed) throw new Error('Workflow activation runtime is disposed')
    return Effect.runFork(effect, { scheduler: this.#scheduler })
  }

  async drain(settleLocalActivities: () => Promise<void>): Promise<void> {
    if (this.#scheduler.closed) throw new Error('Workflow activation runtime is disposed')
    do {
      if (this.#scheduler.hasTasks) this.#scheduler.step()
      await settleLocalActivities()
      await runOutsideWorkflowLogContext(() => new Promise<void>((resolve) => setImmediate(resolve)))
    } while (this.#scheduler.hasTasks)
  }

  dispose(): void {
    this.#scheduler.close()
  }
}
