import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessYieldGaps, observeCapacityYields } from './capture-capacity-yields.mjs'

const snapshot = (at, sequence, extra = {}) => ({
  sampledAt: at,
  threadUserUs: at * 900,
  threadSystemUs: 0,
  eventLoopIdleMs: 0,
  phase: 'input-before-invalidation',
  consumer: { at, epoch: 'actual-epoch', consumerSequence: sequence, deliveredRecords: sequence, ...extra },
})
const gap = (ordinal, at, records = 100) => ({
  ordinal,
  resources: {
    requestStart: snapshot(at, ordinal * 100),
    serverRequest: snapshot(at + 10, ordinal * 100 + records),
    serverFinish: snapshot(at + 11, ordinal * 100 + records),
    responseCallback: snapshot(at + 12, ordinal * 100 + records),
  },
})
const assess = (http, events = [], extra = {}) =>
  assessYieldGaps({
    http,
    events,
    inputAt: 0,
    cutoffAt: 1000,
    failure: null,
    ...extra,
  })
const four = () => [gap(0, 0), gap(1, 20), gap(2, 40), gap(3, 60)]

test('requires four disjoint pre-invalidation gaps and three strong no-explicit-yield spans', () => {
  assert.equal(assess(four()).outcome, 'SUPPORTS_FUTURE_QUANTUM_TEST')
  assert.equal(assess(four().slice(0, 3)).outcome, 'INCONCLUSIVE')
  assert.equal(assess([gap(0, 0), gap(1, 0), gap(2, 0), gap(3, 0)]).outcome, 'INCONCLUSIVE')
  const mixed = four()
  mixed[0] = gap(0, 0, 63)
  assert.equal(assess(mixed).outcome, 'SUPPORTS_FUTURE_QUANTUM_TEST')
  mixed[1] = gap(1, 20, 63)
  assert.equal(assess(mixed).outcome, 'UNSUPPORTED')
  assert.equal(assess(four(), [], { cutoffAt: 65 }).outcome, 'INCONCLUSIVE')
})

test('an observed yield removes its wait and splits record spans instead of attributing delay to Kafka', () => {
  const events = [0, 20, 40, 60].flatMap((at, i) => [
    { boundary: 'before', at: at + 2, epoch: 'actual-epoch', consumerSequence: i * 100 + 30 },
    { boundary: 'after', at: at + 8, epoch: 'actual-epoch', consumerSequence: i * 100 + 30 },
  ])
  const report = assess(four(), events)
  assert.equal(report.outcome, 'UNSUPPORTED')
  assert.ok(report.gaps.every((row) => row.noYieldFraction === 0.2 && row.noYieldRecords === 70))
  assert.equal(assess(four(), events.slice(0, -1)).outcome, 'INCONCLUSIVE')
  const mismatched = structuredClone(events)
  mismatched[1].consumerSequence++
  assert.equal(assess(four(), mismatched).outcome, 'INCONCLUSIVE')
})

test('CPU, idle, epoch, incomplete, and diagnostic failures cannot support tuning', () => {
  for (const mutation of [
    (row) => {
      row.resources.serverRequest.threadUserUs = row.resources.requestStart.threadUserUs + 7999
    },
    (row) => {
      row.resources.serverRequest.eventLoopIdleMs = 0.501
    },
  ]) {
    const http = four()
    http.forEach(mutation)
    assert.equal(assess(http).outcome, 'UNSUPPORTED')
  }
  const epoch = four()
  epoch[0].resources.serverRequest.consumer.epoch = 'replacement'
  assert.equal(assess(epoch).outcome, 'INCONCLUSIVE')
  const missing = four()
  delete missing[0].resources.serverRequest
  assert.equal(assess(missing).outcome, 'INCONCLUSIVE')
  assert.equal(assess(four(), [], { failure: 'resource overflow' }).outcome, 'INCONCLUSIVE')
})

const fixture = () => {
  let at = 0,
    elapsedPerClock = 0,
    nativeReads = 0
  const observer = observeCapacityYields({
    now: () => {
      const value = at
      at += elapsedPerClock
      return value
    },
    readConsumer: () => {
      nativeReads++
      return { epoch: 'actual-epoch', consumerSequence: 99, deliveredRecords: 98 }
    },
  })
  return {
    observer,
    time: (value) => {
      at = value
    },
    cost: (value) => {
      elapsedPerClock = value
    },
    reads: () => nativeReads,
  }
}

test('records only before/after existing yields, preserves actual cursor, and admits at most 16 pairs', () => {
  const f = fixture(),
    o = f.observer
  o.boundary('before', 'setup', 0)
  o.startInput(0)
  const cursor = o.snapshot()
  assert.deepEqual(cursor, { at: 0, epoch: 'actual-epoch', consumerSequence: 99, deliveredRecords: 98 })
  for (let i = 0; i < 16; i++) {
    f.time(i * 10)
    o.boundary('before', 'actual-epoch', i * 256 + 255)
    f.time(i * 10 + 1)
    o.boundary('after', 'actual-epoch', i * 256 + 255)
  }
  o.invalidate(200)
  o.boundary('before', 'late', 9999)
  const report = o.report([])
  assert.equal(report.failure, null)
  assert.equal(report.events.length, 32)
  assert.equal(report.cutoffAt, 200)
  assert.ok(report.eventBytes <= 8192)
  assert.equal(f.reads(), 1)
})

test('event overflow, one-second crossing, invalidation crossing, and unpaired cutoff fail closed', () => {
  for (const cutoff of ['overflow', 'second', 'invalidation', 'close']) {
    const f = fixture(),
      o = f.observer
    o.startInput(0)
    if (cutoff === 'overflow') {
      for (let i = 0; i < 17; i++) {
        o.boundary('before', 'actual-epoch', i * 256 + 255)
        o.boundary('after', 'actual-epoch', i * 256 + 255)
      }
    } else {
      o.boundary('before', 'actual-epoch', 255)
      if (cutoff === 'second') f.time(1000)
      else if (cutoff === 'invalidation') o.invalidate(10)
      else o.close()
      o.boundary('after', 'actual-epoch', 255)
    }
    o.close()
    const report = o.report(four())
    assert.equal(report.assessment.outcome, 'INCONCLUSIVE')
    assert.ok(report.failure)
    assert.ok(report.events.length <= 32)
  }
})

test('per-callback and cumulative observer overhead reject evidence without throwing', () => {
  for (const cost of [0.101, 0.06]) {
    const f = fixture(),
      o = f.observer
    o.startInput(0)
    f.cost(cost)
    for (let i = 0; i < 10; i++) {
      o.boundary('before', 'actual-epoch', i * 256 + 255)
      o.boundary('after', 'actual-epoch', i * 256 + 255)
    }
    o.close()
    assert.match(o.report(four()).failure, /overhead/)
    assert.equal(o.report(four()).assessment.outcome, 'INCONCLUSIVE')
  }
  const f = fixture()
  f.observer.startInput(0)
  assert.doesNotThrow(() => f.observer.boundary('before', 'x'.repeat(65), 1))
  assert.match(f.observer.report([]).failure, /identity/)
})

test('early finalization, snapshot overflow, and escaped event bytes remain inconclusive', () => {
  const early = fixture()
  early.observer.startInput(0)
  early.time(80)
  early.observer.close()
  assert.match(early.observer.report(four()).failure, /before its frozen cutoff/)
  assert.equal(early.observer.report(four()).assessment.outcome, 'INCONCLUSIVE')
  const snapshots = fixture()
  snapshots.observer.startInput(0)
  for (let i = 0; i < 33; i++) snapshots.observer.snapshot()
  assert.equal(snapshots.reads(), 32)
  assert.match(snapshots.observer.report([]).failure, /snapshot overflow/)
  const bytes = fixture()
  bytes.observer.startInput(0)
  for (let i = 0; i < 16; i++) {
    bytes.observer.boundary('before', '\u0000'.repeat(64), i * 256 + 255)
    bytes.observer.boundary('after', '\u0000'.repeat(64), i * 256 + 255)
  }
  bytes.observer.invalidate(1)
  const report = bytes.observer.report(four())
  assert.match(report.failure, /8 KiB/)
  assert.deepEqual(report.events, [])
  assert.equal(report.assessment.outcome, 'INCONCLUSIVE')
})

test('slow endpoint samples cannot create a 5ms gap or a 75 percent no-yield span', () => {
  const short = [0, 20, 40, 60].map((at, ordinal) => ({
    ordinal,
    resources: {
      requestStart: snapshot(at, ordinal * 100),
      serverRequest: snapshot(at + 4, ordinal * 100 + 100, { at: at + 6 }),
      serverFinish: snapshot(at + 7, ordinal * 100 + 100),
      responseCallback: snapshot(at + 8, ordinal * 100 + 100),
    },
  }))
  assert.equal(assess(short).outcome, 'INCONCLUSIVE')
  const inflated = four()
  const events = []
  for (const row of inflated) {
    const at = row.resources.requestStart.sampledAt,
      ordinal = row.ordinal
    row.resources.serverRequest.consumer.at += 6
    row.resources.serverFinish = snapshot(at + 17, ordinal * 100 + 100)
    row.resources.responseCallback = snapshot(at + 18, ordinal * 100 + 100)
    events.push(
      { boundary: 'before', at: at + 1, epoch: 'actual-epoch', consumerSequence: ordinal * 100 + 20 },
      { boundary: 'after', at: at + 4, epoch: 'actual-epoch', consumerSequence: ordinal * 100 + 20 },
    )
  }
  const result = assess(inflated, events)
  assert.equal(result.outcome, 'UNSUPPORTED')
  assert.ok(result.gaps.every((row) => row.elapsedMs === 10 && row.noYieldFraction === 0.6))
  assert.ok(result.gaps.every((row) => row.endpointUncertaintyMs === 6))
})

test('existing sampler duration enters both callback and cumulative observer budgets', () => {
  const slow = fixture()
  slow.observer.startInput(0)
  slow.time(0.101)
  slow.observer.snapshot(0)
  assert.match(slow.observer.report([]).failure, /overhead/)
  assert.equal(slow.observer.report([]).maximumCallbackMs, 0.101)
  const cumulative = fixture()
  cumulative.observer.startInput(0)
  for (let i = 0; i < 32; i++) {
    cumulative.time(i + 0.04)
    cumulative.observer.snapshot(i)
  }
  const result = cumulative.observer.report([])
  assert.match(result.failure, /overhead/)
  assert.ok(result.observerMs > 1)
  assert.ok(result.maximumCallbackMs < 0.1)
  assert.equal(cumulative.reads(), 32)
})
