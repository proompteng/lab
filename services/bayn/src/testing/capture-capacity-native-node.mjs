import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Admin, Producer } from '@platformatic/kafka'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Fiber, Logger, Redacted, Result } from 'effect'

import { canonicalHashV1, sha256 } from '../hash.ts'
import { observeConsumedRecords } from './capture-capacity-iterator.ts'
import { observeCapacityIo } from './capture-capacity-io.mjs'
import { capacityAttributionCase, capacityCorpusHash, terminalHeartbeatMaximum } from './capture-capacity-metrics.mjs'
import { startCapacityCpuProfile, wholeProcessCpuMicros } from './capture-capacity-profile.mjs'
import { makeCapacitySqlProbes } from './capture-capacity-sql-probes.ts'
import { PostgresClientLive } from '../db/postgres-client.ts'
import { makeResearchCapturePostgresStore, readResearchCapturePostgresChunk } from '../db/research-capture-postgres.ts'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { makeKafkaMarketProjection, platformaticProjectionTransport } from '../market-data/streaming/kafka.ts'
import { decodeRawMarketRecord, RawMarketEventKind } from '../market-data/streaming/raw-events.ts'
import { CaptureDisposition, CaptureInvalidation, restoreKafkaTransportTimestamp } from '../research-capture/capture.ts'
import {
  deriveResearchCaptureExportManifest,
  researchCaptureObjectKey,
  verifyResearchCaptureExportPrefix,
} from '../research-capture/export.ts'
import { makeResearchCaptureRecorder } from '../research-capture/recorder.ts'
import { makeS3ResearchCaptureObjectStore } from '../research-capture/s3.ts'

const planBytes = readFileSync(process.argv[2])
const plan = JSON.parse(planBytes)
const expectedPlanHash = process.argv[5]
assert.equal(sha256(planBytes), expectedPlanHash)
const profileEnabled = process.env.BAYN_TEST_CAPTURE_CPU_PROFILE === '1'
const ioEnabled = process.env.BAYN_TEST_CAPTURE_IO_DIAGNOSTICS === '1'
assert.ok(!(profileEnabled && ioEnabled), 'Run one diagnostic mode at a time')
const attributionMode = process.argv[6] ?? null
const attributionCase = attributionMode === null ? null : capacityAttributionCase(attributionMode)
const proofLight = attributionCase?.proofLight ?? false
const attributionAnchor = Number(process.argv[8])
if (attributionMode !== null) {
  assert.ok(!profileEnabled && !ioEnabled, 'Attribution uses neither profiler nor I/O probes')
  assert.match(process.argv[7] ?? '', /^[0-9a-f]{64}$/)
  assert.ok(Number.isSafeInteger(attributionAnchor) && attributionAnchor >= 0)
}
if (profileEnabled || ioEnabled || attributionMode !== null)
  console.log(JSON.stringify({ instrumentedDiagnostic: true, capacityQualification: false }))
const sourceTopics = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const execution = JSON.parse(readFileSync(process.argv[4], 'utf8'))
const username = process.env.BAYN_TEST_KAFKA_USERNAME
const password = process.env.BAYN_TEST_KAFKA_PASSWORD
const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
assert.match(username ?? '', /^bayn-fixture-[0-9a-f]+$/)
assert.match(password ?? '', /^[0-9a-f]{64}$/)
const pgUrl = new URL(postgresUrl ?? '')
assert.ok(['127.0.0.1', 'localhost'].includes(pgUrl.hostname))
assert.equal(pgUrl.pathname, '/bayn_test')
assert.equal(pgUrl.port, '5432')
assert.equal(pgUrl.search, '')
assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), String(plan.worker.memoryBytes))
const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number)
assert.equal(quota / period, plan.worker.cpus)
assert.equal(Number(readFileSync('/sys/fs/cgroup/pids.max', 'utf8')), plan.worker.pids)
const cpuMicros = () => Number(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/^usage_usec (\d+)$/m)?.[1])
const memoryPeak = () => Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'))
const symbols = plan.dataset.symbols
const prefix = `bayn-capacity-${randomUUID()}`
const findTechnical = (value) => {
  if (!value || typeof value !== 'object') return undefined
  if (value.name === 'BAYN_KAFKA_TECHNICAL_FEATURES_TOPIC') return value.value
  return Object.values(value)
    .map(findTechnical)
    .find((value) => value !== undefined)
}
const configured = {
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
  features: 'torghut.market-features.v1',
  technicalFeatures: findTechnical(execution),
}
assert.equal(typeof configured.technicalFeatures, 'string')
const counts = Object.fromEntries(
  Object.entries(configured).map(([kind, topic]) => {
    const definition = sourceTopics.find((item) => item.kind === 'KafkaTopic' && item.metadata.name === topic)
    assert.ok(definition)
    return [kind, definition.spec.partitions]
  }),
)
assert.equal(
  Object.values(counts).reduce((a, b) => a + b, 0),
  25,
)
assert.deepEqual(counts, { bars: 3, quotes: 13, trades: 3, features: 3, technicalFeatures: 3 })
const connection = {
  bootstrapBrokers: ['127.0.0.1:19092'],
  sasl: { mechanism: 'SCRAM-SHA-512', username, password },
  retries: 0,
  requestTimeout: 5000,
  connectTimeout: 5000,
  timeout: 5000,
}
const admin = new Admin({ ...connection, clientId: `${prefix}-admin` })
const producer = new Producer({ ...connection, clientId: `${prefix}-producer` })
let active
const objectServer = createServer(async (request, response) => {
  const arm = active
  if (!arm || !request.url?.startsWith(`/${arm.bucket}/research-capture/sha256/`)) {
    response.writeHead(404).end()
    return
  }
  const key = new URL(request.url, 'http://fixture').pathname
  const io = arm.io
  const ioRequest = io?.serverStart(request.method, request.url, response)
  const attempt = `${request.method} ${key}`
  arm.requests.set(attempt, (arm.requests.get(attempt) ?? 0) + 1)
  try {
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*')
      const chunks = []
      let length = 0
      for await (const chunk of request) {
        length += chunk.byteLength
        assert.ok(length <= plan.limits.maximumObjectBodyBytes)
        chunks.push(chunk)
      }
      io?.serverMark(ioRequest, 'serverBodyConsumedAt')
      const bytes = Buffer.concat(chunks)
      if (arm.objects.has(key)) {
        io?.serverMark(ioRequest, 'serverResponseEndCalledAt')
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>')
        return
      }
      arm.storedBytes += bytes.byteLength
      assert.ok(arm.storedBytes <= plan.limits.maximumCombinedAttemptedSinkBytesPerArm)
      arm.objects.set(key, bytes)
      if (arm.inject && !arm.injected && arm.fault === 's3-put-committed-connection-drop') {
        arm.injected = true
        arm.faultRequest = attempt
        arm.faultObject = { key, bytes, contentHash: sha256(bytes) }
        assert.equal(arm.pendingObject.contentHash, arm.faultObject.contentHash)
        assert.deepEqual(bytes, Buffer.from(arm.pendingObject.payload))
        arm.faultStarted = performance.now()
        request.socket.destroy()
        return
      }
      io?.serverMark(ioRequest, 'serverResponseEndCalledAt')
      response.writeHead(200, { 'content-length': 0 }).end()
      return
    }
    if (request.method === 'GET') {
      const bytes = arm.objects.get(key)
      assert.ok(bytes)
      io?.serverMark(ioRequest, 'serverBodyConsumedAt')
      response.writeHead(200, {
        'content-length': bytes.byteLength,
        'content-type': 'application/octet-stream',
      })
      if (arm.inject && !arm.injected && arm.fault === 's3-get-body-stall' && bytes.byteLength > 1) {
        arm.injected = true
        arm.faultRequest = attempt
        arm.faultStarted = performance.now()
        response.write(bytes.subarray(0, 1))
        response.once('close', () => {
          arm.faultAbortedMs = performance.now() - arm.faultStarted
        })
        return
      }
      io?.serverMark(ioRequest, 'serverResponseEndCalledAt')
      response.end(bytes)
      return
    }
    throw new Error('Unexpected object operation')
  } catch (error) {
    arm.serverError = String(error)
    response.destroy()
  }
})
await new Promise((resolve) => objectServer.listen(0, '127.0.0.1', resolve))
const objectPort = objectServer.address().port
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0
const dataFor = (count, anchor) => {
  const data = []
  const hashes = new Set()
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const symbolIndex = ordinal % symbols.length
    const ns = BigInt(anchor) * 1000000n + BigInt(ordinal) * 200000n
    const timestamp = `${new Date(Number(ns / 1000000n)).toISOString().slice(0, 19)}.${String(ns % 1000000000n).padStart(9, '0')}Z`
    const bidUnits = (100 + symbolIndex) * 10000 + (ordinal % 1000)
    const value = Buffer.from(
      JSON.stringify({
        version: 2,
        provider: 'alpaca',
        feed: 'iex',
        delayClass: 'real_time_exchange_only',
        marketSession: 'regular',
        channel: 'quotes',
        symbol: symbols[symbolIndex],
        eventTs: timestamp,
        ingestTs: timestamp,
        payload: {
          t: timestamp,
          bp: bidUnits / 10000,
          ap: (bidUnits + 100) / 10000,
          bs: 100 + (ordinal % 7),
          as: 101 + (ordinal % 11),
        },
      }),
    )
    const hash = sha256(value)
    assert.ok(!hashes.has(hash))
    hashes.add(hash)
    data.push({ value, partition: symbolIndex % counts.quotes, timestamp: ns / 1000000n })
  }
  assert.ok(data.reduce((sum, item) => sum + item.value.byteLength, 0) <= plan.limits.maximumRawBytesPerArm)
  return data
}
const deterministicState = (projection, topics) => {
  const aliases = new Map(Object.entries(topics).map(([kind, topic]) => [topic, kind]))
  const quote = (entry) => ({
    value: { ...entry.value, sourceTopic: aliases.get(entry.value.sourceTopic) },
    recordHash: entry.recordHash,
  })
  const ordered = (map, transform = (value) => value) =>
    [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, transform(value)])
  for (const map of [
    projection.bars,
    projection.trades,
    projection.tradeHistory,
    projection.features,
    projection.technicalFeatures,
    projection.rejections,
    projection.discardedRejectionsThroughMs,
  ])
    assert.equal(map.size, 0)
  assert.deepEqual(projection.technicalRejections, [])
  assert.equal(projection.featureArrival, null)
  assert.equal(projection.technicalFeatureArrival, null)
  assert.equal(projection.quotes.size, symbols.length)
  assert.equal(projection.quoteHistory.size, symbols.length)
  for (const [symbol, entries] of projection.quoteHistory) {
    assert.equal(entries.length, 512)
    assert.equal(entries.at(-1).value.symbol, symbol)
    for (let index = 1; index < entries.length; index++)
      assert.ok(entries[index].value.eventAt > entries[index - 1].value.eventAt)
  }
  const offsets = [...projection.offsets]
    .map(([key, value]) => {
      const topic = Object.values(topics).find((topic) => typeof topic === 'string' && key.startsWith(`${topic}:`))
      assert.ok(topic)
      return [`${aliases.get(topic)}:${key.slice(topic.length + 1)}`, value]
    })
    .sort(([a], [b]) => a.localeCompare(b))
  return {
    sequence: projection.sequence,
    offsets,
    quotes: ordered(projection.quotes, quote),
    quoteHistory: ordered(projection.quoteHistory, (entries) => entries.map(quote)),
    emptyUnrelatedAndRejectionState: true,
  }
}
const reports = []
let totalRecords = 0
const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`SELECT 1 FROM research_capture_chunks LIMIT 0`
  const runArm = (name, enabled, data, rate, batchSize, fault) => {
    let reported = false
    let snapshot = () => ({ name, phase: 'setup' })
    return Effect.scoped(
      Effect.gen(function* () {
        totalRecords += data.length
        assert.ok(totalRecords <= plan.limits.maximumTotalRecords)
        const topics = Object.fromEntries(Object.keys(configured).map((kind) => [kind, `${prefix}-${name}-${kind}`]))
        for (const [kind, topic] of Object.entries(topics))
          yield* Effect.promise(() => admin.createTopics({ topics: [topic], partitions: counts[kind], replicas: 1 }))
        const universe = {
          universeId: prefix,
          universeSymbolHash: sha256(symbols.join('\n')),
          symbols,
          topics,
        }
        const expectedOffsets = new Map()
        const expectedHistory = new Map()
        const inputByPartition = new Map()
        for (const item of data) {
          const offset = expectedOffsets.get(item.partition) ?? 0
          const decoded = decodeRawMarketRecord(
            {
              topic: topics.quotes,
              partition: item.partition,
              offset: String(offset),
              timestampMs: Number(item.timestamp),
              value: item.value.toString('utf8'),
            },
            universe,
          )
          assert.ok(Result.isSuccess(decoded))
          assert.equal(decoded.success.kind, RawMarketEventKind.Quote)
          expectedOffsets.set(item.partition, offset + 1)
          const values = inputByPartition.get(item.partition) ?? []
          values.push(item)
          inputByPartition.set(item.partition, values)
          const history = expectedHistory.get(decoded.success.value.symbol) ?? []
          history.push({ value: { ...decoded.success.value, sourceTopic: 'quotes' }, recordHash: sha256(item.value) })
          if (history.length > 512) history.shift()
          expectedHistory.set(decoded.success.value.symbol, history)
        }
        const orderedHistory = [...expectedHistory].sort(([a], [b]) => a.localeCompare(b))
        const expectedStateHash = canonicalHashV1({
          sequence: data.length,
          offsets: [...expectedOffsets]
            .map(([partition, count]) => [`quotes:${partition}`, String(count - 1)])
            .sort(([a], [b]) => a.localeCompare(b)),
          quotes: orderedHistory.map(([symbol, entries]) => [symbol, entries.at(-1)]),
          quoteHistory: orderedHistory,
          emptyUnrelatedAndRejectionState: true,
        })
        const captureId = `${prefix}-${name}`
        const arm = {
          captureId,
          bucket: `bayn-fixture-${randomUUID()}`,
          fault,
          objects: new Map(),
          requests: new Map(),
          storedBytes: 0,
          chargedBytes: 0,
          injected: false,
          inject: false,
        }
        active = arm
        const charge = (bytes) => {
          arm.chargedBytes += bytes
          assert.ok(arm.chargedBytes <= plan.limits.maximumCombinedAttemptedSinkBytesPerArm)
        }
        const sinkTimings = {}
        let cpuProfile
        let activeSink = null
        let lastChunk = null
        const io =
          ioEnabled && name === 'normal-0-enabled'
            ? observeCapacityIo({ port: objectPort, bucket: arm.bucket, sink: () => activeSink })
            : undefined
        if (io !== undefined) {
          arm.io = io
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              io.dispose()
              console.log(io.encodedReport())
            }),
          )
        }
        const observedSql =
          io === undefined
            ? sql
            : new Proxy(sql, {
                apply: (target, receiver, args) => {
                  const statement = Reflect.apply(target, receiver, args)
                  const first = args[0][0].replace(/\s+/g, ' ').trim()
                  const kind = first.includes('pg_advisory_xact_lock')
                    ? 'lock'
                    : first.startsWith('SELECT chunk_ordinal')
                      ? 'frontier-read'
                      : first.startsWith('SELECT content_hash')
                        ? 'duplicate-read'
                        : first.startsWith('INSERT INTO research_capture_chunks')
                          ? 'chunk-insert'
                          : first.startsWith('INSERT INTO research_capture_seals')
                            ? 'seal-insert'
                            : 'other'
                  return Effect.suspend(() => {
                    const ordinal = io.beginSql(kind)
                    return statement.pipe(
                      Effect.onExit((exit) => Effect.sync(() => io.endSql(ordinal, Exit.isSuccess(exit)))),
                    )
                  })
                },
              })
        const nativeStore = makeResearchCapturePostgresStore(observedSql)
        const timedSink = (stage, bytes, operation) =>
          Effect.suspend(() => {
            const began = performance.now()
            const ioOrdinal = io?.beginSink(stage, bytes, began, lastChunk)
            const profileCpuStart = cpuProfile?.window.stoppedAt === null ? wholeProcessCpuMicros() : undefined
            activeSink = { stage, bytes, began, profileCpuStart, ioOrdinal }
            return operation.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  const ms = performance.now() - began
                  const value = (sinkTimings[stage] ??= { calls: 0, failed: 0, bytes: 0, totalMs: 0, maximumMs: 0 })
                  value.calls++
                  value.failed += Exit.isFailure(exit) ? 1 : 0
                  value.bytes += bytes
                  value.totalMs += ms
                  value.maximumMs = Math.max(value.maximumMs, ms)
                  io?.endSink(ioOrdinal, Exit.isSuccess(exit))
                  if (profileCpuStart !== undefined) {
                    value.profiledCalls = (value.profiledCalls ?? 0) + 1
                    value.diagnosticWholeProcessCpuMs =
                      (value.diagnosticWholeProcessCpuMs ?? 0) +
                      ((cpuProfile.window.cpuEnd ?? wholeProcessCpuMicros()) - profileCpuStart) / 1000
                    value.diagnosticProfileWindowWallMs =
                      (value.diagnosticProfileWindowWallMs ?? 0) +
                      Math.min(performance.now(), cpuProfile.window.stoppedAt ?? Infinity) -
                      began
                  }
                  activeSink = null
                }),
              ),
            )
          })
        const appendAttempts = new Map()
        const store = {
          append: (bytes) =>
            Effect.sync(() => {
              charge(Buffer.byteLength(bytes.payload))
              const chunk = JSON.parse(bytes.payload)
              const ordinal = chunk.chunkOrdinal
              const receiptBytes =
                Buffer.byteLength(bytes.payload) -
                Buffer.byteLength(JSON.stringify({ ...chunk, receipts: [] })) -
                Math.max(0, chunk.receipts.length - 1)
              const markets = chunk.receipts.filter((receipt) => receipt.event.kind === 'market-record')
              const rawBytes = markets.reduce((sum, receipt) => sum + (receipt.event.rawByteLength ?? 0), 0)
              lastChunk = {
                observedAtStage: 'sql-append-start',
                ordinal,
                receipts: chunk.receipts.length,
                marketRecords: markets.length,
                metadataBytes: Buffer.byteLength(bytes.payload),
                rawBytes,
                entryReservationBytes: 4 * receiptBytes + 3 * rawBytes + 512 * chunk.receipts.length,
              }
              appendAttempts.set(ordinal, (appendAttempts.get(ordinal) ?? 0) + 1)
              assert.equal(appendAttempts.get(ordinal), 1)
            }).pipe(
              Effect.andThen(() => {
                const started = performance.now()
                if (fault === 'postgres-table-lock-delay' && arm.injected) arm.faultAppendStarted = started
                return timedSink('sql.append', Buffer.byteLength(bytes.payload), nativeStore.append(bytes)).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (fault === 'postgres-table-lock-delay' && arm.injected && Exit.isFailure(exit))
                        arm.faultAbortedMs = performance.now() - started
                    }),
                  ),
                )
              }),
            ),
          seal: (bytes) =>
            Effect.sync(() => charge(Buffer.byteLength(bytes.payload))).pipe(
              Effect.andThen(() => timedSink('sql.seal', Buffer.byteLength(bytes.payload), nativeStore.seal(bytes))),
            ),
        }
        const objects = enabled
          ? yield* makeS3ResearchCaptureObjectStore({
              endpoint: `http://127.0.0.1:${objectPort}`,
              bucket: arm.bucket,
              region: 'us-east-1',
              accessKeyId: Redacted.make('fixture-access-key'),
              secretAccessKey: Redacted.make('fixture-secret-key'),
              timeoutMs: 1000,
            })
          : undefined
        const recorder = enabled
          ? yield* makeResearchCaptureRecorder(
              store,
              {
                captureId,
                sourceRevision: 'a'.repeat(40),
                maximumQueuedReceipts: 1024,
                maximumQueuedBytes: 4 * 1024 ** 2,
                maximumReceiptBytes: 64 * 1024,
                flushIntervalMs: 50,
                writeTimeoutMs: 1000,
                maximumObjectBytes: plan.limits.maximumCombinedAttemptedSinkBytesPerArm,
                maximumSqlBytes: plan.limits.maximumCombinedAttemptedSinkBytesPerArm,
              },
              {
                putVerified: (object) =>
                  Effect.sync(() => {
                    charge(object.payload.byteLength)
                    arm.pendingObject = object
                  }).pipe(
                    Effect.andThen(() => {
                      const prefix = Buffer.from(
                        object.payload.buffer,
                        object.payload.byteOffset,
                        Math.min(96, object.payload.byteLength),
                      ).toString('utf8')
                      const stage = prefix.startsWith('{"schemaVersion":"bayn.research-capture-chunk.v1"')
                        ? 'metadata'
                        : prefix.startsWith('{"schemaVersion":"bayn.research-capture-byte-index.v1"')
                          ? 'index'
                          : prefix.startsWith('{"schemaVersion":"bayn.research-capture-seal.v1"')
                            ? 'seal'
                            : prefix.startsWith('{"schemaVersion":"bayn.research-capture-export.v1"')
                              ? 'manifest'
                              : 'raw'
                      return timedSink(
                        `object.${stage}.putAndVerifiedGet`,
                        object.payload.byteLength,
                        objects.putVerified(object),
                      )
                    }),
                    Effect.onExit((exit) =>
                      Effect.sync(() => {
                        if (fault === 's3-put-committed-connection-drop' && arm.injected && Exit.isFailure(exit))
                          arm.faultAbortedMs = performance.now() - arm.faultStarted
                      }),
                    ),
                  ),
              },
            )
          : undefined
        let market
        let nativeEpoch
        let arrivalLowerBound
        let arrivalMinMs = Infinity
        let arrivalMaxMs = -Infinity
        let accepted = 0
        let published = 0
        let peakBacklog = 0
        let peakQueued = 0
        let peakRetained = 0
        let peakPayload = 0
        let progressAfterFailure = 0
        let invalidatedAtCount
        let started
        let cpuStart
        let firstInvalidation = null
        let commonInputCheckpoint = null
        let diagnosticFailure
        let inputStartSinkBaseline = null
        let latestCaptureStatus = null
        let admittedReceipts = 0
        let admittedMarketRecords = 0
        const heartbeat = []
        let lastBeat = performance.now()
        const arrivals = [20, 200].map((widthMs) => ({ widthMs, window: -1, count: 0, maximumRecords: 0 }))
        const producerTiming = {
          batches: 0,
          maximumLatenessMs: 0,
          minimumGapMs: null,
          maximumGapMs: 0,
          catchUpBatches: 0,
        }
        let lastBatchStarted
        snapshot = () => {
          const now = performance.now()
          const elapsedMs = started === undefined ? null : now - started
          return {
            name,
            phase: started === undefined ? 'setup' : 'input',
            elapsedMs,
            verifiedNativeRecords: proofLight ? null : accepted,
            deliveredRecords: accepted,
            perRecordProof: proofLight ? 'OMITTED_NON_QUALIFYING' : 'FULL',
            published,
            admittedReceipts,
            admittedMarketRecords,
            cpuCores: elapsedMs === null || elapsedMs <= 0 ? null : (cpuMicros() - cpuStart) / 1000 / elapsedMs,
            memoryPeakBytes: memoryPeak(),
            heartbeatP99Ms: percentile(heartbeat, 0.99),
            heartbeatMaxMs: Math.max(0, ...heartbeat),
            pendingHeartbeatLatenessMs: started === undefined ? null : Math.max(0, now - lastBeat - 10),
            peakBacklog,
            peakQueued,
            peakRetained,
            peakPayload,
            recorderEnvelopeBytes: enabled ? 65536 : 0,
            captureStatus: latestCaptureStatus,
            diagnosticFailure: diagnosticFailure === undefined ? null : String(diagnosticFailure),
            sinkTimingsSinceRecorderConstruction: sinkTimings,
            inputStartSinkBaseline,
            activeSink:
              activeSink === null
                ? null
                : { stage: activeSink.stage, bytes: activeSink.bytes, elapsedMs: now - activeSink.began },
            lastChunk,
            alignedArrivalBinsOfVerifiedRecords: arrivals,
            producerTiming,
          }
        }
        const sampleCapture = (event) => {
          try {
            const state = Effect.runSync(recorder.status)
            if (event !== undefined && state.accepting && state.invalidations.length === 0) {
              admittedReceipts++
              if (event.kind === 'market-record') admittedMarketRecords++
            }
            latestCaptureStatus = state
            peakRetained = Math.max(peakRetained, state.retainedReceipts)
            peakPayload = Math.max(peakPayload, state.retainedPayloadBytes)
            if (state.invalidations.length && firstInvalidation === null) {
              const recordCount = event?.kind === 'market-record' ? event.consumerSequence : accepted
              invalidatedAtCount = recordCount
              firstInvalidation = structuredClone({ ...snapshot(), observedAtMs: Date.now(), recordCount })
              console.log(JSON.stringify({ captureFirstInvalidation: firstInvalidation }))
              io?.invalidate()
              if (cpuProfile !== undefined) void cpuProfile.stop('invalidation')
            }
          } catch (error) {
            diagnosticFailure = error
          }
        }
        const capture = recorder
          ? {
              rawValues: recorder.rawValues,
              record: (event, at, raw) => {
                recorder.record(event, at, raw)
                sampleCapture(event)
              },
              invalidate: (reason) => {
                recorder.invalidate(reason)
                sampleCapture()
              },
            }
          : undefined
        const seenOffsets = new Map()
        const measuredTransport = (...args) => {
          const transport = platformaticProjectionTransport(...args)
          return {
            ...transport,
            consume: async (...input) => {
              const source = await transport.consume(...input)
              const observed = observeConsumedRecords(source, (record) => {
                let projection
                if (!proofLight) {
                  const key = `${record.topic}:${record.partition}`
                  assert.equal(BigInt(record.offset), BigInt((seenOffsets.get(key) ?? -1) + 1))
                  seenOffsets.set(key, Number(record.offset))
                  const symbol = JSON.parse(record.value).symbol
                  projection = Effect.runSync(market.readForLiquidation).projection
                  const current = projection.quotes.get(symbol)
                  assert.ok(current)
                  assert.equal(projection.epoch, nativeEpoch)
                  assert.ok(Number.isSafeInteger(current.availableAtMs))
                  assert.ok(current.availableAtMs >= arrivalLowerBound && current.availableAtMs <= Date.now())
                  assert.ok(current.availableAtMs >= arrivalMaxMs)
                  arrivalMinMs = Math.min(arrivalMinMs, current.availableAtMs)
                  arrivalMaxMs = current.availableAtMs
                  for (const bin of arrivals) {
                    const window = Math.floor(current.availableAtMs / bin.widthMs)
                    if (bin.window !== window) {
                      bin.window = window
                      bin.count = 0
                    }
                    bin.count++
                    bin.maximumRecords = Math.max(bin.maximumRecords, bin.count)
                  }
                  assert.equal(current.value.sourcePartition, record.partition)
                  assert.equal(current.value.sourceOffset, record.offset)
                  assert.equal(current.recordHash, sha256(record.value))
                }
                accepted++
                if (projection !== undefined) assert.equal(projection.sequence, accepted)
                peakBacklog = Math.max(peakBacklog, published - accepted)
                peakQueued = Math.max(peakQueued, source.queuedRecords())
                assert.equal(diagnosticFailure, undefined)
                assert.ok(
                  peakRetained <= 1024 && peakPayload <= 4 * 1024 ** 2,
                  'Capture retention exceeded its frozen bound',
                )
                if (invalidatedAtCount !== undefined) progressAfterFailure = accepted - invalidatedAtCount
                if (accepted >= plan.faults.triggerAfterRecords) arm.inject = true
                if (attributionMode !== null && accepted === 1000) commonInputCheckpoint = structuredClone(snapshot())
              })
              return {
                queuedRecords: () => source.queuedRecords(),
                drainedPositions: () => source.drainedPositions(),
                [Symbol.asyncIterator]: () => observed[Symbol.asyncIterator](),
              }
            },
          }
        }
        market = yield* makeKafkaMarketProjection(
          {
            brokers: ['127.0.0.1:19092'],
            username,
            password: Redacted.make(password),
            groupPrefix: captureId,
            operationTimeoutMs: 5000,
            bootstrapTimeoutMs: 15000,
            timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
          },
          universe,
          measuredTransport,
          undefined,
          capture,
        )
        const readyDeadline = performance.now() + 15000
        while (!(yield* market.status).ready) {
          assert.ok(performance.now() < readyDeadline)
          yield* Effect.sleep(10)
        }
        const initialState = yield* market.readForLiquidation
        nativeEpoch = initialState.projection.epoch
        assert.equal(initialState.bootstrap.epoch, nativeEpoch)
        arrivalLowerBound = Date.now()
        let running = true
        let finishStarted = false
        let finishDone = false
        const watch = yield* Effect.gen(function* () {
          while (running) {
            if (recorder && !finishStarted && (yield* recorder.status).invalidations.length) {
              sampleCapture()
              finishStarted = true
              yield* recorder.finish
              finishDone = true
            }
            yield* Effect.sleep(10)
          }
        }).pipe(Effect.forkChild)
        const faultFiber =
          fault === 'postgres-table-lock-delay'
            ? yield* Effect.gen(function* () {
                while (accepted < plan.faults.triggerAfterRecords) yield* Effect.sleep(1)
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`LOCK TABLE research_capture_chunks IN ACCESS EXCLUSIVE MODE`
                    arm.injected = true
                    arm.faultStarted = performance.now()
                    const releaseAt = performance.now() + 2000
                    let blocked
                    let cancelled = false
                    while (performance.now() < releaseAt) {
                      yield* sql`SELECT pg_stat_clear_snapshot()`
                      const waiting =
                        yield* sql`SELECT pid, query_start::text AS query_start FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND application_name = 'bayn' AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%FROM research_capture_chunks%' AND query LIKE '%AND chunk_ordinal =%'`
                      if (waiting.length) {
                        assert.equal(waiting.length, 1)
                        assert.equal(
                          cancelled,
                          false,
                          'Cancelled PostgreSQL append was retried while lock remained held',
                        )
                        blocked ??= waiting[0]
                        assert.deepEqual(waiting[0], blocked)
                      } else if (blocked && !cancelled) {
                        cancelled = true
                        arm.pgCancellationMs = performance.now() - arm.faultAppendStarted
                        assert.ok(arm.pgCancellationMs <= 1100)
                        arm.pgCancelledQuery = blocked
                      }
                      yield* Effect.sleep(10)
                    }
                    assert.ok(blocked && cancelled, 'Server-side blocked append must disappear before lock release')
                  }),
                )
              }).pipe(Effect.forkChild)
            : undefined
        const sqlLatency = []
        const sqlProbes = makeCapacitySqlProbes(() => firstInvalidation !== null)
        let probeFailed = false
        lastBeat = performance.now()
        const timer = yield* Effect.acquireRelease(
          Effect.sync(() =>
            setInterval(() => {
              const now = performance.now()
              heartbeat.push(Math.max(0, now - lastBeat - 10))
              lastBeat = now
              assert.ok(heartbeat.length <= 24000)
            }, 10),
          ),
          (timer) => Effect.sync(() => clearInterval(timer)),
        )
        const probes = yield* Effect.gen(function* () {
          while (running) {
            const before = performance.now()
            const observing = io?.withinWindow() === true
            const query = observing
              ? sql`
                  SELECT 1 AS value, COALESCE((
                    SELECT json_agg(json_build_object(
                      'pid', pid, 'state', state, 'waitType', wait_event_type, 'waitEvent', wait_event,
                      'queryKind', CASE
                        WHEN position('pg_advisory_xact_lock' in query) > 0 THEN 'lock'
                        WHEN query ~* 'INSERT.*research_capture_chunks' THEN 'chunk-insert'
                        WHEN query ~* 'INSERT.*research_capture_seals' THEN 'seal-insert'
                        WHEN position('research_capture_chunks' in query) > 0 THEN 'capture-read'
                        ELSE 'other' END,
                      'queryAgeMs', extract(epoch FROM clock_timestamp() - query_start) * 1000,
                      'stateAgeMs', extract(epoch FROM clock_timestamp() - state_change) * 1000
                    )) FROM (
                      SELECT pid, state, wait_event_type, wait_event, query, query_start, state_change
                      FROM pg_stat_activity
                      WHERE datname = current_database() AND usename = current_user
                        AND application_name = 'bayn' AND pid <> pg_backend_pid()
                        AND query_start IS NOT NULL AND state_change IS NOT NULL
                      ORDER BY pid LIMIT 8
                    ) AS observed_backends
                  ), '[]'::json) AS sessions
                `
              : sql`SELECT 1 AS value`
            const rows = yield* sqlProbes.run(query)
            assert.equal(Number(rows[0].value), 1)
            if (observing) io.pgSample(rows[0].sessions, before)
            sqlLatency.push(performance.now() - before)
            assert.ok(sqlLatency.length <= 2400)
            yield* Effect.sleep(100)
          }
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              if (running) probeFailed = true
            }),
          ),
          Effect.forkChild,
        )
        if (profileEnabled && name === 'normal-0-enabled')
          cpuProfile = yield* Effect.acquireRelease(Effect.promise(startCapacityCpuProfile), (profile) =>
            Effect.promise(async () => {
              console.log(JSON.stringify({ capacityCpuProfile: await profile.stop('finalization') }))
            }),
          )
        cpuStart = cpuMicros()
        started = performance.now()
        io?.startInput(started)
        if (cpuProfile !== undefined) cpuProfile.window.inputStartOffsetMs = started - cpuProfile.window.startedAt
        inputStartSinkBaseline = structuredClone({
          completedOperations: sinkTimings,
          activeOperation:
            activeSink === null
              ? null
              : { stage: activeSink.stage, bytes: activeSink.bytes, elapsedBeforeInputMs: started - activeSink.began },
        })
        let publishFinished
        yield* Effect.promise(async () => {
          for (let index = 0; index < data.length; index += batchSize) {
            if (rate) await delay(Math.max(0, started + (index / rate) * 1000 - performance.now()))
            const batchStarted = performance.now()
            producerTiming.batches++
            if (rate)
              producerTiming.maximumLatenessMs = Math.max(
                producerTiming.maximumLatenessMs,
                batchStarted - started - (index / rate) * 1000,
              )
            if (lastBatchStarted !== undefined) {
              const gap = batchStarted - lastBatchStarted
              producerTiming.minimumGapMs = Math.min(producerTiming.minimumGapMs ?? gap, gap)
              producerTiming.maximumGapMs = Math.max(producerTiming.maximumGapMs, gap)
              if (rate && gap < (batchSize / rate) * 500) producerTiming.catchUpBatches++
            }
            lastBatchStarted = batchStarted
            const batch = data.slice(index, index + batchSize)
            await producer.send({
              messages: batch.map((item) => ({
                topic: topics.quotes,
                partition: item.partition,
                value: item.value,
                timestamp: item.timestamp,
              })),
            })
            published += batch.length
            peakBacklog = Math.max(peakBacklog, published - accepted)
          }
          publishFinished = performance.now()
        })
        const offeredRate = data.length / ((publishFinished - started) / 1000)
        const deadline = publishFinished + plan.performancePass.maximumDrainAfterProducerMs
        while (
          accepted < data.length ||
          (recorder &&
            !fault &&
            !finishStarted &&
            (yield* recorder.status).persistedReceipts < (yield* recorder.status).observedReceipts)
        ) {
          assert.ok(performance.now() < deadline)
          const status = yield* market.status
          assert.ok(status.ready && status.failure === undefined)
          if (fault && finishStarted && !finishDone) {
            yield* Effect.sleep(10)
            continue
          }
          yield* Effect.sleep(10)
        }
        if (finishStarted || fault)
          while (!finishDone) {
            assert.ok(performance.now() < deadline)
            yield* Effect.sleep(10)
          }
        if (recorder && !finishStarted) {
          finishStarted = true
          yield* recorder.finish
          finishDone = true
        }
        if (fault)
          while (sqlProbes.progress.completedAfterInvalidation === 0) {
            assert.equal(probeFailed, false, 'Post-invalidation SQL probe failed')
            assert.ok(performance.now() < deadline, 'Post-invalidation SQL probe exceeded the drain deadline')
            yield* Effect.sleep(10)
          }
        assert.ok(performance.now() < deadline)
        const drainedAt = performance.now()
        const measuredMs = drainedAt - started
        const cpuCores = (cpuMicros() - cpuStart) / 1000 / measuredMs
        const wholeArmDiagnostics = structuredClone(snapshot())
        assert.equal(probeFailed, false)
        assert.ok(sqlLatency.length > 0)
        running = false
        clearInterval(timer)
        yield* Fiber.interrupt(watch)
        yield* Fiber.interrupt(probes)
        if (faultFiber) yield* Fiber.join(faultFiber)
        assert.equal(accepted, data.length)
        const state = yield* market.readForLiquidation
        for (const [partition, count] of expectedOffsets)
          assert.equal(state.projection.offsets.get(`${topics.quotes}:${partition}`), String(count - 1))
        assert.equal(state.positions.length, 25)
        assert.equal(state.projection.technicalTopic, topics.technicalFeatures)
        assert.equal(state.projection.epoch, nativeEpoch)
        assert.equal(state.bootstrap.epoch, nativeEpoch)
        const stateHash = canonicalHashV1(deterministicState(state.projection, topics))
        assert.equal(stateHash, expectedStateHash)
        if (proofLight) arrivalMaxMs = Date.now()
        const captureStatus = recorder ? yield* recorder.status : undefined
        const report = {
          name,
          enabled,
          fault,
          accepted,
          perRecordProof: proofLight ? 'OMITTED_NON_QUALIFYING' : 'FULL',
          arrivalClockEvidence: proofLight ? 'FINAL_READBACK_BOUND_ONLY' : 'PER_RECORD',
          commonInputCheckpoint,
          rejected: 0,
          ignored: 0,
          stateHash,
          measuredMs,
          producerMs: publishFinished - started,
          drainMs: drainedAt - publishFinished,
          rawInputBytes: data.reduce((sum, item) => sum + item.value.byteLength, 0),
          nativeEpoch,
          bootstrapEpoch: state.bootstrap.epoch,
          arrivalLowerBound,
          arrivalMinMs: proofLight ? null : arrivalMinMs,
          arrivalMaxMs,
          pgCancellationMs: arm.pgCancellationMs ?? null,
          pgCancelledQuery: arm.pgCancelledQuery ?? null,
          offeredRate,
          cpuCores,
          memoryPeakBytes: memoryPeak(),
          heartbeatP99Ms: percentile(heartbeat, 0.99),
          heartbeatMaxMs: terminalHeartbeatMaximum(wholeArmDiagnostics),
          sqlProbeMaxMs: Math.max(0, ...sqlLatency),
          sqlProbes: { ...sqlProbes.progress },
          peakBacklog,
          peakQueued,
          peakRetained,
          peakPayload,
          progressAfterFailure,
          faultAbortedMs: arm.faultAbortedMs ?? null,
          attemptedSinkBytes: arm.chargedBytes,
          captureActive: {
            endReason: firstInvalidation === null ? 'finish' : 'invalidation',
            metrics: firstInvalidation ?? wholeArmDiagnostics,
          },
          wholeArmDiagnostics,
          finalCaptureStatus: captureStatus ?? null,
          invalidations: captureStatus?.invalidations ?? [],
        }
        reports.push(report)
        console.log(JSON.stringify({ capacityArm: report }))
        reported = true
        assert.equal(diagnosticFailure, undefined)
        assert.ok(peakRetained <= 1024 && peakPayload <= 4 * 1024 ** 2, 'Capture retention exceeded its frozen bound')
        if (enabled && !fault && rate && attributionMode === null) assert.deepEqual(captureStatus.invalidations, [])
        if (enabled && attributionMode !== null)
          assert.ok(
            captureStatus.invalidations.every((reason) => reason === CaptureInvalidation.Overflow),
            'Attribution stopped on an unrelated capture failure',
          )
        if (fault) {
          assert.ok(arm.injected)
          assert.ok(captureStatus.invalidations.includes(CaptureInvalidation.Persistence))
          assert.ok(progressAfterFailure > 0)
          assert.ok(Number.isFinite(arm.faultAbortedMs) && arm.faultAbortedMs <= 1100)
          if (arm.faultRequest) assert.equal(arm.requests.get(arm.faultRequest), 1)
        }
        assert.equal(arm.serverError, undefined)
        assert.ok(
          report.memoryPeakBytes <= plan.performancePass.maximumCgroupMemoryPeakBytes,
          'PERFORMANCE: cgroup memory peak',
        )
        assert.ok(report.cpuCores <= plan.performancePass.maximumAverageWorkerCpuCores, 'PERFORMANCE: average CPU')
        assert.ok(
          report.heartbeatP99Ms <= plan.performancePass.maximumHeartbeatP99DelayMs,
          'PERFORMANCE: heartbeat p99',
        )
        assert.ok(
          report.heartbeatMaxMs <= plan.performancePass.maximumHeartbeatDelayMs,
          'PERFORMANCE: heartbeat maximum',
        )
        assert.ok(
          report.sqlProbeMaxMs <= plan.performancePass.maximumSqlProbeLatencyMs,
          'PERFORMANCE: SQL probe latency',
        )
        if (rate && !fault)
          assert.ok(
            offeredRate >= plan.normal.minimumObservedRecordsPerSecond,
            'INCONCLUSIVE: offered rate below frozen floor',
          )
        return { report, captureId, recorder, arm, inputByPartition, topics }
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && !reported) console.log(JSON.stringify({ capacityFailure: snapshot() }))
          }),
        ),
      ),
    )
  }
  const validateClosed = (result) =>
    Effect.gen(function* () {
      if (!result.recorder) return
      const status = yield* result.recorder.status
      assert.equal(status.retainedReceipts, 0)
      assert.ok(status.retainedPayloadBytes <= 64 * 1024)
      const rows =
        yield* sql`SELECT content_hash, payload FROM research_capture_seals WHERE capture_id = ${result.captureId} AND octet_length(convert_to(payload, 'UTF8')) <= 65536`
      const clean = !result.report.fault && result.report.invalidations.length === 0
      if (clean) assert.equal(rows.length, 1)
      const acknowledgedObjects = new Set()
      let marketCount = 0
      if (rows.length) {
        const sealBytes = { contentHash: rows[0].content_hash, payload: rows[0].payload }
        assert.equal(sha256(sealBytes.payload), sealBytes.contentHash)
        const seal = JSON.parse(sealBytes.payload)
        assert.equal(seal.qualification, 'UNQUALIFIED')
        if (clean) {
          assert.deepEqual(seal.invalidations, [])
          assert.equal(seal.observedReceipts, seal.persistedReceipts)
        } else assert.ok(seal.invalidations.length > 0)
        const manifest = Result.getOrThrow(deriveResearchCaptureExportManifest(sealBytes))
        const object = (hash) => {
          const bytes = result.arm.objects.get(`/${result.arm.bucket}/${researchCaptureObjectKey(hash)}`)
          assert.ok(bytes && bytes.byteLength <= plan.limits.maximumObjectBodyBytes)
          assert.equal(sha256(bytes), hash)
          acknowledgedObjects.add(hash)
          return bytes
        }
        const manifestBytes = {
          contentHash: manifest.contentHash,
          payload: object(manifest.contentHash).toString('utf8'),
        }
        assert.equal(object(sealBytes.contentHash).toString('utf8'), sealBytes.payload)
        const chunks = []
        let indexHash = seal.exportRoot.lastIndexHash
        let readBytes = 0
        while (indexHash !== null) {
          assert.ok(chunks.length < seal.persistedChunks)
          const indexBytes = { contentHash: indexHash, payload: object(indexHash).toString('utf8') }
          const index = JSON.parse(indexBytes.payload)
          const metadata = yield* readResearchCapturePostgresChunk(
            sql,
            result.captureId,
            index.chunkOrdinal,
            plan.limits.maximumObjectBodyBytes,
          )
          assert.equal(object(index.metadata.contentHash).toString('utf8'), metadata.payload)
          const raw = object(index.raw.contentHash)
          readBytes += Buffer.byteLength(indexBytes.payload) + Buffer.byteLength(metadata.payload) + raw.byteLength
          assert.ok(readBytes <= plan.limits.maximumCombinedAttemptedSinkBytesPerArm)
          chunks.push({ index: indexBytes, metadata, raw })
          indexHash = index.previousIndexHash
        }
        chunks.reverse()
        const verified = Result.getOrThrow(verifyResearchCaptureExportPrefix(chunks, sealBytes, manifestBytes))
        assert.equal(verified.exportVerified, true)
        const captureOffsets = new Map()
        for (const chunk of chunks) {
          for (const receipt of JSON.parse(chunk.metadata.payload).receipts) {
            const event = receipt.event
            if (event.kind !== 'market-record') continue
            const offset = captureOffsets.get(event.partition) ?? 0
            assert.equal(event.offset, String(offset))
            captureOffsets.set(event.partition, offset + 1)
            const input = result.inputByPartition.get(event.partition)?.[offset]
            assert.ok(input)
            assert.equal(event.topic, result.topics.quotes)
            assert.equal(event.consumerEpoch, result.report.nativeEpoch)
            assert.equal(event.disposition, CaptureDisposition.Accepted)
            assert.equal(event.tombstone, false)
            assert.equal(event.rawByteLength, input.value.byteLength)
            assert.equal(event.rawValueSha256, sha256(input.value))
            assert.equal(restoreKafkaTransportTimestamp(event.originalTransport), Number(input.timestamp))
            assert.ok(receipt.observedAtMs >= result.report.arrivalLowerBound)
            assert.ok(receipt.observedAtMs <= result.report.arrivalMaxMs)
            marketCount++
            assert.equal(event.consumerSequence, marketCount)
            assert.equal(event.projectionSequence, marketCount)
          }
        }
        if (clean) {
          assert.equal(marketCount, result.report.accepted)
          for (const [partition, inputs] of result.inputByPartition)
            assert.equal(captureOffsets.get(partition), inputs.length)
        }
      }
      if (result.arm.faultObject) {
        assert.equal(rows.length, 1, 'Dropped PUT must be checked against a durable incomplete seal')
        const faultObject = result.arm.faultObject
        assert.equal(sha256(result.arm.objects.get(faultObject.key)), faultObject.contentHash)
        assert.equal(acknowledgedObjects.has(faultObject.contentHash), false)
        assert.equal(result.arm.requests.get(`PUT ${faultObject.key}`), 1)
        assert.equal(result.arm.requests.get(`GET ${faultObject.key}`) ?? 0, 0)
        assert.ok(marketCount < result.report.accepted)
      }
      console.log(
        JSON.stringify({
          captureReadback: {
            name: result.report.name,
            acknowledgedMarketRecords: marketCount,
            acknowledgedObjects: acknowledgedObjects.size,
            orphanedPut: result.arm.faultObject
              ? {
                  contentHash: result.arm.faultObject.contentHash,
                  byteLength: result.arm.faultObject.bytes.byteLength,
                  putAttempts: 1,
                  acknowledged: false,
                }
              : null,
          },
        }),
      )
      result.arm.objects.clear()
    })
  if (attributionMode !== null) {
    const data = dataFor(plan.normal.recordsPerArm, attributionAnchor)
    const corpusHash = capacityCorpusHash(data)
    assert.equal(corpusHash, process.argv[7], 'Attribution input must match the frozen corpus')
    console.log(
      JSON.stringify({
        attributionInput: {
          mode: attributionMode,
          processId: process.pid,
          corpusHash,
          recordsPerArm: data.length,
          anchor: attributionAnchor,
        },
      }),
    )
    const base = yield* runArm(
      attributionCase.disabledName,
      false,
      data,
      plan.normal.targetRecordsPerSecond,
      plan.normal.producerBatchSize,
    )
    const enabled = yield* runArm(
      attributionCase.enabledName,
      true,
      data,
      plan.normal.targetRecordsPerSecond,
      plan.normal.producerBatchSize,
    )
    yield* validateClosed(enabled)
    assert.equal(base.report.stateHash, enabled.report.stateHash)
    assert.ok(
      enabled.report.cpuCores - base.report.cpuCores <= plan.performancePass.maximumNormalEnabledIncrementalCpuCores,
    )
    assert.ok(
      enabled.report.heartbeatP99Ms - base.report.heartbeatP99Ms <=
        plan.performancePass.maximumNormalEnabledP99IncreaseMs,
    )
    assert.equal(totalRecords, 100000)
    assert.ok(base.report.commonInputCheckpoint && enabled.report.commonInputCheckpoint)
    console.log(
      JSON.stringify({
        attributionPair: {
          mode: attributionMode,
          corpusHash,
          capacityQualification: false,
          reports: [base.report, enabled.report],
        },
      }),
    )
    return
  }
  for (let repeat = 0; repeat < plan.normal.pairedRepetitions; repeat++) {
    const data = dataFor(plan.normal.recordsPerArm, Date.now() - 1000)
    const base = yield* runArm(
      `normal-${repeat}-disabled`,
      false,
      data,
      plan.normal.targetRecordsPerSecond,
      plan.normal.producerBatchSize,
    )
    const enabled = yield* runArm(
      `normal-${repeat}-enabled`,
      true,
      data,
      plan.normal.targetRecordsPerSecond,
      plan.normal.producerBatchSize,
    )
    yield* validateClosed(enabled)
    assert.equal(base.report.stateHash, enabled.report.stateHash)
    assert.ok(
      enabled.report.cpuCores - base.report.cpuCores <= plan.performancePass.maximumNormalEnabledIncrementalCpuCores,
    )
    assert.ok(
      enabled.report.heartbeatP99Ms - base.report.heartbeatP99Ms <=
        plan.performancePass.maximumNormalEnabledP99IncreaseMs,
    )
  }
  const burstData = dataFor(plan.burst.recordsPerArm, Date.now() - 3000)
  const burstBase = yield* runArm('burst-disabled', false, burstData, 0, plan.burst.producerBatchSize)
  const burstEnabled = yield* runArm('burst-enabled', true, burstData, 0, plan.burst.producerBatchSize)
  yield* validateClosed(burstEnabled)
  assert.equal(burstBase.report.stateHash, burstEnabled.report.stateHash)
  for (const fault of plan.faults.cases) {
    const result = yield* runArm(
      fault,
      true,
      burstData,
      plan.faults.targetRecordsPerSecond,
      plan.normal.producerBatchSize,
      fault,
    )
    yield* validateClosed(result)
    assert.equal(result.report.stateHash, burstBase.report.stateHash)
  }
  assert.equal(totalRecords, plan.limits.maximumTotalRecords)
})
try {
  await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.timeout('4 minutes'),
      Effect.provide(
        PostgresClientLive({
          operationTimeoutMs: 30000,
          postgres: { url: Redacted.make(postgresUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.provide(Logger.layer([])),
    ),
  )
  assert.equal(Number(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').match(/^oom_kill (\d+)$/m)?.[1]), 0)
  assert.ok(
    memoryPeak() <= plan.performancePass.maximumCgroupMemoryPeakBytes,
    'PERFORMANCE: final lifetime memory peak',
  )
  console.log(
    JSON.stringify({
      capacityResult:
        attributionMode !== null
          ? 'NON_QUALIFYING_ATTRIBUTION'
          : profileEnabled || ioEnabled
            ? 'INSTRUMENTED_DIAGNOSTIC_ONLY'
            : 'PASS',
      capacityQualification: attributionMode === null && !profileEnabled && !ioEnabled,
      planHash: sha256(planBytes),
      totalRecords,
      memoryPeakBytes: memoryPeak(),
      reports,
      limitations:
        'Isolated diagnostic; producer and localhost object fixture share the capped process, so CPU/RSS include their conservative overhead. No real Ceph, TLS PostgreSQL, full trading workflow or production peak claim.',
    }),
  )
} finally {
  await producer.close()
  await admin.close()
  objectServer.closeAllConnections()
  await new Promise((resolve) => objectServer.close(resolve))
}
if (attributionMode !== null || profileEnabled || ioEnabled) process.exitCode = 42
