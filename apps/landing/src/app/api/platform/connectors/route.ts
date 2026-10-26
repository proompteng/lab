import { relayCall } from '@/lib/platform/relay'
import { RelayService } from '@/lib/generated/proompteng/relay/v1/relay_pb'
import { noStoreHeaders, requireSameOriginGet, requireTengriIdentity, tengriRouteError } from '@/lib/tengri/http'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    await requireTengriIdentity(request)
    const response = await relayCall(
      RelayService.method.listOperations,
      { clientService: 'tengri-web' },
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
    return tengriRouteError(error)
  }
}
