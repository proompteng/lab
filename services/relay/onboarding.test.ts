import { expect, test } from 'bun:test'
import { compileConnectors, type ConnectorRegistration } from './onboarding'

const base = {
  policies: { version: 1, resources: [], actions: [] },
  services: { version: 1, services: [], workspaces: [{ id: 'workspace', resources: [] }] },
  schema: 'definition platform_workspace {}\n',
}
const registration = (): ConnectorRegistration => ({
  connector: {
    id: 'fixture',
    type: 'mcp',
    transport: { type: 'http', endpoint: 'https://fixture.test/mcp', authentication: { type: 'none' } },
    operations: [
      {
        operation: {
          name: 'search',
          action: 'fixture.search',
          read_only: true,
          target: { kind: 'fixture.account', id: 'fixture/account', name: 'Fixture' },
          input_schema: { type: 'object', additionalProperties: false },
        },
        tool: 'search',
      },
    ],
  },
  policy: {
    kind: 'fixture.account',
    nativeType: 'fixture_account',
    actions: [
      {
        id: 'fixture.search',
        permission: 'search',
        grantRelation: 'reader',
        workspaceGrantRelation: 'reader_workspace',
      },
    ],
  },
  targets: [{ workspaceId: 'workspace', id: 'fixture/account', name: 'Fixture' }],
})

test('one declaration enrolls a new connector without client or evaluator edits', () => {
  const input = registration()
  const output = compileConnectors([input], base)
  expect(output.relay.connectors).toEqual([input.connector])
  expect(output.services.workspaces[0]?.resources).toEqual([
    { kind: 'fixture.account', id: 'fixture/account', name: 'Fixture' },
  ])
  expect(output.policies.actions).toEqual([{ ...input.policy.actions[0], resourceKind: 'fixture.account' }])
  expect(output.schema).toContain('permission search = reader + reader_workspace->human_member')
  expect(output.approvals).toEqual([])
  expect(base.services.workspaces[0]?.resources).toEqual([])
})

test('new mutations receive native approval rules and deletion removes generated enrollment', () => {
  const input = registration()
  const operation = input.connector.operations![0]!.operation
  operation.read_only = false
  operation.name = 'write.record'
  expect(compileConnectors([input], base).approvals).toEqual([
    { action: 'relay_fixture__write_record', resource: '*', effect: 'ask' },
  ])
  const removed = compileConnectors([], base)
  expect(removed.relay.connectors).toEqual([])
  expect(removed.services.workspaces[0]?.resources).toEqual([])
  expect(removed.policies).toEqual(base.policies)
  expect(removed.approvals).toEqual([])
})

test('separate connector instances can reuse the same policy without duplicating definitions', () => {
  const first = registration(),
    second = registration()
  second.connector.id = 'second'
  second.targets = [{ workspaceId: 'workspace', id: 'second/account', name: 'Fixture' }]
  second.connector.operations![0]!.operation.target.id = 'second/account'
  const output = compileConnectors([first, second], base)
  expect(output.policies.resources).toHaveLength(1)
  expect(output.policies.actions).toHaveLength(1)
  expect(output.services.workspaces[0]?.resources).toHaveLength(2)
  second.policy.nativeType = 'other'
  expect(() => compileConnectors([first, second], base)).toThrow('Conflicting policy')
})

test('unknown workspace, unknown actions, mismatched target and conflicting identities fail closed', () => {
  const workspace = registration()
  workspace.targets = [{ ...workspace.targets[0]!, workspaceId: 'absent' }]
  expect(() => compileConnectors([workspace], base)).toThrow('Unknown workspace')
  const action = registration()
  action.connector.operations![0]!.operation.action = 'fixture.write'
  expect(() => compileConnectors([action], base)).toThrow('Unregistered action')
  const target = registration()
  target.connector.operations![0]!.operation.target.id = 'another/account'
  expect(() => compileConnectors([target], base)).toThrow('Unregistered target')
  expect(() => compileConnectors([registration(), registration()], base)).toThrow('Duplicate connector')
  const native = registration()
  native.policy.nativeType = 'fixture {}'
  expect(() => compileConnectors([native], base)).toThrow('Invalid registration')
})
