import { AGENT_RUN_SPEC, RESOURCE_SPECS, RPC_RESOURCE_MAP } from '../legacy'

export type ResourceSpec = {
  kind: string
  group: string
  version: string
  plural: string
}

export type ResourceEntry = {
  name: string
  spec: ResourceSpec
  rpc?: { list: string; get: string; apply: string; del: string; create?: string }
  aliases: string[]
  isRun?: boolean
  supportsDelete?: boolean
}

const baseAliases = (name: string, spec: ResourceSpec) => {
  const aliases = new Set<string>()
  aliases.add(name)
  aliases.add(`${name}s`)
  aliases.add(spec.kind.toLowerCase())
  aliases.add(spec.plural.toLowerCase())
  return [...aliases]
}

const RESOURCE_ALIASES: Record<string, string[]> = {
  agent: ['agent', 'agents'],
  provider: ['provider', 'providers', 'agentprovider', 'agentproviders'],
  impl: [
    'impl',
    'impls',
    'implementation',
    'implementations',
    'implementationspec',
    'implementationspecs',
    'spec',
    'specs',
  ],
  source: ['source', 'sources', 'implementationsource', 'implementationsources'],
  memory: ['memory', 'memories'],
  tool: ['tool', 'tools'],
  toolrun: ['toolrun', 'toolruns'],
  orchestration: ['orchestration', 'orchestrations'],
  orchestrationrun: ['orchestrationrun', 'orchestrationruns'],
  approval: ['approval', 'approvals', 'approvalpolicy', 'approvalpolicies'],
  budget: ['budget', 'budgets'],
  secretbinding: ['secretbinding', 'secretbindings'],
  signal: ['signal', 'signals'],
  signaldelivery: ['signaldelivery', 'signaldeliveries'],
  schedule: ['schedule', 'schedules'],
  artifact: ['artifact', 'artifacts'],
  workspace: ['workspace', 'workspaces'],
}

const resources: ResourceEntry[] = Object.entries(RESOURCE_SPECS).map(([name, spec]) => ({
  name,
  spec,
  rpc: RPC_RESOURCE_MAP[name],
  aliases: Array.from(new Set([...(RESOURCE_ALIASES[name] ?? []), ...baseAliases(name, spec)])),
  supportsDelete: true,
}))

resources.push({
  name: 'run',
  spec: AGENT_RUN_SPEC,
  aliases: ['run', 'runs', 'agentrun', 'agentruns'],
  isRun: true,
  supportsDelete: false,
})

const resourceIndex = new Map<string, ResourceEntry>()
for (const entry of resources) {
  for (const alias of entry.aliases) {
    resourceIndex.set(alias.toLowerCase(), entry)
  }
}

export const resolveResource = (value: string) => resourceIndex.get(value.trim().toLowerCase())

export const listResourceNames = () =>
  resources
    .filter((entry) => !entry.isRun)
    .map((entry) => entry.name)
    .sort()

export const listAllResourceNames = () =>
  resources
    .map((entry) => entry.name)
    .sort()

export const listAllResourceAliases = () =>
  Array.from(resourceIndex.keys()).sort()
