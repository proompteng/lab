import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createTemporalClient, loadTemporalConfig, temporalCallOptions } from '@proompteng/temporal-bun-sdk'
import { createGitHubClient, GitHubRateLimitError } from '~/server/github-client'
import { createLinearClient } from '~/server/linear-client'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_INTERVAL_SECONDS = 15
const DEFAULT_CONCURRENCY = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
}
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const IMPLEMENTATION_SUMMARY_LIMIT = 256
const PARAMETERS_MAX_ENTRIES = 100
const PARAMETERS_MAX_VALUE_BYTES = 2048

const REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]

type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

let crdCheckState: CrdCheckState | null = null

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type RuntimeRef = Record<string, unknown>

type BackoffState = {
  failures: number
  nextAttemptAt: number
}

const backoffBySource = new Map<string, BackoffState>()

let started = false
let intervalRef: NodeJS.Timeout | null = null
let reconciling = false
let temporalClientPromise: ReturnType<typeof createTemporalClient> | null = null

const nowIso = () => new Date().toISOString()

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_AGENTS_CONTROLLER_ENABLED ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return list.length > 0 ? list : DEFAULT_NAMESPACES
}

const parseIntervalSeconds = () => {
  const raw = process.env.JANGAR_AGENTS_CONTROLLER_INTERVAL_SECONDS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_INTERVAL_SECONDS
}

const parseConcurrency = () => ({
  perNamespace:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE ?? '', 10) ||
    DEFAULT_CONCURRENCY.perNamespace,
  perAgent:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT ?? '', 10) || DEFAULT_CONCURRENCY.perAgent,
  cluster:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER ?? '', 10) || DEFAULT_CONCURRENCY.cluster,
})

const runKubectl = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })

const checkCrds = async (): Promise<CrdCheckState> => {
  const missing: string[] = []
  for (const name of REQUIRED_CRDS) {
    const result = await runKubectl(['get', 'crd', name, '-o', 'json'])
    if (result.code !== 0) {
      missing.push(name)
    }
  }
  const state = { ok: missing.length === 0, missing, checkedAt: nowIso() }
  crdCheckState = state
  if (!state.ok) {
    console.error('[jangar] missing required Agents CRDs:', missing.join(', '))
    console.error(
      '[jangar] install the Agents Helm chart (charts/agents) or apply charts/agents/crds/*.yaml before starting the controller',
    )
  }
  return state
}

export const getAgentsControllerHealth = () => ({
  enabled: shouldStart(),
  started,
  crdsReady: crdCheckState?.ok ?? null,
  missingCrds: crdCheckState?.missing ?? [],
  lastCheckedAt: crdCheckState?.checkedAt ?? null,
})

const normalizeConditions = (raw: unknown): Condition[] => {
  if (!Array.isArray(raw)) return []
  const output: Condition[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const type = asString(record.type)
    const status = asString(record.status)
    if (!type || !status) continue
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason: asString(record.reason) ?? undefined,
      message: asString(record.message) ?? undefined,
      lastTransitionTime: asString(record.lastTransitionTime) ?? nowIso(),
    })
  }
  return output
}

const upsertCondition = (conditions: Condition[], update: Omit<Condition, 'lastTransitionTime'>): Condition[] => {
  const next = [...conditions]
  const index = next.findIndex((cond) => cond.type === update.type)
  if (index === -1) {
    next.push({ ...update, lastTransitionTime: nowIso() })
    return next
  }
  const existing = next[index]
  if (existing.status !== update.status || existing.reason !== update.reason || existing.message !== update.message) {
    next[index] = { ...existing, ...update, lastTransitionTime: nowIso() }
  }
  return next
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) return
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status })
}

const decodeSecretData = (secret: Record<string, unknown>) => {
  const data = asRecord(secret.data) ?? {}
  const decoded: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    const raw = asString(value)
    if (!raw) continue
    try {
      decoded[key] = Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      decoded[key] = raw
    }
  }
  return decoded
}

const getSecretData = async (kube: ReturnType<typeof createKubernetesClient>, namespace: string, name: string) => {
  const secret = await kube.get('secret', name, namespace)
  if (!secret) return null
  return decodeSecretData(secret)
}

const parseRuntimeRef = (raw: unknown): RuntimeRef | null => asRecord(raw) ?? null

const resolveJobImage = (workload: Record<string, unknown>) =>
  asString(workload.image) ?? process.env.JANGAR_AGENT_RUNNER_IMAGE ?? process.env.JANGAR_AGENT_IMAGE ?? null

const renderTemplate = (template: string, context: Record<string, unknown>) =>
  template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path) => {
    const value = resolvePath(context, String(path))
    if (value == null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

const resolvePath = (value: Record<string, unknown>, path: string) => {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let cursor: unknown = value
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor ?? null
}

const getTemporalClient = async () => {
  if (!temporalClientPromise) {
    temporalClientPromise = (async () => {
      const config = await loadTemporalConfig({
        defaults: {
          host: DEFAULT_TEMPORAL_HOST,
          port: DEFAULT_TEMPORAL_PORT,
          address: DEFAULT_TEMPORAL_ADDRESS,
        },
      })
      return createTemporalClient({ config })
    })()
  }
  const { client } = await temporalClientPromise
  return client
}

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const isTemporalPollPending = (error: unknown) => {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    const message = error.message.toLowerCase()
    if (message.includes('deadline') || message.includes('timeout')) return true
  }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number' && code === 4) return true
  if (typeof code === 'string' && code.toLowerCase().includes('deadline')) return true
  return false
}

const classifyTemporalResult = (error: unknown) => {
  if (isTemporalPollPending(error)) {
    return { kind: 'pending' as const }
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('workflow canceled')) {
    return { kind: 'cancelled' as const, reason: 'Cancelled', message }
  }
  if (lower.includes('workflow terminated')) {
    return { kind: 'failed' as const, reason: 'Terminated', message }
  }
  if (lower.includes('workflow timed out')) {
    return { kind: 'failed' as const, reason: 'TimedOut', message }
  }
  if (lower.includes('workflow failed')) {
    return { kind: 'failed' as const, reason: 'Failed', message }
  }
  if (lower.includes('connect') || lower.includes('unavailable') || lower.includes('handshake')) {
    return { kind: 'pending' as const }
  }
  return { kind: 'failed' as const, reason: 'TemporalError', message }
}

const makeName = (base: string, suffix: string) => {
  const normalized = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const combined = `${normalized}-${suffix}`.replace(/^-+|-+$/g, '')
  if (combined.length <= 63) return combined
  const hash = createHash('sha1').update(combined).digest('hex').slice(0, 8)
  const trimmed = combined.slice(0, 63 - hash.length - 1)
  return `${trimmed}-${hash}`
}

const normalizeLabelValue = (value: string) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  const trimmed = normalized.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')
  if (!trimmed) return 'unknown'
  return trimmed.length <= 63 ? trimmed : trimmed.slice(0, 63)
}

const clampUtf8 = (value: string, maxBytes: number) => {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  return buffer.subarray(0, maxBytes).toString('utf8')
}

const normalizeSummary = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, IMPLEMENTATION_SUMMARY_LIMIT)
}

const normalizeText = (value: string | null, fallback?: string | null) => {
  const trimmed = value?.trim() ?? ''
  if (!trimmed && fallback) {
    return clampUtf8(fallback.trim(), IMPLEMENTATION_TEXT_LIMIT)
  }
  return clampUtf8(trimmed, IMPLEMENTATION_TEXT_LIMIT)
}

const buildRunSpecContext = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const agentSpec = asRecord(agent?.spec) ?? {}
  return {
    agentRun: {
      name: asString(metadata.name) ?? '',
      uid: asString(metadata.uid) ?? '',
      namespace: asString(metadata.namespace) ?? '',
    },
    agent: {
      name: asString(readNested(agent, ['metadata', 'name'])) ?? '',
      config: asRecord(agentSpec.config) ?? {},
      env: Array.isArray(agentSpec.env) ? agentSpec.env : [],
    },
    implementation,
    parameters,
    memory: memory ?? {},
  }
}

const resolveImplementation = (agentRun: Record<string, unknown>) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const inline = asRecord(readNested(spec, ['implementation', 'inline']))
  if (inline) return inline
  return null
}

const resolveParameters = (agentRun: Record<string, unknown>) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const params = asRecord(spec.parameters) ?? {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue
    output[key] = value
  }
  return output
}

const parseStringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const validateParameters = (params: Record<string, unknown>) => {
  const entries = Object.entries(params)
  if (entries.length > PARAMETERS_MAX_ENTRIES) {
    return {
      ok: false,
      reason: 'ParametersTooLarge',
      message: `spec.parameters exceeds ${PARAMETERS_MAX_ENTRIES} entries`,
    }
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        reason: 'ParameterNotString',
        message: `spec.parameters.${key} must be a string`,
      }
    }
    if (Buffer.byteLength(value, 'utf8') > PARAMETERS_MAX_VALUE_BYTES) {
      return {
        ok: false,
        reason: 'ParameterValueTooLarge',
        message: `spec.parameters.${key} exceeds ${PARAMETERS_MAX_VALUE_BYTES} bytes`,
      }
    }
  }
  return { ok: true as const }
}

const listItems = (resource: Record<string, unknown>) => {
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  return items
}

const selectDefaultMemory = (memories: Record<string, unknown>[]) => {
  return memories.find((memory) => readNested(memory, ['spec', 'default']) === true) ?? null
}

const resolveMemory = (
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

const buildRuntimeRef = (
  type: string,
  name: string,
  namespace: string,
  extra?: Record<string, unknown>,
): RuntimeRef => ({
  type,
  name,
  namespace,
  ...(extra ?? {}),
})

const deleteRuntimeResource = async (kind: string, name: string, namespace: string) => {
  const result = await runKubectl(['delete', kind, name, '-n', namespace])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to delete ${kind}/${name}`)
  }
}

const cancelRuntime = async (runtimeRef: RuntimeRef, namespace: string) => {
  const type = asString(runtimeRef.type) ?? ''
  const name = asString(runtimeRef.name) ?? ''
  const runtimeNamespace = asString(runtimeRef.namespace) ?? namespace
  if (!name) return
  if (type === 'job') {
    await deleteRuntimeResource('job', name, runtimeNamespace)
    return
  }
  if (type === 'argo') {
    await deleteRuntimeResource('workflow', name, runtimeNamespace)
    return
  }
  if (type === 'temporal') {
    const client = await getTemporalClient()
    const handle = {
      workflowId: asString(runtimeRef.workflowId) ?? name,
      runId: asString(runtimeRef.runId) ?? undefined,
      namespace: asString(runtimeRef.namespace) ?? undefined,
    }
    await client.workflow.cancel(handle)
  }
}

const buildConditions = (resource: Record<string, unknown>) =>
  normalizeConditions(readNested(resource, ['status', 'conditions']))

const reconcileAgent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agent: Record<string, unknown>,
  namespace: string,
  providers: Record<string, unknown>[],
  memories: Record<string, unknown>[],
) => {
  const conditions = buildConditions(agent)
  const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
  let updated = conditions

  if (!providerName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingProviderRef',
      message: 'spec.providerRef.name is required',
    })
  } else {
    const provider = providers.find((item) => asString(readNested(item, ['metadata', 'name'])) === providerName)
    if (!provider) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: `agent provider ${providerName} not found`,
      })
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
    }
  }

  const memoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
  if (memoryRef) {
    const memory = memories.find((item) => asString(readNested(item, ['metadata', 'name'])) === memoryRef)
    if (!memory) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingMemory',
        message: `memory ${memoryRef} not found in ${namespace}`,
      })
    }
  }

  await setStatus(kube, agent, {
    observedGeneration: asRecord(agent.metadata)?.generation ?? 0,
    conditions: updated,
  })
}

const reconcileAgentProvider = async (
  kube: ReturnType<typeof createKubernetesClient>,
  provider: Record<string, unknown>,
) => {
  const spec = asRecord(provider.spec) ?? {}
  const conditions = buildConditions(provider)
  const binary = asString(spec.binary)
  let updated = conditions
  if (!binary) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingBinary',
      message: 'spec.binary is required',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }
  await setStatus(kube, provider, {
    observedGeneration: asRecord(provider.metadata)?.generation ?? 0,
    conditions: updated,
  })
}

const reconcileImplementationSpec = async (
  kube: ReturnType<typeof createKubernetesClient>,
  impl: Record<string, unknown>,
) => {
  const spec = asRecord(impl.spec) ?? {}
  const conditions = buildConditions(impl)
  const text = asString(spec.text) ?? ''
  const summary = asString(spec.summary) ?? ''
  const description = asString(spec.description) ?? ''
  const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []
  let updated = conditions
  if (!text) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingText',
      message: 'spec.text is required',
    })
  } else if (text.length > 131072) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'TextTooLarge',
      message: 'spec.text exceeds 128KB',
    })
  } else if (summary && summary.length > 256) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'SummaryTooLong',
      message: 'spec.summary exceeds 256 characters',
    })
  } else if (description && description.length > IMPLEMENTATION_TEXT_LIMIT) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'DescriptionTooLarge',
      message: 'spec.description exceeds 128KB',
    })
  } else if (acceptanceCriteria.length > 50) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'AcceptanceCriteriaTooLong',
      message: 'spec.acceptanceCriteria exceeds 50 entries',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  await setStatus(kube, impl, {
    observedGeneration: asRecord(impl.metadata)?.generation ?? 0,
    syncedAt: asString(readNested(impl, ['status', 'syncedAt'])) ?? nowIso(),
    sourceVersion: asString(readNested(impl, ['status', 'sourceVersion'])) ?? undefined,
    conditions: updated,
  })
}

const reconcileMemory = async (
  kube: ReturnType<typeof createKubernetesClient>,
  memory: Record<string, unknown>,
  namespace: string,
) => {
  const conditions = buildConditions(memory)
  const memoryType = asString(readNested(memory, ['spec', 'type']))
  const secretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
  const secretKey = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'key']))
  let updated = conditions
  if (!memoryType) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingType',
      message: 'spec.type is required',
    })
  } else if (!secretName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSecretRef',
      message: 'spec.connection.secretRef.name is required',
    })
  } else {
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret) {
      updated = upsertCondition(updated, {
        type: 'Unreachable',
        status: 'True',
        reason: 'SecretNotFound',
        message: `secret ${secretName} not found`,
      })
    } else if (secretKey) {
      const data = asRecord(secret.data) ?? {}
      const stringData = asRecord(secret.stringData) ?? {}
      if (!(secretKey in data) && !(secretKey in stringData)) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretKeyMissing',
          message: `secret ${secretName} missing key ${secretKey}`,
        })
      } else {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
      }
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
    }
  }
  await setStatus(kube, memory, {
    observedGeneration: asRecord(memory.metadata)?.generation ?? 0,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const syncImplementationSpec = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  payload: {
    name: string
    source: Record<string, unknown>
    summary: string | null
    text: string
    labels: string[]
    sourceVersion?: string | null
  },
) => {
  const resource = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'ImplementationSpec',
    metadata: {
      name: payload.name,
      namespace,
      labels: {
        'agents.proompteng.ai/source-provider': asString(payload.source.provider) ?? 'unknown',
      },
    },
    spec: {
      source: payload.source,
      summary: payload.summary ?? undefined,
      text: payload.text,
      labels: payload.labels,
    },
  }
  const applied = await kube.apply(resource)
  const conditions = buildConditions(applied)
  const updated = upsertCondition(conditions, { type: 'Ready', status: 'True', reason: 'Synced' })
  await setStatus(kube, applied, {
    observedGeneration: asRecord(applied.metadata)?.generation ?? 0,
    syncedAt: nowIso(),
    sourceVersion: payload.sourceVersion ?? undefined,
    conditions: updated,
  })
}

const syncGitHubIssues = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  source: Record<string, unknown>,
  token: string,
) => {
  const scope = (asRecord(readNested(source, ['spec', 'scope'])) ?? {}) as Record<string, unknown>
  const repo = asString(scope.repository) ?? ''
  if (!repo.includes('/')) {
    throw new Error('spec.scope.repository must be in owner/repo form')
  }
  const [owner, name] = repo.split('/')
  const labelValue = scope.labels
  const labels = Array.isArray(labelValue) ? labelValue.filter((item): item is string => typeof item === 'string') : []
  const cursor = asString(readNested(source, ['status', 'cursor'])) ?? undefined
  const client = createGitHubClient({
    token,
    apiBaseUrl: process.env.JANGAR_GITHUB_API_BASE_URL?.trim() || 'https://api.github.com',
    userAgent: 'jangar-agents-controller',
  })

  const issues = await client.listIssues({ owner, repo: name, labels, since: cursor })
  let latest = cursor ?? ''
  for (const issue of issues) {
    const externalId = `${owner}/${name}#${issue.number}`
    const shortName = makeName(`${owner}-${name}-${issue.number}`, 'impl')
    const summary = normalizeSummary(issue.title)
    const text = normalizeText(issue.body ?? '', summary)
    const sourceRef = {
      provider: 'github',
      externalId,
      url: issue.htmlUrl ?? undefined,
    }
    await syncImplementationSpec(kube, namespace, {
      name: shortName,
      source: sourceRef,
      summary,
      text,
      labels: issue.labels,
      sourceVersion: issue.updatedAt ?? undefined,
    })
    if (issue.updatedAt && issue.updatedAt > latest) {
      latest = issue.updatedAt
    }
  }
  return { cursor: latest || cursor || nowIso() }
}

const syncLinearIssues = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  source: Record<string, unknown>,
  token: string,
) => {
  const scope = asRecord(readNested(source, ['spec', 'scope'])) ?? {}
  const project = asString(scope.project) ?? undefined
  const team = asString(scope.team) ?? undefined
  const labelValue = (scope as Record<string, unknown>).labels
  const labels = Array.isArray(labelValue) ? labelValue.filter((item): item is string => typeof item === 'string') : []
  const cursor = asString(readNested(source, ['status', 'cursor'])) ?? undefined

  const client = createLinearClient({
    token,
    apiUrl: process.env.JANGAR_LINEAR_API_URL?.trim() || 'https://api.linear.app/graphql',
  })

  const issues = await client.listIssues({
    project,
    team,
    labels,
    updatedAfter: cursor ?? undefined,
  })

  let latest = cursor ?? ''
  for (const issue of issues) {
    const externalId = issue.identifier
    const shortName = makeName(`linear-${issue.identifier}`, 'impl')
    const summary = normalizeSummary(issue.title)
    const text = normalizeText(issue.description ?? '', summary)
    await syncImplementationSpec(kube, namespace, {
      name: shortName,
      source: { provider: 'linear', externalId, url: issue.url ?? undefined },
      summary,
      text,
      labels: issue.labels,
      sourceVersion: issue.updatedAt ?? undefined,
    })
    if (issue.updatedAt && issue.updatedAt > latest) {
      latest = issue.updatedAt
    }
  }
  return { cursor: latest || cursor || nowIso() }
}

const reconcileImplementationSource = async (
  kube: ReturnType<typeof createKubernetesClient>,
  source: Record<string, unknown>,
  namespace: string,
) => {
  const metadata = asRecord(source.metadata) ?? {}
  const name = asString(metadata.name) ?? ''
  const stateKey = `${namespace}/${name}`

  const backoff = backoffBySource.get(stateKey)
  if (backoff && Date.now() < backoff.nextAttemptAt) {
    return
  }

  const pollSpec = asRecord(readNested(source, ['spec', 'poll']))
  const webhookEnabled = readNested(source, ['spec', 'webhook', 'enabled']) === true
  let pollInterval: number | null = null
  if (pollSpec) {
    pollInterval = Number.parseInt(String(readNested(source, ['spec', 'poll', 'intervalSeconds']) ?? ''), 10) || 60
  } else if (!webhookEnabled) {
    pollInterval = 60
  }
  const lastSyncedAt = asString(readNested(source, ['status', 'lastSyncedAt']))
  if (pollInterval != null && lastSyncedAt) {
    const nextAllowed = new Date(lastSyncedAt).getTime() + pollInterval * 1000
    if (Date.now() < nextAllowed) return
  }

  const secretName = asString(readNested(source, ['spec', 'auth', 'secretRef', 'name']))
  const secretKey = asString(readNested(source, ['spec', 'auth', 'secretRef', 'key'])) ?? 'token'
  if (!secretName) {
    const conditions = upsertCondition(buildConditions(source), {
      type: 'Error',
      status: 'True',
      reason: 'MissingSecretRef',
      message: 'spec.auth.secretRef.name is required',
    })
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      conditions,
      lastSyncedAt: lastSyncedAt ?? undefined,
    })
    return
  }

  const secret = await getSecretData(kube, namespace, secretName)
  const token = secret?.[secretKey] ?? ''
  if (!token) {
    const conditions = upsertCondition(buildConditions(source), {
      type: 'Error',
      status: 'True',
      reason: 'MissingToken',
      message: `secret ${secretName} missing key ${secretKey}`,
    })
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      conditions,
      lastSyncedAt: lastSyncedAt ?? undefined,
    })
    return
  }

  if (pollInterval == null && webhookEnabled) {
    const conditions = upsertCondition(buildConditions(source), {
      type: 'Ready',
      status: 'True',
      reason: 'WebhookEnabled',
      message: 'Webhook enabled; waiting for events',
    })
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      cursor: asString(readNested(source, ['status', 'cursor'])) ?? undefined,
      lastSyncedAt: lastSyncedAt ?? undefined,
      conditions,
    })
    return
  }

  try {
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      cursor: asString(readNested(source, ['status', 'cursor'])) ?? undefined,
      lastSyncedAt: lastSyncedAt ?? undefined,
      conditions: upsertCondition(buildConditions(source), {
        type: 'Syncing',
        status: 'True',
        reason: 'InProgress',
      }),
    })
    const provider = asString(readNested(source, ['spec', 'provider'])) ?? 'github'
    const result =
      provider === 'linear'
        ? await syncLinearIssues(kube, namespace, source, token)
        : await syncGitHubIssues(kube, namespace, source, token)

    backoffBySource.delete(stateKey)

    const conditions = upsertCondition(buildConditions(source), {
      type: 'Ready',
      status: 'True',
      reason: 'Synced',
    })
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      cursor: result.cursor,
      lastSyncedAt: nowIso(),
      conditions: upsertCondition(conditions, { type: 'Syncing', status: 'False', reason: 'Complete' }),
    })
  } catch (error) {
    const failureCount = (backoff?.failures ?? 0) + 1
    const baseMs = 5000
    const maxMs = 300000
    const jitter = 0.2
    let delayMs = Math.min(baseMs * 2 ** (failureCount - 1), maxMs)
    delayMs = delayMs * (1 - jitter + Math.random() * jitter * 2)

    if (error instanceof GitHubRateLimitError) {
      delayMs = Math.max(delayMs, error.retryAt - Date.now())
    }

    backoffBySource.set(stateKey, { failures: failureCount, nextAttemptAt: Date.now() + delayMs })

    const conditions = upsertCondition(buildConditions(source), {
      type: 'Error',
      status: 'True',
      reason: 'SyncFailed',
      message: error instanceof Error ? error.message : String(error),
    })
    await setStatus(kube, source, {
      observedGeneration: asRecord(metadata)?.generation ?? 0,
      conditions,
      lastSyncedAt: lastSyncedAt ?? undefined,
    })
  }
}

const buildJobResources = (workload: Record<string, unknown>) => {
  const resources = asRecord(workload.resources) ?? {}
  const requests = asRecord(resources.requests) ?? {}
  const limits = asRecord(resources.limits) ?? {}
  return {
    requests,
    limits,
  }
}

const buildRunSpec = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
  artifacts?: Array<Record<string, unknown>>,
) => {
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory)
  return {
    agentRun: context.agentRun,
    implementation,
    parameters,
    memory:
      memory == null
        ? null
        : {
            type: asString(readNested(memory, ['spec', 'type'])) ?? 'custom',
            connectionRef: asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name'])) ?? '',
          },
    artifacts: artifacts ?? [],
  }
}

const buildVolumeSpecs = (workload: Record<string, unknown>) => {
  const volumes = Array.isArray(workload.volumes) ? (workload.volumes as Record<string, unknown>[]) : []
  const volumeSpecs: Array<{ name: string; spec: Record<string, unknown> }> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  for (const volume of volumes) {
    const type = asString(volume.type)
    const name = asString(volume.name)
    const mountPath = asString(volume.mountPath)
    if (!type || !name || !mountPath) continue
    const readOnly = Boolean(volume.readOnly)

    if (type === 'emptyDir') {
      const emptyDir: Record<string, unknown> = {}
      const medium = asString(volume.medium)
      if (medium) emptyDir.medium = medium
      const sizeLimit = asString(volume.sizeLimit)
      if (sizeLimit) emptyDir.sizeLimit = sizeLimit
      volumeSpecs.push({ name, spec: { emptyDir } })
    }

    if (type === 'pvc') {
      const claimName = asString(volume.claimName)
      if (claimName) {
        volumeSpecs.push({ name, spec: { persistentVolumeClaim: { claimName, readOnly } } })
      }
    }

    if (type === 'secret') {
      const secretName = asString(volume.secretName)
      if (secretName) {
        volumeSpecs.push({ name, spec: { secret: { secretName } } })
      }
    }

    volumeMounts.push({ name, mountPath, readOnly })
  }

  return { volumeSpecs, volumeMounts }
}

const createInputFilesConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  inputFiles: Array<{ path: string; content: string }>,
  labels: Record<string, string>,
) => {
  if (inputFiles.length === 0) return null
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, 'inputs')
  const data: Record<string, string> = {}
  inputFiles.forEach((file, index) => {
    data[`input-${index}`] = file.content
  })
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data,
  }
  await kube.apply(configMap)
  return { name: configName, files: inputFiles }
}

const createRunSpecConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  runSpec: Record<string, unknown>,
  labels: Record<string, string>,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, 'spec')
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data: {
      'run.json': JSON.stringify(runSpec, null, 2),
    },
  }
  await kube.apply(configMap)
  return configName
}

const submitJobRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown>,
  provider: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
  namespace: string,
  workloadImage: string,
) => {
  const workload = asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
  if (!workloadImage) {
    throw new Error('spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime')
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const inputFiles = Array.isArray(providerSpec.inputFiles) ? providerSpec.inputFiles : []
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const binary = asString(providerSpec.binary) ?? '/usr/local/bin/agent-runner'
  const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''

  const parameters = resolveParameters(agentRun)
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory)

  const argsTemplate = Array.isArray(providerSpec.argsTemplate) ? providerSpec.argsTemplate : []
  const args = argsTemplate.map((arg) => renderTemplate(String(arg), context))

  const envTemplate = asRecord(providerSpec.envTemplate) ?? {}
  const env = Object.entries(envTemplate).map(([key, value]) => ({
    name: key,
    value: renderTemplate(String(value), context),
  }))
  if (providerName) {
    env.push({ name: 'AGENT_PROVIDER', value: providerName })
  }

  const runSpec = buildRunSpec(
    agentRun,
    agent,
    implementation,
    parameters,
    memory,
    Array.isArray(outputArtifacts) ? outputArtifacts : [],
  )

  const inputEntries = inputFiles
    .map((file: Record<string, unknown>) => ({
      path: asString(file.path) ?? '',
      content: asString(file.content) ?? '',
    }))
    .filter((file) => file.path && file.content)

  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const serviceAccount = asString(runtimeConfig.serviceAccount)
  const ttlSeconds = runtimeConfig.ttlSecondsAfterFinished

  const metadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'agentrun'
  const runUid = asString(metadata.uid)
  const jobName = makeName(runName, 'job')
  const agentName = asString(readNested(agent, ['metadata', 'name']))
  const implName = asString(readNested(agentRun, ['spec', 'implementationSpecRef', 'name']))
  const labels: Record<string, string> = {
    'agents.proompteng.ai/agent-run': runName,
  }
  if (agentName) {
    labels['agents.proompteng.ai/agent'] = normalizeLabelValue(agentName)
  }
  if (providerName) {
    labels['agents.proompteng.ai/provider'] = normalizeLabelValue(providerName)
  }
  if (implName) {
    labels['agents.proompteng.ai/implementation'] = normalizeLabelValue(implName)
  }

  const inputsConfig = await createInputFilesConfigMap(kube, namespace, agentRun, inputEntries, labels)
  const specConfigName = await createRunSpecConfigMap(kube, namespace, agentRun, runSpec, labels)

  const { volumeSpecs, volumeMounts } = buildVolumeSpecs(workload)

  const configVolumeMounts = [] as Record<string, unknown>[]
  const volumes = [...volumeSpecs]

  if (inputsConfig) {
    const volumeName = makeName(inputsConfig.name, 'vol')
    volumes.push({ name: volumeName, spec: { configMap: { name: inputsConfig.name } } })
    inputsConfig.files.forEach((file, index) => {
      configVolumeMounts.push({
        name: volumeName,
        mountPath: file.path,
        subPath: `input-${index}`,
      })
    })
  }

  const specVolumeName = makeName(specConfigName, 'vol')
  volumes.push({ name: specVolumeName, spec: { configMap: { name: specConfigName } } })
  configVolumeMounts.push({ name: specVolumeName, mountPath: '/workspace/run.json', subPath: 'run.json' })

  const jobResource = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels,
      ...(runUid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid: runUid,
              },
            ],
          }
        : {}),
    },
    spec: {
      ttlSecondsAfterFinished: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
      template: {
        metadata: {
          labels,
        },
        spec: {
          serviceAccountName: serviceAccount ?? undefined,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'agent-runner',
              image: workloadImage,
              command: [binary],
              args,
              env: [{ name: 'AGENT_RUN_SPEC', value: '/workspace/run.json' }, ...env],
              resources: buildJobResources(workload),
              volumeMounts: [...volumeMounts, ...configVolumeMounts],
            },
          ],
          volumes: volumes.map((volume) => ({ name: volume.name, ...volume.spec })),
        },
      },
    },
  }

  const applied = await kube.apply(jobResource)
  return buildRuntimeRef('job', jobName, namespace, { uid: asString(readNested(applied, ['metadata', 'uid'])) })
}

const submitArgoRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
) => {
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const workflowTemplate = asString(runtimeConfig.workflowTemplate)
  if (!workflowTemplate) {
    throw new Error('spec.runtime.config.workflowTemplate is required for argo runtime')
  }
  const workflowNamespace = asString(runtimeConfig.namespace) ?? namespace
  const serviceAccount = asString(runtimeConfig.serviceAccount)

  const parameters = resolveParameters(agentRun)
  const argsInput = runtimeConfig.arguments
  const argumentList: Array<{ name: string; value: string }> = []

  if (argsInput && typeof argsInput === 'object' && !Array.isArray(argsInput)) {
    for (const [key, value] of Object.entries(argsInput as Record<string, unknown>)) {
      argumentList.push({ name: key, value: typeof value === 'string' ? value : JSON.stringify(value) })
    }
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (!argumentList.find((item) => item.name === key)) {
      argumentList.push({ name: key, value })
    }
  }

  const metadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'agentrun'
  const workflowName = makeName(runName, 'wf')

  const resource = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name: workflowName,
      namespace: workflowNamespace,
      labels: {
        'agents.proompteng.ai/agent-run': runName,
      },
    },
    spec: {
      workflowTemplateRef: { name: workflowTemplate },
      serviceAccountName: serviceAccount ?? undefined,
      arguments: argumentList.length > 0 ? { parameters: argumentList } : undefined,
    },
  }

  await kube.apply(resource)
  return buildRuntimeRef('argo', workflowName, workflowNamespace)
}

const submitCustomRun = async (
  agentRun: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
) => {
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const endpoint = asString(runtimeConfig.endpoint)
  if (!endpoint) {
    throw new Error('spec.runtime.config.endpoint is required for custom runtime')
  }
  const payload = runtimeConfig.payload ?? {
    agentRun,
    implementation,
    memory,
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`custom runtime POST failed: ${response.status} ${response.statusText}`)
  }
  let data: Record<string, unknown> | null = null
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    data = null
  }
  return buildRuntimeRef('custom', endpoint, 'external', { response: data ?? {} })
}

const submitTemporalRun = async (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown>,
  provider: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
) => {
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const workflowType = asString(runtimeConfig.workflowType)
  const taskQueue = asString(runtimeConfig.taskQueue)
  if (!workflowType) {
    throw new Error('spec.runtime.config.workflowType is required for temporal runtime')
  }
  if (!taskQueue) {
    throw new Error('spec.runtime.config.taskQueue is required for temporal runtime')
  }

  const namespace = asString(runtimeConfig.namespace) ?? undefined
  const workflowId =
    asString(runtimeConfig.workflowId) ??
    asString(readNested(agentRun, ['spec', 'idempotencyKey'])) ??
    makeName(asString(readNested(agentRun, ['metadata', 'name'])) ?? 'agentrun', 'temporal')

  const timeouts = asRecord(runtimeConfig.timeouts) ?? {}

  const parameters = resolveParameters(agentRun)
  const providerSpec = asRecord(provider.spec) ?? {}
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const payload = buildRunSpec(agentRun, agent, implementation, parameters, memory, outputArtifacts)

  const client = await getTemporalClient()
  const result = await client.workflow.start({
    workflowId,
    workflowType,
    taskQueue,
    namespace,
    args: [payload],
    workflowExecutionTimeoutMs: parseOptionalNumber(timeouts.workflowExecutionTimeoutMs),
    workflowRunTimeoutMs: parseOptionalNumber(timeouts.workflowRunTimeoutMs),
    workflowTaskTimeoutMs: parseOptionalNumber(timeouts.workflowTaskTimeoutMs),
  })

  return buildRuntimeRef('temporal', result.workflowId, result.namespace, {
    workflowId: result.workflowId,
    runId: result.runId,
    taskQueue,
  })
}

const reconcileTemporalRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  runtimeRef: RuntimeRef,
) => {
  const workflowId = asString(runtimeRef.workflowId) ?? asString(runtimeRef.name)
  if (!workflowId) return
  const client = await getTemporalClient()
  const handle = {
    workflowId,
    runId: asString(runtimeRef.runId) ?? undefined,
    namespace: asString(runtimeRef.namespace) ?? undefined,
  }
  try {
    await client.workflow.result(handle, temporalCallOptions({ timeoutMs: 500 }))
    const conditions = buildConditions(agentRun)
    const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
    await setStatus(kube, agentRun, {
      observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
      phase: 'Succeeded',
      finishedAt: nowIso(),
      runtimeRef,
      conditions: updated,
    })
  } catch (error) {
    const outcome = classifyTemporalResult(error)
    if (outcome.kind === 'pending') {
      return
    }
    const conditions = buildConditions(agentRun)
    const updated = upsertCondition(conditions, {
      type: 'Failed',
      status: 'True',
      reason: outcome.reason,
      message: outcome.message,
    })
    await setStatus(kube, agentRun, {
      observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
      phase: outcome.kind === 'cancelled' ? 'Cancelled' : 'Failed',
      finishedAt: nowIso(),
      runtimeRef,
      conditions: updated,
    })
  }
}

const reconcileAgentRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  concurrency: ReturnType<typeof parseConcurrency>,
  inFlight: { total: number; perAgent: Map<string, number> },
  globalInFlight: number,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const name = asString(metadata.name) ?? ''
  const spec = asRecord(agentRun.spec) ?? {}
  const status = asRecord(agentRun.status) ?? {}
  const phase = asString(status.phase) ?? 'Pending'
  const agentName = asString(readNested(spec, ['agentRef', 'name']))
  const finalizer = 'agents.proompteng.ai/runtime-cleanup'
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
    : []
  const hasFinalizer = finalizers.includes(finalizer)
  const deleting = Boolean(metadata.deletionTimestamp)

  const conditions = buildConditions(agentRun)
  const observedGeneration = asRecord(agentRun.metadata)?.generation ?? 0
  const runtimeType = asString(readNested(spec, ['runtime', 'type']))
  const runtimeConfig = asRecord(readNested(spec, ['runtime', 'config'])) ?? {}
  const workload = asRecord(readNested(spec, ['workload'])) ?? {}
  let workloadImage: string | null = null

  if (deleting) {
    if (hasFinalizer) {
      const runtimeRef = parseRuntimeRef(status.runtimeRef)
      if (runtimeRef) {
        try {
          await cancelRuntime(runtimeRef, namespace)
        } catch (error) {
          console.warn('[jangar] runtime cleanup failed', error)
        }
      }
      await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
        metadata: { finalizers: finalizers.filter((item) => item !== finalizer) },
      })
    }
    return
  }

  if (!hasFinalizer) {
    await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
      metadata: { finalizers: [...finalizers, finalizer] },
    })
    return
  }

  const runtimeRef = parseRuntimeRef(status.runtimeRef)
  const shouldSubmit = !runtimeRef && phase !== 'Running' && phase !== 'Succeeded' && phase !== 'Failed'

  if (shouldSubmit && agentName && (inFlight.perAgent.get(agentName) ?? 0) >= concurrency.perAgent) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: `Agent ${agentName} reached concurrency limit`,
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit && inFlight.total >= concurrency.perNamespace) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: `Namespace ${namespace} reached concurrency limit`,
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit && globalInFlight >= concurrency.cluster) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: 'Cluster concurrency limit reached',
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit) {
    if (!runtimeType) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingRuntime',
        message: 'spec.runtime.type is required',
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const parameterCheck = validateParameters(asRecord(spec.parameters) ?? {})
    if (!parameterCheck.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: parameterCheck.reason,
        message: parameterCheck.message,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    if (runtimeType === 'job') {
      workloadImage = resolveJobImage(workload)
      if (!workloadImage) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingWorkloadImage',
          message: 'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'argo') {
      const workflowTemplate = asString(runtimeConfig.workflowTemplate)
      if (!workflowTemplate) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingWorkflowTemplate',
          message: 'spec.runtime.config.workflowTemplate is required for argo runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'custom') {
      const endpoint = asString(runtimeConfig.endpoint)
      if (!endpoint) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingEndpoint',
          message: 'spec.runtime.config.endpoint is required for custom runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'temporal') {
      const workflowType = asString(runtimeConfig.workflowType)
      const taskQueue = asString(runtimeConfig.taskQueue)
      if (!workflowType || !taskQueue) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingTemporalConfig',
          message:
            'spec.runtime.config.workflowType and spec.runtime.config.taskQueue are required for temporal runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    const agent = agentName ? await kube.get(RESOURCE_MAP.Agent, agentName, namespace) : null
    if (!agent) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingAgent',
        message: `agent ${agentName} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
    const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
    if (!provider) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: `agent provider ${providerName ?? 'unknown'} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
    const allowedSecrets = parseStringList(security.allowedSecrets)
    const allowedServiceAccounts = parseStringList(security.allowedServiceAccounts)
    const runSecrets = parseStringList(spec.secrets)

    if (allowedSecrets.length > 0) {
      const forbidden = runSecrets.filter((secret) => !allowedSecrets.includes(secret))
      if (forbidden.length > 0) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (allowedServiceAccounts.length > 0 && (runtimeType === 'job' || runtimeType === 'argo')) {
      const rawServiceAccount = asString(runtimeConfig.serviceAccount)
      const effectiveServiceAccount = rawServiceAccount || 'default'
      if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'ServiceAccountNotAllowed',
          message: `serviceAccount ${effectiveServiceAccount} is not allowlisted`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    const implementation = resolveImplementation(agentRun)
    let implResource = implementation
    if (!implementation) {
      const implRefName = asString(readNested(spec, ['implementationSpecRef', 'name']))
      if (implRefName) {
        const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, implRefName, namespace)
        implResource = asRecord(impl?.spec) ?? null
      }
    }

    if (!implResource) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingImplementation',
        message: 'implementationSpecRef or implementation.inline is required',
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const memory = resolveMemory(agentRun, agent, memories)
    const runMemoryRef = asString(readNested(spec, ['memoryRef', 'name']))
    const agentMemoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
    if ((runMemoryRef || agentMemoryRef) && !memory) {
      const missingName = runMemoryRef || agentMemoryRef || 'unknown'
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingMemory',
        message: `memory ${missingName} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }
    const memorySecretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
    if (memorySecretName) {
      if (allowedSecrets.length > 0 && !allowedSecrets.includes(memorySecretName)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not allowlisted by the Agent`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
      if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not included in spec.secrets`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    let newRuntimeRef: RuntimeRef | null = null
    try {
      if (runtimeType === 'job') {
        newRuntimeRef = await submitJobRun(
          kube,
          agentRun,
          agent,
          provider,
          implResource,
          memory,
          namespace,
          workloadImage ?? '',
        )
      } else if (runtimeType === 'argo') {
        newRuntimeRef = await submitArgoRun(kube, agentRun, namespace)
      } else if (runtimeType === 'custom') {
        newRuntimeRef = await submitCustomRun(agentRun, implResource, memory)
      } else if (runtimeType === 'temporal') {
        newRuntimeRef = await submitTemporalRun(agentRun, agent, provider, implResource, memory)
      } else {
        throw new Error(`unknown runtime type: ${runtimeType}`)
      }

      const updated = upsertCondition(conditions, {
        type: 'Accepted',
        status: 'True',
        reason: 'Submitted',
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        runtimeRef: newRuntimeRef,
        phase: 'Running',
        startedAt: nowIso(),
        conditions: upsertCondition(updated, { type: 'InProgress', status: 'True', reason: 'Running' }),
      })
    } catch (error) {
      const updated = upsertCondition(conditions, {
        type: 'Failed',
        status: 'True',
        reason: 'SubmitFailed',
        message: error instanceof Error ? error.message : String(error),
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        conditions: updated,
      })
    }
    return
  }

  if (!runtimeRef || phase !== 'Running') return

  if (runtimeRef.type === 'job') {
    const job = await kube.get('job', asString(runtimeRef.name) ?? '', asString(runtimeRef.namespace) ?? namespace)
    if (!job) return
    const jobStatus = asRecord(job.status) ?? {}
    const succeeded = Number(jobStatus.succeeded ?? 0)
    const failed = Number(jobStatus.failed ?? 0)
    if (succeeded > 0) {
      const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Succeeded',
        startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
        finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
        runtimeRef,
        conditions: updated,
      })
    } else if (failed > 0) {
      const updated = upsertCondition(conditions, {
        type: 'Failed',
        status: 'True',
        reason: 'JobFailed',
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        runtimeRef,
        conditions: updated,
      })
    }
  }

  if (runtimeRef.type === 'argo') {
    const workflow = await kube.get('workflow', asString(runtimeRef.name) ?? '', asString(runtimeRef.namespace) ?? '')
    if (!workflow) return
    const wfStatus = asRecord(workflow.status) ?? {}
    const wfPhase = asString(wfStatus.phase) ?? ''
    if (wfPhase.toLowerCase() === 'succeeded') {
      const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Succeeded',
        startedAt: asString(wfStatus.startedAt) ?? undefined,
        finishedAt: asString(wfStatus.finishedAt) ?? nowIso(),
        runtimeRef,
        conditions: updated,
      })
    } else if (wfPhase.toLowerCase() === 'failed' || wfPhase.toLowerCase() === 'error') {
      const updated = upsertCondition(conditions, { type: 'Failed', status: 'True', reason: 'WorkflowFailed' })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        runtimeRef,
        conditions: updated,
      })
    }
  }

  if (runtimeRef.type === 'temporal') {
    await reconcileTemporalRun(kube, agentRun, runtimeRef)
  }
}

const reconcileNamespace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  runs: Record<string, unknown>[],
  globalInFlight: number,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const memories = listItems(await kube.list(RESOURCE_MAP.Memory, namespace))
  const agents = listItems(await kube.list(RESOURCE_MAP.Agent, namespace))
  const sources = listItems(await kube.list(RESOURCE_MAP.ImplementationSource, namespace))
  const specs = listItems(await kube.list(RESOURCE_MAP.ImplementationSpec, namespace))
  const providers = listItems(await kube.list(RESOURCE_MAP.AgentProvider, namespace))

  for (const memory of memories) {
    await reconcileMemory(kube, memory, namespace)
  }

  for (const agent of agents) {
    await reconcileAgent(kube, agent, namespace, providers, memories)
  }

  for (const provider of providers) {
    await reconcileAgentProvider(kube, provider)
  }

  for (const spec of specs) {
    await reconcileImplementationSpec(kube, spec)
  }

  for (const source of sources) {
    await reconcileImplementationSource(kube, source, namespace)
  }

  const inFlight = {
    total: 0,
    perAgent: new Map<string, number>(),
  }
  for (const run of runs) {
    const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
    if (phase === 'Running') {
      inFlight.total += 1
      const agent = asString(readNested(run, ['spec', 'agentRef', 'name'])) ?? 'unknown'
      inFlight.perAgent.set(agent, (inFlight.perAgent.get(agent) ?? 0) + 1)
    }
  }

  for (const run of runs) {
    await reconcileAgentRun(kube, run, namespace, memories, concurrency, inFlight, globalInFlight)
  }
}

const reconcileOnce = async () => {
  if (reconciling) return
  reconciling = true
  try {
    const namespaces = parseNamespaces()
    const kube = createKubernetesClient()
    const concurrency = parseConcurrency()
    const runsByNamespace = new Map<string, Record<string, unknown>[]>()
    let globalInFlight = 0
    for (const namespace of namespaces) {
      const runs = listItems(await kube.list(RESOURCE_MAP.AgentRun, namespace))
      runsByNamespace.set(namespace, runs)
      for (const run of runs) {
        const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
        if (phase === 'Running') {
          globalInFlight += 1
        }
      }
    }
    for (const namespace of namespaces) {
      await reconcileNamespace(kube, namespace, runsByNamespace.get(namespace) ?? [], globalInFlight, concurrency)
    }
  } catch (error) {
    console.warn('[jangar] agents controller failed', error)
  } finally {
    reconciling = false
  }
}

export const startAgentsController = async () => {
  if (started || !shouldStart()) return
  const crdsReady = await checkCrds()
  if (!crdsReady.ok) {
    console.error('[jangar] agents controller will not start without CRDs')
    return
  }
  started = true
  void reconcileOnce()
  const intervalMs = parseIntervalSeconds() * 1000
  intervalRef = setInterval(() => {
    void reconcileOnce()
  }, intervalMs)
}

export const stopAgentsController = () => {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
  started = false
}

export const __test = {
  checkCrds,
  reconcileAgentRun,
  reconcileMemory,
  resolveJobImage,
}
