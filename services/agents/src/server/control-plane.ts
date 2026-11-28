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
import type { AgentsServerRouteLoader } from './server-route'

const defaultMetricsPath = '/metrics'

type ControlPlaneRuntimeOptions = {
  routeModules?: AgentsServerRouteLoader[]
  enableWebSocket?: boolean
}

const routeModules: AgentsServerRouteLoader[] = [
  () => import('../routes/mcp/relay/$target'),
  () => import('../routes/mcp'),
  () => import('../routes/v1/agents'),
  () => import('../routes/v1/agents/$id'),
  () => import('../routes/v1/agent-runs'),
  () => import('../routes/v1/agent-runs/resources'),
  () => import('../routes/v1/agent-runs/projection-authority'),
  () => import('../routes/v1/agent-runs/terminal-events'),
  () => import('../routes/v1/agent-runs/terminal-events-ack'),
  () => import('../routes/v1/agent-messages'),
  () => import('../routes/v1/agent-events'),
  () => import('../routes/v1/codex/runs'),
  () => import('../routes/v1/codex/runs/list'),
  () => import('../routes/v1/codex/runs/by-id'),
  () => import('../routes/v1/codex/runs/by-pr'),
  () => import('../routes/v1/codex/runs/recent'),
  () => import('../routes/v1/codex/issues'),
  () => import('../routes/v1/codex/github-events'),
  () => import('../routes/v1/implementation-sources/webhooks/$provider'),
  () => import('../routes/v1/approval-policies/resources'),
  () => import('../routes/v1/budgets/resources'),
  () => import('../routes/v1/memories'),
  () => import('../routes/v1/memories/resources'),
  () => import('../routes/v1/memories/$id'),
  () => import('../routes/v1/memory-queries'),
  () => import('../routes/v1/memory-operations'),
  () => import('../routes/v1/context'),
  () => import('../routes/v1/memory-notes'),
  () => import('../routes/v1/memory-notes/retire'),
  () => import('../routes/v1/memory-notes/$id'),
  () => import('../routes/v1/memory-notes/count'),
  () => import('../routes/v1/memory-notes/stats'),
  () => import('../routes/v1/orchestrations'),
  () => import('../routes/v1/orchestrations/$id'),
  () => import('../routes/v1/orchestration-runs'),
  () => import('../routes/v1/orchestration-runs/$id'),
  () => import('../routes/v1/orchestration-runs/resources'),
  () => import('../routes/v1/jobs/resources'),
  () => import('../routes/v1/control-plane/status'),
  () => import('../routes/v1/control-plane/execution-trust'),
  () => import('../routes/v1/control-plane/events'),
  () => import('../routes/v1/control-plane/logs'),
  () => import('../routes/v1/control-plane/stream'),
  () => import('../routes/v1/control-plane/summary'),
  () => import('../routes/v1/secret-bindings/resources'),
  () => import('../routes/v1/signals/resources'),
  () => import('../routes/v1/swarms/resources'),
  () => import('../routes/v1/agent-runs/$id'),
  () => import('../routes/v1/agent-runs/$id/reruns'),
  () => import('../routes/v1/runs/$id'),
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
    agentRunReruns: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      requireLeaderForMutation: requireLeaderForMutationHttp,
      resolveRepositoryFromParameters,
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
      requireLeaderForMutation: requireLeaderForMutationHttp,
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

  const runtime = await createAgentsHttpRuntime({
    routeModules: options.routeModules ?? routeModules,
    enableWebSocket: options.enableWebSocket,
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

export const startAgentsControllerServer = async () => {
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

  console.log(`[${resolveRuntimeServiceName()}] controllers listening on http://${server.hostname}:${server.port}`)
  return server
}
