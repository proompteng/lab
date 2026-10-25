import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, Effect } from 'effect'

test('the production Node S3 adapter verifies bytes, conditional writes, private ACL and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-evidence-storage-'))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'evidence-archive.test-support.ts')],
      target: 'node',
      outdir: directory,
    })
    expect(built.success).toBeTrue()
    const node = Effect.runSync(Config.String('BAYN_TEST_NODE_BINARY').pipe(Config.withDefault('node')))
    for (const mode of ['regular', 'public', 'corrupt', 'cancel', 'deadline', 'audit']) {
      const child = Bun.spawn([node, join(directory, 'evidence-archive.test-support.js'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ mode, stderr, exitCode }).toEqual({ mode, stderr: '', exitCode: 0 })
      expect(stdout.trim()).toBe('EVIDENCE_STORAGE_VERIFIED')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
