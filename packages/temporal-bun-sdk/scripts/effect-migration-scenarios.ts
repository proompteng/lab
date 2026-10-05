import { Effect, Schema } from 'effect'

import { createDefaultDataConverter } from '../src/common/payloads'
import type { WorkflowActivation, WorkflowActivationJob } from '../src/workflow/activation'
import { defineWorkflow, type WorkflowDefinition } from '../src/workflow/definition'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'
import { WorkflowExecutor } from '../src/workflow/executor'
import { defineWorkflowSignals } from '../src/workflow/inbound'
import { WorkflowRegistry } from '../src/workflow/registry'

const input = { namespace: 'test', taskQueue: 'test', workflowId: 'migration', runId: 'run', arguments: [] }
const complete = (id: string): WorkflowActivationJob => ({
  type: 'activity',
  id,
  resolution: { status: 'completed', value: id },
})

const execute = async (
  definition: WorkflowDefinition<unknown, unknown>,
  activations: readonly WorkflowActivation[],
  determinismState?: WorkflowDeterminismState,
) => {
  const registry = new WorkflowRegistry()
  registry.register(definition)
  const executor = new WorkflowExecutor({ registry, dataConverter: createDefaultDataConverter() })
  const output = await executor.execute({ ...input, workflowType: definition.name, activations, determinismState })
  return JSON.parse(JSON.stringify(output, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)))
}

export const runEffectMigrationScenarios = async (baseline?: Record<string, WorkflowDeterminismState>) => {
  const parallel = defineWorkflow('migration-parallel', (ctx) =>
    Effect.all(
      [
        Effect.flatMap(ctx.activities.schedule('A', [], { activityId: 'A' }), () =>
          ctx.activities.schedule('C', [], { activityId: 'C' }),
        ),
        ctx.activities.schedule('B', [], { activityId: 'B' }),
      ],
      { concurrency: 'unbounded' },
    ),
  )
  const first = await execute(parallel, [{ jobs: [] }])
  const second = await execute(
    parallel,
    [{ jobs: [] }, { jobs: [complete('A')] }],
    baseline?.parallelFirst ?? first.determinismState,
  )
  const final = await execute(
    parallel,
    [{ jobs: [] }, { jobs: [complete('A')] }, { jobs: [complete('B'), complete('C')] }],
    baseline?.parallelSecond ?? second.determinismState,
  )

  const signals = defineWorkflowSignals({ item: Schema.Unknown })
  const signaled = defineWorkflow('migration-signals', (ctx) =>
    Effect.gen(function* () {
      const batch = yield* ctx.signals.drain(signals.item)
      return yield* ctx.activities.schedule('echo', [batch.map((item) => item.payload)], { activityId: 'echo' })
    }),
  )
  const signalA = { type: 'signal' as const, delivery: { name: 'item', args: ['A'], metadata: { eventId: '2' } } }
  const signalB = { type: 'signal' as const, delivery: { name: 'item', args: ['B'], metadata: { eventId: '7' } } }
  const signalFirst = await execute(signaled, [{ jobs: [signalA] }])
  const signalFinal = await execute(
    signaled,
    [{ jobs: [signalA] }, { jobs: [signalB] }, { jobs: [complete('echo')] }],
    baseline?.signalFirst ?? signalFirst.determinismState,
  )
  return { parallelFirst: first, parallelSecond: second, parallelFinal: final, signalFirst, signalFinal }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runEffectMigrationScenarios(), null, 2))
}
