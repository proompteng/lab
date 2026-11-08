type Grant = { id: string; permission: string; grantRelation: string; workspaceGrantRelation: string }
type Resource = {
  kind: string
  nativeType: string
  workspaceScoped: boolean
  relations: { name: string; subjects: string[] }[]
}
type Action = {
  id: string
  resourceKind: string
  permission: string
  grantRelation?: string
  workspaceGrantRelation?: string
}
type Target = { workspaceId: string; id: string; name: string }
type Operation = {
  operation: {
    name: string
    action: string
    read_only: boolean
    target: { kind: string; id: string; name: string }
    [key: string]: unknown
  }
  [key: string]: unknown
}
export type ConnectorRegistration = {
  connector: {
    id: string
    type: 'kubernetes' | 'http' | 'cli' | 'mcp'
    operations?: readonly Operation[]
    [key: string]: unknown
  }
  policy: { kind: string; nativeType: string; actions: readonly Grant[] }
  targets: readonly Target[]
}
type Base = {
  policies: { version: number; resources: Resource[]; actions: Action[] }
  services: {
    version: number
    services: unknown[]
    workspaces: { id: string; resources: { kind: string; id: string; name: string }[]; [key: string]: unknown }[]
  }
  schema: string
}
const unique = (values: readonly string[], label: string) => {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`)
}
const identifier = (value: string, native = false) => {
  if (!(native ? /^[a-z][a-z0-9_]{0,63}$/ : /^[a-z][a-z0-9_.-]{0,127}$/).test(value))
    throw new Error(`Invalid registration identifier: ${value}`)
}

// Generate the common direct/workspace grant policy; the Ofz base package owns platform-specific graph policy.
export function compileConnectors(registrations: readonly ConnectorRegistration[], base: Base) {
  const policies = structuredClone(base.policies)
  const services = structuredClone(base.services)
  const definitions: string[] = []
  const approvals: { action: string; resource: string; effect: 'ask' }[] = []
  const policiesByKind = new Map<string, ConnectorRegistration['policy']>()
  unique(
    registrations.map(({ connector }) => connector.id),
    'connector ID',
  )
  for (const { connector, policy, targets } of registrations) {
    identifier(connector.id)
    identifier(policy.kind)
    identifier(policy.nativeType, true)
    if (!targets.length || !policy.actions.length) throw new Error(`Empty registration: ${connector.id}`)
    unique(
      targets.map((target) => target.id),
      'target',
    )
    unique(
      policy.actions.map((action) => action.permission),
      'permission',
    )
    unique(
      policy.actions.flatMap((action) => [action.grantRelation, action.workspaceGrantRelation]),
      'relation',
    )
    for (const action of policy.actions) {
      identifier(action.id)
      for (const name of [action.permission, action.grantRelation, action.workspaceGrantRelation])
        identifier(name, true)
    }
    const relations = [
      ...policy.actions.map((action) => ({ name: action.grantRelation, subjects: ['human', 'workload'] })),
      ...policy.actions.map((action) => ({ name: action.workspaceGrantRelation, subjects: ['workspace'] })),
    ]
    const previous = policiesByKind.get(policy.kind)
    if (previous && JSON.stringify(previous) !== JSON.stringify(policy))
      throw new Error(`Conflicting policy: ${policy.kind}`)
    if (!previous) {
      policiesByKind.set(policy.kind, policy)
      policies.resources.push({ kind: policy.kind, nativeType: policy.nativeType, workspaceScoped: true, relations })
      policies.actions.push(...policy.actions.map((action) => ({ ...action, resourceKind: policy.kind })))
      definitions.push(
        `definition ${policy.nativeType} {\n${relations.map((relation) => `    relation ${relation.name}: ${relation.subjects.map((subject) => (subject === 'workspace' ? 'platform_workspace' : subject)).join(' | ')}`).join('\n')}\n\n${policy.actions.map((action) => `    permission ${action.permission} = ${action.grantRelation} + ${action.workspaceGrantRelation}->human_member`).join('\n')}\n}`,
      )
    }
    for (const target of targets) {
      const workspace = services.workspaces.find((workspace) => workspace.id === target.workspaceId)
      if (!workspace) throw new Error(`Unknown workspace for ${connector.id}/${target.id}`)
      workspace.resources.push({ kind: policy.kind, id: target.id, name: target.name })
    }
    if (connector.type !== 'kubernetes' && !connector.operations?.length)
      throw new Error(`Missing operations: ${connector.id}`)
    unique(
      (connector.operations ?? []).map(({ operation }) => operation.name),
      'operation',
    )
    for (const { operation } of connector.operations ?? []) {
      identifier(operation.name)
      if (!policy.actions.some((action) => action.id === operation.action))
        throw new Error(`Unregistered action: ${operation.action}`)
      if (
        operation.target.kind !== policy.kind ||
        !targets.some((target) => target.id === operation.target.id && target.name === operation.target.name)
      )
        throw new Error(`Unregistered target: ${operation.target.id}`)
      if (typeof operation.read_only !== 'boolean') throw new Error(`Missing effect: ${operation.name}`)
      if (!operation.read_only)
        approvals.push({
          action: `relay_${connector.id}__${operation.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          resource: '*',
          effect: 'ask',
        })
    }
  }
  unique(
    policies.resources.map((resource) => resource.kind),
    'resource kind',
  )
  unique(
    policies.resources.map((resource) => resource.nativeType),
    'native type',
  )
  unique(
    policies.actions.map((action) => action.id),
    'action',
  )
  unique(
    services.workspaces.flatMap((workspace) =>
      workspace.resources.map((resource) => `${resource.kind}/${resource.id}`),
    ),
    'workspace resource',
  )
  unique(
    approvals.map((rule) => rule.action),
    'client approval action',
  )
  return {
    relay: { version: 1, connectors: registrations.map((registration) => registration.connector) },
    policies,
    services,
    schema: [base.schema.trim(), ...definitions].join('\n\n') + '\n',
    approvals,
  }
}
