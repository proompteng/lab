import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'

import type { AgentRunEvaluationInput, ConnectorKind } from './gateway'

type KubernetesAgentRun = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  spec?: {
    agentRef?: {
      name?: string
    }
    runtime?: {
      type?: string
    }
    secrets?: unknown[]
    parameters?: Record<string, unknown>
  }
  status?: {
    phase?: string
    conditions?: Array<{
      type?: string
      status?: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
    jobName?: string
    observedGeneration?: number
  }
}

type KubernetesAgent = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: {
    description?: string
    model?: string
    runtime?: {
      type?: string
    }
    tools?: unknown[]
  }
  status?: {
    phase?: string
    conditions?: Array<{
      type?: string
      status?: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
  }
}

type KubernetesImplementationSpec = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: {
    summary?: string
    text?: string
    contract?: {
      requiredKeys?: string[]
    }
  }
  status?: {
    conditions?: Array<{
      type?: string
      status?: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
    syncedAt?: string
    updatedAt?: string
  }
}

type KubernetesSwarm = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: {
    mode?: string
    domains?: string[]
    objectives?: string[]
    cadence?: Record<string, string>
    mission?: {
      businessMetric?: string
      ledgerRef?: string
      valueGates?: string[]
    }
  }
  status?: {
    phase?: string
    activeMissions?: number
    autonomousSuccessRate24h?: number
    discoveries24h?: number
    missions24h?: number
    queuedNeeds?: number
    conditions?: Array<{
      type?: string
      status?: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
    stageStates?: Record<string, unknown>
  }
}

type KubernetesJob = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  status?: {
    active?: number
    failed?: number
    succeeded?: number
    startTime?: string
    completionTime?: string
  }
}

type KubernetesPod = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  status?: {
    phase?: string
    containerStatuses?: Array<{
      ready?: boolean
      restartCount?: number
      state?: Record<string, unknown>
    }>
  }
}

type KubernetesList<T> = {
  items?: T[]
}

export type LiveAgent = {
  name: string
  namespace: string
  createdAt: string
  model: string
  runtime: string
  ready: boolean
  phase: string
}

export type LiveAgentRun = {
  name: string
  namespace: string
  agent: string
  phase: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  jobName: string | null
  podName: string | null
  message: string | null
}

export type LiveImplementationSpec = {
  name: string
  namespace: string
  createdAt: string
  summary: string
  text: string
  requiredKeys: string[]
  phase: string
  updatedAt: string | null
}

export type LiveSwarm = {
  name: string
  namespace: string
  createdAt: string
  phase: string
  mode: string
  ready: boolean
  domains: string[]
  objectives: string[]
  activeMissions: number
  missions24h: number
  discoveries24h: number
  queuedNeeds: number
  successRate24h: number | null
  updatedAt: string | null
  cadence: Record<string, string>
  mission: {
    businessMetric: string | null
    ledgerRef: string | null
    valueGates: string[]
  }
  stageStates: Record<string, unknown>
}

export type CreateLiveAgentRunInput = {
  name?: string
  namespace?: string
  agent?: string
  task: string
  repository?: string
  base?: string
  head?: string
  issueNumber?: string
  issueTitle?: string
  issueUrl?: string
}

export type AgentRunLogResult = {
  logs: string
  jobName: string | null
  podName: string | null
  phase: string
}

const serviceAccountPath = '/var/run/secrets/kubernetes.io/serviceaccount'
const agentApiPrefix = '/apis/agents.proompteng.ai/v1alpha1'
const swarmApiPrefix = '/apis/swarm.proompteng.ai/v1alpha1'
const defaultNamespace = process.env.SAG_AGENTRUN_NAMESPACE ?? 'agents'
const defaultAgent = process.env.SAG_AGENTRUN_AGENT ?? 'codex-agent'
const defaultRepository = process.env.SAG_AGENTRUN_REPOSITORY ?? 'proompteng/lab'
const defaultBase = process.env.SAG_AGENTRUN_BASE ?? 'main'
const defaultIssueNumber = normalizeIssueNumber(process.env.SAG_AGENTRUN_ISSUE_NUMBER) || '0'
const defaultIssueTitle = process.env.SAG_AGENTRUN_ISSUE_TITLE ?? 'SAG AgentRun'
const defaultIssueUrl = process.env.SAG_AGENTRUN_ISSUE_URL ?? 'https://sag.proompteng.ai'

export const listLiveAgentRuns = async (limit = 25): Promise<AgentRunEvaluationInput[]> => {
  const client = kubernetesClient()
  if (!client) return []

  const list = await requestJson<KubernetesList<KubernetesAgentRun>>(
    client,
    `${agentApiPrefix}/namespaces/${defaultNamespace}/agentruns`,
  ).catch((error) => {
    console.error('sag.kubernetes.list_agentruns_failed', error)
    return { items: [] }
  })

  return (list.items ?? [])
    .sort(
      (left, right) =>
        Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
        Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
    )
    .slice(0, limit)
    .map(toEvaluationInput)
}

export const listAgents = async (limit = 50): Promise<LiveAgent[]> => {
  const client = kubernetesClient()
  if (!client) return []

  const list = await requestJson<KubernetesList<KubernetesAgent>>(
    client,
    `${agentApiPrefix}/namespaces/${defaultNamespace}/agents`,
  ).catch((error) => {
    console.error('sag.kubernetes.list_agents_failed', error)
    return { items: [] }
  })

  return (list.items ?? [])
    .sort(
      (left, right) =>
        Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
        Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
    )
    .slice(0, limit)
    .map(toLiveAgent)
}

export const listAgentRuns = async ({
  limit = 50,
  namespace = defaultNamespace,
}: {
  limit?: number
  namespace?: string
} = {}): Promise<LiveAgentRun[]> => {
  const client = kubernetesClient()
  if (!client) return []
  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace

  const list = await requestJson<KubernetesList<KubernetesAgentRun>>(
    client,
    `${agentApiPrefix}/namespaces/${safeNamespace}/agentruns`,
  ).catch((error) => {
    console.error('sag.kubernetes.list_live_agentruns_failed', error)
    return { items: [] }
  })

  return Promise.all(
    (list.items ?? [])
      .sort(
        (left, right) =>
          Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
          Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
      )
      .slice(0, limit)
      .map(async (item) => {
        const run = toLiveAgentRun(item)
        if (run.jobName) {
          const pod = await firstPodForJob(client, safeNamespace, run.jobName).catch(() => null)
          return { ...run, podName: pod?.metadata?.name ?? null }
        }
        return run
      }),
  )
}

export const listImplementationSpecs = async ({
  limit = 100,
  namespace = defaultNamespace,
}: {
  limit?: number
  namespace?: string
} = {}): Promise<LiveImplementationSpec[]> => {
  const client = kubernetesClient()
  if (!client) return []
  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace

  const list = await requestJson<KubernetesList<KubernetesImplementationSpec>>(
    client,
    `${agentApiPrefix}/namespaces/${safeNamespace}/implementationspecs`,
  ).catch((error) => {
    console.error('sag.kubernetes.list_implementation_specs_failed', error)
    return { items: [] }
  })

  return (list.items ?? [])
    .sort(
      (left, right) =>
        Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
        Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
    )
    .slice(0, limit)
    .map(toLiveImplementationSpec)
}

export const getImplementationSpec = async ({
  namespace = defaultNamespace,
  name,
}: {
  namespace?: string
  name: string
}): Promise<LiveImplementationSpec | null> => {
  const client = kubernetesClient()
  if (!client) return null
  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace
  const safeName = sanitizeDnsName(name)
  if (!safeName) return null

  const item = await requestJson<KubernetesImplementationSpec>(
    client,
    `${agentApiPrefix}/namespaces/${safeNamespace}/implementationspecs/${safeName}`,
  ).catch((error) => {
    console.error('sag.kubernetes.get_implementation_spec_failed', error)
    return null
  })

  return item ? toLiveImplementationSpec(item) : null
}

export const listSwarms = async ({
  limit = 100,
  namespace = defaultNamespace,
}: {
  limit?: number
  namespace?: string
} = {}): Promise<LiveSwarm[]> => {
  const client = kubernetesClient()
  if (!client) return []
  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace

  const list = await requestJson<KubernetesList<KubernetesSwarm>>(
    client,
    `${swarmApiPrefix}/namespaces/${safeNamespace}/swarms`,
  ).catch((error) => {
    console.error('sag.kubernetes.list_swarms_failed', error)
    return { items: [] }
  })

  return (list.items ?? [])
    .sort((left, right) => (left.metadata?.name ?? '').localeCompare(right.metadata?.name ?? ''))
    .slice(0, limit)
    .map(toLiveSwarm)
}

export const getSwarm = async ({
  namespace = defaultNamespace,
  name,
}: {
  namespace?: string
  name: string
}): Promise<LiveSwarm | null> => {
  const client = kubernetesClient()
  if (!client) return null
  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace
  const safeName = sanitizeDnsName(name)
  if (!safeName) return null

  const item = await requestJson<KubernetesSwarm>(
    client,
    `${swarmApiPrefix}/namespaces/${safeNamespace}/swarms/${safeName}`,
  ).catch((error) => {
    console.error('sag.kubernetes.get_swarm_failed', error)
    return null
  })

  return item ? toLiveSwarm(item) : null
}

export const createLiveAgentRun = async (input: CreateLiveAgentRunInput): Promise<LiveAgentRun> => {
  const client = kubernetesClient()
  if (!client) throw new Error('Kubernetes service account is not available')

  const namespace = sanitizeDnsName(input.namespace ?? defaultNamespace) || defaultNamespace
  const agent = sanitizeDnsName(input.agent ?? defaultAgent) || defaultAgent
  const name = sanitizeDnsName(input.name ?? `sag-${Date.now().toString(36)}`).slice(0, 52)
  const task = input.task.trim()
  if (!task) throw new Error('Task is required')

  const issueNumber = normalizeIssueNumber(input.issueNumber) || defaultIssueNumber
  const issueTitle = input.issueTitle?.trim() || defaultIssueTitle
  const issueUrl = input.issueUrl?.trim() || defaultIssueUrl

  const manifest = buildAgentRunManifest({
    name,
    namespace,
    agent,
    task,
    repository: input.repository?.trim() || defaultRepository,
    base: input.base?.trim() || defaultBase,
    head: input.head?.trim() || `codex/sag-${Date.now().toString(36)}`,
    issueNumber,
    issueTitle,
    issueUrl,
  })

  const created = await requestJson<KubernetesAgentRun>(client, `${agentApiPrefix}/namespaces/${namespace}/agentruns`, {
    method: 'POST',
    body: JSON.stringify(manifest),
  })

  return toLiveAgentRun(created)
}

export const readAgentRunLogs = async (
  namespace: string,
  name: string,
  tailLines = 300,
): Promise<AgentRunLogResult> => {
  const client = kubernetesClient()
  if (!client)
    return { logs: 'Kubernetes service account is not available.', jobName: null, podName: null, phase: 'Unavailable' }

  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace
  const safeName = sanitizeDnsName(name)
  if (!safeName) return { logs: 'AgentRun name is required.', jobName: null, podName: null, phase: 'Invalid' }

  const run = await requestJson<KubernetesAgentRun>(
    client,
    `${agentApiPrefix}/namespaces/${safeNamespace}/agentruns/${safeName}`,
  ).catch(() => null)
  const phase = run ? agentRunPhase(run) : 'Missing'
  const jobName = run ? await resolveJobName(client, safeNamespace, run) : null
  if (!jobName) return { logs: 'Waiting for runtime job.', jobName: null, podName: null, phase }

  const pod = await firstPodForJob(client, safeNamespace, jobName).catch(() => null)
  const podName = pod?.metadata?.name ?? null
  if (!podName) return { logs: 'Waiting for pod.', jobName, podName: null, phase }

  const logs = await requestText(
    client,
    `/api/v1/namespaces/${safeNamespace}/pods/${podName}/log?tailLines=${Math.max(20, Math.min(1000, tailLines))}&timestamps=true`,
  ).catch(() => 'Logs unavailable.')

  return { logs: logs || 'No log lines yet.', jobName, podName, phase }
}

export const streamAgentRunLogs = async (namespace: string, name: string, tailLines = 300): Promise<Response> => {
  const client = kubernetesClient()
  if (!client) return textStreamResponse('Kubernetes service account is not available.')

  const safeNamespace = sanitizeDnsName(namespace) || defaultNamespace
  const safeName = sanitizeDnsName(name)
  if (!safeName) return textStreamResponse('AgentRun name is required.')

  const run = await requestJson<KubernetesAgentRun>(
    client,
    `${agentApiPrefix}/namespaces/${safeNamespace}/agentruns/${safeName}`,
  ).catch(() => null)
  if (!run) return textStreamResponse('AgentRun not found.')

  const jobName = await resolveJobName(client, safeNamespace, run)
  if (!jobName) return textStreamResponse('Waiting for runtime job.')

  const pod = await firstPodForJob(client, safeNamespace, jobName).catch(() => null)
  const podName = pod?.metadata?.name ?? null
  if (!podName) return textStreamResponse('Waiting for pod.')

  return requestTextStream(
    client,
    `/api/v1/namespaces/${safeNamespace}/pods/${podName}/log?tailLines=${Math.max(20, Math.min(1000, tailLines))}&timestamps=true&follow=true`,
  )
}

const toEvaluationInput = (item: KubernetesAgentRun): AgentRunEvaluationInput => {
  const name = item.metadata?.name ?? 'agentrun'
  const namespace = item.metadata?.namespace ?? 'agents'
  const agent = item.spec?.agentRef?.name ?? 'agent'
  const requestedSecrets = (item.spec?.secrets ?? []).map(secretName).filter(Boolean)
  const requestedConnectors: ConnectorKind[] = ['kubernetes']
  const requestedTools = [
    item.spec?.runtime?.type ? `runtime:${item.spec.runtime.type}` : 'runtime:unknown',
    item.status?.phase ? `phase:${item.status.phase}` : 'phase:unknown',
  ]
  const parameters = item.spec?.parameters ?? {}
  const parameterKeys = Object.keys(parameters)
  if (parameterKeys.length > 0) requestedConnectors.push('policy')

  return {
    actorId: 'greg',
    name,
    namespace,
    agent,
    requestedSecrets,
    requestedConnectors,
    requestedTools,
    manifest: JSON.stringify(
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'AgentRun',
        metadata: { name, namespace },
        spec: {
          agentRef: { name: agent },
          runtime: { type: item.spec?.runtime?.type ?? 'unknown' },
          secrets: requestedSecrets,
          parameters: Object.fromEntries(parameterKeys.slice(0, 12).map((key) => [key, '<redacted>'])),
        },
        status: { phase: item.status?.phase ?? 'unknown' },
      },
      null,
      2,
    ),
  }
}

const toLiveAgent = (item: KubernetesAgent): LiveAgent => {
  const conditions = item.status?.conditions ?? []
  const readyCondition = conditions.find((condition) => condition.type?.toLowerCase() === 'ready')
  return {
    name: item.metadata?.name ?? 'agent',
    namespace: item.metadata?.namespace ?? defaultNamespace,
    createdAt: item.metadata?.creationTimestamp ?? '',
    model: item.spec?.model ?? 'configured',
    runtime: item.spec?.runtime?.type ?? 'workflow',
    ready: readyCondition ? readyCondition.status === 'True' : item.status?.phase?.toLowerCase() === 'ready',
    phase: item.status?.phase ?? readyCondition?.reason ?? 'Ready',
  }
}

const toLiveAgentRun = (item: KubernetesAgentRun): LiveAgentRun => ({
  name: item.metadata?.name ?? 'agentrun',
  namespace: item.metadata?.namespace ?? defaultNamespace,
  agent: item.spec?.agentRef?.name ?? defaultAgent,
  phase: agentRunPhase(item),
  createdAt: item.metadata?.creationTimestamp ?? '',
  startedAt:
    item.status?.conditions?.find((condition) => condition.type?.toLowerCase() === 'started')?.lastTransitionTime ??
    null,
  finishedAt:
    item.status?.conditions?.find((condition) =>
      ['succeeded', 'failed', 'complete'].includes(condition.type?.toLowerCase() ?? ''),
    )?.lastTransitionTime ?? null,
  jobName: item.status?.jobName ?? item.metadata?.labels?.['agents.proompteng.ai/job-name'] ?? null,
  podName: null,
  message: latestCondition(item)?.message ?? null,
})

const toLiveImplementationSpec = (item: KubernetesImplementationSpec): LiveImplementationSpec => ({
  name: item.metadata?.name ?? 'spec',
  namespace: item.metadata?.namespace ?? defaultNamespace,
  createdAt: item.metadata?.creationTimestamp ?? '',
  summary: item.spec?.summary ?? firstLine(item.spec?.text) ?? '-',
  text: item.spec?.text ?? '',
  requiredKeys: item.spec?.contract?.requiredKeys ?? [],
  phase: implementationSpecPhase(item),
  updatedAt: item.status?.updatedAt ?? item.status?.syncedAt ?? null,
})

const toLiveSwarm = (item: KubernetesSwarm): LiveSwarm => {
  const conditions = item.status?.conditions ?? []
  const ready = conditions.find((condition) => condition.type?.toLowerCase() === 'ready')
  return {
    name: item.metadata?.name ?? 'swarm',
    namespace: item.metadata?.namespace ?? defaultNamespace,
    createdAt: item.metadata?.creationTimestamp ?? '',
    phase: item.status?.phase ?? ready?.reason ?? 'Pending',
    mode: item.spec?.mode ?? '-',
    ready: ready?.status === 'True',
    domains: item.spec?.domains ?? [],
    objectives: item.spec?.objectives ?? [],
    activeMissions: item.status?.activeMissions ?? 0,
    missions24h: item.status?.missions24h ?? 0,
    discoveries24h: item.status?.discoveries24h ?? 0,
    queuedNeeds: item.status?.queuedNeeds ?? 0,
    successRate24h: item.status?.autonomousSuccessRate24h ?? null,
    updatedAt: latestSwarmCondition(item)?.lastTransitionTime ?? null,
    cadence: item.spec?.cadence ?? {},
    mission: {
      businessMetric: item.spec?.mission?.businessMetric ?? null,
      ledgerRef: item.spec?.mission?.ledgerRef ?? null,
      valueGates: item.spec?.mission?.valueGates ?? [],
    },
    stageStates: item.status?.stageStates ?? {},
  }
}

const agentRunPhase = (item: KubernetesAgentRun) => {
  if (item.status?.phase) return titleCase(item.status.phase)
  const condition = latestCondition(item)
  if (condition?.type) return titleCase(condition.type)
  return 'Pending'
}

const latestCondition = (item: KubernetesAgentRun) =>
  [...(item.status?.conditions ?? [])].sort(
    (left, right) =>
      Date.parse(right.lastTransitionTime ?? '1970-01-01') - Date.parse(left.lastTransitionTime ?? '1970-01-01'),
  )[0]

const implementationSpecPhase = (item: KubernetesImplementationSpec) => {
  const ready = (item.status?.conditions ?? []).find((condition) => condition.type?.toLowerCase() === 'ready')
  if (ready?.status === 'True') return 'Ready'
  if (ready?.reason) return titleCase(ready.reason)
  return item.status?.conditions?.[0]?.type ?? 'Pending'
}

const firstLine = (value?: string) =>
  value
    ?.split('\n')
    .find((line) => line.trim())
    ?.trim()

const latestSwarmCondition = (item: KubernetesSwarm) =>
  [...(item.status?.conditions ?? [])].sort(
    (left, right) =>
      Date.parse(right.lastTransitionTime ?? '1970-01-01') - Date.parse(left.lastTransitionTime ?? '1970-01-01'),
  )[0]

const secretName = (value: unknown) => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name
  return ''
}

const resolveJobName = async (client: KubernetesClient, namespace: string, run: KubernetesAgentRun) => {
  const direct = run.status?.jobName ?? run.metadata?.labels?.['agents.proompteng.ai/job-name']
  if (direct) return direct
  const jobs = await listJobsForAgentRun(client, namespace, run.metadata?.name ?? '')
  return jobs[0]?.metadata?.name ?? null
}

const listJobsForAgentRun = async (client: KubernetesClient, namespace: string, name: string) => {
  if (!name) return []
  const selector = encodeURIComponent(`agents.proompteng.ai/agent-run=${name}`)
  const list = await requestJson<KubernetesList<KubernetesJob>>(
    client,
    `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${selector}`,
  )
  return (list.items ?? []).sort(
    (left, right) =>
      Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
      Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
  )
}

const firstPodForJob = async (client: KubernetesClient, namespace: string, jobName: string) => {
  const selector = encodeURIComponent(`job-name=${jobName}`)
  const list = await requestJson<KubernetesList<KubernetesPod>>(
    client,
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`,
  )
  return (list.items ?? []).sort(
    (left, right) =>
      Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
      Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
  )[0]
}

export const buildAgentRunManifest = ({
  name,
  namespace,
  agent,
  task,
  repository,
  base,
  head,
  issueNumber,
  issueTitle,
  issueUrl,
}: {
  name: string
  namespace: string
  agent: string
  task: string
  repository: string
  base: string
  head: string
  issueNumber: string
  issueTitle: string
  issueUrl: string
}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name,
    namespace,
    labels: {
      'app.kubernetes.io/part-of': 'sag',
      'sag.proompteng.ai/source': 'ui',
    },
  },
  spec: {
    agentRef: { name: agent },
    vcsRef: { name: 'github' },
    vcsPolicy: {
      required: true,
      mode: 'read-write',
    },
    secrets: ['github-token', 'codex-auth'],
    implementation: {
      inline: {
        text: task,
      },
    },
    ttlSecondsAfterFinished: 7200,
    parameters: {
      repository,
      base,
      head,
      issueNumber,
      stage: 'implementation',
      issueTitle,
      issueUrl,
    },
    runtime: {
      type: 'workflow',
    },
    workflow: {
      steps: [
        {
          name: 'run',
          parameters: {
            repository,
            base,
            head,
            issueNumber,
            stage: 'implementation',
            issueTitle,
            issueUrl,
          },
          timeoutSeconds: 7200,
        },
      ],
    },
    workload: {
      resources: {
        requests: {
          cpu: '500m',
          memory: '1024Mi',
        },
        limits: {
          cpu: '2',
          memory: '4Gi',
        },
      },
    },
  },
})

type KubernetesClient =
  | {
      mode: 'in-cluster'
      host: string
      port: string
      token: string
      ca: Buffer
    }
  | {
      mode: 'kubectl'
    }

type InClusterKubernetesClient = Extract<KubernetesClient, { mode: 'in-cluster' }>

type KubectlResult = {
  stdout: string
  stderr: string
}

const kubernetesClient = (): KubernetesClient | null => {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443'
  if (!host) return { mode: 'kubectl' }
  try {
    return {
      mode: 'in-cluster',
      host,
      port,
      token: readFileSync(`${serviceAccountPath}/token`, 'utf8'),
      ca: readFileSync(`${serviceAccountPath}/ca.crt`),
    }
  } catch {
    return { mode: 'kubectl' }
  }
}

const requestJson = async <T>(
  client: KubernetesClient,
  path: string,
  init?: { method?: string; body?: string },
): Promise<T> => {
  if (client.mode === 'kubectl') {
    const method = init?.method ?? 'GET'
    const result =
      method === 'POST'
        ? await kubectl(['create', '-f', '-', '-o', 'json'], init?.body)
        : await kubectl(['get', '--raw', path])
    return result.stdout ? (JSON.parse(result.stdout) as T) : ({} as T)
  }
  return requestInClusterJson<T>(client, path, init)
}

const requestInClusterJson = <T>(
  client: InClusterKubernetesClient,
  path: string,
  init?: { method?: string; body?: string },
) =>
  new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: client.host,
        port: client.port,
        path,
        method: init?.method ?? 'GET',
        ca: client.ca,
        headers: {
          authorization: `Bearer ${client.token}`,
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(init.body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Kubernetes API ${res.statusCode}: ${body.slice(0, 300)}`))
            return
          }
          resolve(body ? (JSON.parse(body) as T) : ({} as T))
        })
      },
    )
    req.on('error', reject)
    if (init?.body) req.write(init.body)
    req.end()
  })

const requestText = async (client: KubernetesClient, path: string): Promise<string> => {
  if (client.mode === 'kubectl') {
    return (await kubectl(['get', '--raw', path])).stdout
  }
  return requestInClusterText(client, path)
}

const requestInClusterText = (client: InClusterKubernetesClient, path: string) =>
  new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: client.host,
        port: client.port,
        path,
        method: 'GET',
        ca: client.ca,
        headers: {
          authorization: `Bearer ${client.token}`,
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Kubernetes API ${res.statusCode}: ${body.slice(0, 300)}`))
            return
          }
          resolve(body)
        })
      },
    )
    req.on('error', reject)
    req.end()
  })

const requestTextStream = (client: KubernetesClient, path: string): Response => {
  if (client.mode === 'kubectl') {
    return kubectlTextStream(path)
  }

  let req: ReturnType<typeof httpsRequest> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req = httpsRequest(
        {
          host: client.host,
          port: client.port,
          path,
          method: 'GET',
          ca: client.ca,
          headers: {
            authorization: `Bearer ${client.token}`,
            accept: 'text/plain',
          },
        },
        (res) => {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          res.on('end', () => controller.close())
          res.on('error', (error) => controller.error(error))
        },
      )
      req.on('error', (error) => controller.error(error))
      req.end()
    },
    cancel() {
      req?.destroy()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

const kubectl = (args: string[], input?: string): Promise<KubectlResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code === 0) {
        resolve(result)
        return
      }
      reject(new Error(`kubectl ${args.join(' ')} failed: ${result.stderr || result.stdout}`))
    })
    if (input) child.stdin.write(input)
    child.stdin.end()
  })

const kubectlTextStream = (path: string): Response => {
  let child: ReturnType<typeof spawn> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      child = spawn('kubectl', ['get', '--raw', path], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      child.on('error', (error) => controller.error(error))
      child.on('close', () => controller.close())
    },
    cancel() {
      child?.kill()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

const textStreamResponse = (text: string) =>
  new Response(`${text}\n`, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const sanitizeDnsName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')

function normalizeIssueNumber(value: string | undefined) {
  const normalized = value?.trim().replace(/^#/, '') ?? ''
  return /^[0-9]+$/.test(normalized) ? normalized : ''
}

const titleCase = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase()
