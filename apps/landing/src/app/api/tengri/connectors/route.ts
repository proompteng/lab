import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { relayCall } from '@/lib/platform/relay'
import { RelayService } from '@/lib/tengri/generated/proompteng/relay/v1/relay_pb'
import { PlatformAuthorizationService } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { connectorAgent, getAgent } from '@/lib/tengri/grpc'
import { humanContext } from '@/lib/tengri/authorization'
import {
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'
import { OfzError, ofzCall } from '@/lib/tengri/ofz'
const install = z.strictObject({
  operationId: z.uuid(),
  agentId: z.string().min(1).max(128),
  connectorId: z.string().min(1).max(128),
  operations: z
    .array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/))
    .min(1)
    .max(16),
  targets: z.array(z.string().min(1).max(128)).min(1).max(16),
  expiresAtUnixMs: z.number().int().positive(),
})
const remove = z.strictObject({ operationId: z.uuid(), agentId: z.string().min(1).max(128), delegationId: z.uuid() })
const agentIdentity = z.object({ agentId: z.uuid(), proofKeyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const acknowledgement = z.object({
  configured: z.literal(true),
  delegationId: z.uuid(),
  proofKeyThumbprint: z.string(),
})
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
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const body = install.parse(await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 32_768 }))
    const agent = await getAgent(identity, body.agentId)
    if (agent.phase !== 'ready' || !agent.runtimeEpoch) throw new OfzError(409)
    const binding = { service: 'tengri', id: agent.uid, generation: agent.runtimeEpoch }
    const guest = agentIdentity.parse(await connectorAgent(identity, body.agentId, 'identity'))
    const catalog = await relayCall(RelayService.method.listOperations, { clientService: 'tengri-web' }, request.signal)
    const operations = catalog.operations.filter(
      (op) => op.connectorId === body.connectorId && body.operations.includes(op.name),
    )
    if (
      operations.some((op) => !op.readOnly) ||
      operations.length !== new Set(body.operations).size ||
      operations.length !== body.operations.length
    )
      throw new OfzError(400)
    const resources = body.targets.map((name) => {
      const target = operations[0]?.targets.find((target) => target.name === name)?.resource
      if (
        !target ||
        operations.some(
          (op) =>
            !op.targets.some(
              (candidate) =>
                candidate.name === name &&
                candidate.resource?.kind === target.kind &&
                candidate.resource.id === target.id,
            ),
        )
      )
        throw new OfzError(400)
      return target
    })
    const context = humanContext(identity)
    const issuer = { humanId: identity.session.humanId, sessionId: identity.session.id, origin: context.origin }
    const delegation = await ofzCall(
      PlatformAuthorizationService.method.createPlatformDelegation,
      {
        operationId: body.operationId,
        issuer,
        clientService: 'tengri-web',
        agentId: guest.agentId,
        actions: operations.map((op) => op.action),
        resources,
        proofKeyThumbprint: guest.proofKeyThumbprint,
        expiresAtUnixMs: BigInt(body.expiresAtUnixMs),
        binding,
      },
      request.signal,
    )
    if (!delegation.credential) {
      await ofzCall(PlatformAuthorizationService.method.revokePlatformDelegation, {
        operationId: randomUUID(),
        issuer,
        delegationId: delegation.delegationId,
      })
      return Response.json(
        {
          error:
            'The installation credential was already delivered. Its delegation is revoked; start a new installation.',
          delegationId: delegation.delegationId,
        },
        { status: 409, headers: noStoreHeaders() },
      )
    }
    try {
      const endpoint = `${context.origin}/api/platform/relay/agent`
      const installed = acknowledgement.parse(
        await connectorAgent(identity, body.agentId, 'configure', {
          delegationId: delegation.delegationId,
          connectorId: body.connectorId,
          clientService: 'tengri-web',
          binding,
          endpoint,
          credential: delegation.credential,
          operations: operations.map((op) => ({
            name: op.name,
            description: op.description,
            inputSchema: JSON.parse(new TextDecoder().decode(op.inputSchemaJson)),
            readOnly: true,
          })),
        }),
      )
      if (
        installed.delegationId !== delegation.delegationId ||
        installed.proofKeyThumbprint !== guest.proofKeyThumbprint
      )
        throw new OfzError(409)
      await ofzCall(
        PlatformAuthorizationService.method.activatePlatformDelegation,
        {
          operationId: randomUUID(),
          issuer,
          delegationId: delegation.delegationId,
          proofKeyThumbprint: installed.proofKeyThumbprint,
        },
        request.signal,
      )
    } catch (error) {
      // Revocation is server-owned cleanup; cancellation must not strand installed authority.
      await ofzCall(PlatformAuthorizationService.method.revokePlatformDelegation, {
        operationId: randomUUID(),
        issuer,
        delegationId: delegation.delegationId,
      })
      throw error
    }
    return Response.json(
      { delegationId: delegation.delegationId, binding, expiresAtUnixMs: body.expiresAtUnixMs },
      { headers: noStoreHeaders() },
    )
  } catch (error) {
    return failure(error)
  }
}
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const body = remove.parse(await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 2048 }))
    const context = humanContext(identity)
    await ofzCall(
      PlatformAuthorizationService.method.revokePlatformDelegation,
      {
        operationId: body.operationId,
        delegationId: body.delegationId,
        issuer: { humanId: identity.session.humanId, sessionId: identity.session.id, origin: context.origin },
      },
      request.signal,
    )
    await connectorAgent(identity, body.agentId, 'remove', { delegationId: body.delegationId })
    return Response.json({ revoked: true }, { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}
function failure(error: unknown) {
  return error instanceof z.ZodError
    ? Response.json({ error: 'Invalid connector request' }, { status: 400, headers: noStoreHeaders() })
    : tengriRouteError(error)
}
