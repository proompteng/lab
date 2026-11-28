import { asString, readNested } from '../primitives'

import { isActiveRun, isQueuedRun, normalizeRepository, resolveRunHeadBranch, resolveRunRepository } from './run-utils'

export type RepoConcurrencyConfig = {
  enabled: boolean
  defaultLimit: number
  overrides: Map<string, number>
}

export const resolveRepoConcurrencyLimit = (repository: string, config: RepoConcurrencyConfig) => {
  if (!config.enabled || !repository.trim()) return null
  const limit = config.overrides.get(normalizeRepository(repository)) ?? config.defaultLimit
  return limit > 0 ? limit : null
}

type Run = Record<string, unknown>
type IndexedRun = {
  resource: Run
  repository: string
  runningAgent: string | null
  queued: boolean
  branch: string | null
}

const createNamespaceRuns = () => ({
  entries: new Map<string, IndexedRun>(),
  running: 0,
  queued: 0,
  runningByAgent: new Map<string, number>(),
  activeByBranch: new Map<string, number>(),
})

const adjustCount = (counts: Map<string, number>, key: string, change: 1 | -1) => {
  const next = (counts.get(key) ?? 0) + change
  if (next === 0) counts.delete(key)
  else counts.set(key, next)
}

const branchKey = (repository: string, branch: string) => JSON.stringify([repository, branch.trim()])

// Keep the resources and their admission indexes under one writer. A run observation changes
// only its own contribution; neither admission nor VCS branch checks scan the fleet.
export class AgentRunIndex {
  private readonly namespaces = new Map<string, ReturnType<typeof createNamespaceRuns>>()
  private readonly runningByRepo = new Map<string, number>()
  private readonly queuedByRepo = new Map<string, number>()
  private running = 0
  private queued = 0

  get(namespace: string, name: string) {
    return this.namespaces.get(namespace)?.entries.get(name)?.resource
  }

  list(namespace: string) {
    return Array.from(this.namespaces.get(namespace)?.entries.values() ?? [], (entry) => entry.resource)
  }

  update(namespace: string, name: string, resource: Run | null) {
    let ns = this.namespaces.get(namespace)
    const previous = ns?.entries.get(name)
    if (previous?.resource === resource || (!previous && !resource)) return
    if (!ns) {
      ns = createNamespaceRuns()
      this.namespaces.set(namespace, ns)
    }
    if (previous) this.adjust(ns, previous, -1)
    if (!resource) {
      ns.entries.delete(name)
      if (!ns.entries.size) this.namespaces.delete(namespace)
      return
    }

    const repository = normalizeRepository(resolveRunRepository(resource))
    const head = repository && isActiveRun(resource) ? resolveRunHeadBranch(resource) : ''
    const entry = {
      resource,
      repository,
      runningAgent:
        asString(readNested(resource, ['status', 'phase'])) === 'Running'
          ? (asString(readNested(resource, ['spec', 'agentRef', 'name'])) ?? 'unknown')
          : null,
      queued: isQueuedRun(resource),
      branch: head ? branchKey(repository, head) : null,
    }
    ns.entries.set(name, entry)
    this.adjust(ns, entry, 1)
  }

  replaceNamespace(namespace: string, resources: ReadonlyMap<string, Run>) {
    for (const name of this.namespaces.get(namespace)?.entries.keys() ?? []) {
      if (!resources.has(name)) this.update(namespace, name, null)
    }
    for (const [name, resource] of resources) this.update(namespace, name, resource)
  }

  admission(namespace: string, name: string, agent: string | null, repository: string) {
    const ns = this.namespaces.get(namespace)
    const self = ns?.entries.get(name)
    const queuedSelf = self?.queued ? 1 : 0
    return {
      runningNamespace: ns?.running ?? 0,
      runningCluster: this.running,
      runningAgent: agent ? (ns?.runningByAgent.get(agent) ?? 0) : 0,
      runningRepo: this.runningByRepo.get(repository) ?? 0,
      queuedNamespace: (ns?.queued ?? 0) - queuedSelf,
      queuedCluster: this.queued - queuedSelf,
      queuedRepo:
        (this.queuedByRepo.get(repository) ?? 0) - (repository && self?.repository === repository ? queuedSelf : 0),
    }
  }

  hasBranchConflict(namespace: string, runName: string, repository: string, head: string) {
    if (!repository || !head) return false
    const ns = this.namespaces.get(namespace)
    const key = branchKey(normalizeRepository(repository), head)
    return (ns?.activeByBranch.get(key) ?? 0) > (ns?.entries.get(runName)?.branch === key ? 1 : 0)
  }

  private adjust(ns: ReturnType<typeof createNamespaceRuns>, run: IndexedRun, change: 1 | -1) {
    if (run.runningAgent !== null) {
      this.running += change
      ns.running += change
      adjustCount(ns.runningByAgent, run.runningAgent, change)
      if (run.repository) adjustCount(this.runningByRepo, run.repository, change)
    }
    if (run.queued) {
      this.queued += change
      ns.queued += change
      if (run.repository) adjustCount(this.queuedByRepo, run.repository, change)
    }
    if (run.branch) adjustCount(ns.activeByBranch, run.branch, change)
  }
}
