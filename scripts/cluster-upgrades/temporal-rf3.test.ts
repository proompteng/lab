import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Temporal RF3 maintenance preserves data and stops on invalid preconditions', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./temporal-rf3.test.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stdout + result.stderr).toBe(0)
}, 65_000)
