import { clone, create } from '@bufbuild/protobuf'
import { beforeEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { connectionRequestSchema, type RelayIdentity } from './connections'
import {
  SessionSchema,
  PlatformConnectionSchema,
  PlatformDecisionSchema,
  ListPlatformConnectionsResponseSchema,
  ProviderConnectionState,
  ProviderConnectionSchema,
  type ProviderConnection,
  type PlatformConnection,
} from './generated/proompteng/authz/v1/platform_pb'
import { ConnectorOperationSchema } from './generated/proompteng/relay/v1/relay_pb'
import type { PlatformIdentity } from '../platform/auth'

void mock.module('server-only', () => ({}))
const { OfzError } = await import('../platform/ofz')
const { TengriUnavailableError } = await import('./grpc')
const workspace = '11111111-1111-4111-8111-111111111111'
const connectionId = '22222222-2222-4222-8222-222222222222'
const firstRuntime = '33333333-3333-4333-8333-333333333333'
const identity: PlatformIdentity = {
  subject: '7',
  user: { id: '7', name: 'Fixture', email: 'fixture@example.test', image: null },
  session: create(SessionSchema, {
    id: workspace,
    humanId: 'github:7',
    expiresAtUnixMs: BigInt(Date.now() + 3_600_000),
  }),
}
const operation = create(ConnectorOperationSchema, {
  connectorId: 'galactic',
  name: 'status',
  action: 'kubernetes.status.read',
  readOnly: true,
  inputSchemaJson: new TextEncoder().encode('{"type":"object"}'),
  targets: [{ name: 'diagnostics', resource: { kind: 'kubernetes.namespace', id: 'galactic/immutable-uid' } }],
})
let connection: PlatformConnection | undefined
let precedingConnections: PlatformConnection[] = []
let providers: ProviderConnection[] = []
let catalog = [operation]
let generation = BigInt(10)
let recoveryGeneration = BigInt(3)
let runtime = firstRuntime
let ready = true
let permitted = true
let consentFailure: number | undefined
let wrongAcknowledgement = false
let removalUnavailable = false
let duringConfigure: (() => Promise<unknown>) | undefined
let installed: RelayIdentity['connections'] = []
const events: { name: string; body: Record<string, unknown> }[] = []
const completed = new Set<string>()
const revocations = new Map<string, bigint>()
const revokedDelegations = new Set<string>()
const decision = () =>
  create(PlatformDecisionSchema, { allowed: true, auditReceiptId: randomUUID(), recoveryGeneration: BigInt(3) })

void mock.module('../platform/ofz', () => ({
  OfzError,
  ofzCall: async (method: { name: string }, input: unknown) => {
    if (method.name === 'ListProviderConnections') return { connections: providers }
    const body = z.record(z.string(), z.unknown()).parse(input)
    events.push({ name: method.name, body })
    expect(body.issuer).toEqual({ humanId: 'github:7', sessionId: workspace, origin: 'https://proompteng.ai' })
    if (method.name === 'ListPlatformConnections')
      return create(ListPlatformConnectionsResponseSchema, {
        connections: [...precedingConnections, ...(connection ? [clone(PlatformConnectionSchema, connection)] : [])],
        recoveryGeneration,
      })
    if (method.name === 'PutPlatformConnection') {
      if (consentFailure) throw new OfzError(consentFailure)
      const operationId = z.uuid().parse(body.operationId)
      if (!completed.has(operationId)) {
        expect(body).toMatchObject({
          connectionId,
          clientService: 'tengri-web',
          actions: ['kubernetes.status.read'],
          resources: operation.targets.flatMap((target) => (target.resource ? [target.resource] : [])),
          expectedVersion: BigInt(0),
          clientReference: workspace + '/galactic',
        })
        connection = create(PlatformConnectionSchema, {
          id: connectionId,
          clientService: 'tengri-web',
          clientReference: workspace + '/galactic',
          actions: ['kubernetes.status.read'],
          resources: operation.targets.flatMap((target) => (target.resource ? [target.resource] : [])),
          binding: { service: 'tengri', id: workspace },
          version: BigInt(1),
          enabled: true,
          recoveryGeneration,
          credentialGeneration: ++generation,
        })
        completed.add(operationId)
      }
      return { connectionId, version: connection?.version, credentialGeneration: generation, decision: decision() }
    }
    if (!connection) throw new OfzError(404)
    if (method.name === 'CreatePlatformDelegation') {
      if (precedingConnections.some((entry) => entry.id === body.connectionId)) throw new OfzError(403)
      if (!permitted || !connection.enabled || body.expectedConnectionVersion !== connection.version)
        throw new OfzError(403)
      expect(body).toMatchObject({
        connectionId,
        clientService: 'tengri-web',
        actions: connection.actions,
        resources: connection.resources,
        binding: { service: 'tengri', id: workspace, generation: runtime },
        proofKeyThumbprint: 'a'.repeat(43),
      })
      if (connection.delegationId) revokedDelegations.add(connection.delegationId)
      connection.delegationId = randomUUID()
      connection.credentialGeneration = ++generation
      connection.credentialBinding = create(PlatformConnectionSchema, {
        credentialBinding: { service: 'tengri', id: workspace, generation: runtime },
      }).credentialBinding
      connection.proofKeyThumbprint = 'a'.repeat(43)
      connection.expiresAtUnixMs = z.bigint().parse(body.expiresAtUnixMs)
      connection.credentialActive = false
      return {
        delegationId: connection.delegationId,
        credential: 'b'.repeat(43),
        credentialGeneration: generation,
        decision: decision(),
      }
    }
    if (method.name === 'ActivatePlatformDelegation') {
      if (
        !connection.enabled ||
        body.delegationId !== connection.delegationId ||
        revokedDelegations.has(String(body.delegationId))
      )
        throw new OfzError(403)
      expect(installed.some((entry) => entry.configured && entry.delegationId === body.delegationId)).toBe(true)
      connection.credentialActive = true
      generation += BigInt(1)
      return { decision: decision() }
    }
    if (method.name === 'RevokePlatformConnection') {
      const operationId = z.uuid().parse(body.operationId)
      const original = revocations.get(operationId)
      if (original !== undefined) return { connectionId, credentialGeneration: original, decision: decision() }
      connection.enabled = false
      connection.credentialActive = false
      connection.delegationId = ''
      connection.version += BigInt(1)
      connection.credentialGeneration = ++generation
      revocations.set(operationId, generation)
      return { connectionId, credentialGeneration: generation, decision: decision() }
    }
    if (method.name === 'RevokePlatformDelegation') {
      revokedDelegations.add(z.uuid().parse(body.delegationId))
      if (body.delegationId === connection.delegationId) connection.credentialActive = false
      generation += BigInt(1)
      return { decision: decision() }
    }
    throw new Error('Unexpected Ofz fixture call ' + method.name)
  },
}))
void mock.module('../platform/relay', () => ({
  relayCall: async (_method: unknown, input: unknown) => {
    expect(input).toEqual({
      subject: {
        clientService: 'tengri-web',
        identity: {
          case: 'human',
          value: { humanId: 'github:7', sessionId: workspace, origin: 'https://proompteng.ai' },
        },
      },
    })
    events.push({ name: 'catalog', body: {} })
    return { operations: catalog }
  },
}))
void mock.module('./grpc', () => ({
  TengriUnavailableError,
  getAgent: async () => ({
    id: 'microvm-fixture',
    uid: workspace,
    runtimeEpoch: runtime,
    phase: ready ? 'ready' : 'sleeping',
  }),
  connectorAgent: async (_identity: unknown, _agent: string, action: string, input: unknown = {}) => {
    const body = z.record(z.string(), z.unknown()).parse(input)
    events.push({ name: action, body })
    if (action === 'identity')
      return { agentId: workspace, proofKeyThumbprint: 'a'.repeat(43), connections: structuredClone(installed) }
    if (action === 'configure') {
      const entry = z
        .object({
          connectionId: z.uuid(),
          delegationId: z.uuid(),
          recoveryGeneration: z.string(),
          credentialGeneration: z.string(),
        })
        .parse(body)
      installed = [{ ...entry, configured: true }]
      await duringConfigure?.()
      return { ...entry, configured: true, proofKeyThumbprint: (wrongAcknowledgement ? 'x' : 'a').repeat(43) }
    }
    if (action === 'remove') {
      if (removalUnavailable) throw new Error('Fixture guest disconnected')
      installed = installed.filter(
        (entry) =>
          entry.connectionId !== body.connectionId || (body.delegationId && entry.delegationId !== body.delegationId),
      )
      return { configured: false, removed: true }
    }
    throw new Error('Unexpected guest fixture action')
  },
}))
const { saveConnection, reconcileConnections, disconnectConnection } = await import('./connection-lifecycle')
const save = () =>
  connectionRequestSchema.options[0].parse({
    kind: 'save',
    operationId: randomUUID(),
    agentId: 'microvm-fixture',
    connectionId,
    expectedVersion: '0',
    connectorId: 'galactic',
    operations: ['status'],
    targets: [{ kind: 'kubernetes.namespace', id: 'galactic/immutable-uid' }],
  })
const disconnect = () =>
  disconnectConnection(identity, { operationId: randomUUID(), agentId: 'microvm-fixture', connectionId })

beforeEach(() => {
  identity.session.idleDeadlineUnixMs = BigInt(Date.now() + 3_600_000)
  connection = undefined
  precedingConnections = []
  providers = []
  catalog = [operation]
  generation = BigInt(10)
  recoveryGeneration = BigInt(3)
  runtime = firstRuntime
  ready = true
  permitted = true
  consentFailure = undefined
  wrongAcknowledgement = false
  removalUnavailable = false
  duringConfigure = undefined
  installed = []
  events.length = 0
  completed.clear()
  revocations.clear()
  revokedDelegations.clear()
  process.env.PLATFORM_WEB_ORIGIN = 'https://proompteng.ai'
})

test('BFF keeps idle workspaces untouched and activates only after exact guest acknowledgement', async () => {
  await reconcileConnections(identity, 'microvm-fixture')
  expect(events.map((event) => event.name)).toEqual(['ListPlatformConnections'])
  events.length = 0
  const result = await saveConnection(identity, save())
  expect(result.connections[0]?.credentialActive).toBe(true)
  expect(events.map((event) => event.name)).toEqual([
    'catalog',
    'PutPlatformConnection',
    'ListPlatformConnections',
    'identity',
    'catalog',
    'CreatePlatformDelegation',
    'configure',
    'ActivatePlatformDelegation',
    'ListPlatformConnections',
  ])
  expect(
    JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
  ).not.toContain('b'.repeat(43))
})

test('an unconnected provider prevents consent and credential installation, then resumes the same intent', async () => {
  providers = [
    create(ProviderConnectionSchema, {
      profileId: 'inventory',
      connectorId: 'galactic',
      state: ProviderConnectionState.RECONNECT,
    }),
  ]
  const request = save()
  await expect(saveConnection(identity, request)).rejects.toMatchObject({ code: 'provider_reconnect_required' })
  expect(events.some((event) => event.name === 'PutPlatformConnection')).toBe(false)
  expect(installed).toHaveLength(0)
  providers[0]!.state = ProviderConnectionState.READY
  const result = await saveConnection(identity, request)
  expect(result.connections[0]?.id).toBe(request.connectionId)
  expect(result.connections[0]?.credentialActive).toBe(true)
})

test('a provider needing repair is not shown active or renewed with a guest credential', async () => {
  await saveConnection(identity, save())
  providers = [
    create(ProviderConnectionSchema, {
      profileId: 'inventory',
      connectorId: 'galactic',
      state: ProviderConnectionState.RECONNECT,
    }),
  ]
  events.length = 0
  const result = await reconcileConnections(identity, 'microvm-fixture')
  expect(result.connections[0]?.credentialActive).toBe(false)
  expect(events.some((event) => event.name === 'CreatePlatformDelegation')).toBe(false)
})

for (const [status, code] of [
  [403, 'connection_access_denied'],
  [409, 'connection_scope_changed'],
] as const) {
  test(`a rejected consent write has a definite outcome and never installs a credential: ${status}`, async () => {
    consentFailure = status
    await expect(saveConnection(identity, save())).rejects.toMatchObject({ status, code })
    expect(connection).toBeUndefined()
    expect(events.map((event) => event.name)).toEqual(['catalog', 'PutPlatformConnection'])
    expect(installed).toEqual([])
  })
}

test('expiry and runtime changes renew credentials without writing consent again', async () => {
  await saveConnection(identity, save())
  expect(connection).toBeDefined()
  if (!connection) throw new Error('Missing fixture connection')
  const first = connection.delegationId
  connection.expiresAtUnixMs = BigInt(Date.now() - 1)
  events.length = 0
  await reconcileConnections(identity, 'microvm-fixture')
  expect(connection.delegationId).not.toBe(first)
  expect(events.some((event) => event.name === 'PutPlatformConnection')).toBe(false)
  runtime = '44444444-4444-4444-8444-444444444444'
  await reconcileConnections(identity, 'microvm-fixture')
  expect(connection.credentialBinding?.generation).toBe(runtime)
  expect(connection.version).toBe(BigInt(1))
})

test('credential issuance cannot outlive the current human idle deadline', async () => {
  identity.session.idleDeadlineUnixMs = BigInt(Date.now() + 120_000)
  await saveConnection(identity, save())
  expect(events.find((event) => event.name === 'CreatePlatformDelegation')?.body.expiresAtUnixMs).toBe(
    identity.session.idleDeadlineUnixMs,
  )
})

test('unavailable saved scopes stay denied while later connections renew', async () => {
  await saveConnection(identity, save())
  if (!connection) throw new Error('Missing fixture connection')
  connection.expiresAtUnixMs = BigInt(Date.now() - 1)
  connection.credentialActive = false
  const saved = connection
  precedingConnections = ['removed', 'recreated'].map((connectorId) => {
    const unavailable = clone(PlatformConnectionSchema, saved)
    unavailable.id = randomUUID()
    unavailable.clientReference = workspace + '/' + connectorId
    return unavailable
  })
  const recreated = clone(ConnectorOperationSchema, operation)
  recreated.connectorId = 'recreated'
  const target = recreated.targets[0]?.resource
  if (!target) throw new Error('Missing fixture target')
  target.id = 'galactic/recreated-uid'
  catalog.push(recreated)
  events.length = 0
  let failure: unknown
  try {
    await reconcileConnections(identity, 'microvm-fixture')
  } catch (error) {
    failure = error
  }
  expect(connection.credentialActive).toBe(true)
  expect(precedingConnections.every((entry) => !entry.credentialActive)).toBe(true)
  expect(
    events.filter((event) => event.name === 'CreatePlatformDelegation').map((event) => event.body.connectionId),
  ).toEqual([connectionId])
  expect(failure).toMatchObject({ status: 409 })
  if (!(failure instanceof Error)) throw new Error('Missing renewal failure')
  for (const entry of precedingConnections) {
    expect(failure.message).toContain(entry.clientReference.slice((workspace + '/').length))
    expect(failure.message).not.toContain(entry.id)
  }
})

test('replaces an inactive installation after gateway interruption with a freshly acknowledged credential', async () => {
  await saveConnection(identity, save())
  if (!connection) throw new Error('Missing fixture connection')
  const inactive = connection.delegationId
  connection.credentialActive = false
  events.length = 0
  await reconcileConnections(identity, 'microvm-fixture')
  expect(events.map((event) => event.name)).toContain('CreatePlatformDelegation')
  expect(events.map((event) => event.name)).toContain('configure')
  expect(connection.delegationId).not.toBe(inactive)
  expect(connection.credentialActive).toBe(true)
})

test('denied connection permissions do not prevent a later authorized renewal', async () => {
  await saveConnection(identity, save())
  if (!connection) throw new Error('Missing fixture connection')
  connection.expiresAtUnixMs = BigInt(Date.now() - 1)
  connection.credentialActive = false
  const denied = clone(PlatformConnectionSchema, connection)
  denied.id = randomUUID()
  denied.clientReference = workspace + '/denied'
  precedingConnections = [denied]
  const deniedOperation = clone(ConnectorOperationSchema, operation)
  deniedOperation.connectorId = 'denied'
  catalog.push(deniedOperation)
  events.length = 0
  let failure: unknown
  try {
    await reconcileConnections(identity, 'microvm-fixture')
  } catch (error) {
    failure = error
  }
  expect(connection.credentialActive).toBe(true)
  expect(denied.credentialActive).toBe(false)
  expect(events.filter((event) => event.name === 'configure').map((event) => event.body.connectionId)).toEqual([
    connectionId,
  ])
  expect(failure).toMatchObject({ status: 403 })
  if (!(failure instanceof Error)) throw new Error('Missing permission denial')
  expect(failure.message).toContain('denied: Access to the selected resources is no longer allowed.')
  expect(failure.message).not.toContain(denied.id)
})

test('disconnect wins against a delayed installation and a replayed original save', async () => {
  const request = save()
  duringConfigure = disconnect
  await expect(saveConnection(identity, request)).rejects.toThrow()
  expect(connection?.enabled).toBe(false)
  expect(connection?.credentialActive).toBe(false)
  duringConfigure = undefined
  events.length = 0
  const replayed = await saveConnection(identity, request)
  expect(replayed.connections[0]?.enabled).toBe(false)
  expect(events.some((event) => event.name === 'CreatePlatformDelegation')).toBe(false)
  expect(events.some((event) => event.name === 'configure')).toBe(false)
})

test('failed cleanup of a disconnected connection does not stop another renewal or expose private errors', async () => {
  await saveConnection(identity, save())
  if (!connection) throw new Error('Missing fixture connection')
  connection.expiresAtUnixMs = BigInt(Date.now() - 1)
  connection.credentialActive = false
  const disconnected = clone(PlatformConnectionSchema, connection)
  disconnected.id = randomUUID()
  disconnected.enabled = false
  precedingConnections = [disconnected]
  removalUnavailable = true
  let failure: unknown
  try {
    await reconcileConnections(identity, 'microvm-fixture')
  } catch (error) {
    failure = error
  }
  expect(connection.credentialActive).toBe(true)
  expect(failure).toMatchObject({ status: 502 })
  if (!(failure instanceof Error)) throw new Error('Missing cleanup failure')
  expect(failure.message).toContain(disconnected.clientReference.slice((workspace + '/').length))
  expect(failure.message).not.toContain(disconnected.id)
  expect(failure.message).not.toContain('Fixture guest disconnected')
})

test('mismatched acknowledgement revokes the child and cleans only its original generation', async () => {
  wrongAcknowledgement = true
  await expect(saveConnection(identity, save())).rejects.toThrow()
  expect(connection?.enabled).toBe(true)
  expect(connection?.credentialActive).toBe(false)
  expect(events.some((event) => event.name === 'ActivatePlatformDelegation')).toBe(false)
  const cleanup = events.find((event) => event.name === 'remove')
  expect(cleanup?.body).toMatchObject({
    connectionId,
    delegationId: connection?.delegationId,
    recoveryGeneration: '3',
    credentialGeneration: String(connection?.credentialGeneration),
  })
  wrongAcknowledgement = false
  await reconcileConnections(identity, 'microvm-fixture')
  expect(connection?.credentialActive).toBe(true)
})

test('renewal needs fresh authority and offline revocation never needs the guest', async () => {
  await saveConnection(identity, save())
  if (!connection) throw new Error('Missing fixture connection')
  connection.expiresAtUnixMs = BigInt(Date.now() - 1)
  permitted = false
  events.length = 0
  await expect(reconcileConnections(identity, 'microvm-fixture')).rejects.toThrow()
  expect(events.some((event) => event.name === 'configure')).toBe(false)
  ready = false
  events.length = 0
  expect(await disconnect()).toEqual({ revoked: true, cleanupPending: true })
  expect(events.map((event) => event.name)).toEqual([
    'ListPlatformConnections',
    'RevokePlatformConnection',
    'ListPlatformConnections',
  ])
  ready = true
  await reconcileConnections(identity, 'microvm-fixture')
  expect(installed).toEqual([])
})

test('replaces a revoked installed credential after failed guest cleanup', async () => {
  wrongAcknowledgement = true
  removalUnavailable = true
  await expect(saveConnection(identity, save())).rejects.toThrow()
  if (!connection) throw new Error('Missing fixture connection')
  const revoked = connection.delegationId
  expect(revokedDelegations.has(revoked)).toBe(true)
  expect(installed[0]?.delegationId).toBe(revoked)
  wrongAcknowledgement = false
  removalUnavailable = false
  events.length = 0
  await reconcileConnections(identity, 'microvm-fixture')
  expect(connection.delegationId).not.toBe(revoked)
  expect(connection.credentialActive).toBe(true)
  expect(
    events
      .filter((event) => event.name === 'ActivatePlatformDelegation')
      .every((event) => event.body.delegationId !== revoked),
  ).toBe(true)
})

test('a replayed disconnect receipt cannot claim current revocation after an explicit reconnect', async () => {
  await saveConnection(identity, save())
  const request = { operationId: randomUUID(), agentId: 'microvm-fixture', connectionId }
  await disconnectConnection(identity, request)
  if (!connection) throw new Error('Missing fixture connection')
  connection.enabled = true
  connection.credentialActive = true
  connection.version += BigInt(1)
  connection.credentialGeneration = ++generation
  events.length = 0
  await expect(disconnectConnection(identity, request)).rejects.toMatchObject({ status: 409 })
  expect(connection.enabled).toBe(true)
  expect(events.some((event) => event.name === 'remove')).toBe(false)
})

test('revoked intent uses the current recovery epoch to retire retained guest state after recovery', async () => {
  await saveConnection(identity, save())
  await disconnect()
  recoveryGeneration = BigInt(4)
  events.length = 0
  await reconcileConnections(identity, 'microvm-fixture')
  expect(events.find((event) => event.name === 'remove')?.body.recoveryGeneration).toBe('4')
  expect(connection?.enabled).toBe(false)
})
