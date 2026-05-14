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

export const listAgentRuns = async (limit = 50): Promise<LiveAgentRun[]> => {
  const client = kubernetesClient()
  if (!client) return []

  const list = await requestJson<KubernetesList<KubernetesAgentRun>>(
    client,
    `${agentApiPrefix}/namespaces/${defaultNamespace}/agentruns`,
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
          const pod = await firstPodForJob(client, run.namespace, run.jobName).catch(() => null)
          return { ...run, podName: pod?.metadata?.name ?? null }
        }
        return run
      }),
  )
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

type KubernetesClient = {
  host: string
  port: string
  token: string
  ca: Buffer
}

const kubernetesClient = (): KubernetesClient | null => {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443'
  if (!host) return null
  return {
    host,
    port,
    token: readFileSync(`${serviceAccountPath}/token`, 'utf8'),
    ca: readFileSync(`${serviceAccountPath}/ca.crt`),
  }
}

const requestJson = <T>(client: KubernetesClient, path: string, init?: { method?: string; body?: string }) =>
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

const requestText = (client: KubernetesClient, path: string) =>
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
