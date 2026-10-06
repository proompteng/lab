import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import { observeCapacityIo } from './capture-capacity-io.mjs'
const requestFor = (bucket, index = 0) =>
  Object.assign(new EventEmitter(), {
    method: 'GET',
    path: `/${bucket}/research-capture/sha256/${String(index).padStart(64, '0')}?x-id=GetObject`,
    getHeader: (name) => (name === 'host' ? '127.0.0.1:12345' : 'synthetic-private-header'),
  })
const publish = (name, request) => channel(name).publish({ request })
const read = (observer) => JSON.parse(observer.encodedReport()).capacityIoDiagnostics
const counters = (at) => ({
  sampledAt: at,
  samplerElapsedMs: 0,
  threadUserUs: at * 100,
  threadSystemUs: at * 10,
  eventLoopActiveMs: at,
  eventLoopIdleMs: 0,
  cgroupUsageUs: at * 110,
  cgroupPeriods: at,
  cgroupThrottledPeriods: 0,
  cgroupThrottledUs: 0,
})

test('correlates same-clock callbacks, preserves server ages, and detaches observers', () => {
  let now = 0
  const observer = observeCapacityIo({
    port: 12345,
    bucket: 'clock',
    sink: () => ({ stage: 'object.raw.putAndVerifiedGet', began: 1 }),
    now: () => now,
    sampleResources: () => counters(now),
  })
  try {
    observer.startInput(1)
    const stage = observer.beginSink('object.raw.putAndVerifiedGet', 10, 1)
    const request = requestFor('clock'),
      response = new EventEmitter()
    now = 2
    publish('http.client.request.created', request)
    now = 3
    publish('http.client.request.start', request)
    now = 4
    const id = observer.serverStart('GET', request.path, response)
    now = 5
    observer.serverMark(id, 'serverBodyConsumedAt')
    now = 6
    observer.serverMark(id, 'serverResponseEndCalledAt')
    now = 7
    observer.invalidate()
    now = 8
    response.emit('finish')
    now = 9
    publish('http.client.response.finish', request)
    now = 10
    request.emit('response', { statusCode: 200 })
    observer.endSink(stage, true)
    const sql = observer.beginSql('lock')
    now = 11
    observer.endSql(sql, true)
    observer.pgSample([
      {
        pid: 3,
        state: 'idle in transaction',
        waitType: 'Client',
        waitEvent: 'ClientRead',
        queryKind: 'lock',
        queryAgeMs: 45,
        stateAgeMs: 20,
        query: 'synthetic-private-query',
      },
    ])
    const result = read(observer)
    assert.equal(result.failure, null)
    assert.equal(result.http.length, 1)
    assert.equal(result.http[0].serverRequestAt, 4)
    assert.equal(result.http[0].responseFinishDiagnosticCallbackAt, 9)
    assert.equal(result.http[0].headersAt, 10)
    assert.equal(result.http[0].completedPhase, 'input-after-invalidation')
    assert.equal(result.serverSamples[0].rows[0].stateAgeMs, 20)
    assert.equal(result.sql[0].finishedAt, 11)
    assert.equal(result.stages[0].finishedAt, 10)
    assert.ok(!observer.encodedReport().includes('synthetic-private'))
    now = 1002
    observer.pgSample([], 999)
    assert.equal(read(observer).serverSamples[1].requestedClientAt, 999)
    assert.equal(read(observer).serverSamples[1].observedClientAt, 1002)
    observer.dispose()
    now = 1003
    publish('http.client.request.created', requestFor('clock', 1))
    assert.equal(read(observer).http.length, 1)
    assert.equal(request.listenerCount('response'), 0)
    assert.equal(response.listenerCount('close'), 0)
  } finally {
    observer.dispose()
  }
})

test('limits observation count and elapsed admission without throwing through callbacks', () => {
  let now = 0
  const observer = observeCapacityIo({
    port: 12345,
    bucket: 'count',
    sink: () => null,
    now: () => now,
    sampleResources: () => counters(now),
  })
  const requests = []
  const pendingResponse = new EventEmitter()
  try {
    observer.startInput(0)
    for (let index = 0; index < 65; index++) {
      const request = requestFor('count', index)
      requests.push(request)
      publish('http.client.request.created', request)
    }
    assert.equal(read(observer).http.length, 64)
    observer.serverStart('GET', requests[0].path, pendingResponse)
    assert.match(read(observer).failure, /count exceeded 64/)
    for (let index = 0; index < 65; index++) {
      observer.beginSql('lock')
      observer.beginSink('sql.append', 10, 0)
    }
    assert.equal(read(observer).sql.length, 64)
    assert.equal(read(observer).stages.length, 64)
    now = 1001
    assert.equal(observer.withinWindow(), false)
    assert.equal(observer.beginSql('lock'), undefined)
  } finally {
    observer.dispose()
  }
  for (const request of requests) assert.equal(request.listenerCount('response'), 0)
  assert.equal(pendingResponse.listenerCount('finish'), 0)
  assert.equal(pendingResponse.listenerCount('close'), 0)
})

test('bounds encoded output even when bounded strings require JSON escaping', () => {
  const observer = observeCapacityIo({ port: 12345, bucket: 'bytes', sink: () => null, now: () => 0 })

  try {
    const rows = Array.from({ length: 8 }, (_, pid) => ({
      pid,
      state: '\u0000'.repeat(64),
      waitType: '\u0000'.repeat(64),
      waitEvent: '\u0000'.repeat(64),
      queryKind: '\u0000'.repeat(64),
      queryAgeMs: 0,
      stateAgeMs: 0,
    }))
    for (let i = 0; i < 16; i++) observer.pgSample(rows)
    const report = observer.encodedReport()
    assert.ok(Buffer.byteLength(report) + 1 <= 128 * 1024)
    assert.equal(JSON.parse(report).capacityIoDiagnostics.failure, 'Encoded diagnostic exceeded 128 KiB')
  } finally {
    observer.dispose()
  }
})

test('limits resource observations to eight input requests and reports unsupported samples', () => {
  let now = 0,
    samples = 0
  const observer = observeCapacityIo({
    port: 12345,
    bucket: 'resources',
    sink: () => null,
    now: () => now,
    sampleResources: () => {
      samples++
      return counters(now)
    },
  })
  try {
    const finishRequest = (index) => {
      const request = requestFor('resources', index),
        response = new EventEmitter()
      publish('http.client.request.created', request)
      now++
      publish('http.client.request.start', request)
      now++
      observer.serverStart('GET', request.path, response)
      now++
      response.emit('finish')
      now++
      publish('http.client.response.finish', request)
    }
    finishRequest(0)
    observer.startInput(now)
    for (let index = 1; index <= 9; index++) finishRequest(index)
    const report = read(observer)
    assert.equal(report.failure, null)
    assert.equal(samples, 32)
    assert.deepEqual(report.resourceObservation, {
      maximumRequests: 8,
      maximumSnapshots: 32,
      requests: 8,
      snapshots: 32,
    })
    assert.equal(report.http[0].resources, undefined)
    assert.equal(report.http[9].resources, undefined)
    assert.equal(report.http[1].resourceDeltas.serverRequest.threadUserUs, 100)
  } finally {
    observer.dispose()
  }
  const unsupported = observeCapacityIo({
    port: 12345,
    bucket: 'unsupported',
    sink: () => null,
    now: () => 0,
    sampleResources: () => {
      throw new Error('Unsupported test counter')
    },
  })
  try {
    unsupported.startInput(0)
    const request = requestFor('unsupported')
    publish('http.client.request.created', request)
    assert.doesNotThrow(() => publish('http.client.request.start', request))
    assert.match(read(unsupported).failure, /Unsupported test counter/)
    assert.equal(read(unsupported).http[0].resources.requestStart, undefined)
  } finally {
    unsupported.dispose()
  }
})
