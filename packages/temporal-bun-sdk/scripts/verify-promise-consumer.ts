import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const verifyPromiseConsumer = async (consumerRoot: string, requireCompiled = false) => {
  const require = createRequire(resolve(consumerRoot, 'package.json'))
  const entry = require.resolve('@proompteng/temporal-bun-sdk')
  const sdkRoot = resolve(dirname(entry), entry.includes('/dist/') ? '../..' : '..')
  const sdkRequire = createRequire(resolve(sdkRoot, 'package.json'))
  const effect = JSON.parse(await readFile(sdkRequire.resolve('effect/package.json'), 'utf8'))
  assert.equal(effect.version, '4.0.0')
  if (requireCompiled) assert.ok(entry.includes('/dist/'), `Expected compiled SDK entry: ${entry}`)
  const { createTemporalClient, loadTemporalConfig } = await import(pathToFileURL(entry).href)
  const config = await loadTemporalConfig({ env: { TEMPORAL_ADDRESS: '127.0.0.1:7233', TEMPORAL_NAMESPACE: 'smoke' } })
  let starts = 0
  const { client } = await createTemporalClient({
    config,
    workflowService: {
      startWorkflowExecution: async () => {
        starts += 1
        return { runId: 'smoke-run' }
      },
    },
    operatorService: {},
    cloudService: {},
  })
  try {
    const result = await client.workflow.start({
      workflowId: 'smoke',
      workflowType: 'smoke',
      taskQueue: 'smoke',
      args: [],
    })
    assert.equal(result.runId, 'smoke-run')
    assert.equal(starts, 1)
  } finally {
    await client.shutdown()
  }
  return { effect: effect.version, entry }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error('Usage: verify-promise-consumer.ts <consumer-root> [--compiled]')
  console.log(JSON.stringify(await verifyPromiseConsumer(root, process.argv.includes('--compiled'))))
}
