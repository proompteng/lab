import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const verifyTemporalRuntime = async (consumerRoot: string) => {
  const require = createRequire(resolve(consumerRoot, 'package.json'))
  const entry = await realpath(require.resolve('@proompteng/temporal-bun-sdk'))
  const sdkRoot = resolve(dirname(entry), '../..')
  const sdk = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'))
  const sdkRequire = createRequire(resolve(sdkRoot, 'package.json'))
  const sdkEffectPath = await realpath(sdkRequire.resolve('effect/package.json'))
  const sdkEffect = JSON.parse(await readFile(sdkEffectPath, 'utf8'))
  const workflowRequire = createRequire(resolve(import.meta.dir, '../src/workflows/index.ts'))
  const workflowEffectPath = await realpath(workflowRequire.resolve('effect/package.json'))
  const consumerEffectPath = await realpath(require.resolve('effect/package.json'))
  const workflowEffect = JSON.parse(await readFile(workflowEffectPath, 'utf8'))
  assert.equal(sdk.dependencies.effect, '4.1.4', 'The SDK must pin the shared Effect runtime')
  assert.equal(sdkEffect.version, '4.1.4', 'The SDK must use Effect 4.1.4')
  assert.equal(workflowEffectPath, sdkEffectPath, 'Workflow imports must resolve the SDK Effect instance')
  assert.equal(consumerEffectPath, sdkEffectPath, 'The worker must resolve the SDK Effect instance')

  const { loadTemporalConfig } = await import(pathToFileURL(entry).href)
  const config = await loadTemporalConfig({ env: { TEMPORAL_ADDRESS: '127.0.0.1:7233', TEMPORAL_NAMESPACE: 'smoke' } })
  assert.equal(config.namespace, 'smoke')

  const { WorkflowExecutor, WorkflowRegistry, createDefaultDataConverter } = await import(
    pathToFileURL(require.resolve('@proompteng/temporal-bun-sdk/workflow')).href
  )
  const { workflows } = await import('../src/workflows/index')
  const registry = new WorkflowRegistry()
  registry.registerMany(workflows)
  const executor = new WorkflowExecutor({ registry, dataConverter: createDefaultDataConverter() })
  const output = await executor.execute({
    workflowType: 'publishMainMergeMemoryNote',
    workflowId: 'runtime-smoke',
    runId: 'runtime-smoke',
    namespace: 'smoke',
    taskQueue: 'smoke',
    arguments: { eventId: 'smoke', deliveryId: 'smoke', repoRoot: '/repo', ref: 'main', commit: 'smoke' },
  })
  assert.equal(output.completion, 'pending')
  assert.equal(output.intents.length, 1)
  assert.equal(output.intents[0].kind, 'schedule-activity')
  assert.equal(output.intents[0].activityType, 'publishMainMergeMemoryNote')
  return { sdk: sdk.version, sdkEffect: sdkEffect.version, workflowEffect: workflowEffect.version, entry }
}

if (import.meta.main) {
  const roots = process.argv.slice(2)
  for (const root of roots.length ? roots : [resolve(import.meta.dir, '..')]) {
    console.log(JSON.stringify({ consumer: root, ...(await verifyTemporalRuntime(root)) }))
  }
}
