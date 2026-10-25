import type { TengriAction, TengriDesktopSnapshot, TengriErrorCode } from '@/lib/tengri/types'
import { readCodexHistory } from '@/lib/tengri/codex-history'
import { tengriCreateAgentSchema } from '@/lib/tengri/schemas'
import { z } from 'zod'
import { reportBrowserFailure } from '@/lib/observability/client'

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
  const response = await fetch('/api/tengri', { cache: 'no-store', credentials: 'same-origin', signal }).catch(
    (error: unknown) => {
      if (!signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError'))
        reportBrowserFailure('tengri.snapshot')
      throw error
    },
  )
  return decodeResponse<TengriDesktopSnapshot>(response)
}

type TengriActionOptions = {
  keepalive?: boolean
  principalId?: string
  signal?: AbortSignal
}

type GuestOperationScope = {
  active: Map<AbortController, { blocksLifecycle: boolean }>
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
  for (const request of guestOperationScopes.get(agentId)?.active.values() ?? []) {
    if (request.blocksLifecycle) return true
  }
  return false
}

export function hasActiveTengriGuestOperations(agentId: string) {
  return getTengriGuestOperationSnapshot(agentId)
}

export function beginTengriLifecycleTransition(agentId: string) {
  const scope = guestOperationScope(agentId)
  scope.lifecycleBlocks += 1
  for (const controller of scope.active.keys()) {
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
  if (scope.lifecycleBlocks > 0) throw new DOMException('Agent lifecycle transition is in progress', 'AbortError')

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options?.signal?.reason)
  options?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  scope.active.set(controller, {
    blocksLifecycle:
      action.action !== 'codex-models' &&
      action.action !== 'list-threads' &&
      action.action !== 'resume-thread' &&
      action.action !== 'active-codex-run' &&
      action.action !== 'codex-run',
  })
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

async function postTengriAction<Result>(
  action: TengriAction,
  options?: TengriActionOptions,
  reconcileCreation = true,
): Promise<Result> {
  const pending = await prepareLifecycleRequest(action, options?.principalId)
  const response = await fetch('/api/tengri', {
    method: 'POST',
    body: JSON.stringify(pending.action),
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    keepalive: options?.keepalive,
    signal: options?.signal,
  }).catch((error: unknown) => {
    if (!options?.signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError'))
      reportBrowserFailure('tengri.request')
    throw error
  })
  if (action.action === 'resume-thread' && response.ok) {
    return (await readCodexHistory(response, action.threadId, options?.signal, (record) =>
      requestFailure(
        record,
        typeof record.status === 'number' && record.status >= 400 && record.status <= 599 ? record.status : 503,
        response.headers.get('x-trace-id'),
      ),
    )) as Result
  }
  try {
    const payload = await decodeResponse<{ result: Result }>(response)
    await pending.complete('committed')
    return payload.result
  } catch (error) {
    if (error instanceof TengriRequestError && error.code === 'lifecycle_superseded') {
      await pending.complete('superseded')
      if (
        reconcileCreation &&
        action.action === 'create-agent' &&
        pending.action.action === 'create-agent' &&
        action.displayName !== pending.action.displayName
      ) {
        return postTengriAction<Result>(action, options, false)
      }
    }
    throw error
  }
}

const pendingLifecycleSchema = z
  .array(
    z.strictObject({
      key: z.string().max(200),
      payload: z.string().max(1024),
      operationId: z.uuid(),
    }),
  )
  .max(16)

async function prepareLifecycleRequest(action: TengriAction, principalId?: string) {
  if (!['create-agent', 'sleep-agent', 'resume-agent', 'delete-agent'].includes(action.action)) {
    return { action, complete: (_outcome: 'committed' | 'superseded') => {} }
  }
  const principal = z.string().min(1).max(200).safeParse(principalId)
  if (!principal.success) {
    throw new Error('Refresh your signed-in session before changing the workspace lifecycle.')
  }
  if (!navigator.locks) {
    throw new Error('This browser cannot coordinate workspace changes. Use a browser that supports Web Locks.')
  }
  const pendingLifecycleKey = `tengri.pending-lifecycle.v2/${encodeURIComponent(principal.data)}`
  const key =
    action.action === 'create-agent'
      ? action.action
      : `${action.action}/${'workspaceUid' in action ? action.workspaceUid : ''}`
  const payload = JSON.stringify(action)
  const read = () => pendingLifecycleSchema.parse(JSON.parse(localStorage.getItem(pendingLifecycleKey) ?? '[]'))
  const pending = await navigator.locks.request(pendingLifecycleKey, () => {
    const entries = read()
    const existing = entries.find((entry) => entry.key === key)
    if (existing && existing.payload !== payload && action.action !== 'create-agent') {
      throw new Error('A workspace change is already recorded. Refresh the desktop or retry it with the same name.')
    }
    const pending = existing ?? { key, payload, operationId: crypto.randomUUID() }
    if (!existing) {
      if (entries.length >= 16) throw new Error('Retry your pending workspace changes before starting another.')
      localStorage.setItem(pendingLifecycleKey, JSON.stringify([...entries, pending]))
    }
    return pending
  })
  const request =
    pending.payload === payload
      ? action
      : tengriCreateAgentSchema.omit({ operationId: true }).parse(JSON.parse(pending.payload))
  return {
    action: { ...request, operationId: pending.operationId },
    complete: (outcome: 'committed' | 'superseded') =>
      navigator.locks.request(pendingLifecycleKey, async () => {
        // A stale tab must recover this creation even after another tab receives its successful response.
        if (outcome === 'committed' && action.action === 'create-agent') return
        const entries = read()
        let removedCreationId: string | undefined
        const creation = entries.find((entry) => entry.key === 'create-agent')
        if (outcome === 'committed' && action.action === 'delete-agent' && creation) {
          const owner = await sha256Hex(`github:${principal.data}`)
          const agentId = `agent-${(await sha256Hex(`ofz.workspace.v1\n${owner}\n${creation.operationId}`)).slice(0, 32)}`
          if (agentId === action.agentId) removedCreationId = creation.operationId
        }
        const current = entries.filter(
          (entry) =>
            (entry.key !== key || entry.operationId !== pending.operationId) &&
            (entry.key !== 'create-agent' || entry.operationId !== removedCreationId),
        )
        localStorage.setItem(pendingLifecycleKey, JSON.stringify(current))
      }),
  }
}

async function sha256Hex(value: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
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
  const scope: GuestOperationScope = { active: new Map(), lifecycleBlocks: 0, listeners: new Set() }
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
    throw requestFailure(payload, response.status, response.headers.get('x-trace-id'))
  }
  if (!payload) throw new Error('Tengri returned an empty response')
  return payload as Result
}

function requestFailure(payload: unknown, status: number, traceId?: string | null) {
  if (status >= 500) reportBrowserFailure('tengri.request', status, traceId)
  const record = typeof payload === 'object' && payload !== null ? payload : {}
  const message = 'error' in record && typeof record.error === 'string' ? record.error : ''
  const code =
    'code' in record &&
    ((status === 404 && record.code === 'conversation_not_found') ||
      (status === 409 && record.code === 'file_conflict') ||
      (status === 409 && record.code === 'lifecycle_superseded') ||
      (status === 409 && record.code === 'control_not_dispatched') ||
      (status === 502 && record.code === 'model_catalog_invalid') ||
      (status === 502 && record.code === 'conversation_history_invalid') ||
      (status === 429 && record.code === 'capacity_full'))
      ? record.code
      : undefined
  return new TengriRequestError(message || `Tengri request failed with ${status}`, status, code)
}

function isAbortSignal(value: AbortSignal | TengriActionOptions | undefined): value is AbortSignal {
  return Boolean(value && 'aborted' in value && 'addEventListener' in value)
}
