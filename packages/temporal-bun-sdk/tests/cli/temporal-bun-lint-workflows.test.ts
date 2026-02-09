import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { executeLintWorkflows, withTempDir } from '../../src/bin/lint-workflows-command'

test('lint-workflows fails on fetch() usage in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    const bad = join(workflowsDir, 'bad.ts')
    await writeFile(entry, "export * from './bad'\n")
    await writeFile(bad, 'export const run = async () => { await fetch(\"https://example.com\") }\n')

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-global' && v.message.includes('fetch'))).toBeTrue()
  })
})

test('lint-workflows fails on process.env access in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, 'export const run = () => process.env.FOO\n')

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes('process.env'))).toBeTrue()
  })
})

test('lint-workflows fails on capturing Date.now in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, 'const now = Date.now\nexport const run = () => now()\n')

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'capture-member-expression' && v.message.includes('Date.now'))).toBeTrue()
  })
})

test('lint-workflows fails when a workflow imports @proompteng/temporal-bun-sdk/client', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, "import '@proompteng/temporal-bun-sdk/client'\nexport const run = () => null\n")

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-import' && v.message.includes('temporal-bun-sdk/client'))).toBeTrue()
  })
})

