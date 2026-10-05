import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  capacityResourceDelta,
  sampleCapacityResources,
  terminalHeartbeatMaximum,
} from './capture-capacity-metrics.mjs'

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

const readers = () => {
  let now = 10
  return {
    now: () => (now += 0.5),
    threadCpuUsage: () => ({ user: 1000, system: 200 }),
    eventLoopUtilization: () => ({ active: 7, idle: 3 }),
    readCpuStat: () => 'usage_usec 5000\nnr_periods 100\nnr_throttled 3\nthrottled_usec 200\n',
  }
}

test('records explicit counter units, observer elapsed time, and paired deltas', () => {
  const before = sampleCapacityResources(readers())
  assert.equal(before.samplerElapsedMs, 0.5)
  const after = {
    ...before,
    sampledAt: 30.5,
    threadUserUs: 5000,
    threadSystemUs: 1200,
    eventLoopActiveMs: 12,
    eventLoopIdleMs: 18,
    cgroupUsageUs: 12000,
    cgroupPeriods: 101,
    cgroupThrottledPeriods: 4,
    cgroupThrottledUs: 2200,
  }
  assert.deepEqual(capacityResourceDelta(before, after), {
    elapsedMs: 20,
    threadUserUs: 4000,
    threadSystemUs: 1000,
    eventLoopActiveMs: 5,
    eventLoopIdleMs: 15,
    cgroupUsageUs: 7000,
    cgroupPeriods: 1,
    cgroupThrottledPeriods: 1,
    cgroupThrottledUs: 2000,
  })
})

test('rejects unsupported readings and reset counters instead of inventing zero', () => {
  assert.throws(() => sampleCapacityResources({ ...readers(), threadCpuUsage: null }), /unavailable/)
  assert.throws(() => sampleCapacityResources({ ...readers(), eventLoopUtilization: () => undefined }), /Unsupported/)
  assert.throws(() => sampleCapacityResources({ ...readers(), readCpuStat: () => 'usage_usec 0\n' }), /Missing/)
  const before = sampleCapacityResources(readers())
  assert.throws(() => capacityResourceDelta(before, { ...before, threadUserUs: 999 }), /Counter reset/)
  assert.throws(() => capacityResourceDelta(before, { ...before, cgroupThrottledUs: 199 }), /Counter reset/)
  assert.throws(() => capacityResourceDelta(before, { ...before, eventLoopActiveMs: Number.NaN }), /Unsupported/)
})
