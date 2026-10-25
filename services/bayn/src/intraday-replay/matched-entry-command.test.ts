import { replayTestInstruments } from '../testing/replay-instruments'
import { equityMarketProfile } from '../jev/markets'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Deferred, Effect, Exit, Fiber, FileSystem, Result } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import { sha256, canonicalHashV1Result } from '../hash'
import { nativeJevBatchResult, nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { JevBatchPlanVersion } from '../jev/batch'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { makeJevObservation } from '../jev/observation'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { historicalRawArrivals } from '../testing/historical-streaming-fixture'
import { retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { compareArrivalPositions, arrivalPosition } from '../market-data/streaming/historical'
import { runMatchedCommand } from '../../tools/matched-entry-study'
import { matchedEntryDefinition, MatchedDataRole, runMatchedEntryStudy } from './matched-entry-study'
import { ControlExit } from './control-portfolio'
import { OrderSide } from '../execution/contracts'
import { backtestSourcePartitions, type BacktestSourceManifest } from './source'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { matchedCommittedDecisionFixture } from './matched-entry.test-support'
import { SignalStudyFailure } from './signal-study'
import { CycleState } from '../cycle/model'
import { JevPurpose } from '../jev/portfolio'
import { defaultJevProtocolDocument } from '../jev/protocol'

const inventoryFor = (data: ReturnType<typeof fixture>, sessionDate = data.input.inventory[0]?.sessionDate ?? '') => {
  const batch = data.input.study.batches[0]
  if (batch === undefined) throw new Error('Missing synthetic batch')
  const batches =
    sessionDate === batch.observation.manifest.sessionDate
      ? [
          {
            batchId: batch.batchPlan.batchId,
            cycleId: batch.batchPlan.cycleId,
            observationHash: batch.batchPlan.observationHash,
            purpose: JevPurpose.Entry,
            resultHash: batch.batchResult.resultHash,
          },
        ]
      : []
  const cycles = [
    ...(batches.length === 0
      ? []
      : [
          {
            cycleId: batch.batchPlan.cycleId,
            protocolHash: data.registration.protocolHash,
            state: CycleState.Completed,
            decisionHash: null,
          },
        ]),
    {
      cycleId: '0'.repeat(64),
      protocolHash: data.registration.protocolHash,
      state: CycleState.Blocked,
      decisionHash: null,
    },
  ].sort((a, b) => a.cycleId.localeCompare(b.cycleId))
  const receipt = {
    schemaVersion: 'bayn.jev-study-export.v1',
    accountBindingHash: Result.getOrThrow(
      canonicalHashV1Result({
        schemaVersion: 'bayn.jev-study-account.v1',
        accountId: batch.observation.portfolio.brokerState.account.accountId,
      }),
    ),
    sessionDate,
    asOf: '2026-09-12T00:00:00.000Z',
    cycleCount: cycles.length,
    batchCount: batches.length,
    entryBatchCount: batches.length,
    managementBatchCount: 0,
    pendingResultCount: 0,
    sourceCoverage: 'RECORDED_OBSERVATIONS_ONLY',
    qualification: 'UNQUALIFIED',
    controllerCoverage: 'UNKNOWN',
    bytes: 1000,
    dataSha256: 'f'.repeat(64),
  }
  return {
    schemaVersion: 'bayn.jev-study-inventory.v1',
    receipt: { ...receipt, receiptHash: Result.getOrThrow(canonicalHashV1Result(receipt)) },
    cycles,
    batches,
  }
}

const fixture = (transientStopAfterMs?: number, partialExitAfterMs?: number, maximumHoldingMinutes = 15) => {
  const base = nativeJevFixture(JevPurpose.Entry, undefined, 'jev-native-test', {
    ...defaultJevProtocolDocument,
    maximumHoldingMinutes,
    horizonMinutes: maximumHoldingMinutes,
  })
  const dates = ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'] as const
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      dates.map((date) => ({ session_open: '0930', session_close: '1600', date, open: '09:30', close: '16:00' })),
      { start: dates[0] ?? '', end: dates[4] ?? '' },
    ),
  )
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(base.cut, { ...base.query, calendar }))
  const cut = base.cut
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: base.observation.payload.cycleId,
      authorityGenerationHash: base.observation.payload.authorityGenerationHash,
      protocol: base.protocol,
      portfolio: base.portfolio,
      snapshot,
    }),
  )
  const native = { ...base, snapshot, observation }
  const retained = nativeJevDecisionEvidence(native)
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: retained.observation,
      expiresAt: retained.batchPlan.expiresAt,
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  const evidence = { ...retained, batchPlan, batchResult: nativeJevBatchResult(batchPlan, retained.decidedAt) }
  const { decidedAt: _decidedAt, ...batch } = evidence
  const at = Date.parse(snapshot.manifest.observedAt)
  const events = [
    ...historicalRawArrivals(snapshot, at),
    ...[...cut.projection.features.values()].flat().map((f) => ({
      availableAtMs: at,
      record: { topic: f.topic, partition: f.partition, offset: f.offset, value: JSON.stringify(f.value) },
    })),
  ]
  const original = snapshot.latestQuotes['AAPL']
  if (original === undefined) throw new Error('Missing quote')
  let offset = events
    .filter((e) => e.record.topic === original.sourceTopic && e.record.partition === original.sourcePartition)
    .reduce((maximum, e) => (BigInt(e.record.offset) > maximum ? BigInt(e.record.offset) : maximum), 0n)
  for (let t = at + 100; t < at + 16 * 60_000; t += 5000) {
    const quote = {
      ...original,
      sourceOffset: String(++offset),
      eventAt: new Date(t).toISOString(),
      ingestedAt: new Date(t).toISOString(),
      ...(t === at + (transientStopAfterMs ?? -1)
        ? { bidPrice: original.bidPrice * 0.99, askPrice: original.askPrice * 0.99 }
        : {}),
      bidSize: t === at + (partialExitAfterMs ?? -1) ? 1 : 1000,
      askSize: 1000,
    }
    events.push(...historicalRawArrivals({ bars: [], trades: [], quotes: [quote] }, t))
  }
  events.sort((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const positions = new Map<
    string,
    { topic: string; partition: number; startOffset: string; endOffsetExclusive: string }
  >()
  for (const event of events) {
    const key = `${event.record.topic}:${event.record.partition}`
    positions.set(key, {
      topic: event.record.topic,
      partition: event.record.partition,
      startOffset: positions.get(key)?.startOffset ?? event.record.offset,
      endOffsetExclusive: String(BigInt(event.record.offset) + 1n),
    })
  }
  const source: BacktestSourceManifest = {
    schemaVersion: 'bayn.backtest-source.v2',
    encoding: 'ndjson-gzip',
    transport: 'captured-kafka',
    dataSha256: sha256(gzipSync(body)),
    recordCount: events.length,
    coverageStartMs: Date.parse(calendar.sessions[0]?.openAt ?? ''),
    coverageEndMs: Date.parse(calendar.sessions[4]?.closeAt ?? ''),
    firstAvailableAtMs: events[0]?.availableAtMs ?? 0,
    lastAvailableAtMs: events.at(-1)?.availableAtMs ?? 0,
    origin: 'Synthetic native matched test capture',
    positions: [...positions.values()].sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition),
    marketSources: [
      {
        universeId: equityMarketProfile.universeId,
        universeSymbolHash: equityMarketProfile.universeSymbolHash,
        symbols: equityMarketProfile.universe,
        topics: { ...equityMarketProfile.sourceTopics, features: 'torghut.market-features.v1' },
      },
    ] as const,
    deliveryModel: {
      schemaVersion: 'bayn.supplied-arrival-times.v1',
      description: 'Synthetic observation-time capture',
      tieBreak: 'availability-topic-partition-offset',
    },
  }
  const completeSource = {
    ...source,
    positions: backtestSourcePartitions(source).map(
      ({ topic, partition }) =>
        positions.get(`${topic}:${partition}`) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  const registration = {
    schemaVersion: 'bayn.matched-entry-registration.v2',
    definitionHash: Result.getOrThrow(canonicalHashV1Result(matchedEntryDefinition)),
    sourceRevision: 'a'.repeat(40),
    protocolHash: Result.getOrThrow(canonicalHashV1Result(base.protocol)),
    registeredAt: '2026-09-03T00:00:00.000Z',
    dataRole: MatchedDataRole.Development,
    sessionDates: dates,
    latencyMs: 100,
    executionAssumptionsHash: Result.getOrThrow(
      canonicalHashV1Result({
        instruments: replayTestInstruments,
        latencyMs: 100,
        slippageBps: 0,
        availableLiquidityPpm: 1000000,
        feeMultiplierPpm: 1000000,
      }),
    ),
    latencyEvidenceHash: null,
    capacityEvidenceHash: null,
  }
  const input = {
    schemaVersion: 'bayn.matched-entry-input.v2',
    timings: [{ batchId: batch.batchPlan.batchId, witness: null }],
    witnesses: [],
    study: {
      schemaVersion: 'bayn.jev-signal-study-input.v2',
      runId: 'e'.repeat(64),
      source: completeSource,
      assumptions: {
        instruments: replayTestInstruments,
        latencyMs: 100,
        slippageBps: 0,
        availableLiquidityPpm: 1000000,
        feeMultiplierPpm: 1000000,
      },
      batches: [batch],
    },
    inventory: dates.map((sessionDate) => ({
      sessionDate,
      entryBatchIds: sessionDate === dates[0] ? [batch.batchPlan.batchId] : [],
      evidenceHash: null,
    })),
    costs: [{ batchId: batch.batchPlan.batchId, inference: null, sharedOperating: null }],
  }
  return { body, input, registration, receipt: retainedReplayCaptureFixture(completeSource), native, evidence }
}

const witnessedFixture = () =>
  Effect.gen(function* () {
    const data = fixture(5100)
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const arrivals = `${directory}/arrivals.gz`
    yield* fs.writeFile(arrivals, gzipSync(data.body))
    const batch = data.input.study.batches[0]
    if (batch === undefined) throw new Error('Missing native batch')
    const committed = yield* matchedCommittedDecisionFixture(data.native, data.evidence)
    const decisionBytes = JSON.stringify(committed)
    const decisionEvidenceHash = sha256(decisionBytes)
    const decisionPath = `${directory}/decision.json`
    yield* fs.writeFileString(decisionPath, decisionBytes)
    const at = Date.parse(batch.observation.observedAt)
    const clocks = {
      inputAvailableAt: batch.observation.observedAt,
      deterministicSelectedAt: batch.observation.observedAt,
      deterministicSymbol: 'AAPL',
      batchCompletedAt: batch.batchResult.completedAt,
      decisionCommittedAt: new Date(at + 5100).toISOString(),
    }
    const timingBytes = JSON.stringify({
      schemaVersion: 'bayn.jev-entry-timing.v2',
      clock: 'effect.Clock.currentTimeMillis',
      sourceRevision: data.registration.sourceRevision,
      batchId: batch.batchPlan.batchId,
      observationHash: batch.batchPlan.observationHash,
      snapshotHash: batch.observation.manifest.contentHash,
      decisionHash: committed.contentHash,
      ...clocks,
    })
    const evidenceHash = sha256(timingBytes)
    const path = `${directory}/timing.json`
    yield* fs.writeFileString(path, timingBytes)
    const input = {
      ...data.input,
      witnesses: [
        { path, sha256: evidenceHash },
        { path: decisionPath, sha256: decisionEvidenceHash },
      ],
      timings: [{ batchId: batch.batchPlan.batchId, witness: { ...clocks, evidenceHash, decisionEvidenceHash } }],
    }
    return {
      data,
      fs,
      directory,
      arrivals,
      batch,
      committed,
      at,
      clocks,
      timingBytes,
      evidenceHash,
      decisionEvidenceHash,
      input,
    }
  })

test.each(
  (['latency', 'capacity', 'inventory', 'inference', 'operating'] as const).flatMap((gate) =>
    (['verified', 'missing', 'changed'] as const).map((state) => [gate, state] as const),
  ),
)('matched study verifies %s witness bytes when %s', async (gate, state) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const data = fixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const path = `${directory}/evidence.bin`
      const bytes =
        gate === 'inventory'
          ? new TextEncoder().encode(JSON.stringify(inventoryFor(data)))
          : new Uint8Array([0, 255, 192, 128, 10])
      const evidenceHash = sha256(bytes)
      if (state !== 'missing')
        yield* fs.writeFile(path, state === 'changed' ? new Uint8Array([0, 255, 192, 128, 11]) : bytes)
      const registration = {
        ...data.registration,
        latencyEvidenceHash: gate === 'latency' ? evidenceHash : null,
        capacityEvidenceHash: gate === 'capacity' ? evidenceHash : null,
      }
      const cost = { costMicros: '17', evidenceHash, unresolvedCount: 0 }
      const input = {
        ...data.input,
        witnesses: [{ path, sha256: evidenceHash }],
        inventory: data.input.inventory.map((entry, index) => ({
          ...entry,
          evidenceHash: gate === 'inventory' && index === 0 ? evidenceHash : null,
        })),
        costs: data.input.costs.map((entry) => ({
          ...entry,
          inference: gate === 'inference' ? cost : null,
          sharedOperating: gate === 'operating' ? cost : null,
        })),
      }
      const result = yield* runMatchedEntryStudy(input, registration, arrivals, data.receipt).pipe(Effect.result)
      if (state === 'verified') {
        expect(Result.isSuccess(result)).toBeTrue()
      } else {
        expect(Result.isFailure(result)).toBeTrue()
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(SignalStudyFailure)
          expect(result.failure).toMatchObject({
            message:
              state === 'missing'
                ? 'Referenced private witness cannot be read'
                : 'Referenced private witness bytes differ',
          })
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test.each([
  'arbitrary',
  'unsupported',
  'duplicate',
  'edited',
  'omitted',
  'purpose',
  'pending',
  'foreign',
  'protocol',
  'pending-cycle',
  'active-cycle',
  'early',
  'complete',
] as const)('matched inventory semantics fail closed for %s evidence', async (scenario) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const data = fixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const retained = inventoryFor(data)
      let cycles =
        scenario === 'protocol'
          ? retained.cycles.map((cycle) =>
              cycle.cycleId === '0'.repeat(64) ? { ...cycle, protocolHash: '0'.repeat(64) } : cycle,
            )
          : retained.cycles
      if (scenario === 'pending-cycle' || scenario === 'active-cycle')
        cycles = cycles.map((cycle) =>
          cycle.cycleId === '0'.repeat(64)
            ? { ...cycle, state: scenario === 'pending-cycle' ? CycleState.Pending : CycleState.Active }
            : cycle,
        )
      let batchRows = retained.batches
      if (scenario === 'duplicate') batchRows = [...batchRows, ...batchRows]
      if (scenario === 'edited') batchRows = batchRows.map((batch) => ({ ...batch, batchId: '1'.repeat(64) }))
      if (scenario === 'omitted') batchRows = []
      if (scenario === 'purpose') batchRows = batchRows.map((batch) => ({ ...batch, purpose: JevPurpose.Manage }))
      const { receiptHash: _hash, ...oldReceipt } = retained.receipt
      const receipt = {
        ...oldReceipt,
        batchCount: batchRows.length,
        entryBatchCount: batchRows.filter((batch) => batch.purpose === JevPurpose.Entry).length,
        managementBatchCount: batchRows.filter((batch) => batch.purpose === JevPurpose.Manage).length,
        pendingResultCount: scenario === 'pending' ? batchRows.length : 0,
        accountBindingHash: scenario === 'foreign' ? '0'.repeat(64) : oldReceipt.accountBindingHash,
        asOf: scenario === 'early' ? '2026-09-04T13:30:00.000Z' : oldReceipt.asOf,
      }
      const bytes = JSON.stringify(
        scenario === 'arbitrary'
          ? { arbitrary: true }
          : {
              ...retained,
              cycles,
              schemaVersion: scenario === 'unsupported' ? 'bayn.jev-study-inventory.v0' : retained.schemaVersion,
              receipt: { ...receipt, receiptHash: Result.getOrThrow(canonicalHashV1Result(receipt)) },
              batches: scenario === 'pending' ? batchRows.map((batch) => ({ ...batch, resultHash: null })) : batchRows,
            },
      )
      const evidenceHash = sha256(bytes)
      const path = `${directory}/inventory.json`
      yield* fs.writeFileString(path, bytes)
      const input = {
        ...data.input,
        witnesses: [{ path, sha256: evidenceHash }],
        inventory: data.input.inventory.map((value, index) =>
          index === 0
            ? {
                ...value,
                evidenceHash,
                entryBatchIds: [
                  ...new Set(
                    batchRows.filter((batch) => batch.purpose === JevPurpose.Entry).map((batch) => batch.batchId),
                  ),
                ],
              }
            : value,
        ),
      }
      const result = yield* Effect.result(runMatchedEntryStudy(input, data.registration, arrivals, data.receipt))
      if (['arbitrary', 'unsupported', 'duplicate', 'foreign'].includes(scenario)) {
        expect(Result.isFailure(result)).toBeTrue()
      } else {
        const report = Result.getOrThrow(result)
        expect(report.inventories).toHaveLength(1)
        expect(report.inventories[0]?.cycles).toEqual(cycles)
        if (scenario === 'early')
          expect(report.summary.completenessProblems).toContain('inventory-cut-before-session-close:2026-09-04')
        else if (scenario === 'protocol')
          expect(report.summary.completenessProblems).toContain('native-inventory-protocol-mismatch:2026-09-04')
        else if (scenario === 'pending-cycle' || scenario === 'active-cycle')
          expect(report.summary.completenessProblems).toContain('nonterminal-inventory-cycle:2026-09-04')
        else if (scenario !== 'complete')
          expect(report.summary.completenessProblems).toContain('native-inventory-batch-mismatch:2026-09-04')
        else expect(report.summary.completenessProblems).not.toContain('native-inventory-batch-mismatch:2026-09-04')
        expect(report.summary.means.selectionBudgetReturnBps).toBeNull()
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('all scheduled native inventories retain zero-batch sessions without filling other evidence gaps', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const data = fixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const witnesses = []
      const inventory = []
      for (const scope of data.input.inventory) {
        const bytes = JSON.stringify(inventoryFor(data, scope.sessionDate))
        const evidenceHash = sha256(bytes)
        const path = `${directory}/${scope.sessionDate}.json`
        yield* fs.writeFileString(path, bytes)
        witnesses.push({ path, sha256: evidenceHash })
        inventory.push({ ...scope, evidenceHash })
      }
      const report = yield* runMatchedEntryStudy(
        { ...data.input, witnesses, inventory },
        data.registration,
        arrivals,
        data.receipt,
      )
      expect(report.inventories).toHaveLength(5)
      expect(
        report.inventories
          .slice(1)
          .every(
            (entry) =>
              entry.batches.length === 0 && entry.cycles.length === 1 && entry.cycles[0]?.decisionHash === null,
          ),
      ).toBeTrue()
      expect(report.summary.completenessProblems.some((problem) => problem.includes('inventory'))).toBeFalse()
      expect(report.summary.completenessProblems).toContain(`missing-entry-timing:${data.evidence.batchPlan.batchId}`)
      expect(report.summary.means.selectionBudgetReturnBps).toBeNull()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('native inventories round-trip pending entry and management batches with no-batch cycles', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const data = fixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const { decidedAt: _at, ...management } = nativeJevDecisionEvidence(nativeJevFixture(JevPurpose.Manage), 'hold')
      const retained = inventoryFor(data)
      const batchRows = [
        ...retained.batches.map((batch) => ({ ...batch, resultHash: null })),
        {
          batchId: management.batchPlan.batchId,
          cycleId: management.batchPlan.cycleId,
          observationHash: management.batchPlan.observationHash,
          purpose: JevPurpose.Manage,
          resultHash: null,
        },
      ].sort((a, b) => a.batchId.localeCompare(b.batchId))
      const cycles = [...retained.cycles]
      if (!cycles.some((cycle) => cycle.cycleId === management.batchPlan.cycleId))
        cycles.push({
          cycleId: management.batchPlan.cycleId,
          protocolHash: data.registration.protocolHash,
          state: CycleState.Completed,
          decisionHash: null,
        })
      cycles.sort((a, b) => a.cycleId.localeCompare(b.cycleId))
      const { receiptHash: _hash, ...original } = retained.receipt
      const receipt = {
        ...original,
        cycleCount: cycles.length,
        batchCount: 2,
        managementBatchCount: 1,
        pendingResultCount: 2,
      }
      const bytes = JSON.stringify({
        ...retained,
        cycles,
        batches: batchRows,
        receipt: { ...receipt, receiptHash: Result.getOrThrow(canonicalHashV1Result(receipt)) },
      })
      const evidenceHash = sha256(bytes)
      const path = `${directory}/inventory.json`
      yield* fs.writeFileString(path, bytes)
      const input = {
        ...data.input,
        study: {
          ...data.input.study,
          batches: [...data.input.study.batches, management].map((batch) => ({ ...batch, batchResult: null })),
        },
        inventory: data.input.inventory.map((scope, index) => (index === 0 ? { ...scope, evidenceHash } : scope)),
        witnesses: [{ path, sha256: evidenceHash }],
      }
      const report = yield* runMatchedEntryStudy(input, data.registration, arrivals, data.receipt)
      expect(report.inventories[0]?.batches).toEqual(batchRows)
      expect(report.inventories[0]?.cycles).toEqual(cycles)
      expect(report.summary.completenessProblems).not.toContain('native-inventory-batch-mismatch:2026-09-04')
      expect(report.summary.means.selectionBudgetReturnBps).toBeNull()
      const empty = yield* Effect.result(
        runMatchedEntryStudy(
          { ...input, study: { ...input.study, batches: [] } },
          data.registration,
          arrivals,
          data.receipt,
        ),
      )
      expect(Result.isFailure(empty)).toBeTrue()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('witnessed immediate and delayed arms on the same symbol keep independent fills and hold clocks', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { data, arrivals, at, input } = yield* witnessedFixture()
      const report = yield* runMatchedEntryStudy(input, data.registration, arrivals, data.receipt)
      const pair = report.pairs[0]
      expect(pair?.timingAvailable).toBe(true)
      expect(pair?.immediateMomentum?.fills[0]?.observedAt).toBe(new Date(at + 100).toISOString())
      expect(pair?.delayedMomentum?.fills[0]?.observedAt).toBe(new Date(at + 5200).toISOString())
      expect(pair?.immediateMomentum?.fills[0]?.priceMicros).not.toBe(pair?.delayedMomentum?.fills[0]?.priceMicros)
      expect(pair?.jev).toEqual(pair?.delayedMomentum)
      expect(pair?.immediateMomentum?.episodes[0]?.exitedAtMs).not.toBe(pair?.delayedMomentum?.episodes[0]?.exitedAtMs)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test.each([
  ['selection-clock', 'Timing receipt belongs to another batch, source or clock'],
  ['decision-file', 'Timing receipt does not bind the committed native entry decision'],
  ['decision-hash', 'Timing receipt does not bind the committed native entry decision'],
] as const)(
  'timing witness rejects an unrelated %s',
  async (variant, message) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const {
          data,
          fs,
          directory,
          arrivals,
          batch,
          committed,
          at,
          clocks,
          timingBytes,
          evidenceHash,
          decisionEvidenceHash,
          input,
        } = yield* witnessedFixture()
        let changed = input
        if (variant === 'selection-clock') {
          changed = {
            ...input,
            timings: [
              {
                batchId: batch.batchPlan.batchId,
                witness: {
                  ...clocks,
                  evidenceHash,
                  decisionEvidenceHash,
                  deterministicSelectedAt: new Date(at - 1).toISOString(),
                },
              },
            ],
          }
        } else {
          const alternate = yield* matchedCommittedDecisionFixture(data.native, data.evidence, '2')
          expect(alternate.contentHash).not.toBe(committed.contentHash)
          if (variant === 'decision-file') {
            const alternateBytes = JSON.stringify(alternate)
            const alternateHash = sha256(alternateBytes)
            const alternatePath = `${directory}/alternate-decision.json`
            yield* fs.writeFileString(alternatePath, alternateBytes)
            changed = {
              ...input,
              witnesses: [...input.witnesses, { path: alternatePath, sha256: alternateHash }],
              timings: [
                {
                  batchId: batch.batchPlan.batchId,
                  witness: { ...clocks, evidenceHash, decisionEvidenceHash: alternateHash },
                },
              ],
            }
          } else {
            const wrongReceiptBytes = JSON.stringify({
              ...JSON.parse(timingBytes),
              decisionHash: alternate.contentHash,
            })
            const wrongReceiptHash = sha256(wrongReceiptBytes)
            const wrongReceiptPath = `${directory}/wrong-timing.json`
            yield* fs.writeFileString(wrongReceiptPath, wrongReceiptBytes)
            changed = {
              ...input,
              witnesses: [...input.witnesses, { path: wrongReceiptPath, sha256: wrongReceiptHash }],
              timings: [
                {
                  batchId: batch.batchPlan.batchId,
                  witness: { ...clocks, decisionEvidenceHash, evidenceHash: wrongReceiptHash },
                },
              ],
            }
          }
        }
        const result = yield* runMatchedEntryStudy(changed, data.registration, arrivals, data.receipt).pipe(
          Effect.result,
        )
        expect(Result.isFailure(result) && result.failure instanceof SignalStudyFailure && result.failure.message).toBe(
          message,
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  },
  30_000,
)

test('offline command reproduces native observations, prices shared lifecycle once, hashes report and refuses overwrite', async () => {
  const data = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const checkout = yield* fs.makeTempDirectoryScoped()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const git = (args: readonly string[]) =>
        ChildProcess.make('git', args, { cwd: checkout, stdin: 'ignore', stderr: 'ignore' })
      expect(Number(yield* spawner.exitCode(git(['init', '--quiet'])))).toBe(0)
      yield* fs.writeFileString(`${checkout}/source.ts`, 'export const value = 1\n')
      expect(Number(yield* spawner.exitCode(git(['add', 'source.ts'])))).toBe(0)
      expect(
        Number(
          yield* spawner.exitCode(
            git([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.invalid',
              '-c',
              'commit.gpgsign=false',
              'commit',
              '--quiet',
              '-m',
              'fixture',
            ]),
          ),
        ),
      ).toBe(0)
      const sourceRevision = (yield* spawner.string(git(['rev-parse', 'HEAD']))).trim()
      let changeDuringEvaluation = false
      let revisionReads = 0
      const run = (args: readonly string[]) =>
        runMatchedCommand(args).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (command._tag !== 'StandardCommand' || command.command !== 'git')
                return Effect.die('Unexpected process in offline matched command')
              expect(command.options.cwd).toBe(fileURLToPath(new URL('../../../../', import.meta.url)))
              const changed =
                changeDuringEvaluation && command.args[0] === 'rev-parse' && ++revisionReads === 2
                  ? fs.writeFileString(`${checkout}/source.ts`, 'export const value = 4\n')
                  : Effect.void
              return changed.pipe(
                Effect.andThen(
                  spawner.spawn(ChildProcess.make('git', command.args, { ...command.options, cwd: checkout })),
                ),
              )
            }),
          ),
        )
      const arrivals = `${directory}/arrivals.gz`
      yield* fs.writeFile(arrivals, gzipSync(data.body))
      const inputPath = `${directory}/input.json`
      const registeredPath = `${directory}/registration.json`
      const receiptPath = `${directory}/receipt.json`
      const inputText = JSON.stringify(data.input)
      const registeredText = JSON.stringify({ ...data.registration, sourceRevision })
      const receiptText = JSON.stringify(data.receipt.value)
      yield* fs.writeFileString(inputPath, inputText)
      yield* fs.writeFileString(registeredPath, registeredText)
      yield* fs.writeFileString(receiptPath, receiptText)
      const outputPath = `${directory}/report.json`
      const args = [
        '--input',
        inputPath,
        '--input-sha256',
        sha256(inputText),
        '--registration',
        registeredPath,
        '--registration-sha256',
        sha256(registeredText),
        '--arrivals',
        arrivals,
        '--source-receipt',
        receiptPath,
        '--source-receipt-sha256',
        sha256(receiptText),
        '--output',
        outputPath,
      ]
      const mismatchedText = JSON.stringify({ ...data.registration, sourceRevision: '0'.repeat(40) })
      yield* fs.writeFileString(registeredPath, mismatchedText)
      expect(
        Result.isFailure(
          yield* run(args.map((v) => (v === sha256(registeredText) ? sha256(mismatchedText) : v))).pipe(Effect.result),
        ),
      ).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.writeFileString(registeredPath, registeredText)
      yield* fs.writeFileString(`${checkout}/source.ts`, 'export const value = 2\n')
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      expect(Number(yield* spawner.exitCode(git(['add', 'source.ts'])))).toBe(0)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      expect(
        Number(yield* spawner.exitCode(git(['restore', '--source=HEAD', '--staged', '--worktree', 'source.ts']))),
      ).toBe(0)
      yield* fs.writeFileString(`${checkout}/untracked.ts`, 'export const value = 3\n')
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.remove(`${checkout}/untracked.ts`)
      changeDuringEvaluation = true
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(revisionReads).toBe(2)
      expect(yield* fs.exists(outputPath)).toBeFalse()
      changeDuringEvaluation = false
      expect(Number(yield* spawner.exitCode(git(['restore', 'source.ts'])))).toBe(0)
      yield* fs.rename(`${checkout}/.git`, `${checkout}/git-metadata`)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(yield* fs.exists(outputPath)).toBeFalse()
      yield* fs.rename(`${checkout}/git-metadata`, `${checkout}/.git`)
      const report = yield* run(args)
      expect(report.schemaVersion).toBe('bayn.matched-entry-study.v8')
      expect(report.pairs).toHaveLength(1)
      expect(report.pairs[0]?.jev).toEqual(report.pairs[0]?.delayedMomentum)
      expect(report.pairs[0]?.jev?.status).toBe('RESOLVED')
      expect(report.pairs[0]?.jev?.episodes[0]?.exitedAtMs).toBe(
        Date.parse(report.observations[0]?.decidedAt ?? '') + 100 + 15 * 60_000 + 100,
      )
      expect(report.summary.completion).toBe('INCOMPLETE')
      expect(report.summary.means.selectionBudgetReturnBps).toBeNull()
      const { reportHash, ...material } = report
      expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(reportHash)
      expect(JSON.parse(yield* fs.readFileString(outputPath))).toEqual(report)
      expect(Result.isFailure(yield* run(args).pipe(Effect.result))).toBeTrue()
      expect(
        Result.isFailure(
          yield* run(args.map((v) => (v === sha256(inputText) ? '0'.repeat(64) : v))).pipe(Effect.result),
        ),
      ).toBeTrue()
      const late = {
        ...data.registration,
        dataRole: MatchedDataRole.Prospective,
        registeredAt: '2026-09-04T13:30:00.000Z',
      }
      const oldDefinitionHash = Result.getOrThrow(
        canonicalHashV1Result({
          ...matchedEntryDefinition,
          schemaVersion: 'bayn.matched-entry-definition.v5',
          lifecycle:
            'One IOC entry and persistent reducing IOC exits; same instrument-quantized budget, quotes, routing, fees, 50 bp stop, 15 minute maximum hold, five-minute equity close window; continuous markets retain elapsed holding deadlines across UTC dates. No model management.',
        }),
      )
      const oldRegistration = { ...data.registration, definitionHash: oldDefinitionHash }
      const oldResult = yield* runMatchedEntryStudy(data.input, oldRegistration, arrivals, data.receipt).pipe(
        Effect.result,
      )
      expect(Result.isFailure(oldResult)).toBeTrue()
      if (Result.isFailure(oldResult))
        expect(String(oldResult.failure)).toContain('Frozen definition or routing assumptions differ')
      expect(
        Result.isFailure(yield* runMatchedEntryStudy(data.input, late, arrivals, data.receipt).pipe(Effect.result)),
      ).toBeTrue()
      const changedFees = {
        ...data.input,
        study: { ...data.input.study, assumptions: { ...data.input.study.assumptions, feeMultiplierPpm: 2000000 } },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(changedFees, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
      const duplicate = {
        ...data.input,
        study: { ...data.input.study, batches: [...data.input.study.batches, ...data.input.study.batches] },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(duplicate, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
      const slowAssumptions = { ...data.input.study.assumptions, latencyMs: 20000 }
      const slow = { ...data.input, study: { ...data.input.study, assumptions: slowAssumptions } }
      const slowReport = yield* runMatchedEntryStudy(
        slow,
        {
          ...data.registration,
          latencyMs: 20000,
          executionAssumptionsHash: Result.getOrThrow(canonicalHashV1Result(slowAssumptions)),
        },
        arrivals,
        data.receipt,
      )
      expect(slowReport.pairs[0]?.jev?.status).toBe('RESOLVED')
      const missingReport = yield* runMatchedEntryStudy(
        { ...data.input, inventory: data.input.inventory.slice(1) },
        data.registration,
        arrivals,
        data.receipt,
      )
      expect(missingReport.summary.completenessProblems).toContain('missing-session-inventory:2026-09-04')
      const mutated = {
        ...data.input,
        study: { ...data.input.study, source: { ...data.input.study.source, dataSha256: 'f'.repeat(64) } },
      }
      expect(
        Result.isFailure(
          yield* runMatchedEntryStudy(mutated, data.registration, arrivals, data.receipt).pipe(Effect.result),
        ),
      ).toBeTrue()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 30_000)

test.each([
  { latencyMs: 20_000, partialExit: false },
  { latencyMs: 20_000, partialExit: true },
  { latencyMs: 17_500, partialExit: true },
])(
  'long routing latency preserves idle five-second polls and skips only an actual pending exit: %j',
  async ({ latencyMs, partialExit }) => {
    const data = fixture(30_100, partialExit ? 50_100 : undefined)
    const assumptions = { ...data.input.study.assumptions, latencyMs }
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const arrivals = `${directory}/arrivals.gz`
        yield* fs.writeFile(arrivals, gzipSync(data.body))
        const report = yield* runMatchedEntryStudy(
          { ...data.input, study: { ...data.input.study, assumptions } },
          {
            ...data.registration,
            latencyMs: assumptions.latencyMs,
            executionAssumptionsHash: Result.getOrThrow(canonicalHashV1Result(assumptions)),
          },
          arrivals,
          data.receipt,
        )
        const result = report.pairs[0]?.jev
        expect(result?.status).toBe('RESOLVED')
        expect(result?.problems).toEqual([])
        expect(result?.episodes[0]?.reason).toBe(ControlExit.ProtectiveStop)
        const observedAt = Date.parse(report.observations[0]?.observedAt ?? '')
        expect(result?.episodes[0]?.exitedAtMs).toBe(observedAt + (partialExit ? 70_100 : 50_100))
        expect(result?.orders).toHaveLength(partialExit ? 3 : 2)
        expect(result?.orders.filter((order) => order.side === OrderSide.Sell).map((order) => order.atMs)).toEqual(
          partialExit ? [observedAt + 50_100, observedAt + 70_100] : [observedAt + 50_100],
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  },
  30_000,
)

test.each(['timeout', 'interruption', 'defect'] as const)(
  'checkout verification releases its process exactly once after %s and writes no report',
  async (termination) => {
    const data = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const inputText = JSON.stringify(data.input)
        const registrationText = JSON.stringify(data.registration)
        yield* fs.writeFileString(`${directory}/input.json`, inputText)
        yield* fs.writeFileString(`${directory}/registration.json`, registrationText)
        const started = yield* Deferred.make<void>()
        let finalized = 0
        const worker = yield* runMatchedCommand([
          '--input',
          `${directory}/input.json`,
          '--input-sha256',
          sha256(inputText),
          '--registration',
          `${directory}/registration.json`,
          '--registration-sha256',
          sha256(registrationText),
          '--arrivals',
          `${directory}/absent.gz`,
          '--source-receipt',
          `${directory}/absent.json`,
          '--source-receipt-sha256',
          '0'.repeat(64),
          '--output',
          `${directory}/report.json`,
        ]).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
                Effect.sync(() => {
                  finalized += 1
                }),
              ).pipe(Effect.andThen(termination === 'defect' ? Effect.die('synthetic Git defect') : Effect.never)),
            ),
          ),
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        if (termination === 'timeout') yield* TestClock.adjust('10 seconds')
        if (termination === 'interruption') yield* Fiber.interrupt(worker)
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBeTrue()
        expect(finalized).toBe(1)
        expect(yield* fs.exists(`${directory}/report.json`)).toBeFalse()
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
    )
  },
)

test('matched studies reject a registered protocol with a different capital-risk budget', async () => {
  const data = fixture(undefined, undefined, 9)
  const result = await Effect.runPromise(
    runMatchedEntryStudy(data.input, data.registration, '/unused-matched-arrivals', data.receipt).pipe(
      Effect.result,
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({ message: 'Matched lifecycle requires the frozen protective protocol' })
})
