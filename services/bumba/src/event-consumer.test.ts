import { afterEach, expect, test } from 'bun:test'
import type { TemporalConfig } from '@proompteng/temporal-bun-sdk'

import { __test__, createGithubEventConsumer } from './event-consumer'

const ENV_KEYS = [
  'BUMBA_GITHUB_EVENT_CONSUMER_ENABLED',
  'BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS',
  'BUMBA_GITHUB_EVENT_BATCH_SIZE',
  'BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK',
  'BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS',
  'BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES',
  'BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS',
  'BUMBA_GITHUB_EVENT_ROUTING_ALIGNMENT_ENABLED',
  'TEMPORAL_TASK_QUEUE',
  'TEMPORAL_WORKER_DEPLOYMENT_NAME',
  'BUMBA_WORKSPACE_ROOT',
  'CODEX_CWD',
  'DATABASE_URL',
  'AGENTS_SERVICE_BASE_URL',
  'GITHUB_API_BASE_URL',
  'GITHUB_TOKEN',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_COMPLETION_MODEL',
  'OPENAI_COMPLETION_TIMEOUT_MS',
  'OPENAI_COMPLETION_MAX_OUTPUT_TOKENS',
  'BUMBA_MERGE_NOTE_REASONING_EFFORT',
] as const

const originalFetch = globalThis.fetch

const envSnapshot = new Map<string, string | undefined>()
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key])
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('extractEventFilePaths returns sorted, deduped, indexable paths', () => {
  const payload = {
    head_commit: {
      added: ['src/a.ts', 'bun.lock', 'assets/logo.png'],
      modified: ['src/z.ts'],
    },
    commits: [
      {
        added: ['src/c.ts', 'src/a.ts'],
        modified: ['src/b.ts', 'yarn.lock'],
      },
    ],
  }

  const paths = __test__.extractEventFilePaths(payload)
  expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/z.ts'])
})

test('extractEventFilePaths retains every target for batched dispatch', () => {
  const payload = {
    commits: [
      {
        added: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
    ],
  }

  const paths = __test__.extractEventFilePaths(payload)
  expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
})

const eventConsumerConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    enabled: true,
    pollIntervalMs: 10_000,
    batchSize: 20,
    maxDispatchEventsPerTick: 2,
    maxEventFileTargets: 200,
    maxDispatchFailures: 6,
    nonterminalIngestionStaleMs: 12 * 60 * 60 * 1000,
    routingAlignmentEnabled: false,
    taskQueue: 'bumba',
    repoRoot: '/workspace/lab',
    ...overrides,
  }) as never

const githubPushEvent = (files: string[], ref = 'refs/heads/main') => ({
  id: 'event-1',
  delivery_id: 'delivery-1',
  event_type: 'push',
  repository: 'proompteng/lab',
  payload: {
    before: '1234567890abcdef',
    after: 'abcdef1234567890',
    ref,
    head_commit: { id: 'abcdef1234567890', modified: files, message: 'fix: merge change' },
  },
})

const ingestionCounts = (overrides: Record<string, unknown> = {}) =>
  ({
    total: 0,
    terminal: 0,
    failed: 0,
    nonterminal: 0,
    oldestNonterminalStartedAt: null,
    ...overrides,
  }) as never

test('processEvent retries a failed target when another target already has an ingestion', async () => {
  const event = githubPushEvent(['src/a.ts', 'src/b.ts'])
  const started = new Set(['src/a.ts'])
  let failB = true

  const dependencies = {
    getCounts: async () =>
      ingestionCounts({ total: 1, terminal: 0, nonterminal: 1, oldestNonterminalStartedAt: Date.now() }),
    startWorkflow: async (_client: unknown, _config: unknown, _event: unknown, filePath: string) => {
      if (started.has(filePath)) throw new Error('WorkflowExecutionAlreadyStarted')
      if (filePath === 'src/b.ts' && failB) throw new Error('deadline exceeded')
      started.add(filePath)
      return {} as never
    },
  }

  const first = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, dependencies)
  expect(first).toMatchObject({ dispatchAlreadyStarted: 1, dispatchFailed: 1, dispatchStarted: 0 })

  failB = false
  const second = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, dependencies)
  expect(second).toMatchObject({ dispatchAlreadyStarted: 1, dispatchFailed: 0, dispatchStarted: 1 })
  expect(started).toEqual(new Set(['src/a.ts', 'src/b.ts']))
})

test('processEvent dispatches oversized events across ticks without dropping targets', async () => {
  const event = githubPushEvent(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  const started = new Set<string>()
  const dependencies = {
    getCounts: async () => ingestionCounts(),
    startWorkflow: async (_client: unknown, _config: unknown, _event: unknown, filePath: string) => {
      if (started.has(filePath)) throw new Error('WorkflowExecutionAlreadyStarted')
      started.add(filePath)
      return {} as never
    },
  }
  const config = eventConsumerConfig({ maxEventFileTargets: 2 })

  const first = await __test__.processEvent({} as never, {} as never, config, event, dependencies)
  expect(first).toMatchObject({ dispatchStarted: 2, dispatchAlreadyStarted: 0 })
  expect(started).toEqual(new Set(['src/a.ts', 'src/b.ts']))

  const second = await __test__.processEvent({} as never, {} as never, config, event, dependencies)
  expect(second).toMatchObject({ dispatchStarted: 1, dispatchAlreadyStarted: 2 })
  expect(started).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']))
})

test('processEvent publishes the main merge note before marking a fully terminal event processed', async () => {
  const event = githubPushEvent(['src/a.ts', 'src/b.ts'])
  const calls: string[] = []
  const result = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, {
    getCounts: async () => ingestionCounts({ total: 2, terminal: 2 }),
    startWorkflow: async () => {
      throw new Error('WorkflowExecutionAlreadyStarted')
    },
    publishMainMergeNote: async (_db, _event, _payload, ref, commit, files) => {
      calls.push(`note:${ref}:${commit}:${files.join(',')}`)
    },
    markProcessed: async (_db, deliveryId) => {
      calls.push(`processed:${deliveryId}`)
    },
  })

  expect(result.processed).toBe(true)
  expect(calls).toEqual(['note:refs/heads/main:abcdef1234567890:src/a.ts,src/b.ts', 'processed:delivery-1'])
})

test('main branch and memory namespace helpers are stable', () => {
  expect(__test__.isMainBranchRef('main')).toBe(true)
  expect(__test__.isMainBranchRef('refs/heads/main')).toBe(true)
  expect(__test__.isMainBranchRef('refs/heads/feature')).toBe(false)
  expect(__test__.mainMergeMemoryNamespace('delivery-1')).toBe('bumba-main-delivery-1')
})

test('publishMainMergeMemoryNote saves Flamingo-generated knowledge through the Agents endpoint', async () => {
  process.env.AGENTS_SERVICE_BASE_URL = 'http://agents.test'
  const requests: Array<{ url: string; method: string; body?: unknown }> = []
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input
    const method = init?.method ?? 'GET'
    requests.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (method === 'GET') return Response.json({ ok: true, count: 0 })
    return Response.json({ ok: true, memory: { id: 'memory-1' } }, { status: 201 })
  }) as typeof fetch

  const event = githubPushEvent(['src/a.ts'])
  await __test__.publishMainMergeMemoryNote(
    {} as never,
    event,
    event.payload,
    'refs/heads/main',
    'abcdef1234567890',
    ['src/a.ts'],
    ingestionCounts({ total: 1, terminal: 1 }),
    {
      loadEnrichments: async () => [
        { path: 'src/a.ts', summary: 'Handles events.', content: '- Retries partial dispatches.' },
      ],
      loadDiff: async () => [{ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@' }],
      generateNote: async () => ({
        summary: 'Event processing now preserves partial work.',
        content: 'Bumba retries undispatched file targets and records merge knowledge only after enrichment settles.',
        tags: ['event-consumer', 'temporal'],
      }),
    },
  )

  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({
    url: 'http://agents.test/v1/memory-notes/count?namespace=bumba-main-delivery-1',
    method: 'GET',
  })
  expect(requests[1]).toMatchObject({ url: 'http://agents.test/v1/memory-notes', method: 'POST' })
  expect(requests[1]?.body).toMatchObject({
    namespace: 'bumba-main-delivery-1',
    summary: 'Event processing now preserves partial work.',
    content: 'Bumba retries undispatched file targets and records merge knowledge only after enrichment settles.',
    tags: ['bumba', 'main', 'merge', 'event-consumer', 'temporal'],
    metadata: {
      deliveryId: 'delivery-1',
      repository: 'proompteng/lab',
      commit: 'abcdef1234567890',
      fileCount: 1,
      enrichmentCount: 1,
      diffFileCount: 1,
    },
  })
})

test('generateMainMergeMemoryNote asks Flamingo for structured durable knowledge', async () => {
  process.env.OPENAI_API_BASE_URL = 'http://flamingo.test/v1'
  process.env.OPENAI_COMPLETION_MODEL = 'qwen36-flamingo'
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Bumba preserves complete enrichment across retries.',
              content:
                'The event consumer uses deterministic workflow IDs and waits for semantic enrichment to settle.',
              tags: ['Bumba', 'Temporal', 'event-consumer'],
            }),
          },
        },
      ],
    })
  }) as typeof fetch

  const event = githubPushEvent(['src/a.ts'])
  const note = await __test__.generateMainMergeMemoryNote(
    event,
    event.payload,
    [
      {
        path: '.github/workflows/bumba-ci.yml',
        summary: 'Builds Bumba.',
        content: '- Runs CI checks.',
      },
      {
        path: 'src/a.ts',
        summary: 'Dispatches enrichment.',
        content: '- Deterministic workflow IDs prevent duplicates.',
      },
    ],
    [
      { path: '.github/workflows/bumba-ci.yml', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old behavior\n+retry missing targets' },
    ],
  )

  expect(note).toEqual({
    summary: 'Bumba preserves complete enrichment across retries.',
    content: 'The event consumer uses deterministic workflow IDs and waits for semantic enrichment to settle.',
    tags: ['bumba', 'temporal', 'event-consumer'],
  })
  expect(requestBody).toMatchObject({
    model: 'qwen36-flamingo',
    stream: false,
    temperature: 0.1,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
  })
  const messages = requestBody?.messages as Array<{ content: string }>
  const userContent = messages[1]?.content ?? ''
  expect(messages[0]?.content).toContain('knowledge that is not recoverable from a filename list or git log')
  expect(messages[0]?.content).toContain('Keep Flamingo completion and the Agents memory endpoint distinct.')
  expect(userContent).toContain('Deterministic workflow IDs prevent duplicates.')
  expect(userContent).toContain('+retry missing targets')
  expect(userContent.indexOf('File: src/a.ts')).toBeLessThan(
    userContent.indexOf('File: .github/workflows/bumba-ci.yml'),
  )
})

test('loadMainMergeDiff fetches bounded change evidence from GitHub compare', async () => {
  process.env.GITHUB_API_BASE_URL = 'http://github.test'
  process.env.GITHUB_TOKEN = 'token'
  let request: Request | undefined
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    request = new Request(input, init)
    return Response.json({
      files: [
        { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
        { filename: 'assets/logo.png', status: 'modified' },
      ],
    })
  }) as typeof fetch

  const event = githubPushEvent(['src/a.ts'])
  const diff = await __test__.loadMainMergeDiff(event, event.payload, 'abcdef1234567890')

  expect(request?.url).toBe('http://github.test/repos/proompteng/lab/compare/1234567890abcdef...abcdef1234567890')
  expect(request?.headers.get('authorization')).toBe('Bearer token')
  expect(diff).toEqual([
    { path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
    { path: 'assets/logo.png', status: 'modified', patch: null },
  ])
})

test('publishMainMergeMemoryNote ignores non-main pushes', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
  const event = githubPushEvent(['src/a.ts'], 'refs/heads/feature')

  await __test__.publishMainMergeMemoryNote(
    {} as never,
    event,
    event.payload,
    'refs/heads/feature',
    'abcdef1234567890',
    ['src/a.ts'],
    ingestionCounts({ total: 1, terminal: 1 }),
  )

  expect(called).toBe(false)
})

test('resolveEventCommit prefers after and falls back to head commit id', () => {
  const withAfter = __test__.resolveEventCommit({
    after: 'abc123',
    head_commit: { id: 'def456' },
  })
  expect(withAfter).toBe('abc123')

  const withHead = __test__.resolveEventCommit({
    head_commit: { id: 'def456' },
  })
  expect(withHead).toBe('def456')
})

test('resolveEventRef falls back to default branch then main', () => {
  const fromPayload = __test__.resolveEventRef({ ref: 'refs/heads/release' })
  expect(fromPayload).toBe('refs/heads/release')

  const fromRepository = __test__.resolveEventRef({ repository: { default_branch: 'develop' } })
  expect(fromRepository).toBe('develop')

  const fromDefault = __test__.resolveEventRef({})
  expect(fromDefault).toBe('main')
})

test('buildEventWorkflowId is deterministic for event+path', () => {
  const a = __test__.buildEventWorkflowId('delivery-1', 'src/a.ts')
  const b = __test__.buildEventWorkflowId('delivery-1', 'src/a.ts')
  const c = __test__.buildEventWorkflowId('delivery-1', 'src/b.ts')

  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

test('resolveConsumerConfig reads environment overrides', () => {
  process.env.BUMBA_GITHUB_EVENT_CONSUMER_ENABLED = 'false'
  process.env.BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS = '2500'
  process.env.BUMBA_GITHUB_EVENT_BATCH_SIZE = '11'
  process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK = '2'
  process.env.BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS = '55'
  process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES = '3'
  process.env.BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS = '600000'
  process.env.BUMBA_GITHUB_EVENT_ROUTING_ALIGNMENT_ENABLED = 'false'
  process.env.TEMPORAL_TASK_QUEUE = 'jangar'
  process.env.BUMBA_WORKSPACE_ROOT = '/workspace/lab'

  const config = __test__.resolveConsumerConfig()

  expect(config.enabled).toBe(false)
  expect(config.pollIntervalMs).toBe(2500)
  expect(config.batchSize).toBe(11)
  expect(config.maxDispatchEventsPerTick).toBe(2)
  expect(config.maxEventFileTargets).toBe(55)
  expect(config.maxDispatchFailures).toBe(3)
  expect(config.nonterminalIngestionStaleMs).toBe(600000)
  expect(config.routingAlignmentEnabled).toBe(false)
  expect(config.taskQueue).toBe('jangar')
  expect(config.repoRoot).toBe('/workspace/lab')
})

test('resolveConsumerConfig defaults dispatch limit to scan batch size', () => {
  process.env.BUMBA_GITHUB_EVENT_BATCH_SIZE = '17'
  delete process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK

  const config = __test__.resolveConsumerConfig()

  expect(config.batchSize).toBe(17)
  expect(config.maxDispatchEventsPerTick).toBe(17)
})

test('runEventConsumerTick scans past waiting rows before applying dispatch limit', async () => {
  const events = [
    {
      id: 'event-waiting-1',
      delivery_id: 'waiting-1',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
    {
      id: 'event-waiting-2',
      delivery_id: 'waiting-2',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
    {
      id: 'event-dispatch-1',
      delivery_id: 'dispatch-1',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
    {
      id: 'event-dispatch-2',
      delivery_id: 'dispatch-2',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
  ]
  const processedDeliveries: string[] = []
  const dispatchedDeliveries: string[] = []

  await __test__.runEventConsumerTick({
    db: {} as never,
    client: {} as never,
    config: {
      enabled: true,
      pollIntervalMs: 10_000,
      batchSize: events.length,
      maxDispatchEventsPerTick: 1,
      maxEventFileTargets: 200,
      maxDispatchFailures: 6,
      nonterminalIngestionStaleMs: 12 * 60 * 60 * 1000,
      routingAlignmentEnabled: false,
      taskQueue: 'bumba',
      repoRoot: '/workspace/lab',
    },
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: new Map(),
    ensureRoutingAlignment: async () => true,
    listPendingEvents: async (_db, batchSize) => {
      expect(batchSize).toBe(events.length)
      return events
    },
    processPendingEvent: async (_db, _client, _config, event) => {
      processedDeliveries.push(event.delivery_id)
      if (event.delivery_id.startsWith('waiting-')) {
        return {
          processed: false,
          waitingOnIngestion: true,
          dispatchStarted: 0,
          dispatchAlreadyStarted: 0,
          dispatchFailed: 0,
        }
      }

      dispatchedDeliveries.push(event.delivery_id)
      return {
        processed: false,
        waitingOnIngestion: false,
        dispatchStarted: 1,
        dispatchAlreadyStarted: 0,
        dispatchFailed: 0,
      }
    },
  })

  expect(processedDeliveries).toEqual(['waiting-1', 'waiting-2', 'dispatch-1'])
  expect(dispatchedDeliveries).toEqual(['dispatch-1'])
})

test('runEventConsumerTick does not count already-started rows against dispatch limit', async () => {
  const events = [
    {
      id: 'event-duplicate',
      delivery_id: 'duplicate-1',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
    {
      id: 'event-dispatch',
      delivery_id: 'dispatch-1',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
    {
      id: 'event-dispatch-2',
      delivery_id: 'dispatch-2',
      event_type: 'push',
      repository: 'proompteng/lab',
      payload: {},
    },
  ]
  const processedDeliveries: string[] = []
  const dispatchedDeliveries: string[] = []
  const failureCounts = new Map<string, number>([['duplicate-1', 1]])

  await __test__.runEventConsumerTick({
    db: {} as never,
    client: {} as never,
    config: {
      enabled: true,
      pollIntervalMs: 10_000,
      batchSize: events.length,
      maxDispatchEventsPerTick: 1,
      maxEventFileTargets: 200,
      maxDispatchFailures: 6,
      nonterminalIngestionStaleMs: 12 * 60 * 60 * 1000,
      routingAlignmentEnabled: false,
      taskQueue: 'bumba',
      repoRoot: '/workspace/lab',
    },
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: failureCounts,
    ensureRoutingAlignment: async () => true,
    listPendingEvents: async () => events,
    processPendingEvent: async (_db, _client, _config, event) => {
      processedDeliveries.push(event.delivery_id)
      if (event.delivery_id === 'duplicate-1') {
        return {
          processed: false,
          waitingOnIngestion: false,
          dispatchStarted: 0,
          dispatchAlreadyStarted: 1,
          dispatchFailed: 0,
        }
      }

      dispatchedDeliveries.push(event.delivery_id)
      return {
        processed: false,
        waitingOnIngestion: false,
        dispatchStarted: 1,
        dispatchAlreadyStarted: 0,
        dispatchFailed: 0,
      }
    },
  })

  expect(processedDeliveries).toEqual(['duplicate-1', 'dispatch-1'])
  expect(dispatchedDeliveries).toEqual(['dispatch-1'])
  expect(failureCounts.has('duplicate-1')).toBe(false)
})

test('runEventConsumerTick retains failure state for an incompletely dispatched event', async () => {
  const event = githubPushEvent(['src/a.ts'])
  const failureCounts = new Map<string, number>()

  await __test__.runEventConsumerTick({
    db: {} as never,
    client: {} as never,
    config: eventConsumerConfig({ batchSize: 1, maxDispatchFailures: 1 }),
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: failureCounts,
    ensureRoutingAlignment: async () => true,
    listPendingEvents: async () => [event],
    processPendingEvent: async () => ({
      processed: false,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchAlreadyStarted: 0,
      dispatchFailed: 1,
    }),
  })

  expect(failureCounts.get('delivery-1')).toBe(1)
})

test('runEventConsumerTick continues after one event processing error', async () => {
  const first = githubPushEvent(['src/a.ts'])
  const second = { ...githubPushEvent(['src/b.ts']), id: 'event-2', delivery_id: 'delivery-2' }
  const attempted: string[] = []

  await __test__.runEventConsumerTick({
    db: {} as never,
    client: {} as never,
    config: eventConsumerConfig({ batchSize: 2 }),
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: new Map(),
    ensureRoutingAlignment: async () => true,
    listPendingEvents: async () => [first, second],
    processPendingEvent: async (_db, _client, _config, event) => {
      attempted.push(event.delivery_id)
      if (event.delivery_id === 'delivery-1') throw new Error('Agents unavailable')
      return {
        processed: false,
        waitingOnIngestion: false,
        dispatchStarted: 1,
        dispatchAlreadyStarted: 0,
        dispatchFailed: 0,
      }
    },
  })

  expect(attempted).toEqual(['delivery-1', 'delivery-2'])
})

test('isWorkflowAlreadyStartedError recognizes Temporal already-started errors', () => {
  expect(__test__.isWorkflowAlreadyStartedError(new Error('WorkflowExecutionAlreadyStarted'))).toBe(true)
  expect(__test__.isWorkflowAlreadyStartedError(new Error('workflow already started for id'))).toBe(true)
  expect(
    __test__.isWorkflowAlreadyStartedError(new Error('[already_exists] Workflow execution is already running')),
  ).toBe(true)
  expect(__test__.isWorkflowAlreadyStartedError(new Error('deadline exceeded'))).toBe(false)
})

test('resolveWorkerDeploymentName uses env override then config default', () => {
  process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME = 'override-deployment'
  expect(
    __test__.resolveWorkerDeploymentName(
      {
        address: 'temporal-frontend.temporal.svc.cluster.local:7233',
        namespace: 'default',
        workerDeploymentName: 'config-deployment',
      } as TemporalConfig,
      'bumba',
    ),
  ).toBe('override-deployment')

  delete process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME
  expect(
    __test__.resolveWorkerDeploymentName(
      {
        address: 'temporal-frontend.temporal.svc.cluster.local:7233',
        namespace: 'default',
        workerDeploymentName: 'config-deployment',
      } as TemporalConfig,
      'bumba',
    ),
  ).toBe('config-deployment')

  expect(
    __test__.resolveWorkerDeploymentName(
      {
        address: 'temporal-frontend.temporal.svc.cluster.local:7233',
        namespace: 'default',
      } as TemporalConfig,
      'bumba',
    ),
  ).toBe('bumba-deployment')
})

test('extractCurrentDeploymentBuildId reads current deployment version build id', () => {
  expect(
    __test__.extractCurrentDeploymentBuildId({
      workerDeploymentInfo: {
        routingConfig: {
          currentDeploymentVersion: { buildId: 'bumba@abc123' },
          currentVersion: '',
        },
      },
    } as never),
  ).toBe('bumba@abc123')

  expect(
    __test__.extractCurrentDeploymentBuildId({
      workerDeploymentInfo: {
        routingConfig: {
          currentVersion: 'bumba@legacy',
        },
      },
    } as never),
  ).toBe('bumba@legacy')
})

test('routing alignment error classifiers are stable', () => {
  expect(__test__.isTransientRoutingAlignmentError(new Error('failed precondition: no pollers for build id'))).toBe(
    true,
  )
  expect(__test__.isTransientRoutingAlignmentError(new Error('Not Found: deployment missing'))).toBe(true)
  expect(__test__.isTransientRoutingAlignmentError(new Error('permission denied'))).toBe(false)

  expect(__test__.isDeploymentApiUnavailableError(new Error('unimplemented'))).toBe(true)
  expect(__test__.isDeploymentApiUnavailableError(new Error('unknown service temporal.api.workflowservice.v1'))).toBe(
    true,
  )
  expect(__test__.isDeploymentApiUnavailableError(new Error('failed precondition'))).toBe(false)
})

test('start fails fast when event consumer is enabled and DATABASE_URL is missing', async () => {
  delete process.env.DATABASE_URL
  process.env.BUMBA_GITHUB_EVENT_CONSUMER_ENABLED = 'true'

  const consumer = createGithubEventConsumer({
    address: 'temporal-frontend.temporal.svc.cluster.local:7233',
    namespace: 'default',
  } as TemporalConfig)

  await expect(consumer.start()).rejects.toThrow('DATABASE_URL is required')
  expect(consumer.isRunning()).toBe(false)
})
