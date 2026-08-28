import type { TengriAction, TengriDesktopSnapshot } from '@/lib/tengri/types'

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
  const response = await fetch('/api/tengri', {
    method: 'POST',
    body: JSON.stringify(action),
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    keepalive: options?.keepalive,
    signal: options?.signal,
  })
  const payload = await decodeResponse<{ result: Result }>(response)
  return payload.result
}

function guestActionAgentId(action: TengriAction) {
  switch (action.action) {
    case 'create-agent':
    case 'delete-agent':
    case 'resume-agent':
    case 'revoke-preview-session':
    case 'sleep-agent':
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
  const payload = (await response.json().catch(() => null)) as ({ error?: string } & Result) | null
  if (!response.ok) throw new Error(payload?.error || `Tengri request failed with ${response.status}`)
  if (!payload) throw new Error('Tengri returned an empty response')
  return payload
}

function isAbortSignal(value: AbortSignal | TengriActionOptions | undefined): value is AbortSignal {
  return Boolean(value && 'aborted' in value && 'addEventListener' in value)
}
