import { readFile } from 'node:fs/promises'

import { resolveBooleanFeatureToggle } from './feature-flags'
import { createAgentsHealthHandler } from './health'
import { createAgentsHttpRuntime, type AgentsHttpRuntime } from './http-runtime'
import { createKubernetesClient } from './kube-types'
import { getLeaderElectionStatus, requireLeaderForMutationHttp } from './leader-election'
import { recordAgentQueueDepth, renderAgentsPrometheusMetrics } from './metrics'
import { createPrimitivesStore } from './primitives-store'
import { validatePolicies } from './primitives-policy'
import { createAgentsReadyHandler, type AgentRunIngestionAssessment, type AgentsControllerHealthState } from './ready'
import { resolveRuntimeServiceName } from './runtime-identity'
import { resolveAuditContextFromRequest, resolveRepositoryFromParameters } from './audit-logging'
import { configureAgentsControllerRuntime, getAgentsControllerHealth } from './agents-controller'
import { startAgentsControllerRuntime, stopAgentsControllerRuntime } from './controller-runtime'
import { getOrchestrationControllerHealth } from './orchestration-controller'
import { getSupportingControllerHealth } from './supporting-primitives-controller'
import { configureAgentsV1Runtime } from './v1/runtime'
import { resolveAgentsHttpServerListenConfig } from './runtime-entry-config'

const defaultMetricsPath = '/metrics'

type RouteSourceSpec = {
  file: string
  sourceUrl: URL
  load: () => Promise<unknown>
}

type ControlPlaneRuntimeOptions = {
  routeSources?: RouteSourceSpec[]
}

const routeSources: RouteSourceSpec[] = [
  {
    file: 'src/routes/v1/agents.ts',
    sourceUrl: new URL('../routes/v1/agents.ts', import.meta.url),
    load: () => import('../routes/v1/agents'),
  },
  {
    file: 'src/routes/v1/agents/$id.ts',
    sourceUrl: new URL('../routes/v1/agents/$id.ts', import.meta.url),
    load: () => import('../routes/v1/agents/$id'),
  },
  {
    file: 'src/routes/v1/agent-runs.ts',
    sourceUrl: new URL('../routes/v1/agent-runs.ts', import.meta.url),
    load: () => import('../routes/v1/agent-runs'),
  },
  {
    file: 'src/routes/v1/agent-runs/resources.ts',
    sourceUrl: new URL('../routes/v1/agent-runs/resources.ts', import.meta.url),
    load: () => import('../routes/v1/agent-runs/resources'),
  },
  {
    file: 'src/routes/v1/agent-messages.ts',
    sourceUrl: new URL('../routes/v1/agent-messages.ts', import.meta.url),
    load: () => import('../routes/v1/agent-messages'),
  },
  {
    file: 'src/routes/v1/agent-events.ts',
    sourceUrl: new URL('../routes/v1/agent-events.ts', import.meta.url),
    load: () => import('../routes/v1/agent-events'),
  },
  {
    file: 'src/routes/v1/implementation-sources/webhooks/$provider.ts',
    sourceUrl: new URL('../routes/v1/implementation-sources/webhooks/$provider.ts', import.meta.url),
    load: () => import('../routes/v1/implementation-sources/webhooks/$provider'),
  },
  {
    file: 'src/routes/v1/approval-policies/resources.ts',
    sourceUrl: new URL('../routes/v1/approval-policies/resources.ts', import.meta.url),
    load: () => import('../routes/v1/approval-policies/resources'),
  },
  {
    file: 'src/routes/v1/budgets/resources.ts',
    sourceUrl: new URL('../routes/v1/budgets/resources.ts', import.meta.url),
    load: () => import('../routes/v1/budgets/resources'),
  },
  {
    file: 'src/routes/v1/memories.ts',
    sourceUrl: new URL('../routes/v1/memories.ts', import.meta.url),
    load: () => import('../routes/v1/memories'),
  },
  {
    file: 'src/routes/v1/memories/resources.ts',
    sourceUrl: new URL('../routes/v1/memories/resources.ts', import.meta.url),
    load: () => import('../routes/v1/memories/resources'),
  },
  {
    file: 'src/routes/v1/memories/$id.ts',
    sourceUrl: new URL('../routes/v1/memories/$id.ts', import.meta.url),
    load: () => import('../routes/v1/memories/$id'),
  },
  {
    file: 'src/routes/v1/memory-queries.ts',
    sourceUrl: new URL('../routes/v1/memory-queries.ts', import.meta.url),
    load: () => import('../routes/v1/memory-queries'),
  },
  {
    file: 'src/routes/v1/memory-operations.ts',
    sourceUrl: new URL('../routes/v1/memory-operations.ts', import.meta.url),
    load: () => import('../routes/v1/memory-operations'),
  },
  {
    file: 'src/routes/v1/orchestrations.ts',
    sourceUrl: new URL('../routes/v1/orchestrations.ts', import.meta.url),
    load: () => import('../routes/v1/orchestrations'),
  },
  {
    file: 'src/routes/v1/orchestrations/$id.ts',
    sourceUrl: new URL('../routes/v1/orchestrations/$id.ts', import.meta.url),
    load: () => import('../routes/v1/orchestrations/$id'),
  },
  {
    file: 'src/routes/v1/orchestration-runs.ts',
    sourceUrl: new URL('../routes/v1/orchestration-runs.ts', import.meta.url),
    load: () => import('../routes/v1/orchestration-runs'),
  },
  {
    file: 'src/routes/v1/orchestration-runs/$id.ts',
    sourceUrl: new URL('../routes/v1/orchestration-runs/$id.ts', import.meta.url),
    load: () => import('../routes/v1/orchestration-runs/$id'),
  },
  {
    file: 'src/routes/v1/orchestration-runs/resources.ts',
    sourceUrl: new URL('../routes/v1/orchestration-runs/resources.ts', import.meta.url),
    load: () => import('../routes/v1/orchestration-runs/resources'),
  },
  {
    file: 'src/routes/v1/jobs/resources.ts',
    sourceUrl: new URL('../routes/v1/jobs/resources.ts', import.meta.url),
    load: () => import('../routes/v1/jobs/resources'),
  },
  {
    file: 'src/routes/v1/control-plane/status.ts',
    sourceUrl: new URL('../routes/v1/control-plane/status.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/status'),
  },
  {
    file: 'src/routes/v1/control-plane/execution-trust.ts',
    sourceUrl: new URL('../routes/v1/control-plane/execution-trust.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/execution-trust'),
  },
  {
    file: 'src/routes/v1/control-plane/events.ts',
    sourceUrl: new URL('../routes/v1/control-plane/events.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/events'),
  },
  {
    file: 'src/routes/v1/control-plane/logs.ts',
    sourceUrl: new URL('../routes/v1/control-plane/logs.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/logs'),
  },
  {
    file: 'src/routes/v1/control-plane/stream.ts',
    sourceUrl: new URL('../routes/v1/control-plane/stream.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/stream'),
  },
  {
    file: 'src/routes/v1/control-plane/summary.ts',
    sourceUrl: new URL('../routes/v1/control-plane/summary.ts', import.meta.url),
    load: () => import('../routes/v1/control-plane/summary'),
  },
  {
    file: 'src/routes/v1/secret-bindings/resources.ts',
    sourceUrl: new URL('../routes/v1/secret-bindings/resources.ts', import.meta.url),
    load: () => import('../routes/v1/secret-bindings/resources'),
  },
  {
    file: 'src/routes/v1/signals/resources.ts',
    sourceUrl: new URL('../routes/v1/signals/resources.ts', import.meta.url),
    load: () => import('../routes/v1/signals/resources'),
  },
  {
    file: 'src/routes/v1/swarms/resources.ts',
    sourceUrl: new URL('../routes/v1/swarms/resources.ts', import.meta.url),
    load: () => import('../routes/v1/swarms/resources'),
  },
  {
    file: 'src/routes/v1/agent-runs/$id.ts',
    sourceUrl: new URL('../routes/v1/agent-runs/$id.ts', import.meta.url),
    load: () => import('../routes/v1/agent-runs/$id'),
  },
  {
    file: 'src/routes/v1/runs/$id.ts',
    sourceUrl: new URL('../routes/v1/runs/$id.ts', import.meta.url),
    load: () => import('../routes/v1/runs/$id'),
  },
]

const assessAgentRunIngestion = (
  namespace: string,
  health: AgentsControllerHealthState,
): AgentRunIngestionAssessment => {
  const current = health.agentRunIngestion?.find((entry) => entry.namespace === namespace)
  return {
    namespace,
    lastWatchEventAt: current?.lastWatchEventAt ?? null,
    lastResyncAt: current?.lastResyncAt ?? null,
    untouchedRunCount: current?.untouchedRunCount ?? 0,
    oldestUntouchedAgeSeconds: current?.oldestUntouchedAgeSeconds ?? null,
    status: health.started ? 'healthy' : 'unknown',
    message: health.started ? 'AgentRun ingestion is active' : 'AgentRun ingestion has not started',
    dispatchPaused: false,
  }
}

const isMetricsEnabled = () => {
  const raw = process.env.AGENTS_PROMETHEUS_METRICS_ENABLED
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

const metricsPath = () => process.env.AGENTS_PROMETHEUS_METRICS_PATH ?? defaultMetricsPath

const renderMetrics = async () => ({
  ok: true as const,
  body: renderAgentsPrometheusMetrics(),
})

const loadRouteSources = async (sources: RouteSourceSpec[]) => {
  const entries = await Promise.all(
    sources.map(async (source) => [source.file, await readFile(source.sourceUrl, 'utf8')]),
  )
  return Object.fromEntries(entries)
}

const configureRuntimeDependencies = () => {
  configureAgentsControllerRuntime({
    createPrimitivesStore,
    resolveBooleanFeatureToggle,
  })

  configureAgentsV1Runtime({
    agents: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      resolveAuditContextFromRequest,
      validatePolicies,
    },
    agentRuns: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      recordAgentQueueDepth,
      resolveAuditContextFromRequest,
      resolveRepositoryFromParameters: (params) => resolveRepositoryFromParameters(params) ?? undefined,
      validatePolicies,
    },
    memories: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      resolveAuditContextFromRequest,
    },
    memoryQueries: {
      kubeClientFactory: createKubernetesClient,
    },
    memoryOperations: {
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
    },
    orchestrations: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      resolveAuditContextFromRequest,
      validatePolicies,
    },
    orchestrationRuns: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      resolveRepositoryFromParameters,
      validatePolicies,
    },
    resourceRead: {
      kubeClientFactory: createKubernetesClient,
    },
    orchestrationRunRead: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
    },
    memoryRead: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
    },
    runRead: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
    },
  })
}

export const createAgentsControlPlaneRuntime = async (
  options: ControlPlaneRuntimeOptions = {},
): Promise<AgentsHttpRuntime & { handleHttpRequest: (request: Request) => Promise<Response> }> => {
  configureRuntimeDependencies()

  const healthHandler = createAgentsHealthHandler({
    getAgentsControllerHealth,
    resolveServiceName: () => 'agents',
  })
  const readyHandler = createAgentsReadyHandler({
    getLeaderElectionStatus,
    getAgentsControllerHealth,
    getOrchestrationControllerHealth,
    getSupportingControllerHealth,
    assessAgentRunIngestion,
  })

  const sources = options.routeSources ?? routeSources
  const runtime = await createAgentsHttpRuntime({
    routeModules: Object.fromEntries(sources.map((source) => [source.file, source.load])),
    routeSources: await loadRouteSources(sources),
    serveClient: false,
    metrics: {
      enabled: isMetricsEnabled,
      path: metricsPath,
      render: renderMetrics,
    },
  })

  return {
    ...runtime,
    async handleHttpRequest(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/health') return healthHandler()
      if (pathname === '/ready') return readyHandler()
      return runtime.handleRequest(request)
    },
  }
}

const startControllerIfEnabled = () => {
  void startAgentsControllerRuntime().catch((error) => {
    console.error('[agents] controller runtime failed to start', error)
  })
}

const installShutdownHandlers = () => {
  const shutdown = () => {
    stopAgentsControllerRuntime()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

type AgentsRuntimeServerKind = 'control-plane' | 'controllers'

const startAgentsRuntimeServer = async (kind: AgentsRuntimeServerKind) => {
  const { port, hostname, idleTimeoutSeconds } = resolveAgentsHttpServerListenConfig()
  const runtime = await createAgentsControlPlaneRuntime()
  startControllerIfEnabled()
  installShutdownHandlers()

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: idleTimeoutSeconds,
    websocket: runtime.websocket,
    async fetch(request, bunServer) {
      const upgrade = await runtime.handleUpgrade(request, bunServer)
      if (upgrade.kind === 'handled') {
        return
      }
      if (upgrade.kind === 'response') {
        return upgrade.response
      }

      return runtime.handleHttpRequest(request)
    },
  })

  console.log(`[${resolveRuntimeServiceName()}] ${kind} listening on http://${server.hostname}:${server.port}`)
  return server
}

export const startAgentsControlPlane = async () => startAgentsRuntimeServer('control-plane')

export const startAgentsControllerServer = async () => startAgentsRuntimeServer('controllers')
