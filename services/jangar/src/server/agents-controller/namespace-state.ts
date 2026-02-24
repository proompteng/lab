import { asString, readNested } from '~/server/primitives-http'

export type NamespaceState = {
  agents: Map<string, Record<string, unknown>>
  providers: Map<string, Record<string, unknown>>
  specs: Map<string, Record<string, unknown>>
  sources: Map<string, Record<string, unknown>>
  vcsProviders: Map<string, Record<string, unknown>>
  memories: Map<string, Record<string, unknown>>
  runs: Map<string, Record<string, unknown>>
}

export type ControllerState = {
  namespaces: Map<string, NamespaceState>
}

export type NamespaceSnapshot = {
  agents: Record<string, unknown>[]
  providers: Record<string, unknown>[]
  specs: Record<string, unknown>[]
  sources: Record<string, unknown>[]
  vcsProviders: Record<string, unknown>[]
  memories: Record<string, unknown>[]
  runs: Record<string, unknown>[]
}

export const listItems = (resource: Record<string, unknown>) => {
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  return items
}

const selectDefaultMemory = (memories: Record<string, unknown>[]) => {
  return memories.find((memory) => readNested(memory, ['spec', 'default']) === true) ?? null
}

export const resolveMemory = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  memories: Record<string, unknown>[],
) => {
  const runRef = asString(readNested(agentRun, ['spec', 'memoryRef', 'name']))
  if (runRef) {
    return memories.find((memory) => asString(readNested(memory, ['metadata', 'name'])) === runRef) ?? null
  }
  const agentRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
  if (agentRef) {
    return memories.find((memory) => asString(readNested(memory, ['metadata', 'name'])) === agentRef) ?? null
  }
  return selectDefaultMemory(memories)
}

export const createNamespaceState = (): NamespaceState => ({
  agents: new Map(),
  providers: new Map(),
  specs: new Map(),
  sources: new Map(),
  vcsProviders: new Map(),
  memories: new Map(),
  runs: new Map(),
})

export const ensureNamespaceState = (state: ControllerState, namespace: string) => {
  const existing = state.namespaces.get(namespace)
  if (existing) return existing
  const created = createNamespaceState()
  state.namespaces.set(namespace, created)
  return created
}

export const updateStateMap = (
  map: Map<string, Record<string, unknown>>,
  eventType: string | undefined,
  resource: Record<string, unknown>,
) => {
  const name = asString(readNested(resource, ['metadata', 'name']))
  if (!name) return
  if (eventType === 'DELETED') {
    map.delete(name)
    return
  }
  map.set(name, resource)
}

export const snapshotNamespace = (state: NamespaceState): NamespaceSnapshot => ({
  agents: Array.from(state.agents.values()),
  providers: Array.from(state.providers.values()),
  specs: Array.from(state.specs.values()),
  sources: Array.from(state.sources.values()),
  vcsProviders: Array.from(state.vcsProviders.values()),
  memories: Array.from(state.memories.values()),
  runs: Array.from(state.runs.values()),
})
