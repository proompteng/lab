import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const serviceRoot = resolve(import.meta.dir, '../../..')
const architectureLint = resolve(import.meta.dir, 'architecture-lint.mjs')

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
})
