export type CodeOpenRequest = {
  path: string
  requestId: number
}

export function isCodePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 4_096 &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  )
}

export function codeOpenRequestKey(request: CodeOpenRequest): string {
  return `${request.requestId}:${request.path}`
}

export function enqueueCodeOpenRequest(queue: CodeOpenRequest[], request: CodeOpenRequest): CodeOpenRequest[] {
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0 || !isCodePath(request.path)) return queue
  const requestKey = codeOpenRequestKey(request)
  return queue.some((candidate) => codeOpenRequestKey(candidate) === requestKey) ? queue : [...queue, request]
}

export function updateDirtyCodeWindows(current: Set<string>, windowId: string, dirty: boolean): Set<string> {
  if (!windowId || current.has(windowId) === dirty) return current
  const next = new Set(current)
  if (dirty) next.add(windowId)
  else next.delete(windowId)
  return next
}
