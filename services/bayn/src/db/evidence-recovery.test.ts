import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { fixtureEvaluation, provenance } from '../app-test-support'
import { makeEquitySeriesArtifact, QualificationArtifactManifestSchema } from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import { buildLedgerPlan } from '../ledger-plan'
import { summarizeEvaluation } from '../risk-balanced-trend'
import { fixtureProtocol } from '../test-fixtures'
import type { EvaluationEvent } from '../types'
import {
  completeEvidenceRecovery,
  evidenceRecoveryContract,
  prepareEvidenceRecovery,
  validateStoredEvidence,
  type EvidenceRecoveryIssue,
  type StoredEvidenceRows,
} from './evidence-recovery'

type QualificationArtifactManifest = typeof QualificationArtifactManifestSchema.Type
type StoredArtifactRow = StoredEvidenceRows['artifacts'][number]
type StoredSnapshotRow = Parameters<typeof completeEvidenceRecovery>[1]

interface RecoveryFixture {
  readonly runId: string
  readonly rows: StoredEvidenceRows
  readonly snapshot: StoredSnapshotRow
}

const artifact = (name: string, schemaVersion: string, payload: unknown, itemCount = 0) => ({
  name,
  schemaVersion,
  payload,
  itemCount,
  contentHash: canonicalHashV1(payload),
})

const makeRecoveryFixture = (): RecoveryFixture => {
  const evaluation = fixtureEvaluation
  const ledger = buildLedgerPlan(evaluation, 1)
  const reconciliation = {
    runId: evaluation.runId,
    accountCount: ledger.accounts.length,
    transferCount: ledger.transfers.length,
    exact: true as const,
  }
  const baseArtifacts = [
    artifact('evaluation-summary', evidenceRecoveryContract.summarySchemaVersion, summarizeEvaluation(evaluation)),
    artifact('input-manifest', evaluation.inputManifest.schemaVersion, evaluation.inputManifest),
    artifact('strategy', 'bayn.performance-metrics.v2', evaluation.strategy),
    artifact('buy-and-hold', 'bayn.performance-metrics.v2', evaluation.buyAndHold),
    artifact('direct-volatility-timing', 'bayn.performance-metrics.v2', evaluation.directVolTiming),
    artifact('double-cost-strategy', 'bayn.performance-metrics.v2', evaluation.doubleCostStrategy),
    artifact(
      'simulated-orders',
      'bayn.simulated-orders.v2',
      {
        schemaVersion: 'bayn.simulated-orders.v2',
        executionModel: evaluation.simulation.executionModel,
        costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
        items: evaluation.simulation.orders,
      },
      evaluation.simulation.orders.length,
    ),
    artifact(
      'cash-changes',
      'bayn.cash-changes.v2',
      { schemaVersion: 'bayn.cash-changes.v2', items: evaluation.simulation.cashChanges },
      evaluation.simulation.cashChanges.length,
    ),
    artifact(
      'daily-position-marks',
      'bayn.daily-position-marks.v3',
      { schemaVersion: 'bayn.daily-position-marks.v3', items: evaluation.simulation.dailyMarks },
      evaluation.simulation.dailyMarks.length,
    ),
    artifact(
      evidenceRecoveryContract.signalDecisionsArtifactName,
      evidenceRecoveryContract.signalDecisionsSchemaVersion,
      {
        schemaVersion: evidenceRecoveryContract.signalDecisionsSchemaVersion,
        items: evaluation.signalDecisions,
      },
      evaluation.signalDecisions.length,
    ),
    artifact(
      'buy-and-hold-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'buy-and-hold',
        items: evaluation.benchmarkSeries.buyAndHold,
      },
      evaluation.benchmarkSeries.buyAndHold.length,
    ),
    artifact(
      'direct-volatility-timing-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'direct-volatility-timing',
        items: evaluation.benchmarkSeries.directVolTiming,
      },
      evaluation.benchmarkSeries.directVolTiming.length,
    ),
    artifact(
      'double-cost-strategy-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'double-cost-strategy',
        items: evaluation.benchmarkSeries.doubleCostStrategy,
      },
      evaluation.benchmarkSeries.doubleCostStrategy.length,
    ),
    artifact(
      'equity-series',
      'bayn.equity-series.v1',
      makeEquitySeriesArtifact(evaluation.equitySeries),
      evaluation.equitySeries.length,
    ),
    artifact(
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation.schemaVersion,
      evaluation.markedEquityReconciliation,
    ),
    artifact('reconciliation', 'bayn.reconciliation.v1', reconciliation),
  ]
  const events = evaluation.events.map((event, ordinal) => ({
    ordinal,
    event_id: event.id,
    event_kind: event.kind,
    content_hash: canonicalHashV1(event),
    payload: event,
  }))
  const gates = evaluation.verdict.gates.map((gate, ordinal) => ({
    ordinal,
    gate_name: gate.name,
    passed: gate.passed,
    actual: gate.actual,
    required: gate.required,
    content_hash: canonicalHashV1(gate),
  }))
  const manifest: QualificationArtifactManifest = {
    schemaVersion: 'bayn.qualification-artifact-manifest.v1',
    identity: {
      runId: evaluation.runId,
      evaluationSchemaVersion: evaluation.schemaVersion,
      protocolHash: evaluation.protocolHash,
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      snapshotId: evaluation.inputManifest.finalizedSnapshot.snapshotId,
      publicationId: evaluation.inputManifest.finalizedSnapshot.publicationId,
      inputManifestHash: evaluation.inputManifest.hash,
      bounds: evaluation.inputManifest.bounds,
      calendarVersion: evaluation.inputManifest.finalizedSnapshot.calendarVersion,
    },
    execution: {
      parameterSchemaVersion: provenance.strategy.parameterSchemaVersion,
      parameterHash: provenance.strategy.parameterHash,
      simulationSchemaVersion: evaluation.simulation.schemaVersion,
      executionModel: evaluation.simulation.executionModel,
      costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
    },
    artifacts: [...baseArtifacts]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, schemaVersion, itemCount, contentHash }) => ({
        name,
        schemaVersion,
        itemCount,
        contentHash,
      })),
    events: {
      count: events.length,
      contentHash: canonicalHashV1(
        events.map(({ ordinal, event_id: id, event_kind: kind, content_hash: contentHash }) => ({
          ordinal,
          id,
          kind,
          contentHash,
        })),
      ),
    },
    gates: {
      count: gates.length,
      contentHash: canonicalHashV1(
        gates.map(({ ordinal, gate_name: name, passed, content_hash: contentHash }) => ({
          ordinal,
          name,
          passed,
          contentHash,
        })),
      ),
    },
  }
  const allArtifacts = [...baseArtifacts, artifact('qualification-artifact-manifest', manifest.schemaVersion, manifest)]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      ({ name, schemaVersion, contentHash, payload }): StoredArtifactRow => ({
        artifact_name: name,
        schema_version: schemaVersion,
        content_hash: contentHash,
        payload,
      }),
    )

  const snapshot = evaluation.inputManifest.finalizedSnapshot
  return {
    runId: evaluation.runId,
    rows: {
      receipts: [
        {
          run_id: evaluation.runId,
          protocol_hash: evaluation.protocolHash,
          snapshot_id: snapshot.snapshotId,
          evaluation_schema_version: evaluation.schemaVersion,
          source_revision: provenance.sourceRevision,
          image_repository: provenance.image.repository,
          image_digest: provenance.image.digest,
          strategy_name: provenance.strategy.name,
          initial_capital_micros: evaluation.initialCapitalMicros,
          status: 'COMPLETE',
          expected_artifact_count: allArtifacts.length,
          expected_event_count: events.length,
          expected_gate_count: gates.length,
          artifact_count: allArtifacts.length,
          event_count: events.length,
          gate_count: gates.length,
        },
      ],
      protocol: {
        protocol_hash: evaluation.protocolHash,
        schema_version: fixtureProtocol.schemaVersion,
        strategy_name: provenance.strategy.name,
        behavior_hash: provenance.strategy.behaviorHash,
        parameter_hash: provenance.strategy.parameterHash,
        parameters: fixtureProtocol,
      },
      artifacts: allArtifacts,
      events,
      gates,
      statuses: [
        {
          status: 'WRITING',
          detail: {
            artifactCount: allArtifacts.length,
            eventCount: events.length,
            gateCount: gates.length,
          },
        },
        {
          status: 'COMPLETE',
          detail: { reconciliationExact: true, verdict: evaluation.verdict.status },
        },
      ],
    },
    snapshot: {
      snapshot_id: snapshot.snapshotId,
      schema_version: snapshot.schemaVersion,
      database_name: evaluation.inputManifest.database,
      table_name: evaluation.inputManifest.tables.bars,
      dataset_version: snapshot.publicationSchemaVersion,
      source: snapshot.source,
      source_feed: snapshot.sourceFeed,
      adjustment: snapshot.adjustment,
      content_hash: snapshot.contentHash,
      row_count: snapshot.rowCount,
      first_session: snapshot.firstSession,
      last_session: snapshot.lastSession,
      manifest: snapshot,
    },
  }
}

const withArtifactCount = (rows: StoredEvidenceRows, artifacts: readonly StoredArtifactRow[]): StoredEvidenceRows => {
  const receipt = rows.receipts[0]
  assert(receipt !== undefined)
  return {
    ...rows,
    receipts: [
      {
        ...receipt,
        expected_artifact_count: artifacts.length,
        artifact_count: artifacts.length,
      },
    ],
    artifacts,
    statuses: rows.statuses.map((status) =>
      status.status === 'WRITING'
        ? { ...status, detail: { ...status.detail, artifactCount: artifacts.length } }
        : status,
    ),
  }
}

const replaceArtifact = (
  fixture: RecoveryFixture,
  name: string,
  payload: unknown,
  refreshManifest: boolean,
): RecoveryFixture => {
  let artifacts = fixture.rows.artifacts.map((item) =>
    item.artifact_name === name ? { ...item, payload, content_hash: canonicalHashV1(payload) } : item,
  )
  if (refreshManifest) {
    const changed = artifacts.find((item) => item.artifact_name === name)
    const manifestRow = artifacts.find((item) => item.artifact_name === 'qualification-artifact-manifest')
    assert(changed !== undefined)
    assert(manifestRow !== undefined)
    const manifest = structuredClone(manifestRow.payload) as QualificationArtifactManifest
    const refreshedManifest = {
      ...manifest,
      artifacts: manifest.artifacts.map((entry) =>
        entry.name === name ? { ...entry, contentHash: changed.content_hash } : entry,
      ),
    }
    artifacts = artifacts.map((item) =>
      item.artifact_name === 'qualification-artifact-manifest'
        ? {
            ...item,
            payload: refreshedManifest,
            content_hash: canonicalHashV1(refreshedManifest),
          }
        : item,
    )
  }
  return { ...fixture, rows: { ...fixture.rows, artifacts } }
}

const failureOf = <A>(result: Result.Result<A, EvidenceRecoveryIssue>): EvidenceRecoveryIssue => {
  assert(Result.isFailure(result))
  return result.failure
}

const prepare = (fixture: RecoveryFixture) =>
  prepareEvidenceRecovery({
    runId: fixture.runId,
    provenance,
    rows: fixture.rows,
  })

const verify = (fixture: RecoveryFixture) =>
  Result.andThen(prepare(fixture), (prepared) => completeEvidenceRecovery(prepared, fixture.snapshot))

describe('evidence recovery verifier', () => {
  test('reconstructs byte-identical terminal evidence without mutating decoded rows', () => {
    const fixture = makeRecoveryFixture()
    const before = structuredClone(fixture)
    const result = verify(fixture)

    assert(Result.isSuccess(result))
    expect(result.success.evaluation).toEqual(summarizeEvaluation(fixtureEvaluation))
    expect(result.success.reconciliation.runId).toBe(fixtureEvaluation.runId)
    expect(result.success.persistence).toEqual({
      runId: fixtureEvaluation.runId,
      deduplicated: true,
      artifactCount: 17,
      eventCount: fixtureEvaluation.events.length,
      gateCount: fixtureEvaluation.verdict.gates.length,
    })
    expect(fixture).toEqual(before)
  })

  test('returns concrete stored graph issues for receipt, protocol, count, ordinal, hash, and status corruption', () => {
    const fixture = makeRecoveryFixture()
    const receipt = fixture.rows.receipts[0]
    const firstEvent = fixture.rows.events[0]
    const firstArtifact = fixture.rows.artifacts[0]
    const writing = fixture.rows.statuses[0]
    const complete = fixture.rows.statuses[1]
    assert(receipt !== undefined)
    assert(firstEvent !== undefined)
    assert(firstArtifact !== undefined)
    assert(writing?.status === 'WRITING')
    assert(complete?.status === 'COMPLETE')

    expect(failureOf(validateStoredEvidence(fixture.runId, { ...fixture.rows, receipts: [receipt, receipt] }))).toEqual(
      {
        _tag: 'RecoveryMismatch',
        stage: 'stored-graph',
        path: ['runs', fixture.runId, 'receiptCount'],
        observed: 2,
        expected: 1,
      },
    )
    expect(
      failureOf(
        validateStoredEvidence(fixture.runId, {
          ...fixture.rows,
          protocol: { ...fixture.rows.protocol, parameter_hash: 'f'.repeat(64) },
        }),
      ),
    ).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'stored-graph',
      path: ['protocol', 'parameterHash'],
      observed: 'f'.repeat(64),
      expected: fixture.rows.protocol.parameter_hash,
    })
    expect(
      failureOf(
        validateStoredEvidence(fixture.runId, {
          ...fixture.rows,
          receipts: [{ ...receipt, expected_event_count: receipt.expected_event_count + 1 }],
        }),
      ),
    ).toEqual({
      _tag: 'RecoveryMismatch',
      stage: 'stored-graph',
      path: ['events', 'count'],
      observed: { loadedCount: fixture.rows.events.length, receiptCount: receipt.event_count },
      expected: {
        loadedCount: receipt.expected_event_count + 1,
        receiptCount: receipt.expected_event_count + 1,
      },
    })
    expect(
      failureOf(
        validateStoredEvidence(fixture.runId, {
          ...fixture.rows,
          events: [{ ...firstEvent, ordinal: 1 }, ...fixture.rows.events.slice(1)],
        }),
      ),
    ).toEqual({
      _tag: 'RecoveryMismatch',
      stage: 'stored-graph',
      path: ['events', firstEvent.event_id, 'ordinal'],
      observed: 1,
      expected: 0,
    })
    expect(
      failureOf(
        validateStoredEvidence(fixture.runId, {
          ...fixture.rows,
          artifacts: [{ ...firstArtifact, content_hash: 'f'.repeat(64) }, ...fixture.rows.artifacts.slice(1)],
        }),
      ),
    ).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'stored-graph',
      path: ['artifacts', firstArtifact.artifact_name, 'contentHash'],
      observed: 'f'.repeat(64),
      expected: canonicalHashV1(firstArtifact.payload),
    })
    expect(
      failureOf(
        validateStoredEvidence(fixture.runId, {
          ...fixture.rows,
          statuses: [
            {
              status: 'WRITING',
              detail: { ...writing.detail, artifactCount: 1 },
            },
            complete,
          ],
        }),
      ),
    ).toEqual({
      _tag: 'RecoveryMismatch',
      stage: 'stored-graph',
      path: ['statuses', 0, 'detail'],
      observed: { ...writing.detail, artifactCount: 1 },
      expected: writing.detail,
    })
  })

  test('reports missing, extra, duplicate, and wrong-schema artifacts with exact facts', () => {
    const fixture = makeRecoveryFixture()
    const strategy = fixture.rows.artifacts.find((item) => item.artifact_name === 'strategy')
    assert(strategy !== undefined)

    const missingRows = withArtifactCount(
      fixture.rows,
      fixture.rows.artifacts.filter((item) => item.artifact_name !== 'strategy'),
    )
    expect(failureOf(verify({ ...fixture, rows: missingRows }))).toMatchObject({
      _tag: 'ArtifactSetFailure',
      problem: {
        _tag: 'MissingArtifact',
        name: 'strategy',
        expectedSchemaVersion: 'bayn.performance-metrics.v2',
      },
    })

    const extra = {
      artifact_name: 'unexpected',
      schema_version: 'bayn.unexpected.v1',
      content_hash: canonicalHashV1({ unexpected: true }),
      payload: { unexpected: true },
    }
    expect(
      failureOf(verify({ ...fixture, rows: withArtifactCount(fixture.rows, [...fixture.rows.artifacts, extra]) })),
    ).toMatchObject({
      _tag: 'ArtifactSetFailure',
      problem: { _tag: 'ExtraArtifact', name: 'unexpected', observedSchemaVersion: 'bayn.unexpected.v1' },
    })

    expect(
      failureOf(
        verify({
          ...fixture,
          rows: withArtifactCount(fixture.rows, [...fixture.rows.artifacts, strategy]),
        }),
      ),
    ).toMatchObject({
      _tag: 'ArtifactSetFailure',
      problem: { _tag: 'DuplicateArtifact', name: 'strategy', observedCount: 2, expectedCount: 1 },
    })

    expect(
      failureOf(
        verify({
          ...fixture,
          rows: {
            ...fixture.rows,
            artifacts: fixture.rows.artifacts.map((item) =>
              item.artifact_name === 'strategy' ? { ...item, schema_version: 'bayn.performance-metrics.v1' } : item,
            ),
          },
        }),
      ),
    ).toMatchObject({
      _tag: 'ArtifactSetFailure',
      problem: {
        _tag: 'WrongArtifactSchema',
        name: 'strategy',
        observedSchemaVersion: 'bayn.performance-metrics.v1',
        expectedSchemaVersion: 'bayn.performance-metrics.v2',
      },
    })
  })

  test('preserves contract, decode, protocol, remaining-decode, and manifest precedence', () => {
    const fixture = makeRecoveryFixture()
    const receipt = fixture.rows.receipts[0]
    assert(receipt !== undefined)
    const invalidEvaluation = replaceArtifact(fixture, 'evaluation-summary', {}, false)
    const invalidCash = replaceArtifact(fixture, 'cash-changes', {}, false)

    const contractAndRuntime = {
      ...fixture,
      rows: {
        ...fixture.rows,
        receipts: [{ ...receipt, strategy_name: 'legacy-strategy', source_revision: 'f'.repeat(40) }],
        protocol: { ...fixture.rows.protocol, strategy_name: 'legacy-strategy' },
      },
    }
    expect(failureOf(verify(contractAndRuntime))).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'contract',
      path: ['strategyName'],
      observed: 'legacy-strategy',
      expected: 'risk-balanced-trend',
    })
    expect(
      failureOf(
        verify({
          ...fixture,
          rows: {
            ...fixture.rows,
            receipts: [{ ...receipt, source_revision: 'f'.repeat(40) }],
          },
        }),
      ),
    ).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'runtime',
      path: ['sourceRevision'],
      observed: 'f'.repeat(40),
      expected: provenance.sourceRevision,
    })

    expect(
      failureOf(
        verify({
          ...invalidEvaluation,
          rows: {
            ...invalidEvaluation.rows,
            protocol: { ...invalidEvaluation.rows.protocol, behavior_hash: 'f'.repeat(64) },
          },
        }),
      ),
    ).toMatchObject({ _tag: 'DecodeFailure', artifactName: 'evaluation-summary' })

    expect(
      failureOf(
        verify({
          ...invalidCash,
          rows: {
            ...invalidCash.rows,
            protocol: { ...invalidCash.rows.protocol, behavior_hash: 'f'.repeat(64) },
          },
        }),
      ),
    ).toMatchObject({ _tag: 'RecoveryMismatch', stage: 'protocol', path: ['behaviorHash'] })
    expect(failureOf(verify(invalidCash))).toMatchObject({
      _tag: 'DecodeFailure',
      artifactName: 'cash-changes',
    })

    const manifestRow = fixture.rows.artifacts.find((item) => item.artifact_name === 'qualification-artifact-manifest')
    assert(manifestRow !== undefined)
    const manifest = structuredClone(manifestRow.payload) as QualificationArtifactManifest
    const invalidManifest = replaceArtifact(
      fixture,
      'qualification-artifact-manifest',
      { ...manifest, events: { ...manifest.events, contentHash: 'f'.repeat(64) } },
      false,
    )
    expect(failureOf(verify(invalidManifest))).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'manifest',
      path: ['qualificationArtifactManifest'],
    })
  })

  test('checks snapshot before reconciliation and final components', () => {
    const fixture = makeRecoveryFixture()
    const reconciliationRow = fixture.rows.artifacts.find((item) => item.artifact_name === 'reconciliation')
    assert(reconciliationRow !== undefined)
    const reconciliation = reconciliationRow.payload as {
      readonly runId: string
      readonly accountCount: number
      readonly transferCount: number
      readonly exact: true
    }
    const changedCount = replaceArtifact(
      fixture,
      'reconciliation',
      { ...reconciliation, accountCount: reconciliation.accountCount + 1 },
      true,
    )
    const corrupted = {
      ...changedCount,
      snapshot: { ...fixture.snapshot, first_session: '1999-01-01' },
    }
    expect(failureOf(verify(corrupted))).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'snapshot',
      path: ['firstSession'],
      observed: '1999-01-01',
      expected: fixture.snapshot.first_session,
    })
  })

  test('rejects coherently rehashed reconciliation cardinality corruption', () => {
    const fixture = makeRecoveryFixture()
    const reconciliationRow = fixture.rows.artifacts.find((item) => item.artifact_name === 'reconciliation')
    assert(reconciliationRow !== undefined)
    const reconciliation = reconciliationRow.payload as {
      readonly runId: string
      readonly accountCount: number
      readonly transferCount: number
      readonly exact: true
    }

    const changedAccounts = replaceArtifact(
      fixture,
      'reconciliation',
      { ...reconciliation, accountCount: reconciliation.accountCount + 1 },
      true,
    )
    expect(failureOf(verify(changedAccounts))).toEqual({
      _tag: 'RecoveryMismatch',
      stage: 'reconciliation',
      path: ['accountCount'],
      observed: reconciliation.accountCount + 1,
      expected: reconciliation.accountCount,
    })

    const changedTransfers = replaceArtifact(
      fixture,
      'reconciliation',
      { ...reconciliation, transferCount: reconciliation.transferCount + 1 },
      true,
    )
    expect(failureOf(verify(changedTransfers))).toEqual({
      _tag: 'RecoveryMismatch',
      stage: 'reconciliation',
      path: ['transferCount'],
      observed: reconciliation.transferCount + 1,
      expected: reconciliation.transferCount,
    })
  })

  test('totalizes ledger-plan construction with the original cause', () => {
    const fixture = makeRecoveryFixture()
    const prepared = prepare(fixture)
    assert(Result.isSuccess(prepared))

    const hostileManifest = new Proxy(prepared.success.decoded.inputManifest, {
      get: (target, property, receiver) => {
        if (property === 'symbols') throw new TypeError('ledger-plan symbols are unavailable')
        return Reflect.get(target, property, receiver)
      },
    })
    const ledgerFailure = completeEvidenceRecovery(
      {
        ...prepared.success,
        decoded: { ...prepared.success.decoded, inputManifest: hostileManifest },
      },
      fixture.snapshot,
    )
    const issue = failureOf(ledgerFailure)
    expect(issue).toMatchObject({
      _tag: 'ComputationFailure',
      operation: 'build-ledger-plan',
    })
    if (issue._tag === 'ComputationFailure') expect(issue.cause).toBeInstanceOf(TypeError)
  })

  test('retains typed reconciliation issues and reports final component and status drift', () => {
    const fixture = makeRecoveryFixture()
    const cashRow = fixture.rows.artifacts.find((item) => item.artifact_name === 'cash-changes')
    assert(cashRow !== undefined)
    const cashPayload = structuredClone(cashRow.payload) as {
      schemaVersion: 'bayn.cash-changes.v2'
      items: { amountMicros: string }[]
    }
    const firstCashChange = cashPayload.items[0]
    assert(firstCashChange !== undefined)
    cashPayload.items[0] = {
      ...firstCashChange,
      amountMicros: (BigInt(firstCashChange.amountMicros) + 1n).toString(),
    }
    const reconciliationFailure = failureOf(verify(replaceArtifact(fixture, 'cash-changes', cashPayload, true)))
    expect(reconciliationFailure).toMatchObject({
      _tag: 'SimulationFailure',
      issues: [{ _tag: 'EvidenceMismatch', problem: { _tag: 'CashChange' } }],
    })
    if (reconciliationFailure._tag === 'SimulationFailure') {
      expect(Object.isFrozen(reconciliationFailure.issues)).toBe(true)
    }

    const strategyRow = fixture.rows.artifacts.find((item) => item.artifact_name === 'strategy')
    assert(strategyRow !== undefined)
    const strategyPayload = structuredClone(strategyRow.payload) as { endingEquityMicros: string }
    const componentFailure = failureOf(
      verify(
        replaceArtifact(
          fixture,
          'strategy',
          {
            ...strategyPayload,
            endingEquityMicros: (BigInt(strategyPayload.endingEquityMicros) + 1n).toString(),
          },
          true,
        ),
      ),
    )
    expect(componentFailure).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'components',
      path: ['artifacts', 'strategy', 'contentHash'],
    })

    const writing = fixture.rows.statuses[0]
    const complete = fixture.rows.statuses[1]
    assert(writing?.status === 'WRITING')
    assert(complete?.status === 'COMPLETE')
    const statusFailure = failureOf(
      verify({
        ...fixture,
        rows: {
          ...fixture.rows,
          statuses: [
            writing,
            {
              ...complete,
              detail: {
                ...complete.detail,
                verdict: complete.detail.verdict === 'PASS' ? ('FAIL_CLOSED' as const) : ('PASS' as const),
              },
            },
          ],
        },
      }),
    )
    expect(statusFailure).toMatchObject({
      _tag: 'RecoveryMismatch',
      stage: 'status',
      path: ['complete', 'verdict'],
    })
  })

  test('totalizes hostile canonicalization with the original cause and operation identity', () => {
    const fixture = makeRecoveryFixture()
    const firstEvent = fixture.rows.events[0]
    assert(firstEvent?.payload.kind === 'decision')
    const hostileEvent: EvaluationEvent = {
      ...firstEvent.payload,
      targetWeights: { ...firstEvent.payload.targetWeights, ['\ud800']: 0 },
    }
    const failure = failureOf(
      verify({
        ...fixture,
        rows: {
          ...fixture.rows,
          events: [{ ...firstEvent, payload: hostileEvent }, ...fixture.rows.events.slice(1)],
        },
      }),
    )
    expect(failure).toMatchObject({
      _tag: 'CanonicalizationFailure',
      operation: 'stored-event-payload',
      subject: firstEvent.event_id,
    })
    if (failure._tag === 'CanonicalizationFailure') expect(failure.cause).toBeInstanceOf(TypeError)
  })
})
