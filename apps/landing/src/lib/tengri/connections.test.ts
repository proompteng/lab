import { create } from '@bufbuild/protobuf'
import { describe, expect, test } from 'bun:test'
import {
  connectionRequestSchema,
  credentialMatchesRuntime,
  installationMatches,
  savedConnectionOperations,
  selectConnectionScope,
  type RelayIdentity,
  type SaveConnection,
} from './connections'
import { PlatformConnectionSchema } from './generated/proompteng/authz/v1/platform_pb'
import { ConnectorOperationSchema } from './generated/proompteng/relay/v1/relay_pb'

const workspace = '11111111-1111-4111-8111-111111111111'
const runtime = '22222222-2222-4222-8222-222222222222'
const connectionId = '33333333-3333-4333-8333-333333333333'
const delegationId = '44444444-4444-4444-8444-444444444444'
const operation = (id = 'galactic/namespace-uid', name = 'production') =>
  create(ConnectorOperationSchema, {
    connectorId: 'galactic',
    name: 'pod_status',
    action: 'kubernetes.status.read',
    readOnly: true,
    targets: [
      {
        name,
        resource: { kind: 'kubernetes.namespace', id, target: name },
      },
    ],
  })
const op = operation()
const request: SaveConnection = {
  kind: 'save',
  operationId: workspace,
  agentId: 'workspace-1',
  connectionId,
  expectedVersion: '0',
  connectorId: 'galactic',
  operations: ['pod_status'],
  targets: [{ kind: 'kubernetes.namespace', id: 'galactic/namespace-uid' }],
}
const saved = () =>
  create(PlatformConnectionSchema, {
    id: connectionId,
    clientService: 'tengri-web',
    clientReference: workspace + '/galactic',
    actions: ['kubernetes.status.read'],
    resources: op.targets.flatMap((entry) => (entry.resource ? [entry.resource] : [])),
    binding: { service: 'tengri', id: workspace },
    credentialBinding: { service: 'tengri', id: workspace, generation: runtime },
    enabled: true,
    version: BigInt(1),
    delegationId,
    credentialGeneration: BigInt(12),
    recoveryGeneration: BigInt(3),
    credentialActive: true,
    expiresAtUnixMs: BigInt(1_000_000),
    proofKeyThumbprint: 'a'.repeat(43),
  })
const guest = (): RelayIdentity => ({
  agentId: workspace,
  proofKeyThumbprint: 'a'.repeat(43),
  connections: [{ connectionId, delegationId, recoveryGeneration: '3', credentialGeneration: '12', configured: true }],
})

describe('saved platform connections', () => {
  test('accepts one strict caller shape and derives actual resources from the catalog', () => {
    expect(connectionRequestSchema.parse(request)).toEqual(request)
    expect(connectionRequestSchema.safeParse({ ...request, expiresAtUnixMs: 42 }).success).toBe(false)
    expect(connectionRequestSchema.safeParse({ ...request, kind: 'renew', enabled: true }).success).toBe(false)
    const scope = selectConnectionScope([op], request)
    expect(scope.resources[0]).toMatchObject({ id: 'galactic/namespace-uid', target: 'production' })
    expect(scope.actions).toEqual(['kubernetes.status.read'])
  })
  test('cannot replace a recreated namespace, duplicate targets, or install unregistered and writable operations', () => {
    const recreated = operation('galactic/recreated-uid')
    expect(() => selectConnectionScope([recreated], request)).toThrow('target changed')
    expect(() =>
      selectConnectionScope([op], { ...request, targets: [...request.targets, ...request.targets] }),
    ).toThrow('once')
    expect(() => selectConnectionScope([op], { ...request, operations: ['arbitrary'] })).toThrow('registered')
    const writable = operation()
    writable.readOnly = false
    expect(() => selectConnectionScope([writable], request)).toThrow('read-only')
  })
  test('renewal retains exact saved authority and rejects a changed catalog or workspace', () => {
    expect(savedConnectionOperations([op], saved(), workspace).operations).toEqual([op])
    expect(() => savedConnectionOperations([], saved(), workspace)).toThrow('saved scope')
    const renamed = operation('galactic/namespace-uid', 'other')
    expect(() => savedConnectionOperations([renamed], saved(), workspace)).toThrow('saved scope')
    expect(() => savedConnectionOperations([op], saved(), runtime)).toThrow('another workspace')
  })
  test('expiry, recovery and runtime changes require new credentials, while disabled intent stays disabled', () => {
    const connection = saved()
    expect(credentialMatchesRuntime(connection, runtime, BigInt(3), 0)).toBe(true)
    expect(credentialMatchesRuntime(connection, runtime, BigInt(3), 910_000)).toBe(false)
    expect(credentialMatchesRuntime(connection, workspace, BigInt(3), 0)).toBe(false)
    expect(credentialMatchesRuntime(connection, runtime, BigInt(4), 0)).toBe(false)
    connection.enabled = false
    expect(credentialMatchesRuntime(connection, runtime, BigInt(3), 0)).toBe(false)
    expect(connection.enabled).toBe(false)
  })
  test('acknowledged installation must match the exact proof, delegation and retained generations', () => {
    expect(installationMatches(saved(), guest())).toBe(true)
    const wrongKey = guest()
    wrongKey.proofKeyThumbprint = 'b'.repeat(43)
    expect(installationMatches(saved(), wrongKey)).toBe(false)
    for (const patch of [
      { configured: false },
      { recoveryGeneration: '2' },
      { credentialGeneration: '11' },
      { delegationId: workspace },
    ]) {
      const current = guest()
      current.connections = current.connections.map((entry) => ({ ...entry, ...patch }))
      expect(installationMatches(saved(), current)).toBe(false)
    }
  })
})
