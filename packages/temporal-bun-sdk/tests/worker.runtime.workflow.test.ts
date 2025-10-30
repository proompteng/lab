import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import Long from 'long'
import { coresdk, temporal } from '@temporalio/proto'
import { WorkflowEngine } from '../src/workflow/runtime'
import { applyDataConverterToWorkflowCompletion } from '../src/worker/runtime'
import {
  PAYLOAD_TUNNEL_FIELD,
  createDataConverter,
  createDefaultDataConverter,
  decodePayloadsToValues,
  encodeValuesToPayloads,
  jsonToPayload,
  payloadToJson,
} from '../src/common/payloads'
import { DefaultPayloadConverter, type PayloadCodec } from '@temporalio/common'
import { encodeValuesToPayloads } from '../src/common/payloads'

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

const dataConverter = createDefaultDataConverter()

class JsonEnvelopeCodec implements PayloadCodec {
  readonly #encoder = new TextEncoder()
  readonly #decoder = new TextDecoder()

  async encode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const serialized = JSON.stringify(payloadToJson(payload))
      return {
        metadata: { encoding: this.#encoder.encode('binary/custom') },
        data: this.#encoder.encode(serialized),
      }
    })
  }

  async decode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding ? new TextDecoder().decode(payload.metadata.encoding) : undefined
      if (encoding !== 'binary/custom') {
        return payload
      }
      const raw = this.#decoder.decode(payload.data ?? new Uint8Array(0))
      const value = raw.length === 0 ? null : JSON.parse(raw)
      return jsonToPayload(value)
    })
  }
}

class PrefixingPayloadConverter extends DefaultPayloadConverter {
  readonly #encoder = new TextEncoder()
  readonly #decoder = new TextDecoder()

  override toPayload(value: unknown) {
    if (typeof value === 'string') {
      return {
        metadata: {
          encoding: this.#encoder.encode('binary/custom'),
        },
        data: this.#encoder.encode(`codec:${value}`),
      }
    }

    return super.toPayload(value)
  }

  override fromPayload(payload: Parameters<DefaultPayloadConverter['fromPayload']>[0]) {
    const encoding = payload.metadata?.encoding ? this.#decoder.decode(payload.metadata.encoding) : undefined
    if (encoding === 'binary/custom') {
      const raw = payload.data ? this.#decoder.decode(payload.data) : ''
      if (!raw.startsWith('codec:')) {
        throw new Error('unexpected payload format')
      }
      return raw.slice('codec:'.length)
    }

    return super.fromPayload(payload)
  }
}

describe('WorkflowEngine', () => {
  test('completes a simple workflow in a single activation', async () => {
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH })
    const activation = buildActivationBase('run-simple')
    const initArgs = (await encodeValuesToPayloads(dataConverter, ['Temporal'])) ?? []
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
          arguments: initArgs,
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
    const value =
      payload && payload !== undefined
        ? (await decodePayloadsToValues(dataConverter, [payload]))[0]
        : undefined
    expect(value).toBe('hello Temporal')
  })

  test('schedules timers and completes after firing', async () => {
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH })
    const activation = buildActivationBase('run-timer')
    const initArgs = (await encodeValuesToPayloads(dataConverter, [1])) ?? []
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
          arguments: initArgs,
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
    const value =
      payload && payload !== undefined
        ? (await decodePayloadsToValues(dataConverter, [payload]))[0]
        : undefined
    expect(value).toBe('timer fired')
  })

  test('restores activator when workflows are interleaved', async () => {
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH })

    const run1Init = buildActivationBase('run-interleave-1')
    const run1Args = (await encodeValuesToPayloads(dataConverter, [1])) ?? []
    run1Init.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'interleave-1',
          workflowType: 'timerWorkflow',
          randomnessSeed: Long.fromNumber(11),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-interleave-1',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          arguments: run1Args,
        },
      }),
    ]

    const run1First = await engine.processWorkflowActivation(run1Init, {
      namespace: 'default',
      taskQueue: 'unit-test',
    })

    const startTimerCommand = run1First.completion.successful?.commands?.find((cmd) => cmd.startTimer)
    const timerSeq = startTimerCommand?.startTimer?.seq ?? 0

    const run2Init = buildActivationBase('run-interleave-2')
    const run2Args = (await encodeValuesToPayloads(dataConverter, ['Temporal'])) ?? []
    run2Init.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'interleave-2',
          workflowType: 'simpleWorkflow',
          randomnessSeed: Long.fromNumber(13),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-interleave-2',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          arguments: run2Args,
        },
      }),
    ]

    await engine.processWorkflowActivation(run2Init, {
      namespace: 'default',
      taskQueue: 'unit-test',
    })

    const run1Fire = buildActivationBase('run-interleave-1')
    run1Fire.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        fireTimer: { seq: timerSeq },
      }),
    ]

    const run1Final = await engine.processWorkflowActivation(run1Fire, {
      namespace: 'default',
      taskQueue: 'unit-test',
    })

    const completionCommand = run1Final.completion.successful?.commands?.find((cmd) => cmd.completeWorkflowExecution)
    expect(completionCommand?.completeWorkflowExecution).toBeDefined()
    const payload = completionCommand?.completeWorkflowExecution?.result
    const value =
      payload && payload !== undefined
        ? (await decodePayloadsToValues(dataConverter, [payload]))[0]
        : undefined
    expect(value).toBe('timer fired')
  })

  test('supports custom data converters for workflow payloads', async () => {
    const customConverter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH, dataConverter: customConverter })

    const activation = buildActivationBase('run-binary')
    activation.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'binary-001',
          workflowType: 'binaryWorkflow',
          randomnessSeed: Long.fromNumber(21),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-binary',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
        },
      }),
    ]

    const result = await engine.processWorkflowActivation(activation, {
      namespace: 'default',
      taskQueue: 'unit-test',
    })

    const command = result.completion.successful?.commands?.[0]
    const payload = command?.completeWorkflowExecution?.result
    const value =
      payload && payload !== undefined
        ? (await decodePayloadsToValues(customConverter, [payload]))[0]
        : undefined
    expect(value).toBeInstanceOf(Uint8Array)
    expect(Array.from(value as Uint8Array)).toEqual([1, 2, 3])
  })

  test('initializes workflow runtime with custom payload converter', async () => {
    const customConverter = createDataConverter({ payloadConverter: new PrefixingPayloadConverter() })
    const engine = new WorkflowEngine({ workflowsPath: WORKFLOWS_PATH, dataConverter: customConverter })

    const activation = buildActivationBase('run-prefixed')
    const initArgs = (await encodeValuesToPayloads(customConverter, ['Temporal'])) ?? []
    activation.jobs = [
      coresdk.workflow_activation.WorkflowActivationJob.create({
        initializeWorkflow: {
          namespace: 'default',
          workflowId: 'prefixed-001',
          workflowType: 'simpleWorkflow',
          randomnessSeed: Long.fromNumber(32),
          attempt: 1,
          taskQueue: 'unit-test',
          firstExecutionRunId: 'run-prefixed',
          startTime: toTimestamp(),
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          arguments: initArgs,
        },
      }),
    ]

    const result = await engine.processWorkflowActivation(activation, {
      namespace: 'default',
      taskQueue: 'unit-test',
    })

    const command = result.completion.successful?.commands?.[0]
    const payload = command?.completeWorkflowExecution?.result
    const value =
      payload && payload !== undefined
        ? (await decodePayloadsToValues(customConverter, [payload]))[0]
        : undefined
    expect(value).toBe('hello Temporal')
  })

  test('does not double encode workflow command payloads', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const [encodedPayload] = (await encodeValuesToPayloads(converter, ['activity-arg'])) ?? []
    expect(encodedPayload).toBeDefined()

    const originalData = encodedPayload?.data ? new Uint8Array(encodedPayload.data) : undefined
    const originalEncoding = encodedPayload?.metadata?.encoding
      ? new Uint8Array(encodedPayload.metadata.encoding)
      : undefined

    const command = coresdk.workflow_commands.WorkflowCommand.create({
      scheduleActivity: coresdk.workflow_commands.ScheduleActivity.create({
        seq: 1,
        activityId: 'activity-1',
        activityType: 'exampleActivity',
        taskQueue: 'unit-test-queue',
        arguments: encodedPayload ? [encodedPayload] : [],
      }),
    })

    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.create({
      runId: 'avoid-double-encode',
      successful: coresdk.workflow_completion.Success.create({
        commands: [command],
      }),
    })

    await applyDataConverterToWorkflowCompletion(converter, completion)

    const [postPayload] = command.scheduleActivity?.arguments ?? []
    expect(postPayload).toBeDefined()

    if (originalData) {
      expect(new Uint8Array(postPayload?.data ?? [])).toEqual(originalData)
    }
    if (originalEncoding) {
      expect(new Uint8Array(postPayload?.metadata?.encoding ?? [])).toEqual(originalEncoding)
    }
  })
})
