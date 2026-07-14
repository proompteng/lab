import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'
import type { TemporalConfig } from '@proompteng/temporal-bun-sdk'

import { __test__, createGithubEventConsumer, runGitFetchWithPublicFallback } from './event-consumer'

const ENV_KEYS = [
  'BUMBA_GITHUB_EVENT_CONSUMER_ENABLED',
  'BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS',
  'BUMBA_GITHUB_EVENT_BATCH_SIZE',
  'BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK',
  'BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS',
  'BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES',
  'BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS',
  'BUMBA_ATLAS_DEFAULT_REF',
  'TEMPORAL_TASK_QUEUE',
  'BUMBA_WORKSPACE_ROOT',
  'CODEX_CWD',
  'DATABASE_URL',
  'AGENTS_SERVICE_BASE_URL',
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
    taskQueue: 'bumba',
    repoRoot: '/workspace/lab',
    defaultRef: 'main',
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

test('processEvent starts one repository reconciliation regardless of changed-file payload size', async () => {
  const event = githubPushEvent(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  const starts: Array<{ ref: string; commit: string }> = []
  const result = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, {
    getCounts: async () => ingestionCounts(),
    getWorkflowIds: async () => new Set<string>(),
    startWorkflow: async (_client, _config, _event, ref, commit) => {
      starts.push({ ref, commit })
      return {} as never
    },
  })

  expect(result).toMatchObject({ dispatchStarted: 1, dispatchAlreadyStarted: 0, dispatchFailed: 0 })
  expect(starts).toEqual([{ ref: 'main', commit: 'abcdef1234567890' }])
})

test('processEvent ignores non-default-branch pushes', async () => {
  const event = githubPushEvent(['src/a.ts'], 'refs/heads/feature')
  let starts = 0
  let processed = 0
  const result = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, {
    startWorkflow: async () => {
      starts += 1
      return {} as never
    },
    markProcessed: async () => {
      processed += 1
    },
  })

  expect(result.processed).toBe(true)
  expect(starts).toBe(0)
  expect(processed).toBe(1)
})

test('processEvent does not duplicate a reconciliation already recorded for the event', async () => {
  const event = githubPushEvent(['src/a.ts'])
  const workflowId = __test__.buildAtlasReconciliationWorkflowId(event.repository)
  let starts = 0
  const result = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, {
    getCounts: async () => ingestionCounts({ total: 1, nonterminal: 1, oldestNonterminalStartedAt: Date.now() }),
    getWorkflowIds: async () => new Set([workflowId]),
    startWorkflow: async () => {
      starts += 1
      return {} as never
    },
  })

  expect(result).toMatchObject({ waitingOnIngestion: true, dispatchStarted: 0, dispatchAlreadyStarted: 1 })
  expect(starts).toBe(0)
})

test('startEventWorkflow uses the one repository-scoped reconciliation ID', async () => {
  let options: Record<string, unknown> | undefined
  const client = {
    workflow: {
      start: async (input: Record<string, unknown>) => {
        options = input
        return {} as never
      },
    },
  }
  const event = githubPushEvent(['src/a.ts'])

  await __test__.startEventWorkflow(client as never, eventConsumerConfig(), event, 'main', 'abcdef1234567890')

  expect(options?.workflowId).toBe(__test__.buildAtlasReconciliationWorkflowId(event.repository))
  expect(options?.workflowType).toBe('reconcileAtlasRepository')
  expect(options?.args).toEqual([
    {
      repoRoot: '/workspace/lab',
      repository: 'proompteng/lab',
      ref: 'main',
      commit: 'abcdef1234567890',
      eventDeliveryId: 'delivery-1',
    },
  ])
  expect(options?.workflowIdReusePolicy).toBe(1)
})

test('startMainMergeNoteWorkflow creates a delivery-scoped durable workflow', async () => {
  let options: Record<string, unknown> | undefined
  const client = {
    workflow: {
      start: async (input: Record<string, unknown>) => {
        options = input
        return {} as never
      },
    },
  }
  const event = githubPushEvent(['src/a.ts'])

  await __test__.startMainMergeNoteWorkflow(client as never, eventConsumerConfig(), {
    eventId: event.id,
    deliveryId: event.delivery_id,
    repoRoot: '/workspace/lab',
    ref: 'refs/heads/main',
    commit: 'abcdef1234567890',
  })

  expect(options?.workflowId).toBe(__test__.buildMainMergeNoteWorkflowId(event.delivery_id))
  expect(options?.workflowType).toBe('publishMainMergeMemoryNote')
  expect(options?.workflowIdReusePolicy).toBe(2)
})

test('processEvent schedules the main merge note workflow before marking a fully terminal event processed', async () => {
  const event = githubPushEvent(['src/a.ts', 'src/b.ts'])
  const calls: string[] = []
  const result = await __test__.processEvent({} as never, {} as never, eventConsumerConfig(), event, {
    getCounts: async () => ingestionCounts({ total: 1, terminal: 1 }),
    getWorkflowIds: async () => new Set<string>(),
    startWorkflow: async () => {
      throw new Error('WorkflowExecutionAlreadyStarted')
    },
    startMainMergeNoteWorkflow: async (_client, _config, input) => {
      calls.push(`note:${input.deliveryId}:${input.ref}:${input.commit}`)
    },
    markProcessed: async (_db, deliveryId) => {
      calls.push(`processed:${deliveryId}`)
    },
  })

  expect(result.processed).toBe(true)
  expect(calls).toEqual(['note:delivery-1:main:abcdef1234567890', 'processed:delivery-1'])
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
    '/workspace/lab',
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
        decision: 'save',
        reason: 'The merge establishes a durable retry and completion invariant.',
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
              decision: 'save',
              reason: 'The merge establishes a durable completion invariant.',
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
    decision: 'save',
    reason: 'The merge establishes a durable completion invariant.',
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
  expect(messages[0]?.content).toContain('most merges should be skipped')
  expect(messages[0]?.content).toContain('Skip image or build-ID promotions')
  expect(messages[0]?.content).toContain('GitHub smart-HTTP Git authentication requires Basic credentials')
  expect(messages[0]?.content).toContain(
    'never invent a command, credential source, endpoint, or operational procedure',
  )
  expect(messages[0]?.content).toContain('Keep Flamingo completion and the Agents memory endpoint distinct.')
  expect(userContent).toContain('Deterministic workflow IDs prevent duplicates.')
  expect(userContent).toContain('+retry missing targets')
  expect(userContent.indexOf('File: src/a.ts')).toBeLessThan(
    userContent.indexOf('File: .github/workflows/bumba-ci.yml'),
  )
})

test('publishMainMergeMemoryNote does not persist a low-value merge', async () => {
  process.env.AGENTS_SERVICE_BASE_URL = 'http://agents.test'
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    return Response.json({ ok: true, count: 0 })
  }) as typeof fetch

  const event = githubPushEvent(['argocd/applications/bumba/deployment.yaml'])
  await __test__.publishMainMergeMemoryNote(
    {} as never,
    '/workspace/lab',
    event,
    event.payload,
    'refs/heads/main',
    'abcdef1234567890',
    ['argocd/applications/bumba/deployment.yaml'],
    ingestionCounts({ total: 1, terminal: 1 }),
    {
      loadEnrichments: async () => [],
      loadDiff: async () => [
        {
          path: 'argocd/applications/bumba/deployment.yaml',
          status: 'modified',
          patch: '- value: bumba@old\n+ value: bumba@new',
        },
      ],
      generateNote: async () => ({
        decision: 'skip',
        reason: 'The merge only promotes an existing binary and adds no durable system knowledge.',
        summary: '',
        content: '',
        tags: [],
      }),
    },
  )

  expect(requests).toEqual([
    {
      url: 'http://agents.test/v1/memory-notes/count?namespace=bumba-main-delivery-1',
      method: 'GET',
    },
  ])
})

test('normalizeGeneratedMemoryNote requires an explicit save or skip decision', () => {
  expect(
    __test__.normalizeGeneratedMemoryNote({
      decision: 'skip',
      reason: 'Routine image promotion.',
      summary: '',
      content: '',
      tags: [],
    }),
  ).toEqual({
    decision: 'skip',
    reason: 'Routine image promotion.',
    summary: '',
    content: '',
    tags: [],
  })
  expect(() =>
    __test__.normalizeGeneratedMemoryNote({ summary: 'Diff summary', content: 'Restates the diff.', tags: [] }),
  ).toThrow('decision to save or skip')
})

test('loadMainMergeDiff reads exact change evidence from the local repository clone', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'bumba-event-diff-'))
  const runGit = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }

  try {
    runGit('init')
    runGit('config', 'user.email', 'bumba@test.invalid')
    runGit('config', 'user.name', 'Bumba Test')
    runGit('config', 'commit.gpgsign', 'false')
    await mkdir(join(repoRoot, 'src'))
    await mkdir(join(repoRoot, 'docs'))
    await writeFile(join(repoRoot, 'src/a.ts'), 'export const value = "old"\n')
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(repoRoot, `docs/${index}.md`), `old-${index}-${'x'.repeat(5_000)}\n`)
    }
    runGit('add', '.')
    runGit('commit', '-m', 'initial')
    const before = runGit('rev-parse', 'HEAD')

    await writeFile(join(repoRoot, 'src/a.ts'), 'export const value = "new"\n')
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(repoRoot, `docs/${index}.md`), `new-${index}-${'y'.repeat(5_000)}\n`)
    }
    runGit('add', '.')
    runGit('commit', '-m', 'change')
    const after = runGit('rev-parse', 'HEAD')

    const diff = await __test__.loadMainMergeDiff(repoRoot, { before }, after)
    expect(diff.length).toBeLessThan(11)
    expect(diff[0]).toMatchObject({ path: 'src/a.ts', status: 'changed' })
    expect(diff[0]?.patch).toContain('-export const value = "old"')
    expect(diff[0]?.patch).toContain('+export const value = "new"')
    expect(diff.reduce((total, file) => total + (file.patch?.length ?? 0), 0)).toBeLessThanOrEqual(36_000)
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
})

test('missing merge commits are fetched with GitHub auth and without auto-maintenance', () => {
  const previousGithubToken = process.env.GITHUB_TOKEN
  const previousGhToken = process.env.GH_TOKEN
  process.env.GITHUB_TOKEN = 'github-token'
  process.env.GH_TOKEN = 'fallback-token'

  try {
    expect(__test__.buildAuthenticatedGitArgs(['fetch', '--no-auto-maintenance', 'origin', 'deadbeef'])).toEqual([
      '-c',
      'http.extraheader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2l0aHViLXRva2Vu',
      'fetch',
      '--no-auto-maintenance',
      'origin',
      'deadbeef',
    ])
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGithubToken
    if (previousGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousGhToken
  }
})

test('failed authenticated git fetch retries anonymously for public repositories', async () => {
  const previousGithubToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'stale-token'
  const calls: Array<{ args: string[]; allowFailure: boolean | undefined }> = []

  try {
    const result = await runGitFetchWithPublicFallback(
      ['fetch', '--no-auto-maintenance', 'origin', 'deadbeef'],
      async (args, allowFailure) => {
        calls.push({ args, allowFailure })
        return { exitCode: calls.length === 1 ? 128 : 0 }
      },
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([
      {
        args: [
          '-c',
          'http.extraheader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46c3RhbGUtdG9rZW4=',
          'fetch',
          '--no-auto-maintenance',
          'origin',
          'deadbeef',
        ],
        allowFailure: true,
      },
      {
        args: ['fetch', '--no-auto-maintenance', 'origin', 'deadbeef'],
        allowFailure: undefined,
      },
    ])
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGithubToken
  }
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
    '/workspace/lab',
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

test('resolveConsumerConfig reads environment overrides', () => {
  process.env.BUMBA_GITHUB_EVENT_CONSUMER_ENABLED = 'false'
  process.env.BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS = '2500'
  process.env.BUMBA_GITHUB_EVENT_BATCH_SIZE = '11'
  process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK = '2'
  process.env.BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS = '55'
  process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES = '3'
  process.env.BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS = '600000'
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

test('runEventConsumerTick serializes reconciliation per repository while allowing another repository', async () => {
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
      repository: 'proompteng/other',
      payload: {},
    },
    {
      id: 'event-dispatch-2',
      delivery_id: 'dispatch-2',
      event_type: 'push',
      repository: 'proompteng/other',
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
      taskQueue: 'bumba',
      repoRoot: '/workspace/lab',
      defaultRef: 'main',
    },
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: new Map(),
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

  expect(processedDeliveries).toEqual(['waiting-1', 'dispatch-1'])
  expect(dispatchedDeliveries).toEqual(['dispatch-1'])
})

test('runEventConsumerTick blocks later events behind an already-started repository reconciliation', async () => {
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
      taskQueue: 'bumba',
      repoRoot: '/workspace/lab',
      defaultRef: 'main',
    },
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: failureCounts,
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

  expect(processedDeliveries).toEqual(['duplicate-1'])
  expect(dispatchedDeliveries).toEqual([])
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
  const second = {
    ...githubPushEvent(['src/b.ts']),
    id: 'event-2',
    delivery_id: 'delivery-2',
    repository: 'proompteng/other',
  }
  const attempted: string[] = []

  await __test__.runEventConsumerTick({
    db: {} as never,
    client: {} as never,
    config: eventConsumerConfig({ batchSize: 2 }),
    inFlightDeliveries: new Set(),
    dispatchFailureCounts: new Map(),
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
