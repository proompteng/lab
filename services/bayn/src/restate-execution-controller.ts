import { timingSafeEqual } from 'node:crypto'

import * as restate from '@restatedev/restate-sdk'
import { Result } from 'effect'

import { maximumConsistencyDelayMs } from './execution/mutations'
import {
  completeExecutionControllerTick,
  decodeExecutionAdvanceStepResult,
  decodeExecutionControllerActivation,
  decodeExecutionControllerBootstrap,
  decodeExecutionControllerDeactivation,
  decodeExecutionControllerState,
  decodeExecutionControllerTick,
  decideExecutionControllerActivation,
  decideExecutionControllerDeactivation,
  decideExecutionControllerTick,
  type ExecutionAdvanceStepResult,
  type ExecutionControllerActivation,
  type ExecutionControllerBootstrap,
  type ExecutionControllerState,
  type ExecutionControllerTick,
} from './execution/controller'
import { sha256 } from './hash'
import { decodeRestateLifecycleState } from './restate-lifecycle'

const stateKey = 'controller'
const executionTickSerde = restate.serde.json.schema<ExecutionControllerTick>({
  type: 'object',
  properties: {
    schemaVersion: { const: 'bayn.execution-controller-tick.v1' },
    epoch: { type: 'integer', minimum: 1 },
    sequence: { type: 'integer', minimum: 0 },
    attempt: { type: 'integer', minimum: 0, maximum: 2 },
    issuedAt: { type: 'string', format: 'date-time' },
  },
  required: ['schemaVersion', 'epoch', 'sequence'],
  additionalProperties: false,
})
const legacyLifecycleDeactivationSerde = restate.serde.json.schema<{
  readonly schemaVersion: 'bayn.restate-lifecycle-deactivation.v1'
  readonly controllerKey: string
  readonly planHash: string
  readonly sourceRevision: string
}>({
  type: 'object',
  properties: {
    schemaVersion: { const: 'bayn.restate-lifecycle-deactivation.v1' },
    controllerKey: { type: 'string' },
    planHash: { type: 'string' },
    sourceRevision: { type: 'string' },
  },
  required: ['schemaVersion', 'controllerKey', 'planHash', 'sourceRevision'],
  additionalProperties: false,
})
const legacyLifecycleStateSerde = restate.serde.json.schema<unknown>({ type: 'object' })

export const executionControllerFinalizationHeadroomMs = 30_000
export const executionControllerActivationRetentionMs = 10 * 60_000
export const executionControllerAdvanceRunOptions = {
  maxRetryAttempts: 0,
} as const satisfies restate.RunOptions<ExecutionAdvanceStepResult>
export const executionControllerAdvanceMaximumAttempts = 3
export const executionControllerTickRetryPolicy = {
  maxAttempts: 1,
  onMaxAttempts: 'pause',
} as const satisfies restate.RetryPolicy
export const executionControllerCommandRetryPolicy = {
  maxAttempts: 3,
  onMaxAttempts: 'pause',
  initialInterval: 1_000,
  maxInterval: 10_000,
  exponentiationFactor: 2,
} as const satisfies restate.RetryPolicy
export const executionControllerInitialTickDelayMs = 5 * 60_000

export interface ExecutionControllerConfig {
  readonly controllerKey: string
  readonly operationTimeoutMs: number
  readonly planHash: string
  readonly sourceRevision: string
}

export interface LegacyLifecycleCutoverBinding {
  readonly controllerKey: string
  readonly planHash: string
  readonly sourceRevision: string
}

export interface NativeExecutionRuntime {
  readonly advance: (
    command: import('./execution/advance').AdvanceExecutionCommand,
    signal: AbortSignal,
  ) => Promise<ExecutionAdvanceStepResult>
  readonly log: (
    level: 'info' | 'warning' | 'error',
    message: string,
    annotations: Readonly<Record<string, string | number | boolean>>,
  ) => Promise<void>
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

const verifyTickBinding = (
  config: ExecutionControllerConfig,
  key: string,
  state: ExecutionControllerState | null,
): void => {
  if (
    key !== config.controllerKey ||
    (state !== null && (state.planHash !== config.planHash || state.sourceRevision !== config.sourceRevision))
  ) {
    throw terminal('execution controller durable state does not match this immutable deployment')
  }
}

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

const legacyLifecycleDeactivationIdempotencyKey = (
  config: ExecutionControllerConfig,
  binding: LegacyLifecycleCutoverBinding,
): string => `bayn-native-cutover-${config.sourceRevision}-${binding.controllerKey}`

const deactivateLegacyLifecycle = async (
  ctx: restate.Context,
  config: ExecutionControllerConfig,
  binding: LegacyLifecycleCutoverBinding,
): Promise<void> => {
  const candidate: unknown = await ctx.genericCall({
    service: 'BaynLifecycle',
    method: 'deactivate',
    key: binding.controllerKey,
    parameter: {
      schemaVersion: 'bayn.restate-lifecycle-deactivation.v1',
      controllerKey: binding.controllerKey,
      planHash: binding.planHash,
      sourceRevision: binding.sourceRevision,
    },
    inputSerde: legacyLifecycleDeactivationSerde,
    outputSerde: legacyLifecycleStateSerde,
    idempotencyKey: legacyLifecycleDeactivationIdempotencyKey(config, binding),
  })
  const state = decodeOrTerminal(
    decodeRestateLifecycleState(candidate),
    'legacy lifecycle deactivation returned invalid state',
  )
  if (state.active || state.planHash !== binding.planHash || state.sourceRevision !== binding.sourceRevision) {
    throw terminal('legacy lifecycle deactivation did not prove the expected inactive owner')
  }
}

export const bindBootstrapActivation = (
  state: ExecutionControllerState | null,
  request: ExecutionControllerBootstrap,
): ExecutionControllerActivation => ({
  schemaVersion: 'bayn.execution-controller-activation.v1',
  controllerKey: request.controllerKey,
  epoch: state?.epoch ?? 1,
  firstSequence: state === null ? 0 : state.active ? state.initialSequence : state.nextSequence,
  planHash: request.planHash,
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

const scheduleTick = (
  ctx: restate.ObjectContext<ControllerObjectState>,
  state: ExecutionControllerState,
  delay: number,
  attempt = 0,
  issuedAt?: string,
): void => {
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
    },
    inputSerde: executionTickSerde,
    delay,
    idempotencyKey: executionControllerTickIdempotencyKey(state.epoch, state.nextSequence, attempt),
  })
}

export const executionControllerHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: operationTimeoutMs * 3 + maximumConsistencyDelayMs + executionControllerFinalizationHeadroomMs * 2,
  abortTimeout: executionControllerFinalizationHeadroomMs,
})

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
          const issuedAt = tick.issuedAt ?? (await ctx.date.toJSON())
          const decision = decisionOrTerminal(decideExecutionControllerTick(state, tick, ctx.key, issuedAt))
          if (decision._tag === 'Ignored') return

          let stepResult: ExecutionAdvanceStepResult
          try {
            stepResult = await ctx.run(
              'advance Bayn execution once',
              () => runtime.advance(decision.command, ctx.request().attemptCompletedSignal),
              executionControllerAdvanceRunOptions,
            )
          } catch (cause) {
            const attempt = tick.attempt ?? 0
            if (attempt + 1 < executionControllerAdvanceMaximumAttempts && state !== null) {
              const nextAttempt = attempt + 1
              const retryDelayMs = Math.min(1_000 * 2 ** attempt, 30_000)
              scheduleTick(ctx, state, retryDelayMs, nextAttempt, issuedAt)
              await writeRuntimeLog(runtime, 'warning', 'Bayn execution controller advance will retry', {
                controllerKey: ctx.key,
                epoch: state.epoch,
                invocationId: ctx.request().id,
                nextAttempt,
                sequence: state.nextSequence,
                sourceRevision: state.sourceRevision,
              })
              return
            }
            await writeRuntimeLog(runtime, 'error', 'Bayn execution controller advance exhausted retries', {
              controllerKey: ctx.key,
              epoch: tick.epoch,
              invocationId: ctx.request().id,
              sequence: tick.sequence,
              sourceRevision: config.sourceRevision,
            })
            throw new Error('Bayn execution controller advance exhausted its durable retry budget', { cause })
          }
          const result = decodeOrTerminal(
            decodeExecutionAdvanceStepResult(stepResult),
            'execution controller advance result failed validation',
          )
          if (state === null) throw terminal('execution controller state disappeared during an accepted tick')
          const completed = decisionOrTerminal(completeExecutionControllerTick(state, tick, result))
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
          verifyActivationBinding(config, ctx.key, request)
          const decision = decisionOrTerminal(decideExecutionControllerDeactivation(await readState(ctx), request))
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
  legacyCutover?: LegacyLifecycleCutoverBinding,
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
          verifyActivationBinding(config, request.controllerKey, request)
          authorizeBootstrap(authorizationHash, ctx.request().headers.get('authorization'))
          const client = ctx.objectClient(controller, config.controllerKey)
          const state = await client.status(undefined)
          if (
            state !== null &&
            state.active &&
            (state.planHash !== config.planHash || state.sourceRevision !== config.sourceRevision)
          ) {
            throw terminal('execution controller bootstrap conflicts with active durable state')
          }
          if (legacyCutover !== undefined && (state === null || !state.active)) {
            await deactivateLegacyLifecycle(ctx, config, legacyCutover)
          }
          return client.activate(bindBootstrapActivation(state, request))
        },
      ),
    },
    options: {
      hooks: [...hooks],
      ...executionControllerHandlerTimeouts(config.operationTimeoutMs),
    },
  })
