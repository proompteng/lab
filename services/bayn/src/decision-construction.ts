import { Worker } from 'node:worker_threads'
import { Context, Effect, Exit, Layer, Match, Semaphore } from 'effect'

import { ShadowDecisionError, type ExecutionDecisionInput, type ObserveShadowDecisionInput } from './shadow-decision'
import {
  retainVerifiedCycleDocument,
  type ExecutionDecisionDocument,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import { Authority } from './execution/contracts'
import { withObservedStage } from './telemetry'
import { observeWorkerMemory, RuntimeIsolate, type RuntimeMemorySample } from './telemetry-memory'

export type DecisionConstructionRequest =
  | { readonly _tag: 'Observe'; readonly input: ObserveShadowDecisionInput }
  | { readonly _tag: 'Execution'; readonly input: ExecutionDecisionInput }

export type DecisionConstructionResponse =
  | { readonly _tag: 'Observed'; readonly document: ObserveShadowDecisionDocument }
  | { readonly _tag: 'Executed'; readonly document: ExecutionDecisionDocument }
  | {
      readonly _tag: 'Failure'
      readonly failure: ShadowDecisionError['failure']
      readonly message: string
      readonly cause: string
    }
  | { readonly _tag: 'Defect'; readonly cause: unknown }

export type DecisionConstructionJob = { readonly id: number; readonly request: DecisionConstructionRequest }
export type DecisionConstructionReply = {
  readonly id: number
  readonly response: DecisionConstructionResponse
  readonly memory: RuntimeMemorySample | undefined
}

export type DecisionConstructionShape = {
  readonly observe: (
    input: ObserveShadowDecisionInput,
  ) => Effect.Effect<ObserveShadowDecisionDocument, ShadowDecisionError>
  readonly execution: (input: ExecutionDecisionInput) => Effect.Effect<ExecutionDecisionDocument, ShadowDecisionError>
}

const failed = (message: string, cause?: unknown) => new ShadowDecisionError({ failure: 'contract', message, cause })

export const makeDecisionConstruction = (
  spawn = () =>
    new Worker(
      new URL(
        import.meta.url.endsWith('.ts') ? './decision-construction-worker.ts' : './decision-construction-worker.js',
        import.meta.url,
      ),
      {
        name: 'bayn-decision-construction',
      },
    ),
) =>
  Effect.gen(function* () {
    const memory = yield* observeWorkerMemory(RuntimeIsolate.DecisionConstruction)
    // Both modes share one permit, including termination of interrupted synchronous work.
    const permit = Semaphore.makeUnsafe(1)
    let worker: Worker | undefined
    let unhealthy = false
    let closed = false
    let nextId = 0
    const onError = () => {
      unhealthy = true
      memory.clear()
    }
    const onExit = () => {
      unhealthy = true
      memory.clear()
    }
    const dispose = () =>
      Effect.promise(async () => {
        const previous = worker
        worker = undefined
        if (previous !== undefined) {
          await previous.terminate()
          previous.off('error', onError)
          previous.off('exit', onExit)
        }
        unhealthy = false
        memory.clear()
      })
    yield* Effect.addFinalizer(() => {
      closed = true
      return dispose()
    })
    const acquire = Effect.gen(function* () {
      if (closed) return yield* failed('Decision construction scope is closed')
      if (unhealthy || worker?.threadId === -1) yield* dispose()
      // Classify this serialized acquisition, not its result or the age of the process.
      // A replacement (or failed spawn) is cold too; never export request or worker identity.
      yield* Effect.annotateCurrentSpan(
        'bayn.decision.worker.lifecycle',
        worker === undefined ? 'cold' : 'reused',
      ).pipe(Effect.catchDefect(() => Effect.void))
      if (worker === undefined) {
        worker = yield* Effect.try({
          try: spawn,
          catch: (cause) => failed('Decision construction worker could not start', cause),
        })
        // Retain idle failures too: an exited worker is replaced, never reused.
        worker.on('error', onError)
        worker.on('exit', onExit)
      }
      return worker
    })
    const construct = (request: DecisionConstructionRequest) =>
      permit.withPermit(
        Effect.acquireUseRelease(
          acquire,
          (worker) =>
            Effect.callback<DecisionConstructionResponse, ShadowDecisionError>((resume) => {
              const id = nextId++
              const cleanup = () => {
                worker.off('message', onMessage)
                worker.off('error', onError)
                worker.off('exit', onExit)
              }
              const settle = (result: Effect.Effect<DecisionConstructionResponse, ShadowDecisionError>) => {
                cleanup()
                resume(result)
              }
              const onMessage = (reply: DecisionConstructionReply) => {
                if (reply?.id === id) memory.receive(reply.memory)
                settle(
                  reply?.id === id
                    ? Effect.succeed(reply.response)
                    : Effect.fail(failed('Decision construction worker returned a different request')),
                )
              }
              const onError = (cause: Error) =>
                settle(Effect.fail(failed('Decision construction worker failed', cause)))
              const onExit = (code: number) =>
                settle(Effect.fail(failed('Decision construction worker exited without a result', { code })))
              worker.once('message', onMessage)
              worker.once('error', onError)
              worker.once('exit', onExit)
              try {
                if (unhealthy || worker.threadId === -1)
                  settle(Effect.fail(failed('Decision construction worker is unavailable')))
                else worker.postMessage({ id, request } satisfies DecisionConstructionJob)
              } catch (cause) {
                settle(Effect.fail(failed('Decision construction worker could not receive the request', cause)))
              }
              return Effect.sync(cleanup)
            }).pipe(
              Effect.flatMap((reply) =>
                Match.value(reply).pipe(
                  Match.tag('Failure', ({ failure, message, cause }) =>
                    Effect.fail(new ShadowDecisionError({ failure, message, cause })),
                  ),
                  Match.tag('Defect', ({ cause }) => Effect.die(cause)),
                  Match.orElse((success) =>
                    (request._tag === 'Observe' && success._tag === 'Observed') ||
                    (request._tag === 'Execution' && success._tag === 'Executed')
                      ? Effect.succeed(success)
                      : Effect.fail(failed('Decision construction worker returned the wrong mode')),
                  ),
                ),
              ),
            ),
          // Never reuse a worker after interruption, failure or defect. Termination
          // finishes before the sole permit is released to the next request.
          (_, exit) => (Exit.isFailure(exit) ? dispose() : Effect.void),
        ).pipe(
          withObservedStage('bayn.execution.decision-build', {
            operation: request._tag === 'Observe' ? Authority.Observe : Authority.Execution,
          }),
        ),
      )
    return {
      observe: (input: ObserveShadowDecisionInput) =>
        construct({ _tag: 'Observe', input }).pipe(
          Effect.flatMap((reply) =>
            reply._tag === 'Observed'
              ? Effect.sync(() => retainVerifiedCycleDocument(reply.document))
              : Effect.fail(failed('Decision construction worker returned the wrong mode')),
          ),
        ),
      execution: (input: ExecutionDecisionInput) =>
        construct({ _tag: 'Execution', input }).pipe(
          Effect.flatMap((reply) =>
            reply._tag === 'Executed'
              ? Effect.sync(() => retainVerifiedCycleDocument(reply.document))
              : Effect.fail(failed('Decision construction worker returned the wrong mode')),
          ),
        ),
    }
  })

export class DecisionConstruction extends Context.Service<DecisionConstruction, DecisionConstructionShape>()(
  'bayn/DecisionConstruction',
) {}

export const DecisionConstructionLive = Layer.effect(DecisionConstruction, makeDecisionConstruction())

export const buildObserveShadowDecision = (input: ObserveShadowDecisionInput) =>
  Effect.flatMap(DecisionConstruction, (construction) => construction.observe(input))
export const buildExecutionDecision = (input: ExecutionDecisionInput) =>
  Effect.flatMap(DecisionConstruction, (construction) => construction.execution(input))
