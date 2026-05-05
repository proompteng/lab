#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const argv = parseArgs({
  options: {
    duration: { type: 'string' },
    workflows: { type: 'string' },
    'workflow-concurrency': { type: 'string' },
    'activity-concurrency': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (argv.values.help) {
  console.log(`Usage: bun scripts/run-worker-soak.ts [options]

Options:
  --duration <ms>             Soak duration. Defaults to TEMPORAL_SOAK_DURATION_MS or 7200000.
  --workflows <n>             Workflows per load iteration.
  --workflow-concurrency <n>  Workflow concurrency target.
  --activity-concurrency <n>  Activity concurrency target.
  --help                      Show this help text.
`)
  process.exit(0)
}

const durationMs = Math.max(
  1_000,
  Number.parseInt(String(argv.values.duration ?? process.env.TEMPORAL_SOAK_DURATION_MS ?? '7200000'), 10),
)
const startedAt = Date.now()
const deadline = startedAt + durationMs
const artifactsDir = process.env.TEMPORAL_SOAK_ARTIFACTS_DIR ?? join(process.cwd(), '.artifacts', 'worker-soak')
const iterations: Array<{ iteration: number; startedAt: string; completedAt: string; exitCode: number }> = []

const applyOverride = (name: string, value: string | boolean | undefined) => {
  if (value !== undefined) {
    process.env[name] = String(value)
  }
}

applyOverride('TEMPORAL_LOAD_TEST_WORKFLOWS', argv.values.workflows)
applyOverride('TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY', argv.values['workflow-concurrency'])
applyOverride('TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY', argv.values['activity-concurrency'])

await mkdir(artifactsDir, { recursive: true })

let iteration = 0
while (Date.now() < deadline) {
  iteration += 1
  const iterationStartedAt = new Date().toISOString()
  const iterationDir = join(artifactsDir, `iteration-${iteration}`)
  await mkdir(iterationDir, { recursive: true })

  const child = Bun.spawn(['bun', 'scripts/run-worker-load.ts'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      TEMPORAL_WORKER_LOAD_ARTIFACTS_DIR: iterationDir,
    },
  })
  const exitCode = await child.exited
  const completedAt = new Date().toISOString()
  iterations.push({ iteration, startedAt: iterationStartedAt, completedAt, exitCode })
  if (exitCode !== 0) {
    process.exitCode = exitCode
    break
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  durationMs,
  elapsedMs: Date.now() - startedAt,
  passed: iterations.length > 0 && iterations.every((entry) => entry.exitCode === 0),
  iterations,
}

await writeFile(join(artifactsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`[worker-soak] report written to ${join(artifactsDir, 'report.json')}`)
