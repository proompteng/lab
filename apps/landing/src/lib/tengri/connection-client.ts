import { fromJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { reportBrowserFailure } from '@/lib/observability/client'
import { ListPlatformConnectionsResponseSchema } from './generated/proompteng/authz/v1/platform_pb'

export async function renewWorkspaceConnections(agentId: string, signal: AbortSignal) {
  try {
    const response = await fetch('/api/tengri/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reconcile', agentId }),
      signal,
    })
    if (signal.aborted) return
    if (!response.ok) {
      if (response.status >= 500) reportBrowserFailure('tengri.connection-renewal', response.status)
      return
    }
    fromJson(ListPlatformConnectionsResponseSchema, z.json().parse(await response.json()))
  } catch {
    if (!signal.aborted) reportBrowserFailure('tengri.connection-renewal')
  }
}
