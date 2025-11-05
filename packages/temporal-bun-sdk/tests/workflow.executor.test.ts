import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../src/common/payloads'
import { WorkflowExecutor } from '../src/workflow/executor'
import { defineWorkflow } from '../src/workflow/definition'
import { WorkflowRegistry } from '../src/workflow/registry'
import { CommandType } from '../src/proto/temporal/api/enums/v1/command_type_pb'

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  return { registry, executor: new WorkflowExecutor({ registry, dataConverter }), dataConverter }
}

test('completes workflow and returns completion command', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'helloWorkflow',
      Schema.Array(Schema.String),
      ({ input }) => Effect.sync(() => `Hello, ${input[0] ?? 'Temporal'}!`),
    ),
  )

  const commands = await executor.execute({ workflowType: 'helloWorkflow', arguments: ['Temporal'] })

  expect(commands).toHaveLength(1)
  const [command] = commands
  expect(command.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(command.attributes?.case).toBe('completeWorkflowExecutionCommandAttributes')
  expect(command.attributes?.value.result?.payloads).toBeDefined()
})

test('fails workflow when handler raises', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'failingWorkflow',
      Schema.Array(Schema.String),
      () => Effect.fail(new Error('boom')),
    ),
  )

  const commands = await executor.execute({ workflowType: 'failingWorkflow', arguments: [] })

  expect(commands).toHaveLength(1)
  const [command] = commands
  expect(command.commandType).toBe(CommandType.FAIL_WORKFLOW_EXECUTION)
  expect(command.attributes?.case).toBe('failWorkflowExecutionCommandAttributes')
})

test('schema violations surface as failure commands', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'arrayWorkflow',
      Schema.Array(Schema.String),
      ({ input }) => Effect.sync(() => input.join(':')),
    ),
  )

  const commands = await executor.execute({ workflowType: 'arrayWorkflow', arguments: [123] as unknown[] })

  expect(commands).toHaveLength(1)
  const [command] = commands
  expect(command.commandType).toBe(CommandType.FAIL_WORKFLOW_EXECUTION)
  expect(command.attributes?.case).toBe('failWorkflowExecutionCommandAttributes')
})
