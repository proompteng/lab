import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  createWebhookQueue,
  postImplementationSourceWebhookHandler,
  processWebhookItem,
} from '~/server/implementation-source-webhooks'

const buildSecret = (value: string) => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 'webhook-secret', namespace: 'agents' },
  data: { token: Buffer.from(value, 'utf8').toString('base64') },
})

const buildKube = (options: {
  source: Record<string, unknown>
  secretValue: string
  applySpy?: ReturnType<typeof vi.fn>
  applyStatusSpy?: ReturnType<typeof vi.fn>
}) => {
  const apply = options.applySpy ?? vi.fn(async (resource: Record<string, unknown>) => resource)
  const applyStatus = options.applyStatusSpy ?? vi.fn(async (resource: Record<string, unknown>) => resource)
  return {
    list: vi.fn(async () => ({ items: [options.source] })),
    get: vi.fn(async (resource: string, name: string) => {
      if (resource !== 'secret') return null
      if (name !== 'webhook-secret') return null
      return buildSecret(options.secretValue)
    }),
    apply,
    applyStatus,
  }
}

const findStatus = (calls: Array<[Record<string, unknown>]>, kind: string) => {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const [resource] = calls[index] ?? []
    if (resource?.kind === kind) {
      return (resource.status ?? {}) as Record<string, unknown>
    }
  }
  return {}
}

const findCondition = (status: Record<string, unknown>, type: string) => {
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  return conditions.find((condition) => (condition as Record<string, unknown>).type === type) as
    | Record<string, unknown>
    | undefined
}

const buildQueue = () => {
  const queue = createWebhookQueue(async (item) => processWebhookItem(item, queue), {
    maxSize: 5,
    retry: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 },
    dedupeTtlMs: 10_000,
  })
  return queue
}

describe('ImplementationSource webhook handler', () => {
  it('ingests GitHub issue webhook and updates status', async () => {
    const source = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'ImplementationSource',
      metadata: { name: 'github-issues', namespace: 'agents', generation: 1 },
      spec: {
        provider: 'github',
        auth: { secretRef: { name: 'webhook-secret', key: 'token' } },
        webhook: { enabled: true },
        scope: { repository: 'proompteng/lab', labels: ['agents'] },
      },
      status: {},
    }

    const secretValue = 'super-secret'
    const apply = vi.fn(async (resource: Record<string, unknown>) => resource)
    const applyStatus = vi.fn(async (resource: Record<string, unknown>) => resource)
    const kube = buildKube({ source, secretValue, applySpy: apply, applyStatusSpy: applyStatus })
    const queue = buildQueue()

    const payload = {
      action: 'opened',
      issue: {
        number: 2519,
        title: 'Implement webhook ingestion',
        body: 'Details',
        labels: [{ name: 'agents' }],
        updated_at: '2026-01-19T00:00:00Z',
        html_url: 'https://github.com/proompteng/lab/issues/2519',
      },
      repository: { full_name: 'proompteng/lab' },
    }

    const rawBody = JSON.stringify(payload)
    const signature = createHmac('sha256', secretValue).update(rawBody, 'utf8').digest('hex')
    const response = await postImplementationSourceWebhookHandler(
      'github',
      new Request('http://localhost/api/agents/implementation-sources/webhooks/github', {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-2519',
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body: rawBody,
      }),
      { kubeClient: kube as never, now: () => '2026-01-19T00:00:00Z', queue, flushQueue: true },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 1, deduped: 0 })

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ImplementationSpec',
        metadata: expect.objectContaining({ name: 'proompteng-lab-2519-impl' }),
        spec: expect.objectContaining({ labels: ['agents'] }),
      }),
    )

    const status = findStatus(applyStatus.mock.calls as Array<[Record<string, unknown>]>, 'ImplementationSource')
    const condition = findCondition(status, 'Ready')
    expect(condition?.reason).toBe('WebhookSynced')
    expect(status.lastWebhook).toMatchObject({
      idempotencyKey: 'github:delivery-2519',
      provider: 'github',
      externalId: 'proompteng/lab#2519',
      status: 'synced',
    })
  })

  it('deduplicates webhook deliveries by idempotency key', async () => {
    const source = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'ImplementationSource',
      metadata: { name: 'github-issues', namespace: 'agents', generation: 1 },
      spec: {
        provider: 'github',
        auth: { secretRef: { name: 'webhook-secret', key: 'token' } },
        webhook: { enabled: true },
        scope: { repository: 'proompteng/lab', labels: ['agents'] },
      },
      status: {},
    }

    const secretValue = 'super-secret'
    const apply = vi.fn(async (resource: Record<string, unknown>) => resource)
    const kube = buildKube({ source, secretValue, applySpy: apply })
    const queue = buildQueue()

    const payload = {
      action: 'opened',
      issue: {
        number: 2501,
        title: 'Implement webhook ingestion',
        body: 'Details',
        labels: [{ name: 'agents' }],
        updated_at: '2026-01-19T00:00:00Z',
        html_url: 'https://github.com/proompteng/lab/issues/2501',
      },
      repository: { full_name: 'proompteng/lab' },
    }

    const rawBody = JSON.stringify(payload)
    const signature = createHmac('sha256', secretValue).update(rawBody, 'utf8').digest('hex')
    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': `sha256=${signature}`,
    }

    const response = await postImplementationSourceWebhookHandler(
      'github',
      new Request('http://localhost/api/agents/implementation-sources/webhooks/github', {
        method: 'POST',
        headers,
        body: rawBody,
      }),
      { kubeClient: kube as never, now: () => '2026-01-19T00:00:00Z', queue, flushQueue: true },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 1, deduped: 0 })

    const duplicate = await postImplementationSourceWebhookHandler(
      'github',
      new Request('http://localhost/api/agents/implementation-sources/webhooks/github', {
        method: 'POST',
        headers,
        body: rawBody,
      }),
      { kubeClient: kube as never, now: () => '2026-01-19T00:00:00Z', queue, flushQueue: true },
    )

    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, queued: 0, deduped: 1 })

    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('ingests Linear issue webhook and updates status', async () => {
    const source = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'ImplementationSource',
      metadata: { name: 'linear-issues', namespace: 'agents', generation: 1 },
      spec: {
        provider: 'linear',
        auth: { secretRef: { name: 'webhook-secret', key: 'token' } },
        webhook: { enabled: true },
        scope: { team: 'ENG', project: 'ProjectX', labels: ['agents'] },
      },
      status: {},
    }

    const secretValue = 'linear-secret'
    const apply = vi.fn(async (resource: Record<string, unknown>) => resource)
    const applyStatus = vi.fn(async (resource: Record<string, unknown>) => resource)
    const kube = buildKube({ source, secretValue, applySpy: apply, applyStatusSpy: applyStatus })
    const queue = buildQueue()

    const now = '2026-01-19T00:00:00Z'
    const timestamp = Date.parse(now)
    const payload = {
      webhookTimestamp: timestamp,
      data: {
        identifier: 'ENG-42',
        title: 'Ship webhook ingestion',
        description: 'Ship it',
        url: 'https://linear.app/team/issue/ENG-42',
        updatedAt: now,
        labels: { nodes: [{ name: 'agents' }] },
        team: { key: 'ENG' },
        project: { name: 'ProjectX' },
      },
    }

    const rawBody = JSON.stringify(payload)
    const signature = createHmac('sha256', secretValue).update(rawBody, 'utf8').digest('hex')
    const response = await postImplementationSourceWebhookHandler(
      'linear',
      new Request('http://localhost/api/agents/implementation-sources/webhooks/linear', {
        method: 'POST',
        headers: {
          'linear-event': 'issue',
          'linear-signature': signature,
        },
        body: rawBody,
      }),
      { kubeClient: kube as never, now: () => now, queue, flushQueue: true },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 1, deduped: 0 })

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ImplementationSpec',
        metadata: expect.objectContaining({ name: 'linear-eng-42-impl' }),
        spec: expect.objectContaining({ labels: ['agents'] }),
      }),
    )

    const status = findStatus(applyStatus.mock.calls as Array<[Record<string, unknown>]>, 'ImplementationSource')
    const condition = findCondition(status, 'Ready')
    expect(condition?.reason).toBe('WebhookSynced')
    expect(status.lastWebhook).toMatchObject({
      provider: 'linear',
      externalId: 'ENG-42',
      status: 'synced',
    })
  })

  it('retries on failures with backoff', async () => {
    const source = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'ImplementationSource',
      metadata: { name: 'github-issues', namespace: 'agents', generation: 1 },
      spec: {
        provider: 'github',
        auth: { secretRef: { name: 'webhook-secret', key: 'token' } },
        webhook: { enabled: true },
        scope: { repository: 'proompteng/lab', labels: [] },
      },
      status: {},
    }

    const secretValue = 'retry-secret'
    const apply = vi.fn(async (resource: Record<string, unknown>) => resource)
    apply.mockRejectedValueOnce(new Error('boom'))
    const applyStatus = vi.fn(async (resource: Record<string, unknown>) => resource)
    const kube = buildKube({ source, secretValue, applySpy: apply, applyStatusSpy: applyStatus })
    const queue = buildQueue()

    const payload = {
      action: 'opened',
      issue: {
        number: 9,
        title: 'Retry webhook',
        body: 'Details',
        labels: [],
        updated_at: '2026-01-20T00:00:00Z',
        html_url: 'https://github.com/proompteng/lab/issues/9',
      },
      repository: { full_name: 'proompteng/lab' },
    }

    const rawBody = JSON.stringify(payload)
    const signature = createHmac('sha256', secretValue).update(rawBody, 'utf8').digest('hex')
    const response = await postImplementationSourceWebhookHandler(
      'github',
      new Request('http://localhost/api/agents/implementation-sources/webhooks/github', {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-9',
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body: rawBody,
      }),
      { kubeClient: kube as never, now: () => '2026-01-20T00:00:00Z', queue, flushQueue: true },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 1, deduped: 0 })
    expect(apply).toHaveBeenCalledTimes(2)
    const status = findStatus(applyStatus.mock.calls as Array<[Record<string, unknown>]>, 'ImplementationSource')
    expect(status.lastWebhook).toMatchObject({
      idempotencyKey: 'github:delivery-9',
      status: 'synced',
      attempts: 2,
    })
  })
})
