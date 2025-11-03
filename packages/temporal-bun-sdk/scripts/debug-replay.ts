import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReplayHistory } from '../src/workflow/runtime'

const bailAfterMs = Number(process.env.BAIL_AFTER_MS ?? '5000')
const timeout = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error(`debug-replay timed out after ${bailAfterMs}ms`))
  }, bailAfterMs).unref()
})

const run = (async () => {
  const baseDir = fileURLToPath(new URL('.', import.meta.url))
  const workflowsPath = join(baseDir, '../tests/fixtures/workflows/simple.workflow.ts')
  const historyPath = join(baseDir, '../tests/fixtures/histories/simple-workflow.json')

  console.log('debug-replay: reading history from %s', historyPath)
  const history = await readFile(historyPath, 'utf8')

  console.log('debug-replay: running replay via Zig bridge')
  await runReplayHistory({
    workflowsPath,
    namespace: 'default',
    taskQueue: 'replay-task-queue',
    identity: 'debug-replay',
    history,
  })
  console.log('debug-replay: replay succeeded')
})()

await Promise.race([run, timeout]).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
