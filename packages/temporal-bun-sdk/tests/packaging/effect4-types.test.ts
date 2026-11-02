import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('Effect 4 config layers provide their service without casts or unresolved requirements', async () => {
  const child = Bun.spawn(
    [process.execPath, 'x', '--no-install', 'tsc', '-p', 'tests/types/tsconfig.json', '--pretty', 'false'],
    {
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
})
