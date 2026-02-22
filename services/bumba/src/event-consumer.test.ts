import { afterEach, expect, test } from 'bun:test'
import type { TemporalConfig } from '@proompteng/temporal-bun-sdk'

import { __test__, createGithubEventConsumer } from './event-consumer'

const ENV_KEYS = [
  'BUMBA_GITHUB_EVENT_CONSUMER_ENABLED',
  'BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS',
  'BUMBA_GITHUB_EVENT_BATCH_SIZE',
  'BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS',
  'BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES',
  'BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS',
  'BUMBA_GITHUB_EVENT_ROUTING_ALIGNMENT_ENABLED',
  'TEMPORAL_TASK_QUEUE',
  'TEMPORAL_WORKER_DEPLOYMENT_NAME',
  'BUMBA_WORKSPACE_ROOT',
  'CODEX_CWD',
  'DATABASE_URL',
] as const

const envSnapshot = new Map<string, string | undefined>()
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key])
}

afterEach(() => {
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

  const paths = __test__.extractEventFilePaths(payload, 200)
  expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/z.ts'])
})

test('extractEventFilePaths honors max target limit', () => {
  const payload = {
    commits: [
      {
        added: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
    ],
  }

  const paths = __test__.extractEventFilePaths(payload, 2)
  expect(paths).toEqual(['src/a.ts', 'src/b.ts'])
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
  expect(config.maxEventFileTargets).toBe(55)
  expect(config.maxDispatchFailures).toBe(3)
  expect(config.nonterminalIngestionStaleMs).toBe(600000)
  expect(config.routingAlignmentEnabled).toBe(false)
  expect(config.taskQueue).toBe('jangar')
  expect(config.repoRoot).toBe('/workspace/lab')
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
