import { Worker } from 'node:worker_threads'
import { Context, Effect, Match, Semaphore } from 'effect'

import { ShadowDecisionError, type ExecutionDecisionInput, type ObserveShadowDecisionInput } from './shadow-decision'
import {
  retainVerifiedCycleDocument,
  type ExecutionDecisionDocument,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import { Authority } from './execution/contracts'
import { withObservedStage } from './telemetry'

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

const failed = (message: string, cause?: unknown) => new ShadowDecisionError({ failure: 'contract', message, cause })

export const makeDecisionConstruction = (
  spawn = (request: DecisionConstructionRequest) =>
    new Worker(
      new URL(
        import.meta.url.endsWith('.ts') ? './decision-construction-worker.ts' : './decision-construction-worker.js',
        import.meta.url,
      ),
      {
        name: 'bayn-decision-construction',
        workerData: request,
      },
    ),
) => {
  // Both modes share one permit, including termination of interrupted synchronous work.
  const permit = Semaphore.makeUnsafe(1)
  const construct = (request: DecisionConstructionRequest) =>
    permit.withPermit(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => spawn(request),
          catch: (cause) => failed('Decision construction worker could not start', cause),
        }),
        (worker) =>
          Effect.callback<DecisionConstructionResponse, ShadowDecisionError>((resume) => {
            const onMessage = (reply: DecisionConstructionResponse) => resume(Effect.succeed(reply))
            const onError = (cause: Error) => resume(Effect.fail(failed('Decision construction worker failed', cause)))
            const onExit = (code: number) =>
              resume(Effect.fail(failed('Decision construction worker exited without a result', { code })))
            worker.once('message', onMessage)
            worker.once('error', onError)
            worker.once('exit', onExit)
            return Effect.sync(() => {
              worker.off('message', onMessage)
              worker.off('error', onError)
              worker.off('exit', onExit)
            })
          }),
        (worker) => Effect.promise(() => worker.terminate()),
      ).pipe(
        Effect.flatMap((reply) =>
          Match.value(reply).pipe(
            Match.tag('Failure', ({ failure, message, cause }) =>
              Effect.fail(new ShadowDecisionError({ failure, message, cause })),
            ),
            Match.tag('Defect', ({ cause }) => Effect.die(cause)),
            Match.orElse((success) => Effect.succeed(success)),
          ),
        ),
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
}

export const DecisionConstruction = Context.Reference<ReturnType<typeof makeDecisionConstruction>>(
  'bayn/DecisionConstruction',
  { defaultValue: makeDecisionConstruction },
)

export const buildObserveShadowDecision = (input: ObserveShadowDecisionInput) =>
  Effect.flatMap(DecisionConstruction, (construction) => construction.observe(input))
export const buildExecutionDecision = (input: ExecutionDecisionInput) =>
  Effect.flatMap(DecisionConstruction, (construction) => construction.execution(input))
