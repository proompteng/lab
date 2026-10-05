import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { terminalHeartbeatMaximum } from './capture-capacity-metrics.mjs'

const plan = JSON.parse(readFileSync(new URL('./capture-capacity-plan.json', import.meta.url), 'utf8'))
const maximumDelayMs = plan.performancePass.maximumHeartbeatDelayMs

test('rejects a terminal stall even before another heartbeat callback runs', () => {
  const completed = { heartbeatMaxMs: 37, heartbeatP99Ms: 12, pendingHeartbeatLatenessMs: 501 }
  assert.equal(maximumDelayMs, 500)
  assert.throws(() => assert.ok(terminalHeartbeatMaximum(completed) <= maximumDelayMs))
  assert.equal(terminalHeartbeatMaximum(completed), 501)
  assert.equal(completed.heartbeatMaxMs, 37)
  assert.equal(completed.heartbeatP99Ms, 12)
})

test('preserves completed maxima and accepts the exact frozen boundary', () => {
  assert.equal(terminalHeartbeatMaximum({ heartbeatMaxMs: 600, pendingHeartbeatLatenessMs: 12 }), 600)
  assert.equal(terminalHeartbeatMaximum({ heartbeatMaxMs: 37, pendingHeartbeatLatenessMs: 500 }), 500)
  assert.equal(terminalHeartbeatMaximum({ heartbeatMaxMs: 37, pendingHeartbeatLatenessMs: null }), 37)
})
