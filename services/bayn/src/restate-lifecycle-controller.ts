import * as restate from '@restatedev/restate-sdk'
import { Effect, Logger, Result } from 'effect'

import { maximumConsistencyDelayMs } from './execution/mutations'
import {
  completeRestateLifecycleTick,
  decodeLifecycleCommandCursorResponse,
  decodeLifecycleCommandResponse,
  decodeRestateLifecycleActivation,
  decodeRestateLifecycleState,
  decodeRestateLifecycleTick,
  initialRestateLifecycleState,
  lifecycleCommandFromCursor,
  type LifecycleCommandCursorResponse,
  type LifecycleCommandResponse,
  type RestateLifecycleConfig,
  type RestateLifecycleState,
  type RestateLifecycleTick,
} from './restate-lifecycle'

const stateKey = 'controller'
const maximumResponseBytes = 64 * 1024
export const lifecycleCommandFinalizationHeadroomMs = 30_000
export const lifecycleCursorRequestTimeoutMs = 10_000
export const lifecycleActivationMaximumAttempts = 8
export const lifecycleActivationInitialRetryIntervalMs = 1_000
export const lifecycleActivationMaximumRetryIntervalMs = 30_000
export const lifecycleActivationRetryIntervalFactor = 2
export const lifecycleActivationIdempotencyRetentionMs = 10 * 60_000
export const lifecycleActivationRetryPolicy = {
  maxAttempts: lifecycleActivationMaximumAttempts,
  onMaxAttempts: 'kill',
  initialInterval: lifecycleActivationInitialRetryIntervalMs,
  maxInterval: lifecycleActivationMaximumRetryIntervalMs,
  exponentiationFactor: lifecycleActivationRetryIntervalFactor,
} as const satisfies restate.RetryPolicy
export const lifecycleBootstrapRetryPolicy = {
  maxAttempts: 1,
  onMaxAttempts: 'kill',
} as const satisfies restate.RetryPolicy
export const lifecycleAdvanceRetryPolicy = {
  maxAttempts: 1,
  onMaxAttempts: 'kill',
} as const satisfies restate.RetryPolicy
const lifecycleTickSerde = restate.serde.json.schema<RestateLifecycleTick>({
  type: 'object',
  required: ['schemaVersion', 'epoch', 'sequence'],
  additionalProperties: false,
})

type LifecycleObjectState = { readonly controller: RestateLifecycleState }

export interface LifecycleCommandClient {
  readonly readCursor: () => Promise<LifecycleCommandCursorResponse>
  readonly advance: (command: {
    readonly controllerKey: string
    readonly commandId: string
    readonly sequence: number
    readonly issuedAt: string
  }) => Promise<LifecycleCommandResponse>
}

type HttpRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type LifecycleCommandCredential = (signal: AbortSignal) => Promise<string>

export const lifecycleLog = (
  message: string,
  annotations: Readonly<Record<string, string | number | boolean>>,
): Promise<void> =>
  Effect.logInfo(message).pipe(
    Effect.annotateLogs(annotations),
    Effect.annotateLogs({ service: 'bayn-lifecycle' }),
    // @effect-diagnostics-next-line strictEffectProvide:off -- Restate owns this isolated worker process
    Effect.provide(Logger.layer([Logger.consoleJson])),
    Effect.runPromise,
  )

const terminal = (message: string): restate.TerminalError =>
  new restate.TerminalError(message, {
    errorCode: 400,
  })

const decodeOrTerminal = <A>(decoded: Result.Result<A, unknown>, message: string): A => {
  if (Result.isFailure(decoded)) throw terminal(message)
  return decoded.success
}

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw terminal('Bayn lifecycle command boundary returned a non-JSON response')
  }
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    throw terminal('Bayn lifecycle command boundary response exceeded its size limit')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumResponseBytes) {
    throw terminal('Bayn lifecycle command boundary response exceeded its size limit')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw terminal('Bayn lifecycle command boundary returned invalid JSON')
  }
}

// One externally driven advance can run a bounded reconciliation preflight and cycle pass. A successful mutation can
// then require the maximum schema-valid consistency delay and one separately bounded reconciliation. Retain a final
// window for the durable command receipt and response rather than interrupting an accepted broker mutation mid-settle.
export const lifecycleCommandRequestTimeoutMs = (operationTimeoutMs: number): number =>
  operationTimeoutMs * 3 + maximumConsistencyDelayMs + lifecycleCommandFinalizationHeadroomMs

const lifecycleActivationRetryDelayMs = (): number => {
  let interval = lifecycleActivationInitialRetryIntervalMs
  let total = 0
  for (let attempt = 1; attempt < lifecycleActivationMaximumAttempts; attempt += 1) {
    total += interval
    interval = Math.min(interval * lifecycleActivationRetryIntervalFactor, lifecycleActivationMaximumRetryIntervalMs)
  }
  return total
}

// Activation is an exclusive virtual-object command. A rollout request can therefore wait behind one already-running
// advance before its own bounded cursor recovery begins. Keep the ingress waiter alive for both phases and a separate
// response-finalization window; otherwise a healthy activation can be abandoned while Restate is still progressing.
export const lifecycleActivationAwaitTimeoutMs = (operationTimeoutMs: number): number =>
  lifecycleCommandRequestTimeoutMs(operationTimeoutMs) +
  lifecycleCursorRequestTimeoutMs * lifecycleActivationMaximumAttempts +
  lifecycleActivationRetryDelayMs() +
  lifecycleCommandFinalizationHeadroomMs

// Let the bounded HTTP request finish and give Restate one additional journal-finalization window before requesting
// suspension. The abort window then bounds non-cooperative code without cutting off any accepted Bayn operation.
export const lifecycleHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: lifecycleCommandRequestTimeoutMs(operationTimeoutMs) + lifecycleCommandFinalizationHeadroomMs,
  abortTimeout: lifecycleCommandFinalizationHeadroomMs,
})

export const lifecycleActivationHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: lifecycleActivationAwaitTimeoutMs(operationTimeoutMs) + lifecycleCommandFinalizationHeadroomMs,
  abortTimeout: lifecycleCommandFinalizationHeadroomMs,
})

const fetchJson = async (
  request: HttpRequest,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await request(url, { ...init, signal })
  if (!response.ok) {
    const message = `Bayn lifecycle command boundary returned HTTP ${response.status}`
    if (response.status >= 400 && response.status < 500) throw terminal(message)
    throw new Error(message)
  }
  return readBoundedJson(response)
}

export const makeLifecycleCommandClient = (
  config: RestateLifecycleConfig,
  credential: LifecycleCommandCredential,
  request: HttpRequest = fetch,
): LifecycleCommandClient => {
  const commandRequestTimeoutMs = lifecycleCommandRequestTimeoutMs(config.operationTimeoutMs)
  return {
    readCursor: async () => {
      const signal = AbortSignal.timeout(lifecycleCursorRequestTimeoutMs)
      const token = await credential(signal)
      return decodeOrTerminal(
        decodeLifecycleCommandCursorResponse(
          await fetchJson(
            request,
            `${config.commandBaseUrl}/v1/lifecycle/cursor`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${token}` },
            },
            signal,
          ),
        ),
        'Bayn lifecycle command cursor response failed validation',
      )
    },
    advance: async (command) => {
      const signal = AbortSignal.timeout(commandRequestTimeoutMs)
      const token = await credential(signal)
      return decodeOrTerminal(
        decodeLifecycleCommandResponse(
          await fetchJson(
            request,
            `${config.commandBaseUrl}/v1/lifecycle/advance`,
            {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                schemaVersion: 'bayn.lifecycle-command.v1',
                ...command,
                sourceRevision: config.sourceRevision,
              }),
            },
            signal,
          ),
        ),
        'Bayn lifecycle command response failed validation',
      )
    },
  }
}

const readState = async (ctx: restate.ObjectContext<LifecycleObjectState>): Promise<RestateLifecycleState | null> => {
  const candidate = await ctx.get(stateKey)
  return candidate === null
    ? null
    : decodeOrTerminal(decodeRestateLifecycleState(candidate), 'Restate lifecycle state failed validation')
}

const scheduleTick = (
  ctx: restate.ObjectContext<LifecycleObjectState>,
  state: RestateLifecycleState,
  delay: number,
  deliveryAttempt = 0,
): void => {
  const sequence = state.cursor._tag === 'Pending' ? state.cursor.command.sequence : state.cursor.sequence
  ctx.genericSend({
    service: 'BaynLifecycle',
    method: 'advance',
    key: ctx.key,
    parameter: {
      schemaVersion: 'bayn.restate-lifecycle-tick.v1',
      epoch: state.epoch,
      sequence,
      deliveryAttempt,
    },
    inputSerde: lifecycleTickSerde,
    delay,
    idempotencyKey: lifecycleTickIdempotencyKey(state.epoch, sequence, deliveryAttempt),
  })
}

export const lifecycleTickIdempotencyKey = (epoch: number, sequence: number, deliveryAttempt: number): string =>
  `bayn-lifecycle-${epoch}-${sequence}-${deliveryAttempt}`

export const makeBaynLifecycle = (config: RestateLifecycleConfig, client: LifecycleCommandClient) =>
  restate.object({
    name: 'BaynLifecycle',
    handlers: {
      activate: restate.handlers.object.exclusive(
        { retryPolicy: lifecycleActivationRetryPolicy },
        async (ctx: restate.ObjectContext<LifecycleObjectState>, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeRestateLifecycleActivation(candidate),
            'Restate lifecycle activation request failed validation',
          )
          if (ctx.key !== config.controllerKey || request.controllerKey !== config.controllerKey) {
            throw terminal('Restate lifecycle activation controller key does not match this deployment')
          }

          const current = await readState(ctx)
          // The public bootstrap is intentionally idempotent for one immutable plan. In particular, it cannot undo an
          // operator-initiated deactivation; only a newly reviewed source/configuration plan may start a new epoch.
          if (current?.planHash === config.planHash) return current

          const cursor = await ctx.run('recover Bayn lifecycle command cursor', () => client.readCursor())
          if (cursor.controllerKey !== config.controllerKey || cursor.sourceRevision !== config.sourceRevision) {
            throw terminal('Bayn lifecycle command cursor does not match this source deployment')
          }
          const state = initialRestateLifecycleState(config, cursor.cursor, current?.epoch ?? 0)
          ctx.set(stateKey, state)
          scheduleTick(ctx, state, 0)
          await lifecycleLog('Bayn Restate lifecycle activated', {
            controllerKey: ctx.key,
            epoch: state.epoch,
            nextSequence: state.cursor._tag === 'Pending' ? state.cursor.command.sequence : state.cursor.sequence,
            planHash: state.planHash,
            sourceRevision: state.sourceRevision,
          })
          return state
        },
      ),

      advance: restate.handlers.object.exclusive(
        { retryPolicy: lifecycleAdvanceRetryPolicy },
        async (ctx: restate.ObjectContext<LifecycleObjectState>, candidate: unknown): Promise<void> => {
          const tick = decodeOrTerminal(
            decodeRestateLifecycleTick(candidate),
            'Restate lifecycle tick failed validation',
          )
          const state = await readState(ctx)
          if (state === null || !state.active || tick.epoch !== state.epoch) return
          const expectedSequence =
            state.cursor._tag === 'Pending' ? state.cursor.command.sequence : state.cursor.sequence
          if (tick.sequence !== expectedSequence) return

          const deliveryAttempt = tick.deliveryAttempt ?? 0
          if (deliveryAttempt === Number.MAX_SAFE_INTEGER) {
            throw terminal('Bayn lifecycle tick exhausted its delivery attempt range')
          }
          // Journal a detached retry before the external command. If the request fails, Restate kills this invocation
          // after one attempt and releases the virtual-object lock; the retry then recovers the same durable command.
          // If it succeeds, the cursor advances and the retry becomes a harmless stale tick.
          scheduleTick(ctx, state, config.pollIntervalMs, deliveryAttempt + 1)

          const issuedAt = await ctx.date.toJSON()
          const command = lifecycleCommandFromCursor(config.controllerKey, state.cursor, issuedAt)
          const response = await ctx.run('advance Bayn lifecycle', () => client.advance(command))
          if (
            response.commandId !== command.commandId ||
            response.sequence !== command.sequence ||
            response.sourceRevision !== config.sourceRevision
          ) {
            throw terminal('Bayn lifecycle command response identity does not match its request')
          }
          const completedAt = await ctx.date.toJSON()
          const completed = completeRestateLifecycleTick(state, response, completedAt)
          ctx.set(stateKey, completed)
          scheduleTick(ctx, completed, response.nextDelayMs)
          await lifecycleLog('Bayn Restate lifecycle command completed', {
            commandId: response.commandId,
            commandSequence: response.sequence,
            controllerKey: ctx.key,
            deliveryAttempt,
            epoch: state.epoch,
            outcome:
              response.observation.result === 'SUCCESS'
                ? response.observation.outcome
                : `${response.observation.operation}/${response.observation.failure}`,
            replayed: response.replayed,
            result: response.observation.result,
          })
        },
      ),

      deactivate: async (ctx: restate.ObjectContext<LifecycleObjectState>, candidate: unknown) => {
        const request = decodeOrTerminal(
          decodeRestateLifecycleActivation(candidate),
          'Restate lifecycle deactivation request failed validation',
        )
        if (ctx.key !== config.controllerKey || request.controllerKey !== config.controllerKey) {
          throw terminal('Restate lifecycle deactivation controller key does not match this deployment')
        }
        const current = await readState(ctx)
        if (current === null || !current.active) return current
        const state = { ...current, active: false, epoch: current.epoch + 1 }
        ctx.set(stateKey, state)
        await lifecycleLog('Bayn Restate lifecycle deactivated', {
          controllerKey: ctx.key,
          epoch: state.epoch,
          planHash: state.planHash,
        })
        return state
      },

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext<LifecycleObjectState>, _candidate: unknown) => {
          const candidate = await ctx.get(stateKey)
          return candidate === null
            ? null
            : decodeOrTerminal(decodeRestateLifecycleState(candidate), 'Restate lifecycle state failed validation')
        },
      ),
    },
    options: {
      ingressPrivate: true,
      enableLazyState: true,
      ...lifecycleHandlerTimeouts(config.operationTimeoutMs),
    },
  })

export const makeBaynLifecycleBootstrap = (
  config: RestateLifecycleConfig,
  lifecycle: ReturnType<typeof makeBaynLifecycle>,
) =>
  restate.service({
    name: 'BaynLifecycleBootstrap',
    handlers: {
      start: restate.handlers.handler(
        {
          idempotencyRetention: lifecycleActivationIdempotencyRetentionMs,
          retryPolicy: lifecycleBootstrapRetryPolicy,
        },
        async (ctx: restate.Context, candidate: unknown) => {
          const request = decodeOrTerminal(
            decodeRestateLifecycleActivation(candidate),
            'Restate lifecycle bootstrap request failed validation',
          )
          if (request.controllerKey !== config.controllerKey) {
            throw terminal('Restate lifecycle bootstrap controller key does not match this deployment')
          }
          return ctx.objectClient(lifecycle, config.controllerKey).activate(request)
        },
      ),
    },
    options: {
      ...lifecycleActivationHandlerTimeouts(config.operationTimeoutMs),
    },
  })
