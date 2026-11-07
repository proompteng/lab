import { createHmac, timingSafeEqual } from 'node:crypto'

import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import {
  buildLinearIssueAgentRunPayload,
  makeAgentsServiceSubmitter,
  type AgentRunSubmitter,
  type LinearIssueAgentRunRequest,
} from '@/services/agents'

import type { IdempotencyStore } from './idempotency-store'
import { makeLinearWebhookMetrics, type LinearWebhookMetrics } from './linear-metrics'
import type { WebhookConfig } from './types'
import { publishAdmission, withDeadline, DeadlineExceededError, type WebhookAdmission } from './admission'
import { publishKafkaMessage } from './utils'

const LINEAR_WEBHOOK_RESPONSE_BUDGET_MS = 4_500
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds configured limit')
    this.name = 'BodyTooLargeError'
  }
}

interface LinearLabel {
  id: string | null
  name: string
}

interface ParsedLinearIssueEvent {
  action: 'create' | 'update'
  webhookTimestamp: number
  webhookId: string | null
  issue: {
    id: string
    identifier: string
    title: string
    description: string
    url: string
    labels: LinearLabel[]
  }
  updatedFrom: Record<string, unknown> | null
}

export interface LinearWebhookDependencies {
  runtime: AppRuntime
  config: WebhookConfig
  idempotencyStore: IdempotencyStore
  now?: () => number
  admit?: (admission: WebhookAdmission) => Promise<void>
  metrics?: LinearWebhookMetrics
  responseBudgetMs?: number
}

const responseJson = (status: number, body: Record<string, unknown>) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

const readBoundedBody = async (request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array> => {
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const normalized = contentLength.trim()
    const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
    if (!Number.isSafeInteger(parsed)) {
      throw new Error('invalid content-length')
    }
    if (parsed > maxBytes) throw new BodyTooLargeError()
  }

  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let deadlineExceeded = false
  const deadline = AbortSignal.timeout(Math.max(1, timeoutMs))
  const cancelOnDeadline = () => {
    deadlineExceeded = true
    void reader.cancel().catch(() => undefined)
  }
  deadline.addEventListener('abort', cancelOnDeadline, { once: true })

  try {
    while (true) {
      const result = await reader.read()
      if (deadlineExceeded) throw new DeadlineExceededError('body')
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new BodyTooLargeError()
      }
      chunks.push(result.value)
    }
  } finally {
    deadline.removeEventListener('abort', cancelOnDeadline)
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

const isJsonContentType = (value: string | null) => {
  if (!value) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true
}

const verifySignature = (secret: string, body: Uint8Array, suppliedHex: string | null) => {
  if (!suppliedHex || !SHA256_HEX_PATTERN.test(suppliedHex)) return false
  const supplied = Buffer.from(suppliedHex, 'hex')
  const expected = createHmac('sha256', secret).update(body).digest()
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const requiredString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const parseLabels = (value: unknown): LinearLabel[] | null => {
  if (!Array.isArray(value)) return null
  const labels: LinearLabel[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) return null
    const name = requiredString(record, 'name')
    if (!name) return null
    labels.push({
      id: requiredString(record, 'id'),
      name,
    })
  }
  return labels
}

const parseLinearIssueEvent = (value: unknown): ParsedLinearIssueEvent | null => {
  const payload = asRecord(value)
  if (!payload) return null
  if (payload.type !== 'Issue' || (payload.action !== 'create' && payload.action !== 'update')) return null
  if (typeof payload.webhookTimestamp !== 'number' || !Number.isSafeInteger(payload.webhookTimestamp)) return null

  const data = asRecord(payload.data)
  if (!data) return null
  const id = requiredString(data, 'id')
  const identifier = requiredString(data, 'identifier')
  const title = requiredString(data, 'title')
  const outerUrl = requiredString(payload, 'url')
  const dataUrl = requiredString(data, 'url')
  const labels = parseLabels(data.labels)
  if (!id || !UUID_PATTERN.test(id) || !identifier || !title || !(outerUrl ?? dataUrl) || !labels) return null

  const descriptionValue = data.description
  if (descriptionValue !== null && descriptionValue !== undefined && typeof descriptionValue !== 'string') return null

  return {
    action: payload.action,
    webhookTimestamp: payload.webhookTimestamp,
    webhookId: requiredString(payload, 'webhookId'),
    issue: {
      id,
      identifier,
      title,
      description: descriptionValue ?? '',
      url: outerUrl ?? dataUrl!,
      labels,
    },
    updatedFrom: payload.updatedFrom === undefined ? null : asRecord(payload.updatedFrom),
  }
}

const previousLabelNames = (updatedFrom: Record<string, unknown>): string[] | null => {
  if (!Object.hasOwn(updatedFrom, 'labels')) return null
  const labels = updatedFrom.labels
  if (labels === null) return []
  if (!Array.isArray(labels)) return null
  const names: string[] = []
  for (const item of labels) {
    if (typeof item === 'string') {
      names.push(item)
      continue
    }
    const record = asRecord(item)
    const name = record ? requiredString(record, 'name') : null
    if (!name) return null
    names.push(name)
  }
  return names
}

const wasTriggerLabelAdded = (event: ParsedLinearIssueEvent, triggerLabel: string) => {
  const normalizedTrigger = triggerLabel.toLowerCase()
  const current = event.issue.labels.find((label) => label.name.toLowerCase() === normalizedTrigger)
  if (!current) return false
  if (event.action === 'create') return true
  if (!event.updatedFrom) return false

  if (Object.hasOwn(event.updatedFrom, 'labelIds')) {
    const previousIds = event.updatedFrom.labelIds
    if (previousIds === null) return current.id !== null
    if (!Array.isArray(previousIds) || !current.id) return false
    if (!previousIds.every((value): value is string => typeof value === 'string')) return false
    return !previousIds.includes(current.id)
  }

  const previousNames = previousLabelNames(event.updatedFrom)
  if (previousNames) {
    return !previousNames.some((name) => name.toLowerCase() === normalizedTrigger)
  }

  return false
}

const makeHeadBranch = (prefix: string, identifier: string, deliveryId: string) => {
  const issueSlug = identifier
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const suffix = `-${deliveryId.toLowerCase()}`
  const availableIssueBytes = 240 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  if (!issueSlug || availableIssueBytes < 1) throw new Error('Linear branch configuration is too long')
  return `${prefix}${issueSlug.slice(0, availableIssueBytes)}${suffix}`
}

const remainingBudget = (deadlineAt: number, now: () => number) => Math.max(1, deadlineAt - now())

export const createLinearWebhookHandler = ({
  runtime,
  config,
  idempotencyStore,
  now = Date.now,
  admit = (admission) => publishAdmission(runtime, admission),
  metrics = makeLinearWebhookMetrics(runtime),
  responseBudgetMs = LINEAR_WEBHOOK_RESPONSE_BUDGET_MS,
}: LinearWebhookDependencies) => {
  return async (request: Request): Promise<Response> => {
    const startedAt = now()
    const deadlineAt = startedAt + responseBudgetMs
    const respond = (status: number, body: Record<string, unknown>, outcome: string) => {
      metrics.recordDeliveryLatencyMs(Math.max(0, now() - startedAt), outcome)
      return responseJson(status, body)
    }
    const reject = (status: number, reason: string) => {
      metrics.recordVerificationFailure(reason)
      return respond(status, { status: 'rejected', reason }, 'rejected')
    }

    if (!isJsonContentType(request.headers.get('content-type'))) {
      return reject(415, 'content-type')
    }

    let rawBody: Uint8Array
    try {
      rawBody = await readBoundedBody(request, config.linear.maxBodyBytes, remainingBudget(deadlineAt, now))
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return reject(413, 'body-too-large')
      }
      if (error instanceof DeadlineExceededError) {
        metrics.recordDownstreamFailure('processing', 'body-timeout')
        return respond(500, { status: 'retry' }, 'retry')
      }
      return reject(400, 'invalid-body')
    }

    if (!verifySignature(config.linear.webhookSecret, rawBody, request.headers.get('linear-signature'))) {
      logger.warn({ provider: 'linear' }, 'linear webhook verification failed')
      return reject(401, 'signature')
    }

    const headerTimestamp = Number(request.headers.get('linear-timestamp'))
    if (
      !Number.isSafeInteger(headerTimestamp) ||
      Math.abs(startedAt - headerTimestamp) > config.linear.webhookToleranceMs
    ) {
      logger.warn({ provider: 'linear' }, 'linear webhook timestamp rejected')
      return reject(401, 'timestamp')
    }

    const deliveryId = request.headers.get('linear-delivery')?.trim() ?? ''
    if (!UUID_PATTERN.test(deliveryId)) {
      return reject(400, 'delivery')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown
    } catch {
      logger.warn({ provider: 'linear', deliveryId }, 'verified linear webhook JSON rejected')
      return reject(400, 'json')
    }

    const payloadRecord = asRecord(parsed)
    const payloadTimestamp = payloadRecord?.webhookTimestamp
    if (
      typeof payloadTimestamp !== 'number' ||
      !Number.isSafeInteger(payloadTimestamp) ||
      Math.abs(startedAt - payloadTimestamp) > config.linear.webhookToleranceMs ||
      Math.abs(headerTimestamp - payloadTimestamp) > config.linear.webhookToleranceMs
    ) {
      logger.warn({ provider: 'linear', deliveryId }, 'linear webhook payload timestamp rejected')
      return reject(401, 'payload-timestamp')
    }

    const eventHeader = request.headers.get('linear-event')?.trim() ?? ''
    const action = typeof payloadRecord?.action === 'string' ? payloadRecord.action : null
    const idempotencyKey = `linear:${deliveryId}`
    const auditHeaders: Record<string, string> = {
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'linear-delivery': deliveryId,
      'linear-event': eventHeader,
      'linear-timestamp': String(headerTimestamp),
      ...(action ? { 'linear-action': action } : {}),
    }

    for (const name of ['traceparent', 'tracestate']) {
      const value = request.headers.get(name)
      if (value) auditHeaders[name] = value
    }
    const event = eventHeader === 'Issue' ? parseLinearIssueEvent(parsed) : null
    if (eventHeader === 'Issue' && (action === 'create' || action === 'update') && event === null)
      return reject(400, 'issue-payload')
    try {
      const duplicate = await idempotencyStore.run(idempotencyKey, () =>
        withDeadline(
          admit({
            provider: 'linear',
            deliveryId,
            receivedAt: startedAt,
            body: new TextDecoder().decode(rawBody),
            headers: auditHeaders,
          }),
          remainingBudget(deadlineAt, now),
          'kafka',
        ),
      )
      return respond(
        200,
        { status: duplicate ? 'duplicate' : 'accepted', deliveryId },
        duplicate ? 'duplicate' : 'accepted',
      )
    } catch (error) {
      metrics.recordDownstreamFailure('kafka', error instanceof DeadlineExceededError ? 'timeout' : 'failure')
      logger.error({ provider: 'linear', deliveryId }, 'linear admission failed')
      return respond(503, { status: 'retry', deliveryId }, 'retry')
    }
  }
}

export const createLinearPolicyProcessor =
  ({
    runtime,
    config,
    submitAgentRun = makeAgentsServiceSubmitter(config.agents),
  }: {
    runtime: AppRuntime
    config: WebhookConfig
    submitAgentRun?: AgentRunSubmitter
  }) =>
  async ({ body, deliveryId, headers }: WebhookAdmission): Promise<void> => {
    await runtime.runPromise(
      publishKafkaMessage({ topic: config.topics.linearRaw, key: deliveryId, value: body, headers }),
    )
    const event = headers['linear-event'] === 'Issue' ? parseLinearIssueEvent(JSON.parse(body)) : null
    if (!event || !wasTriggerLabelAdded(event, config.linear.triggerLabel)) return
    const requestPayload: LinearIssueAgentRunRequest = {
      issueId: event.issue.id,
      identifier: event.issue.identifier,
      title: event.issue.title,
      description: event.issue.description,
      url: event.issue.url,
      action: event.action,
      repository: config.linear.repository,
      base: config.linear.baseBranch,
      head: makeHeadBranch(config.linear.branchPrefix, event.issue.identifier, deliveryId),
    }
    const result = await submitAgentRun({
      deliveryId,
      payload: buildLinearIssueAgentRunPayload(config.agents, requestPayload, deliveryId),
      signal: AbortSignal.timeout(config.linear.agentsTimeoutMs),
    })
    if (!result.ok) throw new Error(`Linear AgentRun submission failed: HTTP ${result.status}`)
    logger.info(
      { provider: 'linear', deliveryId, issueIdentifier: event.issue.identifier },
      'linear AgentRun submitted',
    )
  }

export const __test__ = {
  makeHeadBranch,
  parseLinearIssueEvent,
  verifySignature,
  wasTriggerLabelAdded,
}
