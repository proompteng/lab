import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger, Match, Result } from 'effect'

import { constructExecutionDecision, constructObserveShadowDecision } from './shadow-decision'
import type { DecisionConstructionRequest, DecisionConstructionResponse } from './decision-construction'

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
  const request: DecisionConstructionRequest = workerData
  NodeRuntime.runMain(
    Layer.effectDiscard(
      constructDecision(request).pipe(Effect.flatMap((reply) => Effect.sync(() => port.postMessage(reply)))),
    ).pipe(Layer.provide(Logger.layer([])), Layer.launch),
  )
}
