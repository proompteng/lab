import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import Long from 'long'
import { defaultPayloadConverter } from '@temporalio/common'
import { coresdk } from '@temporalio/proto'
import { WorkflowEngine } from '../src/workflow/runtime'

const WORKFLOWS_PATH = fileURLToPath(new URL('./fixtures/workflows/simple.workflow.ts', import.meta.url))

const toTimestamp = () => {
  const now = Date.now()
  const seconds = Math.floor(now / 1_000)
  const nanos = (now % 1_000) * 1_000_000
  return { seconds: Long.fromNumber(seconds), nanos }
}

const buildActivationBase = (runId: string): coresdk.workflow_activation.WorkflowActivation =>
  coresdk.workflow_activation.WorkflowActivation.create({
    runId,
    historyLength: 0,
    historySizeBytes: Long.fromNumber(0, true),
    isReplaying: false,
    timestamp: toTimestamp(),
  })

const encodeArgs = (...args: unknown[]) => args.map((value) => defaultPayloadConverter.toPayload(value)!)

describe('WorkflowEngine', () => {
  test('completes a simple workflow in a single activation', async () => {
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH })
    const activation = buildActivationBase('run-simple')
    activation.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'simple-001',
          workflowType: 'simpleWorkflow',
          randomnessSeed: Long.fromNumber(4),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-simple',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          arguments: encodeArgs('Temporal'),
        },
      }),
    ]

    let result
    try {
      result = await engine.processWorkflowActivation(activation, {
        namespace: 'default',
        taskQueue: 'unit-test',
      })
    } catch (error) {
      throw error
    }

    const success = result.completion.successful
    expect(success).toBeTruthy()
    const command = success?.commands?.[0]
    expect(command?.completeWorkflowExecution).toBeDefined()
    const payload = command?.completeWorkflowExecution?.result
    const value = payload ? defaultPayloadConverter.fromPayload(payload) : undefined
    expect(value).toBe('hello Temporal')
  })

  test('schedules timers and completes after firing', async () => {
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH })
    const activation = buildActivationBase('run-timer')
    activation.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'timer-001',
          workflowType: 'timerWorkflow',
          randomnessSeed: Long.fromNumber(8),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-timer',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          arguments: encodeArgs(1),
        },
      }),
    ]

    let first
    try {
      first = await engine.processWorkflowActivation(activation, {
        namespace: 'default',
        taskQueue: 'unit-test',
      })
    } catch (error) {
      throw error
    }

    const startTimerCommand = first.completion.successful?.commands?.find((cmd) => cmd.startTimer)
    const timerSeq = startTimerCommand?.startTimer?.seq ?? 0

    const timerActivation = buildActivationBase('run-timer')
    timerActivation.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        fireTimer: { seq: timerSeq ?? 0 },
      }),
    ]

    let second
    try {
      second = await engine.processWorkflowActivation(timerActivation, {
        namespace: 'default',
        taskQueue: 'unit-test',
      })
    } catch (error) {
      console.error('timer final error', error)
      throw error
    }

    const completionCommand = second.completion.successful?.commands?.find((cmd) => cmd.completeWorkflowExecution)
    expect(completionCommand?.completeWorkflowExecution).toBeDefined()
    const payload = completionCommand?.completeWorkflowExecution?.result
    const value = payload ? defaultPayloadConverter.fromPayload(payload) : undefined
    expect(value).toBe('timer fired')
  })
})
