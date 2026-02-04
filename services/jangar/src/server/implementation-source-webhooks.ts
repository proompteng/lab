import { spawn } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { asRecord, asString, errorResponse, okResponse, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { shouldApplyStatus } from '~/server/status-utils'

const DEFAULT_NAMESPACES = ['agents']
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const IMPLEMENTATION_SUMMARY_LIMIT = 256
const LINEAR_TIMESTAMP_TOLERANCE_MS = 60_000
const DEFAULT_WEBHOOK_QUEUE_SIZE = 500
const DEFAULT_WEBHOOK_RETRY_INITIAL_MS = 1000
const DEFAULT_WEBHOOK_RETRY_MAX_MS = 30_000

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type WebhookProvider = 'github' | 'linear'

type ParsedWebhookEvent = {
  provider: WebhookProvider
  externalId: string
  summary: string | null
  text: string
  labels: string[]
  sourceUrl?: string
  sourceVersion?: string
  repository?: string
  owner?: string
  repo?: string
  team?: string
  project?: string
}

type SourceMatch = {
  source: Record<string, unknown>
  namespace: string
}

type WebhookQueueItem = {
  idempotencyKey: string
  provider: WebhookProvider
  event: ParsedWebhookEvent
  matches: SourceMatch[]
  sourceRef: ReturnType<typeof toSourceRef>
  receivedAt: string
  sourceVersion?: string | null
  kubeClient?: ReturnType<typeof createKubernetesClient>
}

type ProviderBackoff = {
  attempt: number
  nextAttemptAt: number
}

const nowIso = () => new Date().toISOString()

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const WEBHOOK_QUEUE_SIZE = parseNumber(process.env.JANGAR_WEBHOOK_QUEUE_SIZE, DEFAULT_WEBHOOK_QUEUE_SIZE)
const WEBHOOK_RETRY_INITIAL_MS = parseNumber(process.env.JANGAR_WEBHOOK_RETRY_INITIAL_MS, DEFAULT_WEBHOOK_RETRY_INITIAL_MS)
const WEBHOOK_RETRY_MAX_MS = parseNumber(process.env.JANGAR_WEBHOOK_RETRY_MAX_MS, DEFAULT_WEBHOOK_RETRY_MAX_MS)
const WEBHOOK_DEDUPE_CACHE_SIZE = Math.max(WEBHOOK_QUEUE_SIZE * 4, 1024)

const webhookQueue: WebhookQueueItem[] = []
const webhookDedupeCache = new Map<string, number>()
const providerBackoff = new Map<WebhookProvider, ProviderBackoff>()
let webhookQueueRunning = false
let webhookQueueTimer: ReturnType<typeof setTimeout> | null = null

const parseNamespaces = () => {
  const raw = process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return list.length > 0 ? list : DEFAULT_NAMESPACES
}

const runKubectl = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
        code: 1,
      })
    })
    child.on('close', (code) => finish({ stdout, stderr, code }))
  })

const resolveNamespaces = async () => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const result = await runKubectl(['get', 'namespace', '-o', 'json'])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to list namespaces')
  }
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items : []
  const resolved = items
    .map((item) => {
      const metadata = item && typeof item === 'object' ? (item as Record<string, unknown>).metadata : null
      const name = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).name : null
      return typeof name === 'string' ? name : null
    })
    .filter((value): value is string => Boolean(value))
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kubectl')
  }
  return resolved
}

const listItems = (resource: Record<string, unknown>) => {
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  return items
}

const normalizeConditions = (raw: unknown): Condition[] => {
  if (!Array.isArray(raw)) return []
  const output: Condition[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const type = asString(record.type)
    const status = asString(record.status)
    if (!type || !status) continue
    const reason = asString(record.reason)?.trim() || 'Reconciled'
    const message = asString(record.message) ?? ''
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason,
      message,
      lastTransitionTime: asString(record.lastTransitionTime) ?? nowIso(),
    })
  }
  return output
}

const buildConditions = (resource: Record<string, unknown>) =>
  normalizeConditions(readNested(resource, ['status', 'conditions']))

const normalizeConditionUpdate = (update: Omit<Condition, 'lastTransitionTime'>) => ({
  ...update,
  reason: update.reason?.trim() || 'Reconciled',
  message: update.message ?? '',
})

const upsertCondition = (conditions: Condition[], update: Omit<Condition, 'lastTransitionTime'>): Condition[] => {
  const next = [...conditions]
  const normalized = normalizeConditionUpdate(update)
  const index = next.findIndex((cond) => cond.type === normalized.type)
  if (index === -1) {
    next.push({ ...normalized, lastTransitionTime: nowIso() })
    return next
  }
  const existing = next[index]
  if (
    existing.status !== normalized.status ||
    existing.reason !== normalized.reason ||
    existing.message !== normalized.message
  ) {
    next[index] = { ...existing, ...normalized, lastTransitionTime: nowIso() }
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
  if (!shouldApplyStatus(asRecord(resource.status), status)) {
    return
  }
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

const makeName = (base: string, suffix: string) => {
  const normalized = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const combined = `${normalized}-${suffix}`.replace(/^-+|-+$/g, '')
  if (combined.length <= 63) return combined
  const hash = createHash('sha1').update(combined).digest('hex').slice(0, 8)
  const trimmed = combined.slice(0, 63 - hash.length - 1)
  return `${trimmed}-${hash}`
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

const normalizeLabelList = (value: unknown) => {
  if (!Array.isArray(value)) return [] as string[]
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const name = asString((item as Record<string, unknown>).name)
        if (name) return name
      }
      return null
    })
    .filter((item): item is string => Boolean(item))
}

const normalizeLinearLabelList = (value: unknown) => {
  if (!value) return [] as string[]
  const record = asRecord(value)
  if (!record) return normalizeLabelList(value)
  if (Array.isArray(record.nodes)) {
    return normalizeLabelList(record.nodes)
  }
  return normalizeLabelList(value)
}

const normalizeScopeLabels = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const safeTimingEqual = (left: Buffer, right: Buffer) => {
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

const verifyGitHubSignature = (rawBody: string, signatureHeader: string | null, secret: string) => {
  if (!signatureHeader) return false
  const trimmed = signatureHeader.trim()
  if (!trimmed) return false
  const [prefix, hash] = trimmed.split('=')
  if (!hash || (prefix !== 'sha256' && prefix !== 'sha1')) return false
  const algorithm = prefix === 'sha1' ? 'sha1' : 'sha256'
  const computed = createHmac(algorithm, secret).update(rawBody, 'utf8').digest('hex')
  const expected = `${prefix}=${computed}`
  return safeTimingEqual(Buffer.from(expected), Buffer.from(trimmed))
}

const verifyLinearSignature = (rawBody: string, signatureHeader: string | null, secret: string) => {
  if (!signatureHeader) return false
  const trimmed = signatureHeader.trim()
  if (!trimmed) return false
  let provided: Buffer
  try {
    provided = Buffer.from(trimmed, 'hex')
  } catch {
    return false
  }
  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  return safeTimingEqual(computed, provided)
}

const parseGitHubEvent = (payload: Record<string, unknown>): ParsedWebhookEvent | null => {
  const issue = asRecord(payload.issue)
  const repository = asRecord(payload.repository)
  const repositoryFullName = asString(repository?.full_name)
  const number = issue?.number
  const issueNumber = typeof number === 'number' ? number : Number.parseInt(String(number ?? ''), 10)
  if (!repositoryFullName || !Number.isFinite(issueNumber)) return null
  if (!repositoryFullName.includes('/')) return null
  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) return null
  const summary = normalizeSummary(asString(issue?.title) ?? null)
  const text = normalizeText(asString(issue?.body) ?? '', summary)
  const labels = normalizeLabelList(issue?.labels)
  const updatedAt = asString(issue?.updated_at) ?? undefined
  return {
    provider: 'github',
    externalId: `${repositoryFullName}#${issueNumber}`,
    summary,
    text,
    labels,
    sourceUrl: asString(issue?.html_url) ?? undefined,
    sourceVersion: updatedAt,
    repository: repositoryFullName,
    owner,
    repo,
  }
}

const parseLinearEvent = (payload: Record<string, unknown>): ParsedWebhookEvent | null => {
  const data = asRecord(payload.data) ?? payload
  const identifier = asString(data.identifier)
  const title = asString(data.title) ?? null
  if (!identifier || !title) return null
  const summary = normalizeSummary(title)
  const text = normalizeText(asString(data.description) ?? '', summary)
  const labels = normalizeLinearLabelList(data.labels)
  const teamKey = asString(readNested(data, ['team', 'key'])) ?? asString(data.team) ?? undefined
  const projectName = asString(readNested(data, ['project', 'name'])) ?? asString(data.project) ?? undefined
  return {
    provider: 'linear',
    externalId: identifier,
    summary,
    text,
    labels,
    sourceUrl: asString(data.url) ?? undefined,
    sourceVersion: asString(data.updatedAt) ?? undefined,
    team: teamKey,
    project: projectName,
  }
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

const matchesGithubSource = (source: Record<string, unknown>, event: ParsedWebhookEvent) => {
  if (event.provider !== 'github') return false
  const scope = asRecord(readNested(source, ['spec', 'scope'])) ?? {}
  const repository = asString(scope.repository)
  if (!repository || !event.repository) return false
  if (repository.toLowerCase() !== event.repository.toLowerCase()) return false
  const labels = normalizeScopeLabels(scope.labels)
  if (labels.length === 0) return true
  return labels.every((label) => event.labels.includes(label))
}

const matchesLinearSource = (source: Record<string, unknown>, event: ParsedWebhookEvent) => {
  if (event.provider !== 'linear') return false
  const scope = asRecord(readNested(source, ['spec', 'scope'])) ?? {}
  const team = asString(scope.team)
  const project = asString(scope.project)
  if (team && event.team && team.toLowerCase() !== event.team.toLowerCase()) return false
  if (project && event.project && project.toLowerCase() !== event.project.toLowerCase()) return false
  if (team && !event.team) return false
  if (project && !event.project) return false
  const labels = normalizeScopeLabels(scope.labels)
  if (labels.length === 0) return true
  return labels.every((label) => event.labels.includes(label))
}

const buildImplementationName = (event: ParsedWebhookEvent) => {
  if (event.provider === 'github' && event.owner && event.repo) {
    return makeName(`${event.owner}-${event.repo}-${event.externalId.split('#').pop() ?? ''}`, 'impl')
  }
  if (event.provider === 'linear') {
    return makeName(`linear-${event.externalId}`, 'impl')
  }
  return makeName(event.externalId, 'impl')
}

const toSourceRef = (event: ParsedWebhookEvent) => ({
  provider: event.provider,
  externalId: event.externalId,
  url: event.sourceUrl ?? undefined,
})

const listImplementationSources = async (kube: ReturnType<typeof createKubernetesClient>) => {
  const namespaces = await resolveNamespaces()
  const sources: SourceMatch[] = []
  for (const namespace of namespaces) {
    const result = await kube.list(RESOURCE_MAP.ImplementationSource, namespace)
    for (const item of listItems(result)) {
      sources.push({ source: item, namespace })
    }
  }
  return sources
}

const resolveSecretRef = (source: Record<string, unknown>) => {
  const name = asString(readNested(source, ['spec', 'auth', 'secretRef', 'name']))
  const key = asString(readNested(source, ['spec', 'auth', 'secretRef', 'key'])) ?? 'token'
  if (!name) return null
  return { name, key }
}

const resolveWebhookEnabled = (source: Record<string, unknown>) =>
  readNested(source, ['spec', 'webhook', 'enabled']) === true

const updateSourceStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  source: Record<string, unknown>,
  status: {
    type: string
    status: 'True' | 'False' | 'Unknown'
    reason: string
    message?: string
    lastSyncedAt?: string
    lastWebhook?: {
      idempotencyKey: string
      provider: WebhookProvider
      externalId: string
      receivedAt: string
      sourceVersion?: string | null
      sourceUrl?: string | null
    }
  },
) => {
  const metadata = asRecord(source.metadata) ?? {}
  const conditions = upsertCondition(buildConditions(source), {
    type: status.type,
    status: status.status,
    reason: status.reason,
    message: status.message,
  })
  await setStatus(kube, source, {
    observedGeneration: asRecord(metadata)?.generation ?? 0,
    cursor: asString(readNested(source, ['status', 'cursor'])) ?? undefined,
    lastSyncedAt: status.lastSyncedAt ?? asString(readNested(source, ['status', 'lastSyncedAt'])) ?? undefined,
    lastWebhook: status.lastWebhook ?? asRecord(readNested(source, ['status', 'lastWebhook'])) ?? undefined,
    conditions,
  })
}

const selectVerifiedSources = async (
  provider: WebhookProvider,
  rawBody: string,
  headers: Headers,
  candidates: SourceMatch[],
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const verified: SourceMatch[] = []
  for (const candidate of candidates) {
    if (!resolveWebhookEnabled(candidate.source)) continue
    const secretRef = resolveSecretRef(candidate.source)
    if (!secretRef) continue
    const secret = await getSecretData(kube, candidate.namespace, secretRef.name)
    const secretValue = secret?.[secretRef.key]
    if (!secretValue) continue
    const ok =
      provider === 'github'
        ? verifyGitHubSignature(
            rawBody,
            headers.get('x-hub-signature-256') ?? headers.get('x-hub-signature'),
            secretValue,
          )
        : verifyLinearSignature(rawBody, headers.get('linear-signature'), secretValue)
    if (ok) verified.push(candidate)
  }
  return verified
}

const parseEvent = (provider: WebhookProvider, payload: Record<string, unknown>) => {
  if (provider === 'github') return parseGitHubEvent(payload)
  return parseLinearEvent(payload)
}

const filterMatchingSources = (sources: SourceMatch[], event: ParsedWebhookEvent) => {
  if (event.provider === 'github') return sources.filter((source) => matchesGithubSource(source.source, event))
  return sources.filter((source) => matchesLinearSource(source.source, event))
}

const validateLinearTimestamp = (payload: Record<string, unknown>, now: () => string) => {
  const timestamp = readNested(payload, ['webhookTimestamp'])
  if (timestamp == null) return { ok: true as const }
  const numeric = Number(timestamp)
  if (!Number.isFinite(numeric)) return { ok: false as const, message: 'Invalid webhookTimestamp' }
  const nowMs = Date.parse(now())
  if (!Number.isFinite(nowMs)) return { ok: true as const }
  if (Math.abs(nowMs - numeric) > LINEAR_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false as const, message: 'Webhook timestamp outside tolerance window' }
  }
  return { ok: true as const }
}

const resolveEventName = (provider: WebhookProvider, headers: Headers) => {
  if (provider === 'github') return headers.get('x-github-event')?.toLowerCase() ?? ''
  return headers.get('linear-event')?.toLowerCase() ?? ''
}

const isIssueEvent = (provider: WebhookProvider, eventName: string) => {
  if (provider === 'github') return eventName === 'issues'
  return eventName === 'issue'
}

const resolveIdempotencyKey = (
  provider: WebhookProvider,
  headers: Headers,
  payload: Record<string, unknown>,
  rawBody: string,
) => {
  const headerCandidates =
    provider === 'github'
      ? ['x-github-delivery', 'x-request-id', 'idempotency-key', 'x-idempotency-key']
      : [
          'linear-delivery-id',
          'linear-delivery',
          'x-linear-delivery-id',
          'x-linear-delivery',
          'x-request-id',
          'idempotency-key',
          'x-idempotency-key',
        ]
  for (const key of headerCandidates) {
    const value = headers.get(key)
    if (value && value.trim().length > 0) {
      return `${provider}:${value.trim()}`
    }
  }
  const payloadCandidates = [
    asString(payload.deliveryId),
    asString(payload.delivery_id),
    asString(payload.id),
    asString(payload.webhookId),
    asString(payload.webhook_id),
    asString(readNested(payload, ['data', 'id'])),
  ].filter((value): value is string => Boolean(value))
  if (payloadCandidates.length > 0) {
    return `${provider}:${payloadCandidates[0]}`
  }
  const bodyHash = createHash('sha1').update(rawBody, 'utf8').digest('hex')
  return `${provider}:body:${bodyHash}`
}

const registerIdempotencyKey = (key: string) => {
  if (webhookDedupeCache.has(key)) return false
  webhookDedupeCache.set(key, Date.now())
  if (webhookDedupeCache.size > WEBHOOK_DEDUPE_CACHE_SIZE) {
    let overflow = webhookDedupeCache.size - WEBHOOK_DEDUPE_CACHE_SIZE
    for (const oldKey of webhookDedupeCache.keys()) {
      webhookDedupeCache.delete(oldKey)
      overflow -= 1
      if (overflow <= 0) break
    }
  }
  return true
}

const getProviderBackoff = (provider: WebhookProvider, nowMs: number) => {
  const backoff = providerBackoff.get(provider)
  if (!backoff) return null
  if (backoff.nextAttemptAt <= nowMs) return null
  return backoff
}

const setProviderBackoff = (provider: WebhookProvider) => {
  const current = providerBackoff.get(provider) ?? { attempt: 0, nextAttemptAt: 0 }
  const attempt = current.attempt + 1
  const delay = Math.min(WEBHOOK_RETRY_INITIAL_MS * 2 ** (attempt - 1), WEBHOOK_RETRY_MAX_MS)
  const nextAttemptAt = Date.now() + delay
  providerBackoff.set(provider, { attempt, nextAttemptAt })
  return delay
}

const clearProviderBackoff = (provider: WebhookProvider) => {
  providerBackoff.delete(provider)
}

const scheduleWebhookQueue = () => {
  if (webhookQueueTimer) {
    clearTimeout(webhookQueueTimer)
    webhookQueueTimer = null
  }
  if (webhookQueue.length === 0) return
  const nowMs = Date.now()
  let nextAt: number | null = null
  for (const item of webhookQueue) {
    const backoff = providerBackoff.get(item.provider)
    if (!backoff || backoff.nextAttemptAt <= nowMs) {
      nextAt = nowMs
      break
    }
    if (nextAt == null || backoff.nextAttemptAt < nextAt) {
      nextAt = backoff.nextAttemptAt
    }
  }
  if (nextAt == null) return
  const delay = Math.max(0, nextAt - nowMs)
  webhookQueueTimer = setTimeout(() => {
    webhookQueueTimer = null
    void processWebhookQueue()
  }, delay)
}

const processWebhookItem = async (kube: ReturnType<typeof createKubernetesClient>, item: WebhookQueueItem) => {
  for (const match of item.matches) {
    await syncImplementationSpec(kube, match.namespace, {
      name: buildImplementationName(item.event),
      source: item.sourceRef,
      summary: item.event.summary,
      text: item.event.text,
      labels: item.event.labels,
      sourceVersion: item.event.sourceVersion ?? undefined,
    })

    await updateSourceStatus(kube, match.source, {
      type: 'Ready',
      status: 'True',
      reason: 'WebhookSynced',
      lastSyncedAt: nowIso(),
      lastWebhook: {
        idempotencyKey: item.idempotencyKey,
        provider: item.provider,
        externalId: item.event.externalId,
        receivedAt: item.receivedAt,
        sourceVersion: item.sourceVersion ?? null,
        sourceUrl: item.event.sourceUrl ?? null,
      },
    })
  }
}

const processWebhookQueue = async () => {
  if (webhookQueueRunning) return
  webhookQueueRunning = true
  try {
    while (webhookQueue.length > 0) {
      const nowMs = Date.now()
      const index = webhookQueue.findIndex((item) => !getProviderBackoff(item.provider, nowMs))
      if (index === -1) break
      const item = webhookQueue.splice(index, 1)[0]
      try {
        const kube = item.kubeClient ?? createKubernetesClient()
        await processWebhookItem(kube, item)
        clearProviderBackoff(item.provider)
      } catch (error) {
        setProviderBackoff(item.provider)
        webhookQueue.push(item)
        console.warn('[jangar] webhook ingest failed; backing off', {
          provider: item.provider,
          idempotencyKey: item.idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    webhookQueueRunning = false
    scheduleWebhookQueue()
  }
}

const enqueueWebhookItem = (item: WebhookQueueItem) => {
  if (webhookDedupeCache.has(item.idempotencyKey)) return { ok: false as const, reason: 'Duplicate' }
  if (webhookQueue.length >= WEBHOOK_QUEUE_SIZE) return { ok: false as const, reason: 'QueueFull' }
  registerIdempotencyKey(item.idempotencyKey)
  webhookQueue.push(item)
  void processWebhookQueue()
  return { ok: true as const }
}

const jsonResponseWithHeaders = (payload: unknown, status: number, headers: Record<string, string>) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
      ...headers,
    },
  })
}

export const flushWebhookQueueForTesting = async () => {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!webhookQueueRunning && webhookQueue.length === 0) {
        resolve()
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
}

export const resetWebhookQueueForTesting = () => {
  webhookQueue.length = 0
  webhookDedupeCache.clear()
  providerBackoff.clear()
  if (webhookQueueTimer) {
    clearTimeout(webhookQueueTimer)
    webhookQueueTimer = null
  }
}

export const postImplementationSourceWebhookHandler = async (
  provider: string,
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient>; now?: () => string } = {},
) => {
  const normalizedProvider = provider.trim().toLowerCase()
  if (normalizedProvider !== 'github' && normalizedProvider !== 'linear') {
    return errorResponse('Unsupported webhook provider', 404)
  }
  const rawBody = await request.text()
  if (!rawBody) return errorResponse('Missing webhook payload', 400)

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return errorResponse('Invalid JSON payload', 400)
  }

  const eventName = resolveEventName(normalizedProvider, request.headers)
  if (eventName && !isIssueEvent(normalizedProvider, eventName)) {
    return okResponse({ ok: true, ignored: true })
  }

  const kube = deps.kubeClient ?? createKubernetesClient()
  const now = deps.now ?? nowIso

  if (normalizedProvider === 'linear') {
    const timestampCheck = validateLinearTimestamp(payload, now)
    if (!timestampCheck.ok) {
      return errorResponse(timestampCheck.message, 400)
    }
  }

  const candidates = await listImplementationSources(kube)
  const providerCandidates = candidates.filter((candidate) => {
    const sourceProvider = asString(readNested(candidate.source, ['spec', 'provider']))
    return sourceProvider?.toLowerCase() === normalizedProvider
  })

  if (providerCandidates.length === 0) {
    return errorResponse('No ImplementationSource configured for webhook provider', 404)
  }

  const verified = await selectVerifiedSources(normalizedProvider, rawBody, request.headers, providerCandidates, kube)
  if (verified.length === 0) {
    return errorResponse('Invalid webhook signature', 401)
  }

  const event = parseEvent(normalizedProvider, payload)
  if (!event) {
    for (const candidate of verified) {
      await updateSourceStatus(kube, candidate.source, {
        type: 'Error',
        status: 'True',
        reason: 'InvalidPayload',
        message: 'Unable to parse webhook payload',
      })
    }
    return errorResponse('Unsupported webhook payload', 400)
  }

  const matching = filterMatchingSources(verified, event)
  if (matching.length === 0) {
    return errorResponse('No matching ImplementationSource for webhook payload', 404)
  }

  const sourceRef = toSourceRef(event)
  const idempotencyKey = resolveIdempotencyKey(normalizedProvider, request.headers, payload, rawBody)
  const backoff = getProviderBackoff(normalizedProvider, Date.now())
  if (backoff) {
    const retryAfterSeconds = Math.max(1, Math.ceil((backoff.nextAttemptAt - Date.now()) / 1000))
    return jsonResponseWithHeaders(
      { ok: false, error: 'Webhook provider in backoff', retryAfterSeconds },
      503,
      { 'retry-after': retryAfterSeconds.toString() },
    )
  }

  const enqueueResult = enqueueWebhookItem({
    idempotencyKey,
    provider: normalizedProvider,
    event,
    matches: matching,
    sourceRef,
    receivedAt: now(),
    sourceVersion: event.sourceVersion ?? null,
    kubeClient: deps.kubeClient,
  })
  if (!enqueueResult.ok) {
    if (enqueueResult.reason === 'Duplicate') {
      return okResponse({ ok: true, duplicated: true })
    }
    return jsonResponseWithHeaders(
      { ok: false, error: 'Webhook queue full' },
      429,
      { 'retry-after': '2' },
    )
  }

  return okResponse({ ok: true, queued: matching.length })
}
