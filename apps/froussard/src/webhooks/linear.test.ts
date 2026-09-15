import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import type { AgentRunSubmitter } from '@/services/agents'

import { createIdempotencyStore } from './idempotency-store'
import { createLinearWebhookHandler } from './linear'
import type { LinearWebhookMetrics } from './linear-metrics'
import type { WebhookConfig } from './types'

const NOW = 1_800_000_000_000
const SECRET = 'linear-test-secret'
const DELIVERY = '234d1a4e-b617-4388-90fe-adc3633d6b72'
const ISSUE_ID = '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9'
const LABEL_ID = '8a82b5d6-8112-4c41-b32a-0efb93ad4e2b'

const config: WebhookConfig = {
  idempotency: { ttlMs: 60_000, maxEntries: 100 },
  atlas: { baseUrl: 'http://atlas.test', apiKey: null },
  agents: {
    serviceBaseUrl: 'http://agents.test',
    serviceClientName: 'froussard-test',
    namespace: 'agents',
    agentName: 'codex-agent',
    linearAgentName: 'codex-linear-agent',
    vcsProviderName: 'github',
    serviceAccountName: 'agents-sa',
    secrets: ['github-token', 'codex-auth'],
    secretBindingRef: 'codex-github-token',
    ttlSecondsAfterFinished: 86_400,
    goalTokenBudget: 250_000,
  },
  codebase: { baseBranch: 'main', branchPrefix: 'codex/issue-' },
  github: {
    token: null,
    ackReaction: '+1',
    apiBaseUrl: 'https://api.github.com',
    userAgent: 'froussard-test',
  },
  codexTriggerLogins: ['test'],
  codexWorkflowLogin: 'github-actions[bot]',
  codexImplementationTriggerPhrase: 'implement issue',
  topics: {
    raw: 'github.webhook.events',
    discordCommands: 'discord.commands.incoming',
    linearRaw: 'linear.webhook.events',
  },
  discord: {
    publicKey: 'test',
    response: { deferType: 'channel-message', ephemeral: true },
  },
  linear: {
    webhookSecret: SECRET,
    triggerLabel: 'agentrun',
    repository: 'proompteng/lab',
    baseBranch: 'main',
    branchPrefix: 'codex/linear-',
    maxBodyBytes: 1024 * 1024,
    webhookToleranceMs: 60_000,
    agentsTimeoutMs: 100,
  },
}

const issuePayload = (overrides: Record<string, unknown> = {}) => ({
  action: 'create',
  type: 'Issue',
  data: {
    id: ISSUE_ID,
    identifier: 'PROOMPT-123',
    title: 'Implement source-bound Linear MCP',
    description: 'Do not leak this issue description into logs.',
    labels: [{ id: LABEL_ID, name: 'agentrun' }],
    labelIds: [LABEL_ID],
  },
  actor: {
    id: 'b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba',
    name: 'Test Actor',
    email: 'actor@example.test',
  },
  url: 'https://linear.app/proompteng/issue/PROOMPT-123/implement-source-bound-linear-mcp',
  webhookTimestamp: NOW,
  webhookId: '000042e3-d123-4980-b49f-8e140eef9329',
  ...overrides,
})

const signedRequest = (
  payload: unknown,
  options: {
    delivery?: string
    event?: string
    timestamp?: number
    signature?: string
    contentType?: string
    body?: string
  } = {},
) => {
  const body = options.body ?? JSON.stringify(payload)
  const signature = options.signature ?? createHmac('sha256', SECRET).update(body).digest('hex')
  return new Request('https://froussard.test/webhooks/linear', {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json; charset=utf-8',
      'linear-delivery': options.delivery ?? DELIVERY,
      'linear-event': options.event ?? 'Issue',
      'linear-signature': signature,
      'linear-timestamp': String(options.timestamp ?? NOW),
    },
    body,
  })
}

const makeHarness = (
  options: {
    config?: WebhookConfig
    submit?: AgentRunSubmitter
    publish?: (message: {
      topic: string
      key: string
      value: Uint8Array
      headers: Record<string, string>
    }) => Promise<void>
    metrics?: LinearWebhookMetrics
    responseBudgetMs?: number
  } = {},
) => {
  const submissions: Parameters<AgentRunSubmitter>[0][] = []
  const published: Array<{
    topic: string
    key: string
    value: Uint8Array
    headers: Record<string, string>
  }> = []
  const submit =
    options.submit ??
    (async (input) => {
      submissions.push(input)
      return { ok: true as const, status: 201, body: { ok: true } }
    })
  const publish =
    options.publish ??
    (async (message) => {
      published.push(message)
    })
  const handler = createLinearWebhookHandler({
    runtime: {} as AppRuntime,
    config: options.config ?? config,
    idempotencyStore: createIdempotencyStore(config.idempotency),
    now: () => NOW,
    submitAgentRun: submit,
    publishRawEvent: publish,
    metrics: options.metrics,
    responseBudgetMs: options.responseBudgetMs,
  })
  return { handler, submissions, published }
}

describe('Linear webhook intake', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('audits a verified issue create and submits exactly one source-bound AgentRun', async () => {
    const { handler, submissions, published } = makeHarness()
    const request = signedRequest(issuePayload())
    const rawBody = await request.clone().text()

    const response = await handler(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'accepted',
      deliveryId: DELIVERY,
      agentRunTriggered: true,
    })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      topic: 'linear.webhook.events',
      key: DELIVERY,
      headers: {
        'linear-delivery': DELIVERY,
        'linear-event': 'Issue',
        'linear-action': 'create',
        'linear-timestamp': String(NOW),
      },
    })
    expect(new TextDecoder().decode(published[0]?.value)).toBe(rawBody)
    expect(published[0]?.headers['linear-signature']).toBeUndefined()
    expect(submissions).toHaveLength(1)
    const submission = submissions[0]!
    expect(submission.deliveryId).toBe(DELIVERY)
    expect(submission.signal).toBeInstanceOf(AbortSignal)
    expect(submission.payload).toMatchObject({
      agentRef: { name: 'codex-linear-agent' },
      idempotencyKey: DELIVERY,
      implementation: {
        summary: 'Implement source-bound Linear MCP',
        text: 'Do not leak this issue description into logs.',
        source: {
          provider: 'linear',
          externalId: 'PROOMPT-123',
          url: 'https://linear.app/proompteng/issue/PROOMPT-123/implement-source-bound-linear-mcp',
        },
        metadata: {
          issueId: ISSUE_ID,
          deliveryId: DELIVERY,
          action: 'create',
          sourceVersion: 1,
        },
      },
      parameters: {
        repository: 'proompteng/lab',
        base: 'main',
        head: `codex/linear-proompt-123-${DELIVERY}`,
      },
    })
    const serialized = JSON.stringify(submission.payload)
    expect(serialized).not.toContain('team')
    expect(serialized).not.toContain('project')
    expect((submission.payload.goal as Record<string, unknown>).tokenBudget).toBeUndefined()
    expect((submission.payload.parameters as Record<string, unknown>).prompt).toBeUndefined()
  })

  it('triggers only when an update proves the trigger label was added', async () => {
    const added = makeHarness()
    const addedResponse = await added.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labelIds: ['another-label-id'] },
        }),
      ),
    )
    expect(addedResponse.status).toBe(200)
    expect(added.submissions).toHaveLength(1)

    const alreadyPresent = makeHarness()
    await alreadyPresent.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labelIds: [LABEL_ID] },
        }),
      ),
    )
    expect(alreadyPresent.submissions).toHaveLength(0)

    const unrelated = makeHarness()
    await unrelated.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { stateId: 'old-state' },
        }),
      ),
    )
    expect(unrelated.submissions).toHaveLength(0)

    const previouslyUnset = makeHarness()
    await previouslyUnset.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labelIds: null },
        }),
      ),
    )
    expect(previouslyUnset.submissions).toHaveLength(1)

    const malformedPriorLabels = makeHarness()
    await malformedPriorLabels.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labels: 'not-an-array' },
        }),
      ),
    )
    expect(malformedPriorLabels.submissions).toHaveLength(0)

    const malformedPriorLabelIds = makeHarness()
    await malformedPriorLabelIds.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labelIds: [{ id: 'another-label-id' }] },
        }),
      ),
    )
    expect(malformedPriorLabelIds.submissions).toHaveLength(0)

    const malformedPriorLabelObjects = makeHarness()
    await malformedPriorLabelObjects.handler(
      signedRequest(
        issuePayload({
          action: 'update',
          updatedFrom: { labels: [{ id: 'another-label-id' }] },
        }),
      ),
    )
    expect(malformedPriorLabelObjects.submissions).toHaveLength(0)
  })

  it('ignores label removal, ordinary updates, comments, and remove actions while retaining the audit event', async () => {
    const cases: Array<{ payload: unknown; event?: string }> = [
      {
        payload: issuePayload({
          action: 'update',
          data: {
            ...issuePayload().data,
            labels: [],
            labelIds: [],
          },
          updatedFrom: { labelIds: [LABEL_ID] },
        }),
      },
      { payload: issuePayload({ action: 'update', updatedFrom: { stateId: 'old-state' } }) },
      {
        event: 'Comment',
        payload: {
          action: 'create',
          type: 'Comment',
          data: { id: 'comment-1', body: 'done' },
          webhookTimestamp: NOW,
        },
      },
      { payload: issuePayload({ action: 'remove' }) },
    ]

    for (const [index, testCase] of cases.entries()) {
      const harness = makeHarness()
      const response = await harness.handler(
        signedRequest(testCase.payload, {
          delivery: `234d1a4e-b617-4388-90fe-adc3633d6b7${index}`,
          event: testCase.event,
        }),
      )
      expect(response.status).toBe(200)
      expect(harness.submissions).toHaveLength(0)
      expect(harness.published).toHaveLength(1)
    }
  })

  it('deduplicates a completed delivery before Kafka and Agents side effects', async () => {
    const { handler, submissions, published } = makeHarness()

    expect((await handler(signedRequest(issuePayload()))).status).toBe(200)
    const duplicate = await handler(signedRequest(issuePayload()))

    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toEqual({ status: 'duplicate', deliveryId: DELIVERY })
    expect(submissions).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  it('rejects invalid signatures before parsing or logging sensitive fields', async () => {
    const { handler, submissions, published } = makeHarness()
    const payload = issuePayload()
    const body = JSON.stringify(payload)
    const invalidSignature = '0'.repeat(64)

    const response = await handler(signedRequest(payload, { body, signature: invalidSignature }))

    expect(response.status).toBe(401)
    expect(submissions).toHaveLength(0)
    expect(published).toHaveLength(0)
    const logs = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls])
    expect(logs).not.toContain(body)
    expect(logs).not.toContain('Do not leak this issue description into logs.')
    expect(logs).not.toContain('actor@example.test')
    expect(logs).not.toContain(invalidSignature)
  })

  it('rejects stale header and payload timestamps', async () => {
    const staleHeader = makeHarness()
    expect((await staleHeader.handler(signedRequest(issuePayload(), { timestamp: NOW - 60_001 }))).status).toBe(401)

    const stalePayload = makeHarness()
    expect((await stalePayload.handler(signedRequest(issuePayload({ webhookTimestamp: NOW - 60_001 })))).status).toBe(
      401,
    )
    expect(staleHeader.submissions).toHaveLength(0)
    expect(stalePayload.submissions).toHaveLength(0)
  })

  it('rejects malformed JSON, non-JSON content, and oversized bodies', async () => {
    const malformed = makeHarness()
    const malformedBody = '{"webhookTimestamp":'
    expect(
      (
        await malformed.handler(
          signedRequest(
            {},
            {
              body: malformedBody,
              signature: createHmac('sha256', SECRET).update(malformedBody).digest('hex'),
            },
          ),
        )
      ).status,
    ).toBe(400)

    const wrongType = makeHarness()
    expect((await wrongType.handler(signedRequest(issuePayload(), { contentType: 'text/plain' }))).status).toBe(415)

    const smallConfig: WebhookConfig = {
      ...config,
      linear: { ...config.linear, maxBodyBytes: 32 },
    }
    const oversized = makeHarness({ config: smallConfig })
    expect((await oversized.handler(signedRequest(issuePayload()))).status).toBe(413)
  })

  it("cancels a slow request body before Linear's response deadline without pre-verification logging", async () => {
    const metrics: LinearWebhookMetrics = {
      recordVerificationFailure: vi.fn(),
      recordDownstreamFailure: vi.fn(),
      recordDeliveryLatencyMs: vi.fn(),
    }
    const harness = makeHarness({ metrics, responseBudgetMs: 10 })
    const body = new ReadableStream<Uint8Array>()
    const request = new Request('https://froussard.test/webhooks/linear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    expect((await harness.handler(request)).status).toBe(500)
    expect(metrics.recordDownstreamFailure).toHaveBeenCalledWith('processing', 'body-timeout')
    expect(infoSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('rejects a Linear issue payload without an immutable UUID', async () => {
    const harness = makeHarness()
    const payload = issuePayload()
    payload.data.id = 'PROOMPT-123'

    expect((await harness.handler(signedRequest(payload))).status).toBe(400)
    expect(harness.submissions).toHaveLength(0)
    expect(harness.published).toHaveLength(1)
  })

  it('returns 500 on Kafka failure and releases the delivery for a successful retry', async () => {
    let shouldFail = true
    const submissions: Parameters<AgentRunSubmitter>[0][] = []
    const submit: AgentRunSubmitter = async (input) => {
      submissions.push(input)
      return { ok: true, status: 201, body: { ok: true } }
    }
    const harness = makeHarness({
      submit,
      publish: async () => {
        if (shouldFail) throw new Error('Kafka unavailable')
      },
    })

    expect((await harness.handler(signedRequest(issuePayload()))).status).toBe(500)
    shouldFail = false
    expect((await harness.handler(signedRequest(issuePayload()))).status).toBe(200)
    expect(submissions).toHaveLength(2)
  })

  it('returns 500 on Agents failure and releases the delivery for retry', async () => {
    let shouldFail = true
    const submit: AgentRunSubmitter = async () =>
      shouldFail
        ? { ok: false, status: 503, body: null, error: 'unavailable' }
        : { ok: true, status: 201, body: { ok: true } }
    const harness = makeHarness({ submit })

    expect((await harness.handler(signedRequest(issuePayload()))).status).toBe(500)
    shouldFail = false
    expect((await harness.handler(signedRequest(issuePayload()))).status).toBe(200)
  })

  it("aborts a slow Agents submission before Linear's delivery deadline", async () => {
    let signal: AbortSignal | null | undefined
    const submit: AgentRunSubmitter = (input) => {
      signal = input.signal
      return new Promise((resolve) => {
        input.signal?.addEventListener('abort', () => {
          resolve({ ok: false, status: 0, body: null, error: 'aborted' })
        })
      })
    }
    const timeoutConfig: WebhookConfig = {
      ...config,
      linear: { ...config.linear, agentsTimeoutMs: 10 },
    }
    const harness = makeHarness({ config: timeoutConfig, submit })

    const response = await harness.handler(signedRequest(issuePayload()))

    expect(response.status).toBe(500)
    expect(signal?.aborted).toBe(true)
  })

  it('records bounded verification, downstream, and latency metric dimensions', async () => {
    const events: string[] = []
    const metrics: LinearWebhookMetrics = {
      recordVerificationFailure: (reason) => events.push(`verification:${reason}`),
      recordDownstreamFailure: (dependency, reason) => events.push(`downstream:${dependency}:${reason}`),
      recordDeliveryLatencyMs: (duration, outcome) => events.push(`latency:${duration}:${outcome}`),
    }

    const rejected = makeHarness({ metrics })
    expect((await rejected.handler(signedRequest(issuePayload(), { signature: '0'.repeat(64) }))).status).toBe(401)

    const failed = makeHarness({
      metrics,
      publish: async () => {
        throw new Error('Kafka unavailable')
      },
    })
    expect((await failed.handler(signedRequest(issuePayload()))).status).toBe(500)

    expect(events).toContain('verification:signature')
    expect(events).toContain('downstream:kafka:failure')
    expect(events).toContain('latency:0:rejected')
    expect(events).toContain('latency:0:retry')
    expect(events.every((event) => !event.includes(ISSUE_ID))).toBe(true)
  })
})
