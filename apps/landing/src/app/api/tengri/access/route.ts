import { observeRequest } from '@/lib/observability/server'
import { createHash } from 'node:crypto'
import { create, toJson, type MessageInitShape } from '@bufbuild/protobuf'
import { z } from 'zod'
import {
  accessCommandSchema,
  accessResourceSchema,
  MAX_ACCESS_COMMAND_BYTES,
  workspaceUidSchema,
  type AccessCommand,
} from '@/lib/tengri/access-schemas'
import { humanContext } from '@/lib/tengri/authorization'
import {
  Action,
  TengriAuthorizationService,
  ExecuteCommandRequestSchema,
  ExecuteCommandResponseSchema,
  ListAccessResponseSchema,
  ResourceKind,
  WorkspaceRole,
} from '@/lib/tengri/generated/proompteng/authz/v1/authz_pb'
import { resolveGithubIdentity } from '@/lib/platform/github-identity'
import {
  noStoreHeaders,
  readPlatformJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requirePlatformIdentity,
  platformRouteError,
} from '@/lib/platform/http'
import { OfzError, ofzCall } from '@/lib/platform/ofz'

export const dynamic = 'force-dynamic'
const actions = {
  metadata: Action.WORKSPACE_METADATA_READ,
  files: Action.FILES_OBSERVE,
  terminal: Action.TERMINAL_OBSERVE,
  codex: Action.CODEX_OBSERVE,
  browser: Action.BROWSER_OBSERVE,
  preview: Action.PREVIEW_OBSERVE,
}
function resource(value: z.infer<typeof accessResourceSchema>) {
  return {
    kind: ResourceKind.WORKSPACE,
    id: value.id,
  }
}
function workspace(command: AccessCommand) {
  return 'workspaceUid' in command ? command.workspaceUid : ''
}

export async function GET(request: Request) {
  return observeRequest(request, 'tengri/access.get', () => handleGET(request))
}

async function handleGET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requirePlatformIdentity(request)
    const url = new URL(request.url)
    const uid = url.searchParams.get('workspace')
    const context = humanContext(identity, uid ? workspaceUidSchema.parse(uid) : '')
    const cursor = z
      .string()
      .max(256)
      .parse(url.searchParams.get('cursor') || '')
    if (url.searchParams.get('view') !== 'workspace' || !uid) throw new OfzError(403)
    const response = await ofzCall(
      TengriAuthorizationService.method.listAccess,
      {
        context,
        cursor,
        limit: 100,
        resource: { kind: ResourceKind.WORKSPACE, id: uid },
      },
      request.signal,
    )
    return Response.json(toJson(ListAccessResponseSchema, response), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  return observeRequest(request, 'tengri/access.post', () => handlePOST(request))
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requirePlatformIdentity(request)
    const parsed = accessCommandSchema.parse(
      await readPlatformJsonBody(request, { subject: identity.subject, maxBytes: MAX_ACCESS_COMMAND_BYTES }),
    )
    const input: MessageInitShape<typeof ExecuteCommandRequestSchema> = {
      context: humanContext(identity, workspace(parsed)),
      operationId: parsed.operationId,
      expectedVersion: BigInt(parsed.expectedVersion),
      reason: parsed.reason,
      clientRequestHash: createHash('sha256').update(JSON.stringify(parsed)).digest(),
    }
    const recovered = await ofzCall(
      TengriAuthorizationService.method.getCommand,
      { context: input.context, operationId: parsed.operationId, clientRequestHash: input.clientRequestHash },
      request.signal,
    ).catch((error) => {
      if (error instanceof OfzError && error.status === 404) return undefined
      throw error
    })
    if (recovered) {
      if (!recovered.receipt) throw new OfzError(503)
      return Response.json(
        toJson(ExecuteCommandResponseSchema, create(ExecuteCommandResponseSchema, { receipt: recovered.receipt })),
        { headers: noStoreHeaders() },
      )
    }
    if ('recipient' in parsed) {
      const permission = {
        collaborator: Action.COLLABORATORS_MANAGE,
        transfer: Action.WORKSPACE_TRANSFER,
      }[parsed.action]
      const authorization = await ofzCall(
        TengriAuthorizationService.method.authorizeCommand,
        {
          context: input.context,
          action: permission,
          resource: {
            kind: ResourceKind.WORKSPACE,
            id: workspace(parsed),
          },
        },
        request.signal,
      )
      if (!authorization.allowed) throw new OfzError(403, authorization.auditReceiptId)
    }
    const human =
      'recipient' in parsed
        ? parsed.recipient.kind === 'github-login'
          ? await resolveGithubIdentity(parsed.recipient.login)
          : {
              githubId: parsed.recipient.githubId,
              humanId: createHash('sha256').update(`github:${parsed.recipient.githubId}`).digest('hex'),
            }
        : undefined
    switch (parsed.action) {
      case 'collaborator':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'setWorkspaceRole',
          value: {
            workspaceUid: parsed.workspaceUid,
            humanId: human.humanId,
            role: parsed.role === 'developer' ? WorkspaceRole.DEVELOPER : WorkspaceRole.VIEWER,
            enabled: parsed.enabled,
            ...(parsed.enabled && parsed.role === 'viewer' ? { scope: parsed.scope } : {}),
          },
        }
        break
      case 'transfer':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'transferWorkspace',
          value: { workspaceUid: parsed.workspaceUid, nextOwnerId: human.humanId },
        }
        break
      case 'grant':
        input.command = {
          case: 'createGrant',
          value: {
            workspaceUid: parsed.workspaceUid,
            grantId: parsed.grantId,
            agentId: parsed.agentId,
            resource: resource(parsed.resource),
            actions: parsed.permissions.map((permission) => actions[permission]),
            scope: parsed.scope,
            expiresAtUnixMs: BigInt(Date.parse(parsed.expiresAt)),
            proofKeyThumbprint: parsed.proofKeyThumbprint,
          },
        }
        break
      case 'revoke':
        input.command = { case: 'revokeGrant', value: { grantId: parsed.grantId } }
        break
    }
    input.context = humanContext(identity, workspace(parsed))
    const response = await ofzCall(TengriAuthorizationService.method.executeCommand, input, request.signal)
    return Response.json(toJson(ExecuteCommandResponseSchema, response), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json(
      { error: 'Invalid access request', issues: error.issues.map(({ path, message }) => ({ path, message })) },
      { status: 400, headers: noStoreHeaders() },
    )
  return platformRouteError(error)
}

export function HEAD() {
  return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } })
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
