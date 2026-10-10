import type { TengriAction, TengriDesktopSnapshot, TengriErrorCode } from '@/lib/tengri/types'
import { readCodexHistory } from '@/lib/tengri/codex-history'
import { z } from 'zod'

export class TengriRequestError extends Error {
  readonly status: number
  readonly code?: TengriErrorCode

  constructor(message: string, status: number, code?: TengriErrorCode) {
    super(message)
    this.name = 'TengriRequestError'
    this.status = status
    this.code = code
  }
}

export async function getDesktopSnapshot(signal?: AbortSignal): Promise<TengriDesktopSnapshot> {
  const response = await fetch('/api/tengri', { cache: 'no-store', credentials: 'same-origin', signal })
  return decodeResponse<TengriDesktopSnapshot>(response)
}

type TengriActionOptions = {
  keepalive?: boolean
  signal?: AbortSignal
}

type GuestOperationScope = {
  active: Set<AbortController>
  lifecycleBlocks: number
  listeners: Set<() => void>
}

const guestOperationScopes = new Map<string, GuestOperationScope>()

export function subscribeTengriGuestOperations(agentId: string, listener: () => void) {
  const scope = guestOperationScope(agentId)
  scope.listeners.add(listener)
  return () => {
    scope.listeners.delete(listener)
    deleteUnusedGuestOperationScope(agentId, scope)
  }
}

export function getTengriGuestOperationSnapshot(agentId: string) {
  return (guestOperationScopes.get(agentId)?.active.size ?? 0) > 0
}

export function hasActiveTengriGuestOperations(agentId: string) {
  return getTengriGuestOperationSnapshot(agentId)
}

export function beginTengriLifecycleTransition(agentId: string) {
  const scope = guestOperationScope(agentId)
  scope.lifecycleBlocks += 1
  for (const controller of scope.active) {
    controller.abort(new DOMException('Agent lifecycle transition is in progress', 'AbortError'))
  }

  let released = false
  return () => {
    if (released) return
    released = true
    scope.lifecycleBlocks = Math.max(0, scope.lifecycleBlocks - 1)
    deleteUnusedGuestOperationScope(agentId, scope)
  }
}

export async function runTengriAction<Result>(
  action: TengriAction,
  signalOrOptions?: AbortSignal | TengriActionOptions,
): Promise<Result> {
  const options = isAbortSignal(signalOrOptions) ? { signal: signalOrOptions } : signalOrOptions
  const guestAgentId = guestActionAgentId(action)
  if (!guestAgentId) return postTengriAction<Result>(action, options)

  options?.signal?.throwIfAborted()
  const scope = guestOperationScope(guestAgentId)
  if (scope.lifecycleBlocks > 0) throw new Error('Agent lifecycle transition is in progress')

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options?.signal?.reason)
  options?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  scope.active.add(controller)
  notifyGuestOperationListeners(scope)
  try {
    return await postTengriAction<Result>(action, { ...options, signal: controller.signal })
  } finally {
    options?.signal?.removeEventListener('abort', abortFromCaller)
    scope.active.delete(controller)
    notifyGuestOperationListeners(scope)
    deleteUnusedGuestOperationScope(guestAgentId, scope)
  }
}

async function postTengriAction<Result>(action: TengriAction, options?: TengriActionOptions) {
  const pending = prepareLifecycleRequest(action)
  const response = await fetch('/api/tengri', {
    method: 'POST',
    body: JSON.stringify(pending.action),
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    keepalive: options?.keepalive,
    signal: options?.signal,
  })
  if (action.action === 'resume-thread' && response.ok) {
    return (await readCodexHistory(response, action.threadId, options?.signal, (record) =>
      requestFailure(
        record,
        typeof record.status === 'number' && record.status >= 400 && record.status <= 599 ? record.status : 503,
      ),
    )) as Result
  }
  const payload = await decodeResponse<{ result: Result }>(response)
  pending.complete()
  return payload.result
}

const pendingLifecycleKey = 'tengri.pending-lifecycle.v1'
const pendingLifecycleSchema = z
  .array(
    z.strictObject({
      key: z.string().max(200),
      payload: z.string().max(1024),
      operationId: z.uuid(),
    }),
  )
  .max(16)

function prepareLifecycleRequest(action: TengriAction) {
  if (!['create-agent', 'sleep-agent', 'resume-agent', 'delete-agent'].includes(action.action)) {
    return { action, complete: () => {} }
  }
  const key =
    action.action === 'create-agent'
      ? action.action
      : `${action.action}/${'workspaceUid' in action ? action.workspaceUid : ''}`
  const payload = JSON.stringify(action)
  const read = () => pendingLifecycleSchema.parse(JSON.parse(sessionStorage.getItem(pendingLifecycleKey) ?? '[]'))
  const entries = read()
  const existing = entries.find((entry) => entry.key === key)
  if (existing && existing.payload !== payload) {
    throw new Error('A workspace change is still pending. Retry it with the same name before starting another.')
  }
  const pending = existing ?? { key, payload, operationId: crypto.randomUUID() }
  if (!existing) {
    if (entries.length >= 16) throw new Error('Retry your pending workspace changes before starting another.')
    sessionStorage.setItem(pendingLifecycleKey, JSON.stringify([...entries, pending]))
  }
  return {
    action: { ...action, operationId: pending.operationId },
    complete: () => {
      const current = read().filter((entry) => entry.key !== key || entry.operationId !== pending.operationId)
      sessionStorage.setItem(pendingLifecycleKey, JSON.stringify(current))
    },
  }
}

function guestActionAgentId(action: TengriAction) {
  switch (action.action) {
    case 'create-agent':
    case 'delete-agent':
    case 'resume-agent':
    case 'revoke-editor-sessions':
    case 'revoke-preview-session':
    case 'sleep-agent':
    case 'update-power-settings':
      return null
    default:
      return action.agentId
  }
}

function guestOperationScope(agentId: string) {
  const existing = guestOperationScopes.get(agentId)
  if (existing) return existing
  const scope: GuestOperationScope = { active: new Set(), lifecycleBlocks: 0, listeners: new Set() }
  guestOperationScopes.set(agentId, scope)
  return scope
}

function notifyGuestOperationListeners(scope: GuestOperationScope) {
  for (const listener of scope.listeners) listener()
}

function deleteUnusedGuestOperationScope(agentId: string, scope: GuestOperationScope) {
  if (scope.active.size === 0 && scope.lifecycleBlocks === 0 && scope.listeners.size === 0) {
    guestOperationScopes.delete(agentId)
  }
}

async function decodeResponse<Result>(response: Response): Promise<Result> {
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw requestFailure(payload, response.status)
  }
  if (!payload) throw new Error('Tengri returned an empty response')
  return payload as Result
}

function requestFailure(payload: unknown, status: number) {
  const record = typeof payload === 'object' && payload !== null ? payload : {}
  const message = 'error' in record && typeof record.error === 'string' ? record.error : ''
  const code =
    'code' in record &&
    ((status === 404 && record.code === 'conversation_not_found') ||
      (status === 409 && record.code === 'file_conflict') ||
      (status === 412 && record.code === 'model_selection_unavailable') ||
      (status === 429 && record.code === 'capacity_full'))
      ? record.code
      : undefined
  return new TengriRequestError(message || `Tengri request failed with ${status}`, status, code)
}

function isAbortSignal(value: AbortSignal | TengriActionOptions | undefined): value is AbortSignal {
  return Boolean(value && 'aborted' in value && 'addEventListener' in value)
}
