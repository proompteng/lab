import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { Config, Effect } from 'effect'

test('public storage and proxy clients use the production Node runtime and release scoped resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-public-storage-'))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'public-information-resources.test-support.ts')],
      target: 'node',
      outdir: directory,
    })
    expect(built.success).toBe(true)
    const node = Effect.runSync(Config.String('BAYN_TEST_NODE_BINARY').pipe(Config.withDefault('node')))
    for (const args of [[], ['--public-acl']]) {
      const child = Bun.spawn([node, join(directory, 'public-information-resources.test-support.js'), ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 })
      expect(stdout.trim()).toBe('PUBLIC_STORAGE_VERIFIED')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
