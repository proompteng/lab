import { executionServiceName } from './execution-service-names'
import * as restate from '@restatedev/restate-sdk'
import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import {
  JevInferenceCompletionSchema,
  maximumWatchedInferenceJobs,
  type JevInferenceCompletion,
  type JevInferenceWatchResult,
} from '../jev/inference-work'
import { Sha256Schema, SourceRevisionSchema, strictParseOptions } from '../schemas'
import { brokerObservationJsonSerde } from './restate-broker-observations'
import type { ExecutionControllerConfig } from './restate-execution-controller'

export interface EntryInferenceRuntime {
  readonly executeInference: (command: InferenceDispatch, signal: AbortSignal) => Promise<JevInferenceCompletion | null>
  readonly awaitDispatch: (
    scope: InferenceControllerEpoch,
    pending: readonly string[],
    signal: AbortSignal,
  ) => Promise<JevInferenceWatchResult>
}

const InferenceControllerEpochSchema = Schema.Struct({
  controllerKey: Sha256Schema,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceRevision: SourceRevisionSchema,
})
type InferenceControllerEpoch = typeof InferenceControllerEpochSchema.Type

export const InferenceDispatchSchema = Schema.Struct({
  ...InferenceControllerEpochSchema.fields,
  schemaVersion: Schema.Literal('bayn.inference-dispatch.v1'),
  jobId: Sha256Schema,
})
export type InferenceDispatch = typeof InferenceDispatchSchema.Type

const PendingJobs = Schema.Array(Sha256Schema).check(Schema.isMaxLength(maximumWatchedInferenceJobs))
const InferenceWatchSchema = Schema.Struct({
  ...InferenceControllerEpochSchema.fields,
  schemaVersion: Schema.Literal('bayn.inference-watch.v1'),
  pending: PendingJobs,
})
const InferenceWatchResultSchema = Schema.Union([
  Schema.Struct({ active: Schema.Literal(false) }),
  Schema.Struct({ active: Schema.Literal(true), pending: PendingJobs, dispatch: PendingJobs }),
])

export const startInferenceWatch = (
  ctx: restate.Context,
  servicePrefix: string | undefined,
  scope: InferenceControllerEpoch,
) =>
  ctx.genericSend({
    service: executionServiceName('inference', servicePrefix),
    method: 'watch',
    parameter: { ...scope, schemaVersion: 'bayn.inference-watch.v1', pending: [] },
    inputSerde: brokerObservationJsonSerde,
    idempotencyKey: `bayn-inference-watch-${scope.controllerKey}-${scope.epoch}`,
  })

/** This service owns paid inference only. All financial work stays on the account object. */
export const makeBaynEntryInference = (
  config: ExecutionControllerConfig,
  runtime: EntryInferenceRuntime,
  hooks: readonly restate.HooksProvider[] = [],
) =>
  restate.service({
    name: executionServiceName('inference', config.servicePrefix),
    handlers: {
      watch: restate.handlers.handler(
        { ingressPrivate: true },
        async (ctx: restate.Context, candidate: unknown): Promise<void> => {
          const request = Schema.decodeUnknownResult(InferenceWatchSchema, strictParseOptions)(candidate)
          if (Result.isFailure(request)) throw new restate.TerminalError('inference watch failed validation')
          const { schemaVersion, pending, ...scope } = request.success
          // Restate can route a departing watch's continuation to the newly registered revision.
          if (scope.sourceRevision !== config.sourceRevision) return
          if (scope.controllerKey !== config.controllerKey)
            throw new restate.TerminalError('inference watch differs from its immutable account deployment')
          const observed = await ctx.run(
            'await committed Bayn inference work',
            () => runtime.awaitDispatch(scope, pending, ctx.request().attemptCompletedSignal),
            { initialRetryInterval: 50, maxRetryInterval: 1_000 },
          )
          const result = Schema.decodeUnknownResult(InferenceWatchResultSchema, strictParseOptions)(observed)
          if (Result.isFailure(result)) throw new restate.TerminalError('inference watch returned invalid work')
          if (!result.success.active) return

          for (const jobId of result.success.dispatch) {
            ctx.genericSend({
              service: executionServiceName('inference', config.servicePrefix),
              method: 'evaluate',
              parameter: { ...scope, schemaVersion: 'bayn.inference-dispatch.v1', jobId },
              inputSerde: brokerObservationJsonSerde,
              idempotencyKey: `bayn-inference-${scope.epoch}-${jobId}`,
            })
          }
          // Each scoped wait closes its listener and keeps the invocation journal bounded.
          ctx.genericSend({
            service: executionServiceName('inference', config.servicePrefix),
            method: 'watch',
            parameter: { ...scope, schemaVersion, pending: result.success.pending },
            inputSerde: brokerObservationJsonSerde,
            idempotencyKey: `bayn-inference-watch-next-${ctx.request().id}`,
          })
        },
      ),
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
              () => runtime.executeInference(command, ctx.request().attemptCompletedSignal),
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
            service: executionServiceName('controller', config.servicePrefix),
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
            idempotencyKey: `bayn-inference-completion-${command.epoch}-${command.jobId}`,
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
