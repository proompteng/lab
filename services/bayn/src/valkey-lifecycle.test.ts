import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { Config, Effect } from 'effect'

test('production Valkey lifecycle preserves idle connections and bounds startup and commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-valkey-lifecycle-'))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'testing/valkey-lifecycle-node-test-support.ts')],
      target: 'node',
      outdir: directory,
    })
    expect(built.success).toBe(true)
    const node = Effect.runSync(Config.String('BAYN_TEST_NODE_BINARY').pipe(Config.withDefault('node')))
    for (const mode of [
      'idle',
      'startup-deadline',
      'startup-interrupt',
      'command-deadline',
      'command-interrupt',
      'command-disconnect',
    ]) {
      const child = Bun.spawn([node, join(directory, 'valkey-lifecycle-node-test-support.js'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ mode, stderr, exitCode }).toEqual({ mode, stderr: '', exitCode: 0 })
      expect(JSON.parse(stdout).mode).toBe(mode)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
