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
  const effect = JSON.parse(await readFile(sdkRequire.resolve('effect/package.json'), 'utf8'))
  assert.ok(entry.includes('/node_modules/'), `Worker resolved a workspace SDK: ${entry}`)
  assert.equal(sdk.version, '0.11.5', 'Existing workflows require the immutable Effect 3 SDK')
  assert.equal(effect.version, '3.22.1', 'The retained SDK must use its exact published Effect runtime')

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
  return { sdk: sdk.version, effect: effect.version, entry }
}

if (import.meta.main) {
  const roots = process.argv.slice(2)
  for (const root of roots.length ? roots : [resolve(import.meta.dir, '..')]) {
    console.log(JSON.stringify({ consumer: root, ...(await verifyTemporalRuntime(root)) }))
  }
}
