import { platformSession } from '@/lib/platform/auth'
import { relayCall } from '@/lib/platform/relay'
import { RelayService } from '@/lib/tengri/generated/proompteng/relay/v1/relay_pb'
import { noStoreHeaders, requireSameOriginGet, requirePlatformIdentity, platformRouteError } from '@/lib/platform/http'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requirePlatformIdentity(request)
    const response = await relayCall(
      RelayService.method.listOperations,
      { subject: { clientService: 'tengri-web', identity: { case: 'human', value: platformSession(identity) } } },
      request.signal,
    )
    return Response.json(
      {
        operations: response.operations.map((op) => ({
          connectorId: op.connectorId,
          name: op.name,
          action: op.action,
          description: op.description,
          targets: op.targets.map((target) => ({
            name: target.name,
            resource: target.resource && { kind: target.resource.kind, id: target.resource.id },
          })),
          readOnly: op.readOnly,
          inputSchema: JSON.parse(new TextDecoder().decode(op.inputSchemaJson)),
        })),
      },
      { headers: noStoreHeaders() },
    )
  } catch (error) {
    return platformRouteError(error)
  }
}
