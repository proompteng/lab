import { readdir } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const serviceRoot = `${import.meta.dir}/../..`
const sourceRoot = `${import.meta.dir}/..`
const databaseRoot = `${sourceRoot}/db`
const architectureLint = `${import.meta.dir}/architecture-lint.mjs`

describe('Bayn production architecture', () => {
  test('keeps production modules outside import cycles', async () => {
    const lint = Bun.spawn(['node', architectureLint], {
      cwd: serviceRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      lint.exited,
      new Response(lint.stdout).text(),
      new Response(lint.stderr).text(),
    ])

    if (exitCode !== 0) {
      throw new Error([stdout, stderr].filter((output) => output.length > 0).join('\n'))
    }
    expect(exitCode).toBe(0)

    expect(JSON.parse(stdout)).toEqual({ cycles: [] })
  })

  test('keeps autonomous cycle implementation inside the cycle module', async () => {
    const [sourceEntries, databaseEntries, moduleEntries] = await Promise.all([
      readdir(sourceRoot),
      readdir(databaseRoot),
      readdir(import.meta.dir),
    ])
    const legacySourceEntries = new Set([
      'cycle.ts',
      'cycle.test.ts',
      'cycle-runner',
      'cycle-runner.ts',
      'cycle-runner.test.ts',
      'cycle-observability.ts',
      'cycle-observability.test.ts',
      'cycle-readiness.ts',
      'cycle-readiness.test.ts',
      'cycle-recovery.ts',
      'cycle-recovery.test.ts',
    ])
    const legacyDatabaseEntries = new Set([
      'cycle-store',
      'cycle-observability.ts',
      'cycle-observability.test.ts',
      'cycle-observability.integration.test.ts',
    ])

    expect(sourceEntries.filter((entry) => legacySourceEntries.has(entry))).toEqual([])
    expect(databaseEntries.filter((entry) => legacyDatabaseEntries.has(entry))).toEqual([])
    expect(moduleEntries.filter((entry) => entry.startsWith('cycle-'))).toEqual([])
  })
})
