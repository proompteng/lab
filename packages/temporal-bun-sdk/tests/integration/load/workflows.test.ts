import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../../src/common/payloads'
import { CommandType } from '../../../src/proto/temporal/api/enums/v1/command_type_pb'
import { WorkflowExecutor } from '../../../src/workflow/executor'
import { WorkflowRegistry } from '../../../src/workflow/registry'
import { workerLoadActivityWorkflow } from './workflows'

test('worker load activity workflow schedules activities with configured timeout budgets', async () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  registry.register(workerLoadActivityWorkflow)

  const output = await executor.execute({
    workflowType: 'workerLoadActivityWorkflow',
    arguments: [
      {
        bursts: 1,
        computeIterations: 1_000,
        activityDelayMs: 175,
        payloadBytes: 512,
        activityHeartbeatTimeoutMs: 11_000,
        activityStartToCloseTimeoutMs: 31_000,
        activityScheduleToStartTimeoutMs: 61_000,
        activityScheduleToCloseTimeoutMs: 92_000,
      },
    ],
    workflowId: 'load-timeout-workflow',
    runId: 'load-timeout-run',
    namespace: 'default',
    taskQueue: 'load-timeout-task-queue',
  })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(1)
  const command = output.commands[0]
  expect(command.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  expect(command.attributes.case).toBe('scheduleActivityTaskCommandAttributes')
  if (command.attributes.case === 'scheduleActivityTaskCommandAttributes') {
    expect(durationMillis(command.attributes.value.heartbeatTimeout)).toBe(11_000)
    expect(durationMillis(command.attributes.value.startToCloseTimeout)).toBe(31_000)
    expect(durationMillis(command.attributes.value.scheduleToStartTimeout)).toBe(61_000)
    expect(durationMillis(command.attributes.value.scheduleToCloseTimeout)).toBe(92_000)
  }
})

const durationMillis = (duration: { seconds?: bigint | number; nanos?: number } | undefined): number => {
  if (!duration) {
    return 0
  }
  return Number(duration.seconds ?? 0) * 1_000 + Math.trunc((duration.nanos ?? 0) / 1_000_000)
}
