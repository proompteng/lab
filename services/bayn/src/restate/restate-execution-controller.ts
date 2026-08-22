import { timingSafeEqual } from 'node:crypto'

import * as restate from '@restatedev/restate-sdk'
import { Result } from 'effect'

import { maximumConsistencyDelayMs } from '../execution/mutations'
import {
  completeExecutionControllerTick,
  decodeExecutionAdvanceStepResult,
  decodeExecutionControllerActivation,
  decodeExecutionControllerBootstrap,
  decodeExecutionControllerDeactivation,
  decodeExecutionControllerState,
  decodeExecutionControllerTick,
  decideExecutionControllerActivation,
  decideExecutionControllerBootstrap,
  decideExecutionControllerDeactivation,
  decideExecutionControllerTick,
  executionControllerMaximumDeliveryAttempt,
  executionControllerMaximumRecoveryWindow,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerActivation,
  type ExecutionControllerBinding,
  type ExecutionControllerBootstrap,
  type ExecutionControllerDeactivation,
  type ExecutionControllerState,
  type ExecutionControllerTick,
} from '../execution/controller'
import { sha256 } from '../hash'

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
export const executionControllerActivationRetentionMs = 10 * 60_000
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
export const executionControllerRecoveryMaximumDelayMs = 24 * 60 * 60_000
export const executionControllerRecoveryDelayMs = (recoveryWindow: number): number =>
  Math.min(
    executionControllerRecoveryTickDelayMs * 4 ** Math.max(0, recoveryWindow - 1),
    executionControllerRecoveryMaximumDelayMs,
  )
export const executionControllerBootstrapCompletionPollIntervalMs = 5_000

export interface ExecutionControllerConfig {
  readonly controllerKey: string
  readonly operationTimeoutMs: number
  readonly planHash: string
  readonly previousBinding?: ExecutionControllerBinding
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

const executionAdvanceFailureDiagnostic = (cause: unknown): ExecutionAdvanceFailureDiagnostic => {
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
    candidate?._tag === 'TransientExecutionFailure' || candidate?._tag === 'NativeExecutionRuntimeError'
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
    knownTag !== undefined && typeof candidate?.message === 'string'
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

const verifyBootstrapBinding = (config: ExecutionControllerConfig, request: ExecutionControllerBootstrap): void => {
  const requestPrevious =
    request.schemaVersion === 'bayn.execution-controller-bootstrap.v3' ? request.previousBinding : undefined
  const previousMatches =
    requestPrevious === undefined && config.previousBinding === undefined
      ? true
      : requestPrevious !== undefined &&
        config.previousBinding !== undefined &&
        requestPrevious.planHash === config.previousBinding.planHash &&
        requestPrevious.sourceRevision === config.previousBinding.sourceRevision
  if (
    request.controllerKey !== config.controllerKey ||
    request.planHash !== config.planHash ||
    request.sourceRevision !== config.sourceRevision ||
    !previousMatches
  ) {
    throw terminal('execution controller bootstrap does not match this immutable deployment')
  }
}

const verifyDeactivationBinding = (
  config: ExecutionControllerConfig,
  key: string,
  request: ExecutionControllerDeactivation,
): void => {
  const matches = (binding: ExecutionControllerBinding): boolean =>
    request.planHash === binding.planHash && request.sourceRevision === binding.sourceRevision
  if (
    key !== config.controllerKey ||
    request.controllerKey !== config.controllerKey ||
    (!matches(config) && (config.previousBinding === undefined || !matches(config.previousBinding)))
  ) {
    throw terminal('execution controller deactivation does not match this immutable deployment')
  }
}

const verifyTickBinding = (
  config: ExecutionControllerConfig,
  key: string,
  state: ExecutionControllerState | null,
): void => {
  const matchesPrevious =
    state !== null &&
    config.previousBinding !== undefined &&
    state.planHash === config.previousBinding.planHash &&
    state.sourceRevision === config.previousBinding.sourceRevision
  if (key !== config.controllerKey || (state !== null && !matchesPrevious && state.planHash !== config.planHash)) {
    throw terminal('execution controller durable state does not match this immutable deployment')
  }
}

const isPreviousBinding = (config: ExecutionControllerConfig, state: ExecutionControllerState | null): boolean =>
  state !== null &&
  config.previousBinding !== undefined &&
  state.planHash === config.previousBinding.planHash &&
  state.sourceRevision === config.previousBinding.sourceRevision

const bootstrapTokenPattern = /^[A-Za-z0-9_-]{43,128}$/
const authorizationPrefix = 'Bearer '

const isCanonicalBootstrapToken = (token: string): boolean => {
  if (!bootstrapTokenPattern.test(token)) return false
  const decoded = Buffer.from(token, 'base64url')
  return decoded.length >= 32 && decoded.length <= 96 && decoded.toString('base64url') === token
}

export const executionBootstrapAuthorizationHash = (token: string): Result.Result<string, string> =>
  isCanonicalBootstrapToken(token)
    ? Result.succeed(sha256(token))
    : Result.fail('execution controller bootstrap token must be 32-96 bytes of base64url entropy')

const authorizeBootstrap = (expectedHash: string, authorization: string | undefined): void => {
  const token =
    authorization !== undefined && authorization.startsWith(authorizationPrefix)
      ? authorization.slice(authorizationPrefix.length)
      : undefined
  const actualHash = token !== undefined && isCanonicalBootstrapToken(token) ? sha256(token) : '0'.repeat(64)
  const expected = Buffer.from(expectedHash, 'hex')
  const actual = Buffer.from(actualHash, 'hex')
  if (expected.length !== 32 || actual.length !== 32 || !timingSafeEqual(expected, actual)) {
    throw new restate.TerminalError('execution controller bootstrap authorization failed', { errorCode: 403 })
  }
}

export const bindBootstrapActivation = (
  state: ExecutionControllerState | null,
  request: ExecutionControllerBootstrap,
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
  if (sourceCatchUpRevision !== undefined) {
    idempotencyKey = executionControllerSourceCatchUpTickIdempotencyKey(
      state.epoch,
      state.nextSequence,
      attempt,
      sourceCatchUpRevision,
    )
  } else if (retryWindowHash !== undefined) {
    idempotencyKey = executionControllerRecoveryTickIdempotencyKey(
      state.epoch,
      state.nextSequence,
      attempt,
      retryWindowHash,
    )
  } else {
    idempotencyKey = executionControllerTickIdempotencyKey(state.epoch, state.nextSequence, attempt)
  }
  ctx.genericSend({
    service: 'BaynExecutionController',
    method: 'tick',
    key: ctx.key,
    parameter: {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: state.epoch,
      sequence: state.nextSequence,
      attempt,
      ...(issuedAt === undefined ? {} : { issuedAt }),
      ...(recoveryWindow === undefined ? {} : { recoveryWindow }),
      ...(retryWindowHash === undefined ? {} : { retryWindowHash }),
      ...(sourceCatchUpRevision === undefined ? {} : { sourceCatchUpRevision }),
    },
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

// A bootstrap rotation can wait behind one already-running exclusive controller command. Keep the bootstrap alive for
// the controller's complete native inactivity bound plus one response-finalization margin. This is deliberately
// independent of the retired lifecycle controller and remains below the 15-minute activation-hook deadline at the
// production 30s operation budget.
export const executionControllerBootstrapRotationBoundMs = (operationTimeoutMs: number): number =>
  executionControllerHandlerTimeouts(operationTimeoutMs).inactivityTimeout + executionControllerFinalizationHeadroomMs

export const executionControllerBootstrapHandlerTimeouts = (
  operationTimeoutMs: number,
  rotatesPreviousBinding: boolean,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } =>
  rotatesPreviousBinding
    ? {
        inactivityTimeout: executionControllerBootstrapRotationBoundMs(operationTimeoutMs),
        abortTimeout: executionControllerFinalizationHeadroomMs,
      }
    : executionControllerHandlerTimeouts(operationTimeoutMs)

export const executionControllerBootstrapCompletionMaximumAttempts = (operationTimeoutMs: number): number =>
  Math.floor(
    (executionControllerHandlerTimeouts(operationTimeoutMs).inactivityTimeout -
      executionControllerFinalizationHeadroomMs) /
      executionControllerBootstrapCompletionPollIntervalMs,
  ) + 1

export const executionControllerSuccessorPassCompleted = (
  state: ExecutionControllerState | null,
  activation: ExecutionControllerActivation,
): state is ExecutionControllerState & {
  readonly lastCompletion: NonNullable<ExecutionControllerState['lastCompletion']>
} =>
  state !== null &&
  state.active &&
  state.epoch === activation.epoch &&
  state.planHash === activation.planHash &&
  state.sourceRevision === activation.sourceRevision &&
  state.lastCompletion !== undefined &&
  state.lastCompletion.sequence > activation.firstSequence &&
  state.nextSequence === state.lastCompletion.sequence + 1

export const makeBaynExecutionController = (
  config: ExecutionControllerConfig,
  runtime: NativeExecutionRuntime,
  hooks: readonly restate.HooksProvider[] = [],
) =>
  restate.object({
    name: 'BaynExecutionController',
    handlers: {
      activate: restate.handlers.object.exclusive(
        { retryPolicy: executionControllerCommandRetryPolicy },
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
            scheduleTick(ctx, decision.state, executionControllerInitialTickDelayMs)
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller activated', {
              controllerKey: ctx.key,
              epoch: decision.state.epoch,
              invocationId: ctx.request().id,
              planHash: decision.state.planHash,
              sourceRevision: decision.state.sourceRevision,
            })
          } else if (decision.state.sourceRevision !== config.sourceRevision) {
            // A plan-compatible worker revision normally inherits the already-scheduled next tick. If that delivery
            // was paused or cancelled, replaying activation is the only durable recovery signal available. Sending
            // the current sequence again is safe because its Restate idempotency key is deterministic.
            scheduleTick(
              ctx,
              decision.state,
              executionControllerInitialTickDelayMs,
              0,
              undefined,
              config.sourceRevision,
            )
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller scheduled a source catch-up pass', {
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
        { retryPolicy: executionControllerTickRetryPolicy },
        async (ctx: restate.ObjectContext<ControllerObjectState>, candidate: unknown): Promise<void> => {
          const tick = decodeOrTerminal(
            decodeExecutionControllerTick(candidate),
            'execution controller tick failed validation',
          )
          const state = await readState(ctx)
          verifyTickBinding(config, ctx.key, state)
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
          if (isPreviousBinding(config, state)) {
            await writeRuntimeLog(runtime, 'info', 'Bayn execution controller quiesced a previous-binding tick', {
              controllerKey: ctx.key,
              epoch: tick.epoch,
              invocationId: ctx.request().id,
              sequence: tick.sequence,
              sourceRevision: config.sourceRevision,
            })
            return
          }
          const issuedAt = tick.issuedAt ?? (await ctx.date.toJSON())
          const decision = decisionOrTerminal(
            decideExecutionControllerTick(state, tick, ctx.key, issuedAt, config.sourceRevision),
          )
          if (decision._tag === 'Ignored') return

          let stepResult: ExecutionAdvanceStepResult
          try {
            stepResult = await ctx.run(
              'advance Bayn execution once',
              () => runtime.advance(decision.command, ctx.request().attemptCompletedSignal),
              executionControllerAdvanceRunOptions,
            )
          } catch (cause: unknown) {
            const attempt = tick.attempt ?? 0
            const failure = executionAdvanceFailureDiagnostic(cause)
            const replacementFirstPass =
              config.previousBinding !== undefined &&
              state !== null &&
              state.lastCompletion === undefined &&
              state.nextSequence === state.initialSequence
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
            const recoveryDelayMs = executionControllerRecoveryDelayMs(nextRecoveryWindow)
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
          scheduleTick(ctx, completed, result.outcome.nextDelayMs)
          await writeRuntimeLog(runtime, 'info', 'Bayn execution controller tick completed', {
            controllerKey: ctx.key,
            epoch: completed.epoch,
            invocationId: ctx.request().id,
            nextSequence: completed.nextSequence,
            outcome: result.outcome._tag,
            receiptHash: result.outcome.receiptHash,
            sourceRevision: completed.sourceRevision,
          })
        },
      ),

      deactivate: restate.handlers.object.exclusive(
        { retryPolicy: executionControllerCommandRetryPolicy },
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

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext<ControllerObjectState>, _candidate: unknown) => readState(ctx),
      ),
    },
    options: {
      ingressPrivate: true,
      enableLazyState: true,
      hooks: [...hooks],
      ...executionControllerHandlerTimeouts(config.operationTimeoutMs),
    },
  })

export const makeBaynExecutionBootstrap = (
  config: ExecutionControllerConfig,
  controller: ReturnType<typeof makeBaynExecutionController>,
  authorizationHash: string,
  hooks: readonly restate.HooksProvider[] = [],
) =>
  restate.service({
    name: 'BaynExecutionBootstrap',
    handlers: {
      start: restate.handlers.handler(
        {
          idempotencyRetention: executionControllerActivationRetentionMs,
          retryPolicy: executionControllerCommandRetryPolicy,
        },
        async (ctx: restate.Context, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeExecutionControllerBootstrap(candidate),
            'execution controller bootstrap failed validation',
          )
          verifyBootstrapBinding(config, request)
          authorizeBootstrap(authorizationHash, ctx.request().headers.get('authorization'))
          const client = ctx.objectClient(controller, config.controllerKey)
          const state = await client.status(undefined)
          const decision = decisionOrTerminal(decideExecutionControllerBootstrap(state, request))
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
          const activation = bindBootstrapActivation(activationState ?? null, request, config)
          let activated: ExecutionControllerState | null = await client.activate(activation)
          const maximumAttempts = executionControllerBootstrapCompletionMaximumAttempts(config.operationTimeoutMs)
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            if (executionControllerSuccessorPassCompleted(activated, activation)) return activated
            if (attempt === maximumAttempts) {
              throw terminal('execution controller bootstrap did not observe a completed durable successor pass')
            }
            await ctx.sleep({ milliseconds: executionControllerBootstrapCompletionPollIntervalMs })
            activated = await client.status(undefined)
          }
          throw terminal('execution controller bootstrap completion bound is invalid')
        },
      ),
    },
    options: {
      hooks: [...hooks],
      ...executionControllerBootstrapHandlerTimeouts(config.operationTimeoutMs, config.previousBinding !== undefined),
    },
  })
