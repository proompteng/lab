import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PlatformIdentity } from '../platform/auth'
import { humanContext } from './authorization'
import {
  connectionReference,
  credentialMatchesRuntime,
  installationMatches,
  relayAcknowledgementSchema,
  relayIdentitySchema,
  relayRemovalSchema,
  savedConnectionOperations,
  selectConnectionScope,
  type SaveConnection,
  type RelayIdentity,
} from './connections'
import { PlatformAuthorizationService, type PlatformConnection } from './generated/proompteng/authz/v1/platform_pb'
import { RelayService, type ConnectorOperation } from './generated/proompteng/relay/v1/relay_pb'
import { connectorAgent, getAgent, TengriUnavailableError } from './grpc'
import { ofzCall, OfzError } from '../platform/ofz'
import { relayCall } from '../platform/relay'

async function authority(identity: PlatformIdentity, agentId: string, signal?: AbortSignal) {
  const agent = await getAgent(identity, agentId)
  const context = humanContext(identity)
  return {
    identity,
    agent,
    signal,
    issuer: { humanId: identity.session.humanId, sessionId: identity.session.id, origin: context.origin },
    binding: { service: 'tengri', id: agent.uid, generation: agent.runtimeEpoch ?? '' },
    endpoint: context.origin + '/api/platform/relay/agent',
  }
}
type Authority = Awaited<ReturnType<typeof authority>>

function list(context: Authority) {
  return ofzCall(
    PlatformAuthorizationService.method.listPlatformConnections,
    { issuer: context.issuer, clientService: 'tengri-web', binding: context.binding },
    context.signal,
  )
}

export async function listConnections(identity: PlatformIdentity, agentId: string, signal?: AbortSignal) {
  return list(await authority(identity, agentId, signal))
}

export async function saveConnection(identity: PlatformIdentity, request: SaveConnection, signal?: AbortSignal) {
  const context = await authority(identity, request.agentId, signal)
  requireReady(context)
  const catalog = await relayCall(
    RelayService.method.listOperations,
    { subject: { clientService: 'tengri-web', identity: { case: 'human', value: context.issuer } } },
    signal,
  )
  let scope: ReturnType<typeof selectConnectionScope>
  try {
    scope = selectConnectionScope(catalog.operations, request)
  } catch (error) {
    throw new TengriUnavailableError(
      error instanceof Error ? error.message : 'The available access changed. Review your selection.',
      409,
      'connection_scope_changed',
    )
  }
  try {
    await ofzCall(
      PlatformAuthorizationService.method.putPlatformConnection,
      {
        operationId: request.operationId,
        issuer: context.issuer,
        clientService: 'tengri-web',
        connectionId: request.connectionId,
        expectedVersion: BigInt(request.expectedVersion),
        clientReference: connectionReference(context.agent.uid, request.connectorId),
        actions: scope.actions,
        resources: scope.resources,
        binding: context.binding,
      },
      signal,
    )
  } catch (error) {
    if (error instanceof OfzError && error.status === 403)
      throw new TengriUnavailableError(
        'An administrator needs to allow the selected resources before you can connect.',
        403,
        'connection_access_denied',
      )
    if (error instanceof OfzError && error.status === 409)
      throw new TengriUnavailableError(
        'This connection changed. Review its current access and connect again.',
        409,
        'connection_scope_changed',
      )
    throw error
  }
  return reconcile(context)
}

export async function reconcileConnections(identity: PlatformIdentity, agentId: string, signal?: AbortSignal) {
  return reconcile(await authority(identity, agentId, signal))
}

function requireReady(context: Authority) {
  if (context.agent.phase !== 'ready' || !context.binding.generation)
    throw new TengriUnavailableError('Resume the workspace before connecting it.', 409)
}

async function reconcile(context: Authority) {
  const snapshot = await list(context)
  if (snapshot.connections.length === 0 || context.agent.phase !== 'ready') return snapshot
  requireReady(context)
  const guestReply = relayIdentitySchema.safeParse(await connectorAgent(context.identity, context.agent.id, 'identity'))
  if (!guestReply.success)
    throw new TengriUnavailableError('The workspace returned an invalid connector identity.', 502)
  const guest = guestReply.data
  const renew = snapshot.connections.filter(
    (connection) =>
      connection.enabled &&
      (!credentialMatchesRuntime(connection, context.binding.generation, snapshot.recoveryGeneration, Date.now()) ||
        !installationMatches(connection, guest)),
  )
  const catalog = renew.length
    ? await relayCall(
        RelayService.method.listOperations,
        { subject: { clientService: 'tengri-web', identity: { case: 'human', value: context.issuer } } },
        context.signal,
      )
    : undefined
  const failures: { service: string; error: unknown }[] = []
  for (const connection of snapshot.connections) {
    context.signal?.throwIfAborted()
    try {
      if (!connection.enabled) await removeGuest(context, connection, snapshot.recoveryGeneration)
      else if (renew.includes(connection)) {
        if (!catalog) throw new OfzError(503)
        await renewConnection(context, connection, guest, catalog.operations)
      }
    } catch (error) {
      context.signal?.throwIfAborted()
      const prefix = context.agent.uid + '/'
      failures.push({
        service: connection.clientReference.startsWith(prefix)
          ? connection.clientReference.slice(prefix.length)
          : 'Service',
        error,
      })
    }
  }
  const [first] = failures
  if (first) {
    const message = failures
      .map(
        ({ service, error }) =>
          `${service}: ${
            error instanceof OfzError && error.status === 403
              ? 'Access to the selected resources is no longer allowed.'
              : error instanceof OfzError || error instanceof TengriUnavailableError
                ? error.message
                : 'Connection renewal could not be confirmed.'
          }`,
      )
      .join(' ')
    if (first.error instanceof OfzError || first.error instanceof TengriUnavailableError) {
      first.error.message = message
      throw first.error
    }
    const error = new TengriUnavailableError(message, 502)
    error.cause = first.error
    throw error
  }
  return list(context)
}

async function renewConnection(
  context: Authority,
  connection: PlatformConnection,
  guest: RelayIdentity,
  operations: ConnectorOperation[],
) {
  let selection: ReturnType<typeof savedConnectionOperations>
  try {
    selection = savedConnectionOperations(operations, connection, context.agent.uid)
  } catch (error) {
    throw new TengriUnavailableError(error instanceof Error ? error.message : 'Saved connection unavailable', 409)
  }
  const expiresAtUnixMs = [
    context.identity.session.expiresAtUnixMs,
    context.identity.session.idleDeadlineUnixMs,
    BigInt(Date.now() + 900_000),
  ].reduce((earlier, limit) => (earlier < limit ? earlier : limit))
  const issued = await ofzCall(
    PlatformAuthorizationService.method.createPlatformDelegation,
    {
      operationId: randomUUID(),
      issuer: context.issuer,
      clientService: 'tengri-web',
      agentId: guest.agentId,
      connectionId: connection.id,
      expectedConnectionVersion: connection.version,
      actions: connection.actions,
      resources: connection.resources,
      proofKeyThumbprint: guest.proofKeyThumbprint,
      expiresAtUnixMs,
      binding: context.binding,
    },
    context.signal,
  )
  try {
    if (!issued.credential || !issued.decision || !issued.credentialGeneration) throw new OfzError(409)
    const recoveryGeneration = String(issued.decision.recoveryGeneration)
    const credentialGeneration = String(issued.credentialGeneration)
    const acknowledgement = relayAcknowledgementSchema.safeParse(
      await connectorAgent(context.identity, context.agent.id, 'configure', {
        connectionId: connection.id,
        recoveryGeneration,
        credentialGeneration,
        delegationId: issued.delegationId,
        connectorId: selection.connectorId,
        clientService: 'tengri-web',
        binding: context.binding,
        endpoint: context.endpoint,
        credential: issued.credential,
        operations: selection.operations.map((operation) => ({
          name: operation.name,
          description: operation.description,
          inputSchema: JSON.parse(new TextDecoder().decode(operation.inputSchemaJson)),
          readOnly: true,
        })),
      }),
    )
    if (!acknowledgement.success) throw new TengriUnavailableError('The workspace did not confirm the connection.', 502)
    const acknowledged = acknowledgement.data
    if (
      acknowledged.connectionId !== connection.id ||
      acknowledged.delegationId !== issued.delegationId ||
      acknowledged.proofKeyThumbprint !== guest.proofKeyThumbprint ||
      acknowledged.recoveryGeneration !== recoveryGeneration ||
      acknowledged.credentialGeneration !== credentialGeneration
    )
      throw new OfzError(409)
    await activate(context, issued.delegationId, guest.proofKeyThumbprint)
  } catch (error) {
    // Cleanup uses this issuance's generation so it cannot fence out a later successful install.
    await ofzCall(PlatformAuthorizationService.method.revokePlatformDelegation, {
      operationId: randomUUID(),
      issuer: context.issuer,
      delegationId: issued.delegationId,
    })
    if (issued.decision && issued.credentialGeneration)
      await connectorAgent(context.identity, context.agent.id, 'remove', {
        connectionId: connection.id,
        delegationId: issued.delegationId,
        recoveryGeneration: String(issued.decision.recoveryGeneration),
        credentialGeneration: String(issued.credentialGeneration),
      })
    throw error
  }
}

function activate(context: Authority, delegationId: string, proofKeyThumbprint: string) {
  return ofzCall(
    PlatformAuthorizationService.method.activatePlatformDelegation,
    { operationId: randomUUID(), issuer: context.issuer, delegationId, proofKeyThumbprint },
    context.signal,
  )
}

function removeGuest(context: Authority, connection: PlatformConnection, recoveryGeneration: bigint) {
  return connectorAgent(context.identity, context.agent.id, 'remove', {
    connectionId: connection.id,
    recoveryGeneration: String(recoveryGeneration),
    credentialGeneration: String(connection.credentialGeneration),
  })
}

export async function disconnectConnection(
  identity: PlatformIdentity,
  request: { operationId: string; agentId: string; connectionId: string },
  signal?: AbortSignal,
) {
  const context = await authority(identity, request.agentId, signal)
  const snapshot = await list(context)
  if (!snapshot.connections.some((connection) => connection.id === request.connectionId)) throw new OfzError(404)
  const revoked = await ofzCall(
    PlatformAuthorizationService.method.revokePlatformConnection,
    {
      operationId: request.operationId,
      issuer: context.issuer,
      clientService: 'tengri-web',
      connectionId: request.connectionId,
    },
    signal,
  )
  if (!revoked.decision?.allowed || !revoked.credentialGeneration) throw new OfzError(503)
  const after = await list(context)
  const current = after.connections.find((connection) => connection.id === request.connectionId)
  if (!current || current.enabled) throw new OfzError(409)
  if (context.agent.phase === 'ready') {
    try {
      const cleanup = relayRemovalSchema.parse(
        await connectorAgent(identity, request.agentId, 'remove', {
          connectionId: request.connectionId,
          recoveryGeneration: String(after.recoveryGeneration),
          credentialGeneration: String(current.credentialGeneration),
        }),
      )
      return { revoked: true, cleanupPending: !cleanup.removed }
    } catch {
      return { revoked: true, cleanupPending: true }
    }
  }
  return { revoked: true, cleanupPending: true }
}
