import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

test('Node owns a real Kafka stream delivered after consumer shutdown', async () => {
  const directory = await mkdtemp(join(import.meta.dir, '.node-transport-'))
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../testing/kafka-transport-node.mjs')],
      target: 'node',
      outdir: directory,
      external: ['@platformatic/kafka'],
    })
    expect(built.success).toBe(true)
    const process = Bun.spawn(['node', join(directory, 'kafka-transport-node.js')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    expect(stdout).toContain('late Kafka stream rejected and closed without an unhandled error')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
