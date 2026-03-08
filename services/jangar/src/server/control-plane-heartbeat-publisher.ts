import { getAgentsControllerHealth } from '~/server/agents-controller'
import {
  createControlPlaneHeartbeatStore,
  resolveControlPlaneHeartbeatIntervalSeconds,
  resolveControlPlanePodIdentity,
  type ControlPlaneHeartbeatComponent,
  type ControlPlaneHeartbeatInput,
  type ControlPlaneHeartbeatStore,
  type ControlPlaneHeartbeatStatus,
} from '~/server/control-plane-heartbeat-store'
import { getLeaderElectionStatus, type LeaderElectionStatus } from '~/server/leader-election'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'

type ControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
}

type PublisherDeps = {
  now?: () => Date
  createStore?: () => ControlPlaneHeartbeatStore
  getLeaderStatus?: () => LeaderElectionStatus
  getAgentsHealth?: () => ControllerHealthSnapshot
  getSupportingHealth?: () => ControllerHealthSnapshot
  getOrchestrationHealth?: () => ControllerHealthSnapshot
  resolvePodIdentity?: () => { podName: string; deploymentName: string }
  logWarning?: (message: string, error: unknown) => void
}

type HeartbeatComponentState = {
  enabled: boolean
  status: ControlPlaneHeartbeatStatus
  message: string
}

const DEFAULT_NAMESPACES = ['agents']

const globalState = globalThis as typeof globalThis & {
  __jangarControlPlaneHeartbeatPublisher?: {
    timer: ReturnType<typeof setInterval> | null
    tickInFlight: boolean
    store: ControlPlaneHeartbeatStore | null
  }
}

const publisherState = (() => {
  if (globalState.__jangarControlPlaneHeartbeatPublisher) {
    return globalState.__jangarControlPlaneHeartbeatPublisher
  }
  const initial = {
    timer: null,
    tickInFlight: false,
    store: null,
  }
  globalState.__jangarControlPlaneHeartbeatPublisher = initial
  return initial
})()

const defaultLogWarning = (message: string, error: unknown) => {
  console.warn(`[jangar] ${message}`, error)
}

const uniqueStrings = (values: string[]) => Array.from(new Set(values))

const shouldPublishAuthoritativeHeartbeats = (leaderStatus: LeaderElectionStatus) =>
  !leaderStatus.enabled || !leaderStatus.required || leaderStatus.isLeader

const resolveLeadershipState = (leaderStatus: LeaderElectionStatus) =>
  leaderStatus.enabled && leaderStatus.required ? 'leader' : 'not-applicable'

const buildComponentState = (
  component: ControlPlaneHeartbeatComponent,
  health: ControllerHealthSnapshot,
): HeartbeatComponentState => {
  const label = component === 'workflow-runtime' ? 'workflow runtime' : component.replace(/-/g, ' ')

  if (!health.enabled) {
    return {
      enabled: false,
      status: 'disabled',
      message: `${label} disabled`,
    }
  }

  if (!health.started) {
    return {
      enabled: true,
      status: 'degraded',
      message: `${label} not started`,
    }
  }

  if (health.crdsReady === false) {
    return {
      enabled: true,
      status: 'degraded',
      message: `missing CRDs: ${health.missingCrds.join(', ') || 'unknown'}`,
    }
  }

  if (health.crdsReady === null) {
    return {
      enabled: true,
      status: 'unknown',
      message: 'CRD status not yet checked',
    }
  }

  return {
    enabled: true,
    status: 'healthy',
    message: '',
  }
}

const resolveNamespaces = (
  health: ControllerHealthSnapshot,
  envName: string,
  label: string,
  logWarning: (message: string, error: unknown) => void,
) => {
  const configuredNamespaces = (() => {
    if (Array.isArray(health.namespaces) && health.namespaces.length > 0) {
      return health.namespaces
    }

    try {
      return parseNamespaceScopeEnv(envName, {
        fallback: DEFAULT_NAMESPACES,
        label,
      })
    } catch (error) {
      logWarning(`failed to resolve ${label} namespaces for heartbeat publishing`, error)
      return []
    }
  })()

  return uniqueStrings(configuredNamespaces.filter((namespace) => namespace.length > 0 && namespace !== '*'))
}

export const buildControlPlaneHeartbeatInputs = ({
  now,
  leaderStatus,
  podIdentity,
  agentsHealth,
  supportingHealth,
  orchestrationHealth,
  logWarning = defaultLogWarning,
}: {
  now: Date
  leaderStatus: LeaderElectionStatus
  podIdentity: { podName: string; deploymentName: string }
  agentsHealth: ControllerHealthSnapshot
  supportingHealth: ControllerHealthSnapshot
  orchestrationHealth: ControllerHealthSnapshot
  logWarning?: (message: string, error: unknown) => void
}): ControlPlaneHeartbeatInput[] => {
  if (!shouldPublishAuthoritativeHeartbeats(leaderStatus)) {
    return []
  }

  const observedAt = now.toISOString()
  const leadershipState = resolveLeadershipState(leaderStatus)
  const componentStates = [
    {
      component: 'agents-controller' as const,
      health: agentsHealth,
      namespaces: resolveNamespaces(
        agentsHealth,
        'JANGAR_AGENTS_CONTROLLER_NAMESPACES',
        'agents controller',
        logWarning,
      ),
    },
    {
      component: 'supporting-controller' as const,
      health: supportingHealth,
      namespaces: resolveNamespaces(
        supportingHealth,
        'JANGAR_SUPPORTING_CONTROLLER_NAMESPACES',
        'supporting controller',
        logWarning,
      ),
    },
    {
      component: 'orchestration-controller' as const,
      health: orchestrationHealth,
      namespaces: resolveNamespaces(
        orchestrationHealth,
        'JANGAR_ORCHESTRATION_CONTROLLER_NAMESPACES',
        'orchestration controller',
        logWarning,
      ),
    },
    {
      component: 'workflow-runtime' as const,
      health: agentsHealth,
      namespaces: resolveNamespaces(
        agentsHealth,
        'JANGAR_AGENTS_CONTROLLER_NAMESPACES',
        'workflow runtime',
        logWarning,
      ),
    },
  ]

  return componentStates.flatMap(({ component, health, namespaces }) => {
    const state = buildComponentState(component, health)
    return namespaces.map((namespace) => ({
      namespace,
      component,
      workloadRole: 'controllers' as const,
      podName: podIdentity.podName,
      deploymentName: podIdentity.deploymentName,
      enabled: state.enabled,
      status: state.status,
      message: state.message,
      leadershipState,
      observedAt,
    }))
  })
}

export const publishControlPlaneHeartbeatsOnce = async (deps: PublisherDeps = {}) => {
  const logWarning = deps.logWarning ?? defaultLogWarning
  const inputs = buildControlPlaneHeartbeatInputs({
    now: (deps.now ?? (() => new Date()))(),
    leaderStatus: (deps.getLeaderStatus ?? getLeaderElectionStatus)(),
    podIdentity: (deps.resolvePodIdentity ?? resolveControlPlanePodIdentity)(),
    agentsHealth: (deps.getAgentsHealth ?? getAgentsControllerHealth)(),
    supportingHealth: (deps.getSupportingHealth ?? getSupportingControllerHealth)(),
    orchestrationHealth: (deps.getOrchestrationHealth ?? getOrchestrationControllerHealth)(),
    logWarning,
  })

  if (inputs.length === 0) {
    return 0
  }

  const store = (deps.createStore ?? createControlPlaneHeartbeatStore)()
  await Promise.all(inputs.map((input) => store.upsertHeartbeat(input)))
  return inputs.length
}

const resolveSharedStore = () => {
  if (publisherState.store) {
    return publisherState.store
  }
  const store = createControlPlaneHeartbeatStore()
  publisherState.store = store
  return store
}

const closeSharedStore = async () => {
  const store = publisherState.store
  publisherState.store = null
  if (!store) {
    return
  }
  await store.close()
}

export const startControlPlaneHeartbeatPublisher = (deps: PublisherDeps = {}) => {
  if (publisherState.timer) {
    return
  }

  const run = async () => {
    if (publisherState.tickInFlight) {
      return
    }
    publisherState.tickInFlight = true
    try {
      await publishControlPlaneHeartbeatsOnce({
        ...deps,
        createStore: deps.createStore ?? resolveSharedStore,
      })
    } catch (error) {
      ;(deps.logWarning ?? defaultLogWarning)('control-plane heartbeat publish failed', error)
    } finally {
      publisherState.tickInFlight = false
    }
  }

  void run()
  publisherState.timer = setInterval(() => {
    void run()
  }, resolveControlPlaneHeartbeatIntervalSeconds() * 1000)
}

export const stopControlPlaneHeartbeatPublisher = () => {
  if (publisherState.timer) {
    clearInterval(publisherState.timer)
    publisherState.timer = null
  }
  publisherState.tickInFlight = false
  void closeSharedStore().catch((error) => {
    defaultLogWarning('failed to close control-plane heartbeat store', error)
  })
}

export const __test__ = {
  buildComponentState,
  shouldPublishAuthoritativeHeartbeats,
}
