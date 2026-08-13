import { createHash } from 'node:crypto'

import { Result, Schema } from 'effect'

import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'

export const LifecycleControllerKeySchema = Schema.Trim.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))
export const LifecycleSequenceSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
)
export const lifecycleCommandV1StaleExecutionBootstrapReason = 'STALE_PAPER_BOOTSTRAP' as const

export const LifecycleCommandSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.lifecycle-command.v1'),
  controllerKey: LifecycleControllerKeySchema,
  commandId: Sha256Schema,
  sequence: LifecycleSequenceSchema,
  issuedAt: UtcInstantSchema,
})

export type LifecycleCommand = Omit<typeof LifecycleCommandSchema.Type, 'schemaVersion'>

export const LifecycleCommandRequestSchema = Schema.Struct({
  ...LifecycleCommandSchema.fields,
  sourceRevision: GitSourceRevisionSchema,
})

const decodeLifecycleCommandRequest = Schema.decodeUnknownResult(LifecycleCommandRequestSchema, strictParseOptions)

export const lifecycleCommandId = (controllerKey: string, sequence: number): string =>
  createHash('sha256').update(`bayn/lifecycle-command/v1/${controllerKey}/${sequence}`).digest('hex')

export type LifecycleCommandDecision =
  | { readonly _tag: 'Accept'; readonly command: LifecycleCommand; readonly sourceRevision: string }
  | {
      readonly _tag: 'Reject'
      readonly status: 400 | 403 | 503
      readonly reason: 'INVALID_COMMAND' | 'CONTROLLER_MISMATCH' | 'SOURCE_REVISION_MISMATCH'
    }

export const decideLifecycleCommand = (
  expectedControllerKey: string,
  acceptedSourceRevisions: readonly string[],
  candidate: unknown,
): LifecycleCommandDecision => {
  const decoded = decodeLifecycleCommandRequest(candidate)
  if (Result.isFailure(decoded)) return { _tag: 'Reject', status: 400, reason: 'INVALID_COMMAND' }
  const request = decoded.success
  const command: LifecycleCommand = {
    controllerKey: request.controllerKey,
    commandId: request.commandId,
    sequence: request.sequence,
    issuedAt: request.issuedAt,
  }
  if (
    command.controllerKey !== expectedControllerKey ||
    command.commandId !== lifecycleCommandId(command.controllerKey, command.sequence)
  ) {
    return { _tag: 'Reject', status: 403, reason: 'CONTROLLER_MISMATCH' }
  }
  if (!acceptedSourceRevisions.includes(request.sourceRevision)) {
    return { _tag: 'Reject', status: 503, reason: 'SOURCE_REVISION_MISMATCH' }
  }
  return { _tag: 'Accept', command, sourceRevision: request.sourceRevision }
}
