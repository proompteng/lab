import { z } from 'zod'
import { agentRunCommandSchema, parseAgentRunView } from '@/lib/tengri/agent-runs'
import { runConnectionCommand } from '@/lib/tengri/connection-lifecycle'
import {
  noStoreHeaders,
  readPlatformJsonBody,
  requireSameOrigin,
  requirePlatformIdentity,
  platformRouteError,
  PlatformRequestError,
} from '@/lib/platform/http'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requirePlatformIdentity(request)
    const command = agentRunCommandSchema.parse(
      await readPlatformJsonBody(request, { subject: identity.subject, maxBytes: 4096 }),
    )
    const response = await runConnectionCommand(identity, command, request.signal)
    const view = parseAgentRunView(response.result)
    if (!view || view.run.runId !== command.runId || view.targetId !== command.targetId)
      throw new PlatformRequestError('The run response could not be confirmed', 502)
    return Response.json({ view, canCancel: response.canCancel }, { headers: noStoreHeaders() })
  } catch (error) {
    return error instanceof z.ZodError
      ? Response.json({ error: 'Invalid run request' }, { status: 400, headers: noStoreHeaders() })
      : platformRouteError(error)
  }
}
