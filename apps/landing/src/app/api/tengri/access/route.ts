import { toJson, type MessageInitShape } from '@bufbuild/protobuf'
import { z } from 'zod'
import {
  accessCommandSchema,
  accessResourceSchema,
  workspaceUidSchema,
  type AccessCommand,
} from '@/lib/tengri/access-schemas'
import { humanContext } from '@/lib/tengri/authorization'
import {
  Action,
  AuthorizationService,
  ExecuteCommandRequestSchema,
  ExecuteCommandResponseSchema,
  ListAccessResponseSchema,
  PlatformRole,
  ReadAuditResponseSchema,
  ResourceKind,
  WorkspaceRole,
} from '@/lib/tengri/generated/proompteng/authz/v1/authz_pb'
import { resolveGithubIdentity } from '@/lib/tengri/github-identity'
import {
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'
import { OfzError, ofzCall } from '@/lib/tengri/ofz'

export const dynamic = 'force-dynamic'
const actions = {
  metadata: Action.WORKSPACE_METADATA_READ,
  files: Action.FILES_OBSERVE,
  terminal: Action.TERMINAL_OBSERVE,
  codex: Action.CODEX_OBSERVE,
  browser: Action.BROWSER_OBSERVE,
  preview: Action.PREVIEW_OBSERVE,
  'kube-status': Action.KUBE_STATUS_READ,
  'kube-logs': Action.KUBE_LOGS_READ,
  'kube-events': Action.KUBE_EVENTS_READ,
  connector: Action.CONNECTOR_READ,
}
const roles = {
  member: PlatformRole.MEMBER,
  administrator: PlatformRole.ADMINISTRATOR,
  auditor: PlatformRole.AUDITOR,
  operator: PlatformRole.OPERATOR,
}
function resource(value: z.infer<typeof accessResourceSchema>) {
  return {
    kind:
      value.kind === 'workspace'
        ? ResourceKind.WORKSPACE
        : value.kind === 'namespace'
          ? ResourceKind.KUBE_NAMESPACE
          : ResourceKind.CONNECTOR_CONNECTION,
    id: value.id,
  }
}
function workspace(command: AccessCommand) {
  return 'workspaceUid' in command ? command.workspaceUid : ''
}

export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requireTengriIdentity(request)
    const url = new URL(request.url)
    const uid = url.searchParams.get('workspace')
    const context = humanContext(identity, uid ? workspaceUidSchema.parse(uid) : '')
    const cursor = z
      .string()
      .max(256)
      .parse(url.searchParams.get('cursor') || '')
    const view = url.searchParams.get('view') || 'platform'
    if (view === 'audit' && !uid) {
      const response = await ofzCall(
        AuthorizationService.method.readAudit,
        { context, cursor, limit: 100 },
        request.signal,
      )
      return Response.json(toJson(ReadAuditResponseSchema, response), { headers: noStoreHeaders() })
    }
    if (view !== 'platform' && view !== 'workspace') throw new OfzError(400)
    if ((view === 'workspace') !== Boolean(uid)) throw new OfzError(400)
    const response = await ofzCall(
      AuthorizationService.method.listAccess,
      {
        context,
        cursor,
        limit: 100,
        resource: { kind: uid ? ResourceKind.WORKSPACE : ResourceKind.PLATFORM, id: uid || 'lab' },
      },
      request.signal,
    )
    return Response.json(toJson(ListAccessResponseSchema, response), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const parsed = accessCommandSchema.parse(
      await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 65536 }),
    )
    const input: MessageInitShape<typeof ExecuteCommandRequestSchema> = {
      context: humanContext(identity, workspace(parsed)),
      operationId: parsed.operationId,
      expectedVersion: BigInt(parsed.expectedVersion),
      reason: parsed.reason,
    }
    if ('login' in parsed) {
      const permission = {
        membership: Action.MEMBERS_MANAGE,
        collaborator: Action.COLLABORATORS_MANAGE,
        transfer: Action.WORKSPACE_TRANSFER,
        quota: Action.QUOTAS_MANAGE,
        target: Action.TARGETS_MANAGE,
        emergency: Action.MEMBERS_MANAGE,
      }[parsed.action]
      const workspacePermission = parsed.action === 'collaborator' || parsed.action === 'transfer'
      const authorization = await ofzCall(
        AuthorizationService.method.authorizeCommand,
        {
          context: input.context,
          action: permission,
          resource: {
            kind: workspacePermission ? ResourceKind.WORKSPACE : ResourceKind.PLATFORM,
            id: workspacePermission ? workspace(parsed) : 'lab',
          },
        },
        request.signal,
      )
      if (!authorization.allowed) throw new OfzError(403, authorization.auditReceiptId)
    }
    const human = 'login' in parsed ? await resolveGithubIdentity(parsed.login) : undefined
    switch (parsed.action) {
      case 'membership':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'setMembership',
          value: { ...human, role: roles[parsed.role], enabled: parsed.enabled },
        }
        break
      case 'collaborator':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'setWorkspaceRole',
          value: {
            workspaceUid: parsed.workspaceUid,
            humanId: human.humanId,
            role: parsed.role === 'developer' ? WorkspaceRole.DEVELOPER : WorkspaceRole.VIEWER,
            enabled: parsed.enabled,
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
      case 'quota':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'setQuota',
          value: {
            humanId: human.humanId,
            totalWorkspaces: parsed.total,
            activeWorkspaces: parsed.active,
            retainedBytes: BigInt(parsed.retainedGiB) * BigInt(1_073_741_824),
          },
        }
        break
      case 'target':
        if (!human || parsed.resource.kind === 'workspace') throw new OfzError(400)
        input.command = {
          case: 'setTargetAccess',
          value: {
            humanId: human.humanId,
            resource: resource(parsed.resource),
            action: actions[parsed.permission],
            enabled: parsed.enabled,
          },
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
      case 'emergency':
        if (!human) throw new OfzError(400)
        input.command = {
          case: 'emergencyAccess',
          value: {
            workspaceUid: parsed.workspaceUid,
            humanId: human.humanId,
            incidentId: parsed.incidentId,
            custodianApprovalId: parsed.approvalId,
            expiresAtUnixMs: BigInt(Date.parse(parsed.expiresAt)),
          },
        }
        break
    }
    input.context = humanContext(identity, workspace(parsed))
    const response = await ofzCall(AuthorizationService.method.executeCommand, input, request.signal)
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
  return tengriRouteError(error)
}

export function HEAD() {
  return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } })
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
