import { Effect, Scheduler, Supervisor, type Context, type Exit, type Fiber, type Option } from 'effect'
import { globalValue } from 'effect/GlobalValue'

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
    return Effect.async<A>((resume) => {
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

class WorkflowFiberOwner extends Supervisor.AbstractSupervisor<void> {
  readonly value = Effect.void
  readonly fibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>()

  override onStart<A, E, R>(
    _context: Context.Context<R>,
    _effect: Effect.Effect<A, E, R>,
    _parent: Option.Option<Fiber.RuntimeFiber<unknown, unknown>>,
    fiber: Fiber.RuntimeFiber<A, E>,
  ): void {
    this.fibers.add(fiber)
  }

  override onEnd<A, E>(_exit: Exit.Exit<A, E>, fiber: Fiber.RuntimeFiber<A, E>): void {
    this.fibers.delete(fiber)
  }
}

class WorkflowScheduler extends Scheduler.ControlledScheduler {
  closed = false

  override scheduleTask(...args: Parameters<Scheduler.ControlledScheduler['scheduleTask']>): void {
    if (!this.closed) super.scheduleTask(...args)
  }
}

export class WorkflowActivationRuntime {
  readonly #scheduler = new WorkflowScheduler()
  readonly #owner = new WorkflowFiberOwner()
  readonly #roots: Set<unknown>

  constructor() {
    // Effect 3 retains root fibers until they exit. Durable task disposal must not
    // interrupt workflows and run their finalizers. This executor owns those fibers.
    const scope = globalValue<unknown>(Symbol.for('effect/FiberScope/Global'), () => {
      throw new Error('Effect global fiber scope is unavailable')
    })
    if (typeof scope !== 'object' || scope === null || !('roots' in scope) || !(scope.roots instanceof Set)) {
      throw new Error('Effect global fiber scope has an unsupported shape')
    }
    this.#roots = scope.roots
  }

  fork<A, E>(effect: Effect.Effect<A, E>): Fiber.RuntimeFiber<A, E> {
    if (this.#scheduler.closed) throw new Error('Workflow activation runtime is disposed')
    const fiber = Effect.runFork(effect.pipe(Effect.supervised(this.#owner)), {
      scheduler: this.#scheduler,
      immediate: false,
    })
    this.#owner.fibers.add(fiber)
    fiber.addObserver(() => this.#owner.fibers.delete(fiber))
    this.#detachRoots()
    return fiber
  }

  async drain(settleLocalActivities: () => Promise<void>): Promise<void> {
    if (this.#scheduler.closed) throw new Error('Workflow activation runtime is disposed')
    do {
      if (this.#scheduler.tasks.buckets.length) this.#scheduler.step()
      this.#detachRoots()
      await settleLocalActivities()
      await runOutsideWorkflowLogContext(() => new Promise<void>((resolve) => setImmediate(resolve)))
    } while (this.#scheduler.tasks.buckets.length)
  }

  dispose(): void {
    this.#scheduler.closed = true
    this.#scheduler.tasks.buckets = []
    this.#detachRoots()
    this.#owner.fibers.clear()
  }

  #detachRoots(): void {
    for (const fiber of this.#owner.fibers) this.#roots.delete(fiber)
  }
}
