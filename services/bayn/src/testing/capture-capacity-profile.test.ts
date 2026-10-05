import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('native CPU diagnostic stops once, disconnects, and bounds its summary', () => {
  const result = spawnSync(
    'node',
    [
      '--max-old-space-size=192',
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict'
import { url } from 'node:inspector'
import { setTimeout as delay } from 'node:timers/promises'
const { startCapacityCpuProfile } = await import(process.argv[1])
assert.equal(url(), undefined)
const manual = await startCapacityCpuProfile()
const until = performance.now() + 50
while (performance.now() < until) Math.sqrt(performance.now())
await delay(10)
const first = await manual.stop('invalidation')
assert.equal(await manual.stop('finalization'), first)
assert.equal(first.reason, 'invalidation')
assert.ok(first.sampleCount > 0)
assert.equal(first.diagnosticOverflow, false)
assert.ok(first.topSelfCosts.length <= 20)
const timed = await startCapacityCpuProfile()
await delay(1100)
const second = await timed.stop('finalization')
assert.equal(second.reason, 'timer')
assert.equal(second.diagnosticOverflow, false)
assert.equal(second.requestedWindowMs, 1000)
assert.ok(Number.isFinite(second.elapsedToStopRequestMs) && second.elapsedToStopRequestMs > 0)
assert.equal(url(), undefined)
assert.ok(process.memoryUsage().rss < 256 * 1024 ** 2)
console.log('bounded native CPU diagnostic passed')
`,
      join(import.meta.dir, 'capture-capacity-profile.mjs'),
    ],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('bounded native CPU diagnostic passed\n')
}, 10_000)
