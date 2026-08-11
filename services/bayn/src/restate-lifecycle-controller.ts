import * as restate from '@restatedev/restate-sdk'
import { Effect, Logger, Result } from 'effect'

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
export type LifecycleCommandCredential = () => Promise<string>

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

export const lifecycleCommandRequestTimeoutMs = (operationTimeoutMs: number): number =>
  operationTimeoutMs + lifecycleCommandFinalizationHeadroomMs

// Let the bounded HTTP request finish and give Restate one additional journal-finalization window before requesting
// suspension. The abort window then bounds non-cooperative code without cutting off any accepted Bayn operation.
export const lifecycleHandlerTimeouts = (
  operationTimeoutMs: number,
): { readonly inactivityTimeout: number; readonly abortTimeout: number } => ({
  inactivityTimeout: lifecycleCommandRequestTimeoutMs(operationTimeoutMs) + lifecycleCommandFinalizationHeadroomMs,
  abortTimeout: lifecycleCommandFinalizationHeadroomMs,
})

const fetchJson = async (
  request: HttpRequest,
  url: string,
  init: RequestInit,
  requestTimeoutMs: number,
): Promise<unknown> => {
  const response = await request(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
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
  const requestTimeoutMs = lifecycleCommandRequestTimeoutMs(config.operationTimeoutMs)
  return {
    readCursor: async () => {
      const token = await credential()
      return decodeOrTerminal(
        decodeLifecycleCommandCursorResponse(
          await fetchJson(
            request,
            `${config.commandBaseUrl}/v1/lifecycle/cursor`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${token}` },
            },
            requestTimeoutMs,
          ),
        ),
        'Bayn lifecycle command cursor response failed validation',
      )
    },
    advance: async (command) => {
      const token = await credential()
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
            requestTimeoutMs,
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
): void => {
  const sequence = state.cursor._tag === 'Pending' ? state.cursor.command.sequence : state.cursor.sequence
  ctx.genericSend({
    service: 'BaynLifecycle',
    method: 'advance',
    key: ctx.key,
    parameter: { schemaVersion: 'bayn.restate-lifecycle-tick.v1', epoch: state.epoch, sequence },
    inputSerde: lifecycleTickSerde,
    delay,
    idempotencyKey: `bayn-lifecycle-${state.epoch}-${sequence}`,
  })
}

export const makeBaynLifecycle = (config: RestateLifecycleConfig, client: LifecycleCommandClient) =>
  restate.object({
    name: 'BaynLifecycle',
    handlers: {
      activate: async (ctx: restate.ObjectContext<LifecycleObjectState>, candidate: unknown) => {
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
          throw new Error('Bayn lifecycle command cursor does not match this source deployment')
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

      advance: async (ctx: restate.ObjectContext<LifecycleObjectState>, candidate: unknown): Promise<void> => {
        const tick = decodeOrTerminal(decodeRestateLifecycleTick(candidate), 'Restate lifecycle tick failed validation')
        const state = await readState(ctx)
        if (state === null || !state.active || tick.epoch !== state.epoch) return
        const expectedSequence = state.cursor._tag === 'Pending' ? state.cursor.command.sequence : state.cursor.sequence
        if (tick.sequence !== expectedSequence) return

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
          epoch: state.epoch,
          outcome:
            response.observation.result === 'SUCCESS'
              ? response.observation.outcome
              : `${response.observation.operation}/${response.observation.failure}`,
          replayed: response.replayed,
          result: response.observation.result,
        })
      },

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
      start: async (ctx: restate.Context, candidate: unknown) => {
        const request = decodeOrTerminal(
          decodeRestateLifecycleActivation(candidate),
          'Restate lifecycle bootstrap request failed validation',
        )
        if (request.controllerKey !== config.controllerKey) {
          throw terminal('Restate lifecycle bootstrap controller key does not match this deployment')
        }
        return ctx.objectClient(lifecycle, config.controllerKey).activate(request)
      },
    },
    options: {
      ...lifecycleHandlerTimeouts(config.operationTimeoutMs),
    },
  })
