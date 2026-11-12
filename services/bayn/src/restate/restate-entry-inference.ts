import * as restate from '@restatedev/restate-sdk'
import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { JevInferenceCompletionSchema } from '../jev/inference-work'
import type { JevInferenceCompletion } from '../jev/inference-work'
import { Sha256Schema, SourceRevisionSchema, strictParseOptions } from '../schemas'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import type { ExecutionControllerConfig } from './restate-execution-controller'

export interface EntryInferenceRuntime {
  readonly executeInference: (jobId: string, signal: AbortSignal) => Promise<JevInferenceCompletion | null>
}

export const InferenceDispatchSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.inference-dispatch.v1'),
  controllerKey: Sha256Schema,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceRevision: SourceRevisionSchema,
  jobId: Sha256Schema,
})

/** This service owns paid inference only. All financial work stays on the account object. */
export const makeBaynEntryInference = (
  config: ExecutionControllerConfig,
  runtime: EntryInferenceRuntime,
  hooks: readonly restate.HooksProvider[] = [],
) =>
  restate.service({
    name: 'BaynEntryInference',
    handlers: {
      evaluate: restate.handlers.handler(
        { ingressPrivate: true },
        async (ctx: restate.Context, candidate: unknown): Promise<void> => {
          const request = Schema.decodeUnknownResult(InferenceDispatchSchema, strictParseOptions)(candidate)
          if (Result.isFailure(request)) throw new restate.TerminalError('inference dispatch failed validation')
          const command = request.success
          if (command.controllerKey !== config.controllerKey || command.sourceRevision !== config.sourceRevision)
            throw new restate.TerminalError('inference dispatch differs from its immutable account deployment')

          const execute = async () => {
            // An explicit run policy avoids inheriting the invocation's finite retry cap.
            // The one-way SQL claim prevents another paid call after an uncertain provider outcome.
            const result = await ctx.run(
              'execute admitted Bayn inference',
              () => runtime.executeInference(command.jobId, ctx.request().attemptCompletedSignal),
              { initialRetryInterval: 50, maxRetryInterval: 1_000 },
            )
            const decoded = Schema.decodeUnknownResult(JevInferenceCompletionSchema, strictParseOptions)(result)
            if (Result.isFailure(decoded) || decoded.success.jobId !== command.jobId)
              throw new restate.TerminalError('inference completion does not match its durable admission')
            return decoded.success
          }
          let completion = await execute()
          if (completion.status === 'Pending') {
            // A claimed call may have reached the provider before a worker failed. Wait for its original expiry;
            // the one-way SQL claim prevents this replay from issuing another paid request.
            const deadline = Date.parse(completion.expiresAt)
            const now = await ctx.date.now()
            if (now < deadline) await ctx.sleep({ milliseconds: deadline - now })
            completion = await execute()
          }
          ctx.genericSend({
            service: 'BaynExecutionController',
            method: 'wake',
            key: command.controllerKey,
            parameter: {
              schemaVersion: 'bayn.execution-wakeup.v1',
              _tag: 'InferenceCompleted',
              sourceRevision: command.sourceRevision,
              eventId: sha256(`${command.jobId}:${completion.status}:${completion.completedAt}`),
              epoch: command.epoch,
              jobId: command.jobId,
              batchId: completion.batchId,
              cycleId: completion.cycleId,
              authorityGenerationHash: completion.authorityGenerationHash,
              expiresAt: completion.expiresAt,
              completedAt: completion.completedAt,
            },
            inputSerde: brokerObservationJsonSerde,
            idempotencyKey: `bayn-inference-completion-${command.jobId}`,
          })
        },
      ),
    },
    options: {
      ingressPrivate: true,
      hooks: [...hooks],
      inactivityTimeout: config.operationTimeoutMs * 5 + 60_000,
      abortTimeout: 30_000,
      retryPolicy: { initialInterval: 50, maxInterval: 1_000 },
    },
  })
