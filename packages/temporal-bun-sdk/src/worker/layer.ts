import { Context, Effect, Layer } from 'effect'

import type { WorkerRuntimeOptions } from './runtime'
import { WorkerRuntime } from './runtime'

export class WorkerRuntimeService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerRuntime')<
  WorkerRuntimeService,
  WorkerRuntime
>() {}

export const makeWorkerRuntimeEffect = (options: WorkerRuntimeOptions = {}) =>
  Effect.promise(() => WorkerRuntime.create(options))

export const runWorkerEffect = (options: WorkerRuntimeOptions = {}) =>
  Effect.acquireRelease(
    makeWorkerRuntimeEffect(options).pipe(Effect.tap((runtime) => Effect.promise(() => runtime.run()))),
    (runtime) => Effect.promise(() => runtime.shutdown()),
  )

export const createWorkerRuntimeLayer = (options: WorkerRuntimeOptions = {}) =>
  Layer.scoped(WorkerRuntimeService, runWorkerEffect(options))

export const WorkerRuntimeLayer = createWorkerRuntimeLayer()
