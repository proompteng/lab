import { parentPort } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger, Match, Queue, Result } from 'effect'

import { constructExecutionDecision, constructObserveShadowDecision } from './shadow-decision'
import type {
  DecisionConstructionJob,
  DecisionConstructionReply,
  DecisionConstructionRequest,
  DecisionConstructionResponse,
} from './decision-construction'

export const constructDecision = (request: DecisionConstructionRequest) =>
  Match.value(request).pipe(
    Match.tagsExhaustive({
      Observe: ({ input }) =>
        constructObserveShadowDecision(input).pipe(
          Effect.map((document): DecisionConstructionResponse => ({ _tag: 'Observed', document })),
        ),
      Execution: ({ input }) =>
        constructExecutionDecision(input).pipe(
          Effect.map((document): DecisionConstructionResponse => ({ _tag: 'Executed', document })),
        ),
    }),
    Effect.catchCause((cause) => {
      const failure = Cause.findError(cause)
      return Effect.succeed<DecisionConstructionResponse>(
        Result.isSuccess(failure) && !Cause.hasDies(cause)
          ? {
              _tag: 'Failure',
              failure: failure.success.failure,
              message: failure.success.message,
              cause: Cause.pretty(cause),
            }
          : { _tag: 'Defect', cause: Cause.squash(cause) },
      )
    }),
  )

if (parentPort !== null) {
  const port = parentPort
  const requests = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DecisionConstructionJob>()
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const receive = (job: DecisionConstructionJob) => {
          Queue.offerUnsafe(queue, job)
        }
        port.on('message', receive)
        return receive
      }),
      (receive) =>
        Effect.sync(() => {
          port.off('message', receive)
        }),
    )
    return yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap(({ id, request }) =>
          constructDecision(request).pipe(
            Effect.flatMap((response) =>
              Effect.sync(() => port.postMessage({ id, response } satisfies DecisionConstructionReply)),
            ),
          ),
        ),
      ),
    )
  })
  NodeRuntime.runMain(Layer.effectDiscard(requests).pipe(Layer.provide(Logger.layer([])), Layer.launch))
}
