import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

test.each(['drain', 'interrupt', 'invalid'])(
  'real Kafka response expansion is bounded: %s',
  async (mode) => {
    const process = Bun.spawn(['node', join(import.meta.dir, '../../testing/kafka-backpressure-node.mjs'), mode], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    expect(stdout).toContain(`${mode}: bounded real Kafka stream preserved offsets and released its response`)
  },
  10_000,
)

test.each(['drain', 'invalidate', 'interrupt'])(
  'Node services I/O during continuously ready Kafka consumption: %s',
  async (mode) => {
    const directory = await mkdtemp(join(import.meta.dir, '.node-scheduling-'))
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../testing/kafka-scheduling-node.mjs')],
        target: 'node',
        outdir: directory,
        external: ['@platformatic/kafka'],
      })
      expect(built.success).toBe(true)
      const process = Bun.spawn(['node', join(directory, 'kafka-scheduling-node.js'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).toContain(`${mode}: Node I/O serviced during consumption`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000,
)

test.each(['late', 'construct', 'closed', 'shutdown'])(
  'Node owns real Kafka streams during %s',
  async (mode) => {
    const directory = await mkdtemp(join(import.meta.dir, '.node-transport-'))
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../testing/kafka-transport-node.mjs')],
        target: 'node',
        outdir: directory,
        external: ['@platformatic/kafka'],
      })
      expect(built.success).toBe(true)
      const process = Bun.spawn(['node', join(directory, 'kafka-transport-node.js'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).toContain(`${mode}: Kafka stream owned and closed without an unhandled error`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000,
)
