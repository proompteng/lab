import { Data, Result, Schema } from 'effect'

import { lifecycleCommandId, LifecycleControllerKeySchema, LifecycleSequenceSchema } from './lifecycle-command-contract'
import { maximumOperationalThresholdMs, minimumOperationalThresholdMs } from './config/model'
import { sha256 } from './hash'
import { AutonomousCyclePassObservationSchema } from './runtime-state'
import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'

export const OperationalThresholdSchema = Schema.Int.check(
  Schema.isBetween({ minimum: minimumOperationalThresholdMs, maximum: maximumOperationalThresholdMs }),
)
const NextDelayMsSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumOperationalThresholdMs }))
const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
const EpochSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

export const RestateLifecycleConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.restate-lifecycle-config.v1'),
  controllerKey: LifecycleControllerKeySchema,
  commandBaseUrl: Schema.Trim.check(Schema.isMinLength(1)),
  operationTimeoutMs: OperationalThresholdSchema,
  pollIntervalMs: OperationalThresholdSchema,
  sourceRevision: GitSourceRevisionSchema,
  port: PortSchema,
})

export type RestateLifecycleConfigInput = typeof RestateLifecycleConfigSchema.Type

export interface RestateLifecycleConfig extends RestateLifecycleConfigInput {
  readonly planHash: string
}

export class RestateLifecycleConfigError extends Data.TaggedError('RestateLifecycleConfigError')<{
  readonly reason: 'INVALID_CONFIG' | 'INVALID_COMMAND_URL'
  readonly message: string
  readonly cause?: unknown
}> {}

const validateCommandBaseUrl = (candidate: string): Result.Result<string, RestateLifecycleConfigError> =>
  Result.try({
    try: () => {
      const url = new URL(candidate)
      if (
        url.protocol !== 'http:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        (url.pathname !== '' && url.pathname !== '/')
      ) {
        throw new Error('command URL must be an uncredentialed HTTP origin without path, query, or fragment')
      }
      return url.origin
    },
    catch: (cause) =>
      new RestateLifecycleConfigError({
        reason: 'INVALID_COMMAND_URL',
        message: 'Bayn lifecycle command URL is invalid',
        cause,
      }),
  })

export const decodeRestateLifecycleConfig = (
  candidate: unknown,
): Result.Result<RestateLifecycleConfig, RestateLifecycleConfigError> => {
  const decoded = Schema.decodeUnknownResult(RestateLifecycleConfigSchema, strictParseOptions)(candidate)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new RestateLifecycleConfigError({
        reason: 'INVALID_CONFIG',
        message: 'Restate lifecycle configuration is invalid',
        cause: decoded.failure,
      }),
    )
  }
  const commandBaseUrl = validateCommandBaseUrl(decoded.success.commandBaseUrl)
  if (Result.isFailure(commandBaseUrl)) return Result.fail(commandBaseUrl.failure)
  const config = { ...decoded.success, commandBaseUrl: commandBaseUrl.success }
  return Result.succeed({
    ...config,
    planHash: sha256(
      [
        config.schemaVersion,
        config.controllerKey,
        config.commandBaseUrl,
        String(config.operationTimeoutMs),
        String(config.pollIntervalMs),
        config.sourceRevision,
      ].join('\n'),
    ),
  })
}

export const RestateLifecycleActivationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.restate-lifecycle-activation.v1'),
  controllerKey: LifecycleControllerKeySchema,
})

export const RestateLifecycleTickSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.restate-lifecycle-tick.v1'),
  epoch: EpochSchema,
  sequence: LifecycleSequenceSchema,
})

export type RestateLifecycleTick = typeof RestateLifecycleTickSchema.Type

const LifecycleCommandInputSchema = Schema.Struct({
  controllerKey: LifecycleControllerKeySchema,
  commandId: Sha256Schema,
  sequence: LifecycleSequenceSchema,
  issuedAt: UtcInstantSchema,
})

const LifecycleCommandCursorSchema = Schema.Union([
  Schema.TaggedStruct('Next', { sequence: LifecycleSequenceSchema }),
  Schema.TaggedStruct('Pending', { command: LifecycleCommandInputSchema }),
])

export const LifecycleCommandCursorResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.lifecycle-command-cursor.v1'),
  controllerKey: LifecycleControllerKeySchema,
  sourceRevision: GitSourceRevisionSchema,
  cursor: LifecycleCommandCursorSchema,
})

export const LifecycleCommandResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.lifecycle-command-response.v1'),
  accepted: Schema.Literal(true),
  commandId: Sha256Schema,
  sequence: LifecycleSequenceSchema,
  sourceRevision: GitSourceRevisionSchema,
  replayed: Schema.Boolean,
  nextDelayMs: NextDelayMsSchema,
  observation: AutonomousCyclePassObservationSchema,
})

export type LifecycleCommandCursorResponse = typeof LifecycleCommandCursorResponseSchema.Type
export type LifecycleCommandResponse = typeof LifecycleCommandResponseSchema.Type

export interface RestateLifecycleState {
  readonly schemaVersion: 'bayn.restate-lifecycle-state.v1'
  readonly active: boolean
  readonly epoch: number
  readonly planHash: string
  readonly sourceRevision: string
  readonly cursor: LifecycleCommandCursorResponse['cursor']
  readonly lastCompletion: {
    readonly commandId: string
    readonly sequence: number
    readonly completedAt: string
    readonly replayed: boolean
    readonly result: 'SUCCESS' | 'FAILURE'
    readonly outcome: string
  } | null
}

const RestateLifecycleStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.restate-lifecycle-state.v1'),
  active: Schema.Boolean,
  epoch: EpochSchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  cursor: LifecycleCommandCursorSchema,
  lastCompletion: Schema.NullOr(
    Schema.Struct({
      commandId: Sha256Schema,
      sequence: LifecycleSequenceSchema,
      completedAt: UtcInstantSchema,
      replayed: Schema.Boolean,
      result: Schema.Literals(['SUCCESS', 'FAILURE']),
      outcome: Schema.NonEmptyString,
    }),
  ),
})

export const decodeRestateLifecycleActivation = Schema.decodeUnknownResult(
  RestateLifecycleActivationSchema,
  strictParseOptions,
)
export const decodeRestateLifecycleTick = Schema.decodeUnknownResult(RestateLifecycleTickSchema, strictParseOptions)
export const decodeRestateLifecycleState = Schema.decodeUnknownResult(RestateLifecycleStateSchema, strictParseOptions)
export const decodeLifecycleCommandCursorResponse = Schema.decodeUnknownResult(
  LifecycleCommandCursorResponseSchema,
  strictParseOptions,
)
export const decodeLifecycleCommandResponse = Schema.decodeUnknownResult(
  LifecycleCommandResponseSchema,
  strictParseOptions,
)

export const initialRestateLifecycleState = (
  config: RestateLifecycleConfig,
  cursor: LifecycleCommandCursorResponse['cursor'],
  priorEpoch: number,
): RestateLifecycleState => ({
  schemaVersion: 'bayn.restate-lifecycle-state.v1',
  active: true,
  epoch: priorEpoch + 1,
  planHash: config.planHash,
  sourceRevision: config.sourceRevision,
  cursor,
  lastCompletion: null,
})

export const lifecycleCommandFromCursor = (
  controllerKey: string,
  cursor: LifecycleCommandCursorResponse['cursor'],
  issuedAt: string,
) =>
  cursor._tag === 'Pending'
    ? cursor.command
    : {
        controllerKey,
        commandId: lifecycleCommandId(controllerKey, cursor.sequence),
        sequence: cursor.sequence,
        issuedAt,
      }

export const completeRestateLifecycleTick = (
  state: RestateLifecycleState,
  response: LifecycleCommandResponse,
  completedAt: string,
): RestateLifecycleState => ({
  ...state,
  cursor: { _tag: 'Next', sequence: response.sequence + 1 },
  lastCompletion: {
    commandId: response.commandId,
    sequence: response.sequence,
    completedAt,
    replayed: response.replayed,
    result: response.observation.result,
    outcome:
      response.observation.result === 'SUCCESS'
        ? response.observation.outcome
        : `${response.observation.operation}/${response.observation.failure}`,
  },
})
