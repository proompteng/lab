import type { TengriAction, TengriDesktopSnapshot } from '@/lib/tengri/types'

export async function getDesktopSnapshot(signal?: AbortSignal): Promise<TengriDesktopSnapshot> {
  const response = await fetch('/api/tengri', { cache: 'no-store', credentials: 'same-origin', signal })
  return decodeResponse<TengriDesktopSnapshot>(response)
}

type TengriActionOptions = {
  keepalive?: boolean
  signal?: AbortSignal
}

export async function runTengriAction<Result>(
  action: TengriAction,
  signalOrOptions?: AbortSignal | TengriActionOptions,
): Promise<Result> {
  const options = isAbortSignal(signalOrOptions) ? { signal: signalOrOptions } : signalOrOptions
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

async function decodeResponse<Result>(response: Response): Promise<Result> {
  const payload = (await response.json().catch(() => null)) as ({ error?: string } & Result) | null
  if (!response.ok) throw new Error(payload?.error || `Tengri request failed with ${response.status}`)
  if (!payload) throw new Error('Tengri returned an empty response')
  return payload
}

function isAbortSignal(value: AbortSignal | TengriActionOptions | undefined): value is AbortSignal {
  return Boolean(value && 'aborted' in value && 'addEventListener' in value)
}
