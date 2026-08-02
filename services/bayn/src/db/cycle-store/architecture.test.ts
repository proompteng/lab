import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const serviceRoot = resolve(import.meta.dir, '../../..')
const architectureLint = resolve(import.meta.dir, 'architecture-lint.mjs')

describe('cycle-store architecture', () => {
  test('keeps cycle-store, readiness, and recovery modules outside import cycles', async () => {
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

    expect(exitCode).toBe(0)
    if (exitCode !== 0) {
      throw new Error([stdout, stderr].filter((output) => output.length > 0).join('\n'))
    }

    expect(JSON.parse(stdout)).toEqual({ cycles: [] })
  })
})
