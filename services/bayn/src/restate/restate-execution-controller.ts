import { timingSafeEqual } from 'node:crypto'

import * as restate from '@restatedev/restate-sdk'
import { Clock, Result, Schema } from 'effect'

import { maximumConsistencyDelayMs } from '../execution/mutations/model'
import {
  completeExecutionControllerTick,
  decodeExecutionAdvanceStepResult,
  decodeExecutionControllerActivation,
  decodeExecutionDeploymentActivation,
  decodeExecutionControllerDeactivation,
  decodeExecutionControllerState,
  decodeExecutionControllerTick,
  decideExecutionControllerActivation,
  decideExecutionDeploymentActivation,
  decideExecutionControllerDeactivation,
  decideExecutionControllerTick,
  executionControllerMaximumDeliveryAttempt,
  executionControllerMaximumRecoveryWindow,
  executionControllerSuccessorPassCompleted,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerActivation,
  type ExecutionDeploymentActivation,
  type ExecutionControllerDeactivation,
  type ExecutionControllerState,
  type ExecutionControllerTick,
} from '../execution/controller'
import { sha256 } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { BrokerObservationOwnerStateSchema, brokerObservationJsonSerde } from './restate-broker-observations'

const stateKey = 'controller'
const executionTickSerde = restate.serde.json.schema<ExecutionControllerTick>({
  type: 'object',
  properties: {
    schemaVersion: { const: 'bayn.execution-controller-tick.v1' },
    epoch: { type: 'integer', minimum: 1 },
    sequence: { type: 'integer', minimum: 0 },
    attempt: { type: 'integer', minimum: 0, maximum: executionControllerMaximumDeliveryAttempt },
    issuedAt: { type: 'string', format: 'date-time' },
    recoveryWindow: { type: 'integer', minimum: 1, maximum: executionControllerMaximumRecoveryWindow },
    retryWindowHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    sourceCatchUpRevision: { type: 'string', pattern: '^[0-9a-f]{40}$' },
  },
  required: ['schemaVersion', 'epoch', 'sequence'],
  additionalProperties: false,
})
export const executionControllerFinalizationHeadroomMs = 30_000
export const executionControllerActivationRetentionMs = 7 * 24 * 60 * 60_000
export const executionControllerAdvanceRunOptions = {
  maxRetryAttempts: 0,
} as const satisfies restate.RunOptions<ExecutionAdvanceStepResult>
export const executionControllerAdvanceMaximumAttempts = (replacementFirstPass: boolean): number =>
  replacementFirstPass ? executionControllerMaximumDeliveryAttempt + 1 : 3
export const executionControllerTickRetryPolicy = {
  maxAttempts: 3,
  onMaxAttempts: 'pause',
  initialInterval: 1_000,
  maxInterval: 10_000,
  exponentiationFactor: 2,
} as const satisfies restate.RetryPolicy
export const executionControllerCommandRetryPolicy = {
  maxAttempts: 3,
  onMaxAttempts: 'pause',
  initialInterval: 1_000,
  maxInterval: 10_000,
  exponentiationFactor: 2,
} as const satisfies restate.RetryPolicy
export const executionControllerInitialTickDelayMs = 0
export const executionControllerRecoveryTickDelayMs = 30_000
export const executionControllerDeploymentCompletionPollIntervalMs = 5_000

export interface ExecutionControllerConfig {
  readonly controllerKey: string
  readonly operationTimeoutMs: number
  readonly planHash: string
  readonly sourceRevision: string
}

export interface NativeExecutionRuntime {
  readonly advance: (
    command: import('../execution/advance').AdvanceExecutionCommand,
    signal: AbortSignal,
  ) => Promise<ExecutionAdvanceStepResult>
  readonly log: (
    level: 'info' | 'warning' | 'error',
    message: string,
    annotations: Readonly<Record<string, string | number | boolean>>,
  ) => Promise<void>
  readonly projectState: (controllerKey: string, state: ExecutionControllerState, signal: AbortSignal) => Promise<void>
}

const writeRuntimeLog = (
  runtime: NativeExecutionRuntime,
  level: 'info' | 'warning' | 'error',
  message: string,
  annotations: Readonly<Record<string, string | number | boolean>>,
): Promise<void> =>
  Promise.resolve()
    .then(() => runtime.log(level, message, annotations))
    .catch(() => undefined)

interface ExecutionAdvanceFailureDiagnostic {
  readonly failureCauseCategory?: string
  readonly failureCauseOperation?: string
  readonly failureCauseTag?: string
  readonly failureFingerprint: string
  readonly failureMessage: string
  readonly failureOperation: string
  readonly failureTag: string
}

const executionAdvanceFailureMetadataKey = 'bayn.execution-advance-failure.v1'
const FailureLabelSchema = Schema.NonEmptyString.check(Schema.isMaxLength(80))
const ExecutionAdvanceFailureDiagnosticSchema = Schema.fromJsonString(
  Schema.Struct({
    failureCauseCategory: Schema.optionalKey(FailureLabelSchema),
    failureCauseOperation: Schema.optionalKey(FailureLabelSchema),
    failureCauseTag: Schema.optionalKey(FailureLabelSchema),
    failureFingerprint: Sha256Schema,
    failureMessage: Schema.NonEmptyString.check(Schema.isMaxLength(240)),
    failureOperation: FailureLabelSchema,
    failureTag: FailureLabelSchema,
  }),
)

const executionAdvanceFailureDiagnostic = (cause: unknown): ExecutionAdvanceFailureDiagnostic => {
  if (cause instanceof restate.TerminalError) {
    const retained = Schema.decodeUnknownResult(
      ExecutionAdvanceFailureDiagnosticSchema,
      strictParseOptions,
    )(cause.metadata?.[executionAdvanceFailureMetadataKey])
    if (Result.isSuccess(retained)) return retained.success
  }
  const candidate =
    typeof cause === 'object' && cause !== null
      ? (cause as {
          readonly _tag?: unknown
          readonly cause?: unknown
          readonly failure?: unknown
          readonly message?: unknown
          readonly name?: unknown
          readonly operation?: unknown
        })
      : undefined
  const nestedCause =
    typeof candidate?.cause === 'object' && candidate.cause !== null
      ? (candidate.cause as {
          readonly _tag?: unknown
          readonly failure?: unknown
          readonly operation?: unknown
        })
      : undefined
  const knownTag =
    candidate?._tag === 'TransientExecutionFailure' ||
    candidate?._tag === 'NativeExecutionRuntimeError' ||
    candidate?._tag === 'OperationalError'
      ? candidate._tag
      : undefined
  const failureTag =
    knownTag ??
    (typeof candidate?.name === 'string' && candidate.name.length > 0 ? candidate.name.slice(0, 80) : 'UnknownFailure')
  const failureOperation =
    knownTag !== undefined && typeof candidate?.operation === 'string'
      ? candidate.operation.slice(0, 80)
      : 'unclassified'
  const failureMessage =
    knownTag === 'OperationalError'
      ? 'execution advance rejected an operational check'
      : knownTag !== undefined && typeof candidate?.message === 'string'
        ? candidate.message.slice(0, 240)
        : 'execution advance rejected with an unclassified failure'
  const fingerprintMaterial =
    cause instanceof Error
      ? `${cause.name}:${cause.message}:${cause.stack ?? ''}`
      : `${typeof cause}:${Object.prototype.toString.call(cause)}:${String(cause)}`
  return {
    ...(typeof nestedCause?._tag === 'string' ? { failureCauseTag: nestedCause._tag.slice(0, 80) } : {}),
    ...(typeof nestedCause?.operation === 'string'
      ? { failureCauseOperation: nestedCause.operation.slice(0, 80) }
      : {}),
    ...(typeof nestedCause?.failure === 'string' ? { failureCauseCategory: nestedCause.failure.slice(0, 80) } : {}),
    failureFingerprint: sha256(fingerprintMaterial),
    failureMessage,
    failureOperation,
    failureTag,
  }
}

/** Restate records failures as TerminalError; preserve bounded domain diagnostics before the durable boundary. */
const executionAdvanceRunFailure = (cause: unknown): unknown => {
  const failure = executionAdvanceFailureDiagnostic(cause)
  if (!['TransientExecutionFailure', 'NativeExecutionRuntimeError', 'OperationalError'].includes(failure.failureTag)) {
    return cause
  }
  return new restate.TerminalError(failure.failureMessage, {
    errorCode: cause instanceof restate.TerminalError ? cause.code : 500,
    metadata: { [executionAdvanceFailureMetadataKey]: JSON.stringify(failure) },
  })
}

type ControllerObjectState = { readonly controller: ExecutionControllerState }

const terminal = (message: string): restate.TerminalError =>
  new restate.TerminalError(message, {
    errorCode: 400,
  })

const decodeOrTerminal = <A>(decoded: Result.Result<A, unknown>, message: string): A => {
  if (Result.isFailure(decoded)) throw terminal(message)
  return decoded.success
}

const decisionOrTerminal = <A>(decision: Result.Result<A, { readonly message: string }>): A => {
  if (Result.isFailure(decision)) throw terminal(decision.failure.message)
  return decision.success
}

const verifyActivationBinding = (
  config: ExecutionControllerConfig,
  key: string,
  request: Pick<ExecutionControllerActivation, 'controllerKey' | 'planHash' | 'sourceRevision'>,
): void => {
  if (
    key !== config.controllerKey ||
    request.controllerKey !== config.controllerKey ||
    request.planHash !== config.planHash ||
    request.sourceRevision !== config.sourceRevision
  ) {
    throw terminal('execution controller request does not match this immutable deployment')
  }
}

const verifyDeploymentBinding = (
  config: ExecutionControllerConfig,
  key: string,
  request: ExecutionDeploymentActivation,
): void => {
  if (
    key !== config.controllerKey ||
    request.controllerKey !== config.controllerKey ||
    request.planHash !== config.planHash ||
    request.sourceRevision !== config.sourceRevision
  ) {
    throw terminal('execution controller deployment activation does not match this immutable deployment')
  }
}

const verifyDeactivationBinding = (
  config: ExecutionControllerConfig,
  key: string,
  request: ExecutionControllerDeactivation,
): void => {
  if (key !== config.controllerKey || request.controllerKey !== config.controllerKey) {
    throw terminal('execution controller deactivation does not match this immutable deployment')
  }
}

const verifyTickKey = (config: ExecutionControllerConfig, key: string): void => {
  if (key !== config.controllerKey)
    throw terminal('execution controller durable state does not match this immutable deployment')
}

const ownsControllerState = (config: ExecutionControllerConfig, state: ExecutionControllerState): boolean =>
  state.planHash === config.planHash && state.sourceRevision === config.sourceRevision

const activationTokenPattern = /^[A-Za-z0-9_-]{43,128}$/
const authorizationPrefix = 'Bearer '

const isCanonicalActivationToken = (token: string): boolean => {
  if (!activationTokenPattern.test(token)) return false
  const decoded = Buffer.from(token, 'base64url')
  return decoded.length >= 32 && decoded.length <= 96 && decoded.toString('base64url') === token
}

export const executionActivationAuthorizationHash = (token: string): Result.Result<string, string> =>
  isCanonicalActivationToken(token)
    ? Result.succeed(sha256(token))
    : Result.fail('execution controller deployment activation token must be 32-96 bytes of base64url entropy')

const authorizeDeployment = (expectedHash: string, authorization: string | undefined): void => {
  const token =
    authorization !== undefined && authorization.startsWith(authorizationPrefix)
      ? authorization.slice(authorizationPrefix.length)
      : undefined
  const actualHash = token !== undefined && isCanonicalActivationToken(token) ? sha256(token) : '0'.repeat(64)
  const expected = Buffer.from(expectedHash, 'hex')
  const actual = Buffer.from(actualHash, 'hex')
  if (expected.length !== 32 || actual.length !== 32 || !timingSafeEqual(expected, actual)) {
    throw new restate.TerminalError('execution controller deployment activation authorization failed', {
      errorCode: 403,
    })
  }
}

export const bindDeploymentActivation = (
  state: ExecutionControllerState | null,
  request: ExecutionDeploymentActivation,
  config: ExecutionControllerConfig,
): ExecutionControllerActivation => ({
  schemaVersion: 'bayn.execution-controller-activation.v1',
  controllerKey: request.controllerKey,
  epoch: state?.epoch ?? 1,
  firstSequence: state === null ? 0 : state.active ? state.initialSequence : state.nextSequence,
  planHash: config.planHash,
  sourceRevision: request.sourceRevision,
})

const readState = async (
  ctx: restate.ObjectContext<ControllerObjectState> | restate.ObjectSharedContext<ControllerObjectState>,
): Promise<ExecutionControllerState | null> => {
  const candidate = await ctx.get(stateKey)
  return candidate === null
    ? null
    : decodeOrTerminal(decodeExecutionControllerState(candidate), 'execution controller state failed validation')
}

export const executionControllerTickIdempotencyKey = (epoch: number, sequence: number, attempt: number): string =>
  `bayn-execution-controller-${epoch}-${sequence}-${attempt}`

export const executionControllerRecoveryTickIdempotencyKey = (
  epoch: number,
  sequence: number,
  attempt: number,
  retryWindowHash: string,
): string => `bayn-execution-controller-${epoch}-${sequence}-recovery-${retryWindowHash}-${attempt}`

export const executionControllerSourceCatchUpTickIdempotencyKey = (
  epoch: number,
  sequence: number,
  attempt: number,
  sourceRevision: string,
): string => `bayn-execution-controller-${epoch}-${sequence}-source-${sourceRevision}-${attempt}`

const scheduleTick = (
  ctx: restate.ObjectContext<ControllerObjectState>,
  state: ExecutionControllerState,
  delay: number,
  attempt = 0,
  issuedAt?: string,
  sourceCatchUpRevision?: string,
  retryWindowHash?: string,
  recoveryWindow?: number,
): void => {
  let idempotencyKey: string
  if (retryWindowHash !== undefined) {
    idempotencyKey = executionControllerRecoveryTickIdempotencyKey(
      state.epoch,
      state.nextSequence,
      attempt,
      retryWindowHash,
    )
  } else if (sourceCatchUpRevision !== undefined) {
    idempotencyKey = executionControllerSourceCatchUpTickIdempotencyKey(
      state.epoch,
      state.nextSequence,
      attempt,
      sourceCatchUpRevision,
    )
  } else {
    idempotencyKey = executionControllerTickIdempotencyKey(state.epoch, state.nextSequence, attempt)
  }
  const tick: ExecutionControllerTick = {
    schemaVersion: 'bayn.execution-controller-tick.v1',
    epoch: state.epoch,
    sequence: state.nextSequence,
    attempt,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ...(recoveryWindow === undefined ? {} : { recoveryWindow }),
    ...(retryWindowHash === undefined ? {} : { retryWindowHash }),
    ...(sourceCatchUpRevision === undefined ? {} : { sourceCatchUpRevision }),
  }
  ctx.genericSend({
    service: 'BaynExecutionController',
    method: 'tick',
    key: ctx.key,
    parameter: tick,
    inputSerde: executionTickSerde,
    delay,
    idempotencyKey,
  })
}

export const executionControllerHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: operationTimeoutMs * 3 + maximumConsistencyDelayMs + executionControllerFinalizationHeadroomMs * 2,
  abortTimeout: executionControllerFinalizationHeadroomMs,
})

// Rotation can wait behind an exclusive command already in progress. Allow its full inactivity bound plus one
// response-finalization margin, within the deployment hook's 15-minute deadline at the production 30s operation budget.
export const executionControllerDeploymentRotationBoundMs = (operationTimeoutMs: number): number =>
  executionControllerHandlerTimeouts(operationTimeoutMs).inactivityTimeout + executionControllerFinalizationHeadroomMs

export const executionControllerDeploymentHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: executionControllerDeploymentRotationBoundMs(operationTimeoutMs),
  abortTimeout: executionControllerFinalizationHeadroomMs,
})

export const executionControllerDeploymentCompletionMaximumAttempts = (operationTimeoutMs: number): number =>
  Math.floor(
    (executionControllerHandlerTimeouts(operationTimeoutMs).inactivityTimeout -
      executionControllerFinalizationHeadroomMs) /
      executionControllerDeploymentCompletionPollIntervalMs,
  ) + 1

export const makeBaynExecutionController = (
  config: ExecutionControllerConfig & { readonly activationAuthorizationHash: string },
  runtime: NativeExecutionRuntime,
  hooks: readonly restate.HooksProvider[] = [],
  transportClock: Pick<Clock.Clock, 'currentTimeMillisUnsafe'> = Clock.Clock.defaultValue(),
) => {
  const controller = restate.object({
    name: 'BaynExecutionController',
    handlers: {
      activate: restate.handlers.object.exclusive(
        { ingressPrivate: true, retryPolicy: executionControllerCommandRetryPolicy },
        async (ctx: restate.ObjectContext<ControllerObjectState>, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeExecutionControllerActivation(candidate),
            'execution controller activation failed validation',
          )
          verifyActivationBinding(config, ctx.key, request)
          const decision = decisionOrTerminal(decideExecutionControllerActivation(await readState(ctx), request))
          await ctx.run(
            'project Bayn execution controller activation',
            () => runtime.projectState(ctx.key, decision.state, ctx.request().attemptCompletedSignal),
            executionControllerAdvanceRunOptions,
          )
          if (decision._tag === 'Activated') {
            ctx.set(stateKey, decision.state)
            scheduleTick(
              ctx,
              decision.state,
              executionControllerInitialTickDelayMs,
              0,
              undefined,
              undefined,
              undefined,
              undefined,
            )
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller activated', {
              controllerKey: ctx.key,
              epoch: decision.state.epoch,
              invocationId: ctx.request().id,
              planHash: decision.state.planHash,
              sourceRevision: decision.state.sourceRevision,
            })
          } else {
            // A new activation must wake a delayed controller even on the same revision. Bind the probe to this
            // invocation so a previous exhausted probe cannot deduplicate an explicit recovery attempt.
            scheduleTick(
              ctx,
              decision.state,
              executionControllerInitialTickDelayMs,
              0,
              undefined,
              config.sourceRevision,
              sha256(ctx.request().id),
              undefined,
            )
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller scheduled an activation recovery pass', {
              controllerKey: ctx.key,
              epoch: decision.state.epoch,
              invocationId: ctx.request().id,
              sequence: decision.state.nextSequence,
              sourceRevision: config.sourceRevision,
            })
          }
          return decision.state
        },
      ),

      tick: restate.handlers.object.exclusive(
        { ingressPrivate: true, retryPolicy: executionControllerTickRetryPolicy },
        async (ctx: restate.ObjectContext<ControllerObjectState>, candidate: unknown): Promise<void> => {
          const tick = decodeOrTerminal(
            decodeExecutionControllerTick(candidate),
            'execution controller tick failed validation',
          )
          const state = await readState(ctx)
          verifyTickKey(config, ctx.key)
          if (tick.sourceCatchUpRevision !== undefined && tick.sourceCatchUpRevision !== config.sourceRevision) {
            await writeRuntimeLog(runtime, 'warning', 'Bayn execution controller quiesced a foreign source catch-up', {
              controllerKey: ctx.key,
              epoch: tick.epoch,
              invocationId: ctx.request().id,
              sequence: tick.sequence,
              sourceRevision: config.sourceRevision,
            })
            return
          }
          if (state !== null && !ownsControllerState(config, state)) {
            await writeRuntimeLog(
              runtime,
              'info',
              'Bayn execution controller quiesced a foreign binding pending activation',
              {
                controllerKey: ctx.key,
                epoch: tick.epoch,
                invocationId: ctx.request().id,
                sequence: tick.sequence,
                sourceRevision: config.sourceRevision,
              },
            )
            return
          }
          const issuedAt = tick.issuedAt ?? (await ctx.date.toJSON())
          const decision = decisionOrTerminal(
            decideExecutionControllerTick(state, tick, ctx.key, issuedAt, config.sourceRevision),
          )
          if (decision._tag === 'Ignored') {
            return
          }

          let stepResult: ExecutionAdvanceStepResult
          try {
            stepResult = await ctx.run(
              'advance Bayn execution once',
              async () => {
                try {
                  return await runtime.advance(decision.command, ctx.request().attemptCompletedSignal)
                } catch (cause) {
                  throw executionAdvanceRunFailure(cause)
                }
              },
              executionControllerAdvanceRunOptions,
            )
          } catch (cause: unknown) {
            const attempt = tick.attempt ?? 0
            const failure = executionAdvanceFailureDiagnostic(cause)

            const replacementFirstPass =
              state !== null && state.lastCompletion === undefined && state.nextSequence === state.initialSequence
            const maximumAttempts = executionControllerAdvanceMaximumAttempts(replacementFirstPass)
            if (attempt + 1 < maximumAttempts && state !== null) {
              const nextAttempt = attempt + 1
              const retryDelayMs = Math.min(1_000 * 2 ** attempt, 30_000)
              scheduleTick(
                ctx,
                state,
                retryDelayMs,
                nextAttempt,
                issuedAt,
                tick.sourceCatchUpRevision,
                tick.retryWindowHash,
                tick.recoveryWindow,
              )
              await writeRuntimeLog(runtime, 'warning', 'Bayn execution controller advance will retry', {
                controllerKey: ctx.key,
                epoch: state.epoch,
                ...failure,
                invocationId: ctx.request().id,
                nextAttempt,
                ...(tick.recoveryWindow === undefined ? {} : { recoveryWindow: tick.recoveryWindow }),
                sequence: state.nextSequence,
                sourceRevision: state.sourceRevision,
              })
              return
            }
            await writeRuntimeLog(runtime, 'error', 'Bayn execution controller advance exhausted retries', {
              controllerKey: ctx.key,
              epoch: tick.epoch,
              ...failure,
              invocationId: ctx.request().id,
              ...(tick.recoveryWindow === undefined ? {} : { recoveryWindow: tick.recoveryWindow }),
              sequence: tick.sequence,
              sourceRevision: config.sourceRevision,
            })
            // A source catch-up is a rollout probe queued alongside the established revision's normal tick. Complete
            // the failed probe without changing state so the established revision remains free to advance.
            if (tick.sourceCatchUpRevision !== undefined) return
            if (state === null) throw terminal('execution controller state disappeared during retry recovery')
            const currentRecoveryWindow = tick.retryWindowHash === undefined ? 0 : (tick.recoveryWindow ?? 1)
            if (currentRecoveryWindow >= executionControllerMaximumRecoveryWindow) {
              await writeRuntimeLog(runtime, 'error', 'Bayn execution controller recovery budget exhausted', {
                controllerKey: ctx.key,
                epoch: state.epoch,
                ...failure,
                invocationId: ctx.request().id,
                recoveryWindow: currentRecoveryWindow,
                sequence: state.nextSequence,
                sourceRevision: state.sourceRevision,
              })
              throw new restate.TerminalError('execution controller recovery budget exhausted', {
                errorCode: 503,
                metadata: {
                  ...(failure.failureCauseCategory === undefined
                    ? {}
                    : { failureCauseCategory: failure.failureCauseCategory }),
                  ...(failure.failureCauseOperation === undefined
                    ? {}
                    : { failureCauseOperation: failure.failureCauseOperation }),
                  ...(failure.failureCauseTag === undefined ? {} : { failureCauseTag: failure.failureCauseTag }),
                  failureFingerprint: failure.failureFingerprint,
                  failureMessage: failure.failureMessage,
                  failureOperation: failure.failureOperation,
                  failureTag: failure.failureTag,
                  recoveryWindow: String(currentRecoveryWindow),
                },
              })
            }
            const nextRecoveryWindow = currentRecoveryWindow + 1
            const retryWindowHash = sha256(`${ctx.request().id}:${nextRecoveryWindow}`)
            const recoveryDelayMs = executionControllerRecoveryTickDelayMs
            scheduleTick(ctx, state, recoveryDelayMs, 0, issuedAt, undefined, retryWindowHash, nextRecoveryWindow)
            await writeRuntimeLog(runtime, 'warning', 'Bayn execution controller scheduled a recovery window', {
              controllerKey: ctx.key,
              epoch: state.epoch,
              invocationId: ctx.request().id,
              recoveryDelayMs,
              recoveryWindow: nextRecoveryWindow,
              retryWindowHash,
              sequence: state.nextSequence,
              sourceRevision: state.sourceRevision,
            })
            return
          }
          const result = decodeOrTerminal(
            decodeExecutionAdvanceStepResult(stepResult),
            'execution controller advance result failed validation',
          )
          if (state === null) throw terminal('execution controller state disappeared during an accepted tick')
          const completed = decisionOrTerminal(
            completeExecutionControllerTick(state, tick, result, config.sourceRevision),
          )
          ctx.set(stateKey, completed)

          // Transport timing must use a live clock: a journaled sample can precede a crash before the send is recorded.
          // SDK 1.16.5 converts delay to live invoke_time; core 7.0.2 excludes that field from send replay equality.
          // The persisted successor and its idempotency key are unchanged; this clock never authorizes execution.
          // Ordinary polling waits retain the same due-time contract; projection and journaling must consume their
          // delay budget too, rather than starting a fresh wait after the persisted deadline has already passed.
          const scheduleAt = transportClock.currentTimeMillisUnsafe()
          const completionDelay =
            completed.nextDueAt === undefined
              ? result.outcome.nextDelayMs
              : Math.min(result.outcome.nextDelayMs, Math.max(1, Date.parse(completed.nextDueAt) - scheduleAt))
          scheduleTick(ctx, completed, completionDelay, 0, undefined, undefined, undefined, undefined)
          await writeRuntimeLog(runtime, 'info', 'Bayn execution controller tick completed', {
            completionToScheduleMs: scheduleAt - Date.parse(result.completedAt),
            controllerKey: ctx.key,
            epoch: completed.epoch,
            invocationId: ctx.request().id,
            nextSequence: completed.nextSequence,
            outcome: result.outcome._tag,
            receiptHash: result.outcome.receiptHash,
            requestedNextDelayMs: result.outcome.nextDelayMs,
            scheduledNextDelayMs: completionDelay,
            sourceRevision: completed.sourceRevision,
          })
        },
      ),

      deactivate: restate.handlers.object.exclusive(
        { ingressPrivate: true, retryPolicy: executionControllerCommandRetryPolicy },
        async (ctx: restate.ObjectContext<ControllerObjectState>, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeExecutionControllerDeactivation(candidate),
            'execution controller deactivation failed validation',
          )
          verifyDeactivationBinding(config, ctx.key, request)
          const decision = decisionOrTerminal(decideExecutionControllerDeactivation(await readState(ctx), request))
          await ctx.run(
            'project Bayn execution controller deactivation',
            () => runtime.projectState(ctx.key, decision.state, ctx.request().attemptCompletedSignal),
            executionControllerAdvanceRunOptions,
          )
          if (decision._tag === 'Deactivated') {
            ctx.set(stateKey, decision.state)
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller deactivated', {
              controllerKey: ctx.key,
              epoch: decision.state.epoch,
              invocationId: ctx.request().id,
              planHash: decision.state.planHash,
              sourceRevision: decision.state.sourceRevision,
            })
          }
          return decision.state
        },
      ),

      prepareActivation: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext<ControllerObjectState>, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeExecutionDeploymentActivation(candidate),
            'execution controller deployment activation failed validation',
          )
          verifyDeploymentBinding(config, ctx.key, request)
          return readState(ctx)
        },
      ),

      status: restate.handlers.object.shared(
        { ingressPrivate: true },
        async (ctx: restate.ObjectSharedContext<ControllerObjectState>, _candidate: unknown) => readState(ctx),
      ),

      activateDeployment: restate.handlers.object.shared(
        {
          ingressPrivate: false,
          idempotencyRetention: executionControllerActivationRetentionMs,
          journalRetention: 0,
          retryPolicy: executionControllerCommandRetryPolicy,
          ...executionControllerDeploymentHandlerTimeouts(config.operationTimeoutMs),
        },
        async (
          ctx: restate.ObjectSharedContext<ControllerObjectState>,
          candidate: unknown,
        ): Promise<ExecutionControllerState> => {
          const request = decodeOrTerminal(
            decodeExecutionDeploymentActivation(candidate),
            'execution controller deployment activation failed validation',
          )
          verifyDeploymentBinding(config, ctx.key, request)
          authorizeDeployment(config.activationAuthorizationHash, ctx.request().headers.get('authorization'))
          const client = ctx.objectClient(controller, ctx.key)
          // Fence a pinned coordinator against the latest immutable target before reading its predecessor.
          const state = await client.prepareActivation(request)
          const decision = decisionOrTerminal(decideExecutionDeploymentActivation(state, request))
          let activationState = decision._tag === 'Activate' ? decision.state : undefined
          if (decision._tag === 'Rotate') {
            const deactivated = await client.deactivate(decision.deactivation)
            if (
              deactivated.active ||
              deactivated.epoch !== decision.deactivation.epoch + 1 ||
              deactivated.planHash !== decision.deactivation.planHash ||
              deactivated.sourceRevision !== decision.deactivation.sourceRevision
            ) {
              throw terminal('execution controller rotation did not prove the expected inactive previous binding')
            }
            activationState = deactivated
          }
          const observation = Schema.decodeUnknownResult(
            BrokerObservationOwnerStateSchema,
            strictParseOptions,
          )(
            await ctx.genericCall({
              service: 'BaynBrokerObservations',
              method: 'activate',
              key: config.controllerKey,
              parameter: { sourceRevision: config.sourceRevision },
              inputSerde: brokerObservationJsonSerde,
              outputSerde: brokerObservationJsonSerde,
            }),
          )
          if (
            Result.isFailure(observation) ||
            observation.success.sourceRevision !== config.sourceRevision ||
            observation.success.lastSnapshotHash === undefined
          )
            throw terminal('execution controller deployment activation requires a fresh published broker observation')
          const activation = bindDeploymentActivation(activationState ?? null, request, config)
          const completionBinding = {
            ...activation,
            firstSequence: Math.max(activation.firstSequence, state?.nextSequence ?? 0),
          }
          let activated: ExecutionControllerState | null = await client.activate(activation)
          const maximumAttempts = executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs)
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            if (executionControllerSuccessorPassCompleted(activated, completionBinding)) return activated
            if (attempt === maximumAttempts) {
              throw terminal(
                'execution controller deployment activation did not observe a completed durable successor pass',
              )
            }
            await ctx.sleep({ milliseconds: executionControllerDeploymentCompletionPollIntervalMs })
            activated = await client.status(undefined)
          }
          throw terminal('execution controller deployment activation completion bound is invalid')
        },
      ),
    },
    options: {
      ingressPrivate: false,
      enableLazyState: false,
      hooks: [...hooks],
      ...executionControllerHandlerTimeouts(config.operationTimeoutMs),
    },
  })
  return controller
}
