import { expect, test } from 'bun:test'

import { readWorkerLoadConfig } from './config'

test('worker load config reads restart and sticky TTL failure-injection controls', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_RESTART_AFTER_SUBMIT: '1',
      TEMPORAL_LOAD_TEST_RESTART_DELAY_MS: '250',
      TEMPORAL_LOAD_TEST_STICKY_TTL_MS: '1000',
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_RATIO: '0.75',
      TEMPORAL_LOAD_TEST_ACTIVITY_CANCELLATION_DELAY_MS: '125',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.restartAfterSubmit).toBeTrue()
      expect(config.restartDelayMs).toBe(250)
      expect(config.stickyTtlMs).toBe(1000)
      expect(config.activityCancellationRatio).toBe(0.75)
      expect(config.activityCancellationDelayMs).toBe(125)
    },
  )
})

test('worker load config uses release-safe activity timeouts by default', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_ACTIVITY_HEARTBEAT_TIMEOUT_MS: undefined,
      TEMPORAL_LOAD_TEST_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS: undefined,
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS: undefined,
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS: undefined,
      TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS: '175',
      TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS: '4',
      TEMPORAL_LOAD_TEST_WORKFLOWS: '1000',
      TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY: '50',
      TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY: '80',
      TEMPORAL_LOAD_TEST_DESCRIBE_CONCURRENCY: undefined,
      TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS: undefined,
      TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS: undefined,
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.activityHeartbeatTimeoutMs).toBe(30_000)
      expect(config.activityStartToCloseTimeoutMs).toBe(60_000)
      expect(config.activityScheduleToStartTimeoutMs).toBe(90_000)
      expect(config.activityScheduleToCloseTimeoutMs).toBe(150_000)
      expect(config.workflowPollP95TargetMs).toBe(6_000)
      expect(config.activityPollP95TargetMs).toBe(6_000)
      expect(config.workflowDescribeConcurrency).toBe(32)
      expect(config.workflowDurationBudgetMs).toBe(300_000)
    },
  )
})

test('worker load config keeps small smoke timeout compact', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_TIMEOUT_MS: undefined,
      TEMPORAL_LOAD_TEST_WORKFLOWS: '64',
      TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY: '10',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.workflowDurationBudgetMs).toBe(105_000)
    },
  )
})

test('worker load config allows explicit timeout overrides', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_TIMEOUT_MS: '420000',
      TEMPORAL_LOAD_TEST_WORKFLOWS: '1000',
      TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY: '50',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.workflowDurationBudgetMs).toBe(420_000)
    },
  )
})

test('worker load config exposes bounded workflow describe concurrency', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_WORKFLOWS: '1000',
      TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY: '50',
      TEMPORAL_LOAD_TEST_DESCRIBE_CONCURRENCY: '64',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.workflowDescribeConcurrency).toBe(64)
    },
  )
})

test('worker load config clamps workflow describe concurrency', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_DESCRIBE_CONCURRENCY: '256',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.workflowDescribeConcurrency).toBe(128)
    },
  )
})

test('worker load config exposes poll p95 overrides for runner-specific release gates', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS: '12000',
      TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS: '11000',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.workflowPollP95TargetMs).toBe(12_000)
      expect(config.activityPollP95TargetMs).toBe(11_000)
    },
  )
})

test('worker load config exposes activity timeout overrides', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_ACTIVITY_HEARTBEAT_TIMEOUT_MS: '5000',
      TEMPORAL_LOAD_TEST_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS: '12000',
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS: '20000',
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS: '35000',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.activityHeartbeatTimeoutMs).toBe(5_000)
      expect(config.activityStartToCloseTimeoutMs).toBe(12_000)
      expect(config.activityScheduleToStartTimeoutMs).toBe(20_000)
      expect(config.activityScheduleToCloseTimeoutMs).toBe(35_000)
    },
  )
})

test('worker load config keeps activity timeout overrides coherent', async () => {
  await withEnvironment(
    {
      TEMPORAL_LOAD_TEST_ACTIVITY_HEARTBEAT_TIMEOUT_MS: '5000',
      TEMPORAL_LOAD_TEST_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS: '1000',
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_START_TIMEOUT_MS: '20000',
      TEMPORAL_LOAD_TEST_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT_MS: '21000',
    },
    async () => {
      const config = readWorkerLoadConfig()

      expect(config.activityHeartbeatTimeoutMs).toBe(5_000)
      expect(config.activityStartToCloseTimeoutMs).toBe(5_000)
      expect(config.activityScheduleToStartTimeoutMs).toBe(20_000)
      expect(config.activityScheduleToCloseTimeoutMs).toBe(25_000)
    },
  )
})

const withEnvironment = async <A>(env: Record<string, string | undefined>, action: () => Promise<A>): Promise<A> => {
  const snapshot = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    snapshot.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
