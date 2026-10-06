import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export const terminalHeartbeatMaximum = ({ heartbeatMaxMs, pendingHeartbeatLatenessMs }) =>
  Math.max(heartbeatMaxMs, pendingHeartbeatLatenessMs ?? 0)

export const capacityAttributionCase = (mode) => {
  assert.ok(mode === 'full' || mode === 'proof-light')
  return {
    proofLight: mode === 'proof-light',
    disabledName: 'attribution-disabled',
    enabledName: 'attribution-enabled',
  }
}

export const capacityCorpusHash = (records) => {
  const hash = createHash('sha256').update('bayn.capacity-corpus.v1\n')
  for (const record of records)
    hash.update(`${record.partition}:${record.timestamp}:${record.value.byteLength}\n`).update(record.value)
  return hash.digest('hex')
}

const counterKeys = [
  'threadUserUs',
  'threadSystemUs',
  'eventLoopActiveMs',
  'eventLoopIdleMs',
  'cgroupUsageUs',
  'cgroupPeriods',
  'cgroupThrottledPeriods',
  'cgroupThrottledUs',
]
const checked = (value, name) => {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `Unsupported ${name} counter`)
  return value
}

export const sampleCapacityResources = ({
  threadCpuUsage = process.threadCpuUsage,
  eventLoopUtilization = performance.eventLoopUtilization,
  readCpuStat = () => readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'),
  now = () => performance.now(),
} = {}) => {
  assert.equal(typeof threadCpuUsage, 'function', 'Node thread CPU counters unavailable')
  assert.equal(typeof eventLoopUtilization, 'function', 'Node event-loop counters unavailable')
  const sampledAt = checked(now(), 'sample clock')
  const thread = threadCpuUsage.call(process),
    loop = eventLoopUtilization.call(performance),
    stat = readCpuStat()
  const cgroup = (key) => {
    assert.equal(typeof stat, 'string', 'cgroup CPU counters unavailable')
    const matches = [...stat.matchAll(new RegExp(`^${key} ([0-9]+)$`, 'gm'))]
    assert.equal(matches.length, 1, `Missing or ambiguous cgroup ${key}`)
    const value = Number(matches[0][1])
    assert.ok(Number.isSafeInteger(value), `Unsupported cgroup ${key}`)
    return value
  }
  const result = {
    sampledAt,
    threadUserUs: checked(thread?.user, 'thread user'),
    threadSystemUs: checked(thread?.system, 'thread system'),
    eventLoopActiveMs: checked(loop?.active, 'event-loop active'),
    eventLoopIdleMs: checked(loop?.idle, 'event-loop idle'),
    cgroupUsageUs: cgroup('usage_usec'),
    cgroupPeriods: cgroup('nr_periods'),
    cgroupThrottledPeriods: cgroup('nr_throttled'),
    cgroupThrottledUs: cgroup('throttled_usec'),
    samplerElapsedMs: checked(now() - sampledAt, 'sampler elapsed'),
  }
  return result
}

export const capacityResourceDelta = (before, after) => {
  const result = { elapsedMs: checked(after.sampledAt - before.sampledAt, 'counter interval') }
  for (const key of counterKeys) {
    const delta = checked(after[key], key) - checked(before[key], key)
    assert.ok(delta >= 0, `Counter reset: ${key}`)
    result[key] = delta
  }
  return result
}
