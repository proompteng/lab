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
    await writeFile(bad, 'export const run = async () => { await fetch("https://example.com") }\n')

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

test('lint-workflows fails on Bun environment, timer, file, and socket escape hatches', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(
      entry,
      [
        'export const env = () => Bun.env.FOO',
        'export const sleep = () => Bun.sleep(1)',
        "export const file = () => Bun.file('/tmp/probe')",
        "export const write = () => Bun.write('/tmp/probe', 'x')",
        "export const connect = () => Bun.connect({ hostname: '127.0.0.1', port: 1, socket: {} })",
        "export const serve = () => Bun.serve({ port: 0, fetch: () => new Response('ok') })",
      ].join('\n'),
    )

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    for (const api of ['Bun.env', 'Bun.sleep', 'Bun.file', 'Bun.write', 'Bun.connect', 'Bun.serve']) {
      expect(
        result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes(api)),
      ).toBeTrue()
    }
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

test('lint-workflows fails on live time and randomness member calls in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, 'export const run = () => Date.now() + Math.random() + performance.now()\n')

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes('Date.now'))).toBeTrue()
    expect(result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes('Math.random'))).toBeTrue()
    expect(result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes('performance.now'))).toBeTrue()
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

test('lint-workflows fails on raw Promise constructors in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, 'export const run = () => new Promise((resolve) => resolve("ok"))\n')

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-global' && v.message.includes('Promise'))).toBeTrue()
  })
})

test('lint-workflows fails on Effect promise escape hatches in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(
      entry,
      "import { Effect } from 'effect'\nexport const run = () => Effect.tryPromise(() => fetch('https://example.com'))\n",
    )

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-member-expression' && v.message.includes('Effect.tryPromise'))).toBeTrue()
  })
})

test('lint-workflows fails on eval and Function constructors in workflow modules', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })

    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, "export const run = () => eval('1') + new Function('return 2')()\n")

    const result = await executeLintWorkflows({
      cwd: dir,
      workflows: [entry],
      mode: 'strict',
      format: 'json',
    })

    expect(result.exitCode).toBe(1)
    expect(result.violations.some((v) => v.rule === 'deny-global' && v.message.includes('eval'))).toBeTrue()
    expect(result.violations.some((v) => v.rule === 'deny-global' && v.message.includes('Function'))).toBeTrue()
  })
})

test('lint-workflows changed-only mode fails closed when the merge-base ref is unavailable', async () => {
  await withTempDir(async (dir) => {
    const workflowsDir = join(dir, 'workflows')
    await mkdir(workflowsDir, { recursive: true })
    const entry = join(workflowsDir, 'index.ts')
    await writeFile(entry, 'export const run = () => "ok"\n')

    await expect(
      executeLintWorkflows({
        cwd: dir,
        workflows: [entry],
        mode: 'strict',
        format: 'json',
        changedOnly: true,
      }),
    ).rejects.toThrow('Unable to determine changed workflow files')
  })
})
