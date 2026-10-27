import { z } from 'zod'
import type { PlatformConnection } from './generated/proompteng/authz/v1/platform_pb'
import type { ConnectorOperation } from './generated/proompteng/relay/v1/relay_pb'

const generation = z.string().regex(/^[1-9][0-9]{0,18}$/)
const resource = z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(256) })
const command = { operationId: z.uuid(), agentId: z.string().min(1).max(128) }
export const connectionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...command,
    kind: z.literal('save'),
    connectionId: z.uuid(),
    expectedVersion: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    connectorId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    operations: z.array(z.string().min(1).max(128)).min(1).max(16),
    targets: z.array(resource).min(1).max(16),
  }),
  z.strictObject({ agentId: command.agentId, kind: z.literal('reconcile') }),
])
export const disconnectRequestSchema = z.strictObject({ ...command, connectionId: z.uuid() })
export type SaveConnection = Extract<z.infer<typeof connectionRequestSchema>, { kind: 'save' }>

const pendingConnectionSchema = z.strictObject({
  request: connectionRequestSchema,
  resumeAfterSignIn: z.boolean(),
  updatedAtMs: z.number().int().nonnegative(),
})

export function pendingConnectionKey(principal: string, workspaceUid: string) {
  return 'tengri-connection:' + JSON.stringify([principal, workspaceUid])
}

export function readPendingConnection(storage: Storage, key: string) {
  const encoded = storage.getItem(key)
  if (!encoded) return undefined
  const pending = pendingConnectionSchema.parse(JSON.parse(encoded))
  if (pending.request.kind !== 'save') throw new Error('The pending connection is invalid')
  return {
    request: pending.request,
    resumeAfterSignIn:
      pending.resumeAfterSignIn && Date.now() >= pending.updatedAtMs && Date.now() - pending.updatedAtMs <= 300_000,
  }
}

export function retainPendingConnection(
  storage: Storage,
  key: string,
  request: SaveConnection,
  resumeAfterSignIn: boolean,
) {
  const previous = readPendingConnection(storage, key)
  if (previous && previous.request.operationId !== request.operationId)
    throw new Error('Finish the pending connection before starting another change.')
  storage.setItem(key, JSON.stringify({ request, resumeAfterSignIn, updatedAtMs: Date.now() }))
}

export function completePendingConnection(storage: Storage, key: string, operationId: string) {
  if (readPendingConnection(storage, key)?.request.operationId === operationId) storage.removeItem(key)
}

const installation = z.strictObject({
  connectionId: z.uuid(),
  delegationId: z.uuid().optional(),
  recoveryGeneration: generation,
  credentialGeneration: generation,
  configured: z.boolean(),
})
export const relayIdentitySchema = z.strictObject({
  agentId: z.uuid(),
  proofKeyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  connections: z.array(installation).max(128),
})
export const relayAcknowledgementSchema = z.strictObject({
  configured: z.literal(true),
  connectionId: z.uuid(),
  delegationId: z.uuid(),
  recoveryGeneration: generation,
  credentialGeneration: generation,
  proofKeyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
export type RelayIdentity = z.infer<typeof relayIdentitySchema>
export const relayRemovalSchema = z.object({ configured: z.literal(false), removed: z.boolean() })

export function connectionReference(workspaceUid: string, connectorId: string) {
  return workspaceUid + '/' + connectorId
}

export function connectionConnector(connection: PlatformConnection, workspaceUid: string) {
  const prefix = workspaceUid + '/'
  if (!connection.clientReference.startsWith(prefix)) throw new Error('Connection belongs to another workspace')
  return connection.clientReference.slice(prefix.length)
}

export function selectConnectionScope(operations: ConnectorOperation[], request: SaveConnection) {
  const selected = operations.filter(
    (operation) => operation.connectorId === request.connectorId && request.operations.includes(operation.name),
  )
  if (
    selected.length === 0 ||
    selected.length !== request.operations.length ||
    new Set(request.operations).size !== request.operations.length ||
    selected.some((operation) => !operation.readOnly)
  )
    throw new Error('Select registered read-only operations')
  const resources = request.targets.map((target) => {
    const registered = selected[0]?.targets.find(
      (candidate) => candidate.resource?.kind === target.kind && candidate.resource.id === target.id,
    )?.resource
    if (
      !registered ||
      selected.some(
        (operation) =>
          !operation.targets.some(
            (candidate) =>
              candidate.resource?.kind === registered.kind &&
              candidate.resource.id === registered.id &&
              candidate.resource.target === registered.target,
          ),
      )
    )
      throw new Error('A selected target changed or is unavailable for these operations')
    return registered
  })
  if (new Set(resources.map((target) => JSON.stringify([target.kind, target.id]))).size !== resources.length)
    throw new Error('Select each target once')
  return { actions: [...new Set(selected.map((operation) => operation.action))], resources, operations: selected }
}

export function savedConnectionOperations(
  operations: ConnectorOperation[],
  connection: PlatformConnection,
  workspaceUid: string,
) {
  const connectorId = connectionConnector(connection, workspaceUid)
  const selected = operations.filter(
    (operation) => operation.connectorId === connectorId && connection.actions.includes(operation.action),
  )
  if (
    selected.length === 0 ||
    connection.actions.some((action) => !selected.some((operation) => operation.action === action)) ||
    selected.some(
      (operation) =>
        !operation.readOnly ||
        connection.resources.some(
          (resource) =>
            !operation.targets.some(
              (target) =>
                target.resource?.kind === resource.kind &&
                target.resource.id === resource.id &&
                target.resource.target === resource.target,
            ),
        ),
    )
  )
    throw new Error('The saved scope is unavailable. Review this connection before changing it.')
  return { connectorId, operations: selected }
}

export function credentialMatchesRuntime(
  connection: PlatformConnection,
  runtimeEpoch: string,
  recoveryGeneration: bigint,
  now: number,
) {
  return (
    connection.enabled &&
    connection.recoveryGeneration === recoveryGeneration &&
    connection.credentialBinding?.generation === runtimeEpoch &&
    connection.credentialBinding.service === connection.binding?.service &&
    connection.credentialBinding.id === connection.binding?.id &&
    connection.expiresAtUnixMs > BigInt(now + 90_000)
  )
}

export function installationMatches(connection: PlatformConnection, guest: RelayIdentity) {
  return (
    connection.proofKeyThumbprint === guest.proofKeyThumbprint &&
    guest.connections.some(
      (installed) =>
        installed.configured &&
        installed.connectionId === connection.id &&
        installed.delegationId === connection.delegationId &&
        installed.recoveryGeneration === String(connection.recoveryGeneration) &&
        installed.credentialGeneration === String(connection.credentialGeneration),
    )
  )
}
