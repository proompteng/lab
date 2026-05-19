import { readFile } from 'node:fs/promises'

import { installAgentsEnvCompatibility } from './env-compat'
import { resolveBooleanFeatureToggle } from './feature-flags'
import { createAgentsHealthHandler } from './health'
import { createAgentsHttpRuntime, type AgentsHttpRuntime } from './http-runtime'
import { createKubernetesClient } from './kube-types'
import { recordAgentQueueDepth } from './metrics'
import { createPrimitivesStore } from './primitives-store'
import { validatePolicies } from './primitives-policy'
import { createAgentsReadyHandler, type AgentRunIngestionAssessment, type AgentsControllerHealthState } from './ready'
import { resolveRuntimeServiceName } from './runtime-identity'
import { resolveAuditContextFromRequest, resolveRepositoryFromParameters } from './audit-logging'
import {
  configureAgentsControllerRuntime,
  getAgentsControllerHealth,
  startAgentsController,
  stopAgentsController,
} from './agents-controller'
import { createControllerStartupRetry } from './controller-startup-retry'
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
    file: 'src/routes/v1/agent-runs.ts',
    sourceUrl: new URL('../routes/v1/agent-runs.ts', import.meta.url),
    load: () => import('../routes/v1/agent-runs'),
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

const disabledControllerHealth = (): AgentsControllerHealthState => ({
  enabled: false,
  started: false,
  namespaces: null,
  crdsReady: null,
  missingCrds: [],
  lastCheckedAt: null,
})

const getLeaderElectionStatus = () => ({
  required: false,
  isLeader: true,
  lastAttemptAt: new Date().toISOString(),
  lastError: null,
})

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
  const raw = process.env.AGENTS_PROMETHEUS_METRICS_ENABLED ?? process.env.JANGAR_PROMETHEUS_METRICS_ENABLED
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

const metricsPath = () =>
  process.env.AGENTS_PROMETHEUS_METRICS_PATH ?? process.env.JANGAR_PROMETHEUS_METRICS_PATH ?? defaultMetricsPath

const renderMetrics = async () => ({
  ok: true as const,
  body: '# Agents metrics endpoint is active; metric emission is provided by the configured runtime sink.\n',
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
    agentRuns: {
      storeFactory: createPrimitivesStore,
      kubeClientFactory: createKubernetesClient,
      recordAgentQueueDepth,
      resolveAuditContextFromRequest,
      resolveRepositoryFromParameters: (params) => resolveRepositoryFromParameters(params) ?? undefined,
      validatePolicies,
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
  installAgentsEnvCompatibility()
  configureRuntimeDependencies()

  const healthHandler = createAgentsHealthHandler({
    getAgentsControllerHealth,
    resolveServiceName: () => 'agents',
  })
  const readyHandler = createAgentsReadyHandler({
    getLeaderElectionStatus,
    getAgentsControllerHealth,
    getOrchestrationControllerHealth: disabledControllerHealth,
    getSupportingControllerHealth: disabledControllerHealth,
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

const agentsControllerStartup = createControllerStartupRetry({
  name: 'agents-controller',
  start: startAgentsController,
  isStarted: () => getAgentsControllerHealth().started,
  isEnabled: () => getAgentsControllerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const startControllerIfEnabled = () => {
  agentsControllerStartup.start()
}

const installShutdownHandlers = () => {
  const shutdown = () => {
    agentsControllerStartup.cancel()
    stopAgentsController()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

export const startAgentsControlPlane = async () => {
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

  console.log(`[${resolveRuntimeServiceName()}] control-plane listening on http://${server.hostname}:${server.port}`)
  return server
}
