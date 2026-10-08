import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result } from 'effect'
import { WriterFence, WriterFenceError, type WriterFenceService } from '../execution/writer-fence'
import { PgClient } from '@effect/sql-pg'
import { makeIntradayPerformanceFixture } from '../forward-performance/intraday-cycle.test-support'
import { makeIntradayPerformanceVolumeEvidence } from '../forward-performance/intraday-volume'
import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from '../hash'
import {
  decodeForwardPerformanceReceiptEnvelopeResult,
  makeForwardPerformanceReceiptEnvelope,
  makePersistableForwardPerformanceReceiptEnvelope,
  persistForwardPerformanceReceipt,
  evaluateAndPersistForwardPerformanceReceipt,
} from './forward-performance-receipt'
import { makePersistenceReceipt } from './forward-performance-receipt.test-support'

const testDatabase = (sql: PgClient.PgClient) =>
  Layer.mergeAll(
    Layer.succeed(PgClient.PgClient, sql),
    Layer.succeed(WriterFence, {
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }),
  )

const hash = 'a'.repeat(64)

const receiptMaterial = {
  schemaVersion: 'bayn.forward-performance-receipt.v3' as const,
  bindings: {
    runtime: {
      sourceRevision: 'b'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${'c'.repeat(64)}`,
    },
    source: null,
    strategy: null,
    account: { accountReferenceHash: 'd'.repeat(64), provider: 'alpaca', environment: 'sandbox' },
  },
  window: {
    firstCycleId: null,
    lastCycleId: null,
    openedAt: null,
    closedAt: null,
    reconciliationId: null,
    reconciliationContentHash: null,
    reconciliationStatus: null,
    cashYieldAdjustedExact: null,
  },
  totals: {
    startingCapitalMicros: null,
    realizedGainsMicros: null,
    realizedLossesMicros: null,
    brokerExecutionFeesMicros: null,
    otherChargedCostsMicros: null,
    cashYieldMicros: null,
    grossRealizedPnlMicros: null,
    netRealizedPnlAfterCostsMicros: null,
    netRealizedReturn: null,
  },
  counts: { cycleCount: 0, completedExecutionCount: 0, realizedCloseCount: 0 },
  evidence: {
    status: 'INSUFFICIENT_EVIDENCE' as const,
    reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'] as const,
    cashYield: null,
  },
  reconciliationProof: {
    accountingReceiptsExact: false,
    ledgerExact: false,
    missingLedgerAccountCount: 0,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: 0,
  },
  executionQuality: {
    status: 'NOT_ELIGIBLE' as const,
    reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'] as const,
    evidenceHash: null,
    implementationShortfall: null,
  },
  observedCapacity: {
    status: 'NOT_ELIGIBLE' as const,
    reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'] as const,
    evidenceHash: null,
    observations: [],
    boundedObservedReferenceNotionalMicros: null,
    boundedObservedExecutedNotionalMicros: null,
    maximumParticipationRate: null,
  },
  profitability: 'UNDETERMINED' as const,
}

const receipt = { ...receiptMaterial, receiptHash: canonicalHashV1(receiptMaterial) }

const envelopeMaterial = {
  schemaVersion: 'bayn.forward-performance-receipt-envelope.v1' as const,
  authorityGenerationHash: hash,
  cycleId: hash,
  receiptHash: receipt.receiptHash,
  receipt,
  createdAt: '2026-07-28T08:00:00.000Z',
}

const envelope = { ...envelopeMaterial, contentHash: canonicalHashV1(envelopeMaterial) }

const fencedPersistenceHarness = () => {
  const events: string[] = []
  const rows: unknown[] = []
  let held = false
  const transaction: WriterFenceService['transaction'] = (effect) =>
    Effect.suspend(() =>
      held
        ? effect
        : Effect.acquireUseRelease(
            Effect.sync(() => {
              held = true
              events.push('acquire')
              return rows.length
            }),
            () => effect,
            (length, exit) =>
              Effect.sync(() => {
                events.push(Exit.isSuccess(exit) ? 'commit' : 'rollback')
                if (Exit.isFailure(exit)) rows.splice(length)
                held = false
              }),
          ),
    )
  const query = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    Effect.suspend(() => {
      expect(held).toBe(true)
      if (strings.join('').includes('INSERT INTO')) {
        events.push('append')
        rows.push(values[2])
        return Effect.succeed([])
      }
      events.push('verify')
      return Effect.succeed([{ matches: true }])
    })
  const sql = Object.assign(query, {
    json: (value: unknown) => value,
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  }) as unknown as PgClient.PgClient
  const fence: WriterFenceService = { check: Effect.void, transaction }
  return {
    events,
    rows,
    fence,
    layer: Layer.mergeAll(Layer.succeed(PgClient.PgClient, sql), Layer.succeed(WriterFence, fence)),
  }
}

describe('forward-performance fenced evaluation', () => {
  test('owns the writer fence before the first evidence read through append and commit', async () => {
    const harness = fencedPersistenceHarness()
    const report = { receipt: makePersistenceReceipt() }
    const result = await Effect.runPromise(
      evaluateAndPersistForwardPerformanceReceipt(hash, (fence) =>
        Effect.sync(() => {
          expect(fence).toBe(harness.fence)
          expect(harness.events).toEqual(['acquire'])
          harness.events.push('read')
          return report
        }),
      ).pipe(Effect.provide(harness.layer)),
    )
    expect(result).toBe(report)
    expect(harness.events).toEqual(['acquire', 'read', 'verify', 'append', 'verify', 'commit'])
    expect(harness.rows).toHaveLength(1)
  })

  test('a busy execution writer prevents both evaluation and persistence', async () => {
    let evaluated = false
    const busy = new WriterFenceError({
      failure: 'busy',
      operation: 'transaction',
      message: 'ingestion owns the writer',
    })
    const harness = fencedPersistenceHarness()
    const result = await Effect.runPromise(
      evaluateAndPersistForwardPerformanceReceipt(hash, () =>
        Effect.sync(() => {
          evaluated = true
          return { receipt: makePersistenceReceipt() }
        }),
      ).pipe(
        // Override the actual boundary, not the evaluator, so it cannot consume a pre-fence snapshot.
        Effect.provideService(WriterFence, { check: Effect.fail(busy), transaction: () => Effect.fail(busy) }),
        Effect.provide(harness.layer),
        Effect.result,
      ),
    )
    expect(result).toEqual(Result.fail(busy))
    expect(evaluated).toBe(false)
    expect(harness.rows).toHaveLength(0)
  })

  test('evaluation failure rolls back and does not append a provisional receipt', async () => {
    const harness = fencedPersistenceHarness()
    const result = await Effect.runPromise(
      evaluateAndPersistForwardPerformanceReceipt(hash, () => Effect.fail('evidence unavailable')).pipe(
        Effect.result,
        Effect.provide(harness.layer),
      ),
    )
    expect(result).toEqual(Result.fail('evidence unavailable'))
    expect(harness.events).toEqual(['acquire', 'rollback'])
    expect(harness.rows).toHaveLength(0)
  })

  test('interrupted evidence reads release the fence exactly once and allow a fresh evaluation', async () => {
    const harness = fencedPersistenceHarness()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const attempt = yield* evaluateAndPersistForwardPerformanceReceipt(hash, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(attempt)
        const exit = yield* Fiber.await(attempt)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(harness.events).toEqual(['acquire', 'rollback'])
        expect(harness.rows).toHaveLength(0)
        return yield* evaluateAndPersistForwardPerformanceReceipt(hash, () =>
          Effect.succeed({ receipt: makePersistenceReceipt() }),
        )
      }).pipe(Effect.provide(harness.layer)),
    )
    expect(result.receipt.evidence.status).toBe('SUFFICIENT')
    expect(harness.events).toEqual(['acquire', 'rollback', 'acquire', 'verify', 'append', 'verify', 'commit'])
  })

  test('evaluation defects remain defects without writing a receipt', async () => {
    const harness = fencedPersistenceHarness()
    const defect = new Error('invalid evidence invariant')
    const exit = await Effect.runPromiseExit(
      evaluateAndPersistForwardPerformanceReceipt(hash, () => Effect.die(defect)).pipe(Effect.provide(harness.layer)),
    )
    expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ _tag: 'Die', defect }] } })
    expect(harness.events).toEqual(['acquire', 'rollback'])
    expect(harness.rows).toHaveLength(0)
  })
})

describe('forward-performance receipt persistence contract', () => {
  test('persists once and accepts an exact idempotent replay', async () => {
    const packet = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, makePersistenceReceipt()))
    const rows: Array<typeof packet> = []
    const query = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      if (strings.join('').includes('FROM authority_generations')) return Effect.succeed([{ matches: true }])
      if (strings.join('').includes('INSERT INTO')) {
        const incoming = values[2] as typeof packet
        if (!rows.some((row) => row.authorityGenerationHash === incoming.authorityGenerationHash)) rows.push(incoming)
        return Effect.succeed([])
      }
      const incoming = values[0] as typeof packet
      const existing = rows.find((row) => row.authorityGenerationHash === incoming.authorityGenerationHash)
      return Effect.succeed([{ matches: existing?.contentHash === incoming.contentHash }])
    }
    const sql = Object.assign(query, {
      json: (value: unknown) => value,
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }) as unknown as PgClient.PgClient
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* persistForwardPerformanceReceipt(packet)
        yield* persistForwardPerformanceReceipt(packet)
      }).pipe(Effect.provide(testDatabase(sql))),
    )
    expect(rows).toEqual([packet])
  })

  test('rejects a conflicting replay for the same authority generation', async () => {
    const packet = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, makePersistenceReceipt()))
    const query = (strings: TemplateStringsArray, ..._values: readonly unknown[]) =>
      Effect.succeed(
        strings.join('').includes('INSERT INTO')
          ? []
          : [{ matches: strings.join('').includes('FROM authority_generations') }],
      )
    const sql = Object.assign(query, {
      json: (value: unknown) => value,
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }) as unknown as PgClient.PgClient
    const exit = await Effect.runPromiseExit(
      persistForwardPerformanceReceipt(packet).pipe(Effect.provide(testDatabase(sql))),
    )
    expect(exit._tag).toBe('Failure')
  })

  test('rejects insufficient evidence with non-null cycle and reconciliation before any database call', async () => {
    for (const overrides of [
      { unclosedCycleCount: 1 },
      { unresolvedMutationCount: 1 },
      { openPositionCount: 1 },
      { accountingReceiptsExact: false },
      { ledgerExact: false },
      { missingLedgerAccountCount: 1 },
      {
        ledgerTotals: {
          realizedGainMicros: '100',
          realizedLossMicros: '0',
          brokerExecutionFeesMicros: '20',
          otherChargedCostsMicros: null,
          cashYieldMicros: '0',
        },
      },
    ]) {
      const receipt = makePersistenceReceipt(overrides)
      expect(receipt.window.lastCycleId).not.toBeNull()
      expect(receipt.window.closedAt).not.toBeNull()
      expect(receipt.evidence.status).toBe('INSUFFICIENT_EVIDENCE')
      expect(Result.isFailure(makePersistableForwardPerformanceReceiptEnvelope(hash, receipt))).toBe(true)
      const packet = Result.getOrThrow(
        makeForwardPerformanceReceiptEnvelope({
          ...envelopeMaterial,
          receipt,
          receiptHash: receipt.receiptHash,
        }),
      )
      let calls = 0
      const query = () => {
        calls += 1
        return Effect.succeed([{ matches: true }])
      }
      const sql = Object.assign(query, {
        json: (value: unknown) => value,
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      }) as unknown as PgClient.PgClient
      const result = await Effect.runPromise(
        persistForwardPerformanceReceipt(packet).pipe(Effect.result, Effect.provide(testDatabase(sql))),
      )
      expect(Result.isFailure(result)).toBe(true)
      expect(calls).toBe(0)
    }
  })

  test('rejects an active generation before any insert even when its current report is sufficient', async () => {
    const packet = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, makePersistenceReceipt()))
    let inserts = 0
    const query = (strings: TemplateStringsArray) => {
      if (strings.join('').includes('INSERT INTO')) inserts += 1
      return Effect.succeed([])
    }
    const sql = Object.assign(query, {
      json: (value: unknown) => value,
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }) as unknown as PgClient.PgClient
    const result = await Effect.runPromise(
      persistForwardPerformanceReceipt(packet).pipe(Effect.result, Effect.provide(testDatabase(sql))),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain('superseded and settled')
    expect(inserts).toBe(0)
  })

  test('uses only the closed evidence timestamp for repeatable envelope identity', () => {
    const receipt = makePersistenceReceipt()
    const first = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, receipt))
    const second = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, receipt))
    expect(first).toEqual(second)
    expect(receipt.window.closedAt).toBe(first.createdAt)
    expect(receipt.window.lastCycleId).toBe(first.cycleId)
    expect(Result.getOrThrow(decodeForwardPerformanceReceiptEnvelopeResult(first))).toEqual(first)
  })

  test('rejects altered envelope bindings or invocation-time timestamps before database access', async () => {
    const packet = Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(hash, makePersistenceReceipt()))
    const { contentHash: _contentHash, ...material } = packet
    const invocationTimed = Result.getOrThrow(
      makeForwardPerformanceReceiptEnvelope({
        ...material,
        createdAt: '2026-07-20T21:01:01.000Z',
      }),
    )
    for (const candidate of [{ ...packet, cycleId: 'e'.repeat(64) }, invocationTimed]) {
      let calls = 0
      const query = () => {
        calls += 1
        return Effect.succeed([{ matches: true }])
      }
      const sql = Object.assign(query, {
        json: (value: unknown) => value,
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      }) as unknown as PgClient.PgClient
      const result = await Effect.runPromise(
        persistForwardPerformanceReceipt(candidate).pipe(Effect.result, Effect.provide(testDatabase(sql))),
      )
      expect(Result.isFailure(result)).toBe(true)
      expect(calls).toBe(0)
    }
  })

  test('round-trips unresolved operating costs with retained trading totals and stable hashes', () => {
    const material = {
      ...receiptMaterial,
      totals: {
        ...receiptMaterial.totals,
        grossRealizedPnlMicros: '100',
        brokerExecutionFeesMicros: '20',
      },
      evidence: {
        ...receiptMaterial.evidence,
        reasonCodes: ['OPERATING_COST_EVIDENCE_GAP'] as const,
      },
    }
    const receipt = { ...material, receiptHash: canonicalHashV1(material) }
    const packet = {
      ...envelopeMaterial,
      receipt,
      receiptHash: receipt.receiptHash,
    }
    const first = Result.getOrThrow(makeForwardPerformanceReceiptEnvelope(packet))
    const second = Result.getOrThrow(makeForwardPerformanceReceiptEnvelope(packet))
    const decoded = Result.getOrThrow(decodeForwardPerformanceReceiptEnvelopeResult(first))
    expect(decoded).toEqual(first)
    expect(second).toEqual(first)
    expect(decoded.receipt.totals.grossRealizedPnlMicros).toBe('100')
    expect(decoded.receipt.totals.otherChargedCostsMicros).toBeNull()
    expect(decoded.receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
    expect(decoded.receipt.profitability).toBe('UNDETERMINED')
  })

  test('preserves legacy receipts and hashes without inserting episode evidence', () => {
    const decoded = Result.getOrThrow(decodeForwardPerformanceReceiptEnvelopeResult(envelope))
    expect(decoded).toEqual(envelope)
    expect(decoded.receipt).not.toHaveProperty('positionEpisodes')
  })

  test('retains unverified decision hashes only with undetermined execution quality', () => {
    for (const status of ['UNDETERMINED', 'MEASURED'] as const) {
      const unverifiedDecisionHashes = ['9'.repeat(64)]
      const material = {
        ...receiptMaterial,
        executionQuality: {
          ...receiptMaterial.executionQuality,
          status,
          reasonCodes: ['PLANNED_DECISION_EVIDENCE_GAP'],
          unverifiedDecisionHashes,
          evidenceHash: canonicalHashV1({ unverifiedDecisionHashes }),
        },
      }
      const receipt = { ...material, receiptHash: canonicalHashV1(material) }
      const value = { ...envelopeMaterial, receipt, receiptHash: receipt.receiptHash }
      const decoded = decodeForwardPerformanceReceiptEnvelopeResult({ ...value, contentHash: canonicalHashV1(value) })
      expect(decoded._tag).toBe(status === 'UNDETERMINED' ? 'Success' : 'Failure')
    }
  })
  test('rejects an envelope whose receipt only exposes a matching hash', () => {
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
      authorityGenerationHash: hash,
      cycleId: hash,
      receiptHash: hash,
      receipt: { receiptHash: hash },
      createdAt: '2026-07-28T08:00:00.000Z',
      contentHash: hash,
    })

    expect(decoded._tag).toBe('Failure')
  })

  test('rejects a structurally valid envelope when the nested receipt hash is not canonical', () => {
    const tamperedReceiptHash = 'f'.repeat(64)
    const tamperedMaterial = {
      ...envelopeMaterial,
      receiptHash: tamperedReceiptHash,
      receipt: { ...receipt, receiptHash: tamperedReceiptHash },
    }
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      ...tamperedMaterial,
      contentHash: canonicalHashV1(tamperedMaterial),
    })

    expect(decodeForwardPerformanceReceiptEnvelopeResult(envelope)._tag).toBe('Success')
    expect(decoded._tag).toBe('Failure')
  })

  test('rejects a valid receipt when the envelope hash binding differs', () => {
    const mismatchedMaterial = { ...envelopeMaterial, receiptHash: hash }
    const decoded = decodeForwardPerformanceReceiptEnvelopeResult({
      ...mismatchedMaterial,
      contentHash: canonicalHashV1(mismatchedMaterial),
    })

    expect(decoded._tag).toBe('Failure')
  })
})

test('round trips native archive provenance and rejects a rehashed nested source substitution', () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
  if (evidence === undefined) throw new Error('expected native evidence')
  const material = {
    ...receiptMaterial,
    observedCapacity: {
      ...receiptMaterial.observedCapacity,
      intradaySources: [evidence],
      observations: [
        {
          cycleId: request.cycleId,
          symbol: request.symbol,
          windowOpenedAt: request.windowOpenedAt,
          windowClosedAt: request.windowClosedAt,
          filledQuantityMicros: '18000000',
          marketVolumeQuantityMicros: evidence.quantityMicros,
          participationRate: {
            numeratorQuantityMicros: '18000000',
            denominatorQuantityMicros: evidence.quantityMicros,
            decimal: '0.000461538461',
          },
          intradaySource: {
            feed: 'iex' as const,
            volumeScope: evidence.volumeScope,
            evidenceHash: evidence.contentHash,
          },
        },
      ],
    },
  }
  const nested = { ...material, receiptHash: canonicalHashV1(material) }
  const outer = { ...envelopeMaterial, receipt: nested, receiptHash: nested.receiptHash }
  const decoded = Result.getOrThrow(
    decodeForwardPerformanceReceiptEnvelopeResult({ ...outer, contentHash: canonicalHashV1(outer) }),
  )
  expect(decoded.receipt.observedCapacity.intradaySources).toEqual([evidence])
  const altered = { ...evidence, decisionSnapshotId: '0'.repeat(64) }
  const { contentHash: _hash, ...alteredMaterial } = altered
  material.observedCapacity.intradaySources[0] = {
    ...alteredMaterial,
    contentHash: canonicalHashV1(alteredMaterial),
  }
  const tamperedReceipt = { ...material, receiptHash: canonicalHashV1(material) }
  const tamperedEnvelope = { ...envelopeMaterial, receipt: tamperedReceipt, receiptHash: tamperedReceipt.receiptHash }
  expect(
    decodeForwardPerformanceReceiptEnvelopeResult({
      ...tamperedEnvelope,
      contentHash: canonicalHashV1(tamperedEnvelope),
    })._tag,
  ).toBe('Failure')
})
