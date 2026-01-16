import { afterAll, beforeAll, expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'

import { createTemporalClient } from '../../src/client'
import { durationFromMillis } from '../../src/common/duration'
import { loadTemporalConfig } from '../../src/config'
import { ScheduleSchema, ScheduleSpecSchema, IntervalSpecSchema } from '../../src/proto/temporal/api/schedule/v1/message_pb'
import { WorkflowTypeSchema } from '../../src/proto/temporal/api/common/v1/message_pb'
import { TaskQueueSchema } from '../../src/proto/temporal/api/taskqueue/v1/message_pb'
import { NewWorkflowExecutionInfoSchema } from '../../src/proto/temporal/api/workflow/v1/message_pb'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, type IntegrationTestEnv } from './test-env'

let env: IntegrationTestEnv | null = null

beforeAll(async () => {
  env = await acquireIntegrationTestEnv()
})

afterAll(async () => {
  await releaseIntegrationTestEnv()
})

test('schedule client can create and manage schedules', async () => {
  if (!env) {
    throw new Error('integration env not initialised')
  }
  await env.runOrSkip('schedule-ops', async () => {
    const config = await loadTemporalConfig({
      defaults: {
        address: env.cliConfig.address,
        namespace: env.cliConfig.namespace,
        taskQueue: env.cliConfig.taskQueue,
      },
    })
    const { client } = await createTemporalClient({ config })

    const scheduleId = `schedule-${Date.now()}`
    const schedule = create(ScheduleSchema, {
      spec: create(ScheduleSpecSchema, {
        interval: [create(IntervalSpecSchema, { interval: durationFromMillis(60_000) })],
      }),
      action: {
        case: 'startWorkflow',
        value: create(NewWorkflowExecutionInfoSchema, {
          workflowId: `schedule-wf-${scheduleId}`,
          workflowType: create(WorkflowTypeSchema, { name: 'integrationActivityWorkflow' }),
          taskQueue: create(TaskQueueSchema, { name: env.cliConfig.taskQueue }),
        }),
      },
    })

    try {
      await client.schedules.create({ scheduleId, schedule, namespace: env.cliConfig.namespace })
      const described = await client.schedules.describe({ scheduleId, namespace: env.cliConfig.namespace })
      expect(described.schedule).toBeDefined()

      await client.schedules.pause({ scheduleId, namespace: env.cliConfig.namespace })
      await client.schedules.unpause({ scheduleId, namespace: env.cliConfig.namespace })

      await client.schedules.listMatchingTimes({
        scheduleId,
        namespace: env.cliConfig.namespace,
        startTime: timestampFromDate(new Date()),
        endTime: timestampFromDate(new Date(Date.now() + 60_000)),
      })
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.Unimplemented) {
        console.warn('[temporal-bun-sdk] schedule RPCs unimplemented, skipping test')
        return
      }
      throw error
    } finally {
      try {
        await client.schedules.delete({ scheduleId, namespace: env.cliConfig.namespace })
      } catch {
        // ignore cleanup failures
      }
      await client.shutdown()
    }
  })
})
