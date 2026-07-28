import { Result, Schema } from 'effect'

import { ReconciliationResultSchema } from '../evidence-contracts'
import { strictParseOptions as StrictParseOptions } from '../schemas'
import type { AuditCheck, QualificationAuditFailure } from './audit'
import {
  auditContract,
  hashAuditMaterial,
  makeAuditCheck,
  makeEvaluationSummary,
  MICROS_STRING,
  sameAuditMaterial,
  type QualificationAuditFacts,
} from './core'

const decodeReconciliation = Schema.decodeUnknownResult(ReconciliationResultSchema, StrictParseOptions)

export const auditReferenceArtifacts = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { artifact, artifactContentHashes, database, input, markedEquity, reference, trace } = facts
    const checks: AuditCheck[] = []
    const checkArtifact = (name: string, expected: unknown): Result.Result<void, QualificationAuditFailure> =>
      Result.gen(function* () {
        const expectedHash = yield* hashAuditMaterial({ scope: 'reference', name }, expected)
        const stored = artifact.get(name)
        if (stored === undefined) {
          checks.push(makeAuditCheck(`reference-${name}`, false, `missing; expected contentHash=${expectedHash}`))
          return
        }
        const matches = artifactContentHashes.get(name) === expectedHash
        checks.push(makeAuditCheck(`reference-${name}`, matches, `contentHash=${expectedHash}`))
      })
    if (markedEquity._tag === 'Unavailable') {
      checks.push(makeAuditCheck('reference-evaluation-summary', false, markedEquity.evidence))
    } else {
      yield* checkArtifact(
        'evaluation-summary',
        makeEvaluationSummary(input, reference, trace, markedEquity.proof.reconciliation),
      )
    }
    const expectedArtifacts = new Map<string, unknown>([
      ['input-manifest', input.manifest],
      ['strategy', reference.strategy.metrics],
      ['buy-and-hold', reference.buyAndHold.metrics],
      ['direct-volatility-timing', reference.directVolTiming.metrics],
      ['double-cost-strategy', reference.doubleCostStrategy.metrics],
      [
        'simulated-orders',
        {
          schemaVersion: 'bayn.simulated-orders.v2',
          executionModel: input.protocol.executionModel,
          costMultiplierMicros: MICROS_STRING,
          items: trace.orders,
        },
      ],
      ['cash-changes', { schemaVersion: 'bayn.cash-changes.v2', items: trace.cashChanges }],
      ['daily-position-marks', { schemaVersion: 'bayn.daily-position-marks.v3', items: trace.dailyMarks }],
      [
        auditContract.decisionArtifactName,
        { schemaVersion: auditContract.decisionArtifactSchemaVersion, items: reference.strategy.decisions },
      ],
      [
        'buy-and-hold-series',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'buy-and-hold',
          items: reference.buyAndHold.daily,
        },
      ],
      [
        'direct-volatility-timing-series',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'direct-volatility-timing',
          items: reference.directVolTiming.daily,
        },
      ],
      [
        'double-cost-strategy-series',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'double-cost-strategy',
          items: reference.doubleCostStrategy.daily,
        },
      ],
    ])
    for (const [name, expected] of expectedArtifacts) yield* checkArtifact(name, expected)
    if (markedEquity._tag === 'Unavailable') {
      checks.push(
        makeAuditCheck('reference-equity-series', false, markedEquity.evidence),
        makeAuditCheck('reference-marked-equity-reconciliation', false, markedEquity.evidence),
      )
    } else {
      yield* checkArtifact('equity-series', {
        schemaVersion: 'bayn.equity-series.v1',
        items: markedEquity.proof.equitySeries,
      })
      yield* checkArtifact('marked-equity-reconciliation', markedEquity.proof.reconciliation)
    }
    const referenceEventsHash = yield* hashAuditMaterial(
      { scope: 'reference', name: 'events' },
      reference.strategy.events,
    )
    const referenceEventsMatch = yield* sameAuditMaterial(
      { scope: 'reference', name: 'events' },
      database.events.map((value) => value.payload),
      reference.strategy.events,
    )
    const referenceGatesMatch = yield* sameAuditMaterial(
      { scope: 'reference', name: 'gates' },
      database.gates.map(({ name, passed, actual, required }) => ({ name, passed, actual, required })),
      reference.verdict.gates,
    )
    checks.push(
      makeAuditCheck('reference-events', referenceEventsMatch, `contentHash=${referenceEventsHash}`),
      makeAuditCheck('reference-gates', referenceGatesMatch, `economicStatus=${reference.verdict.status}`),
    )
    return checks
  })

export const auditArtifactManifest = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { artifact, artifactContentHashes, database, input, markedEquity, reference, trace } = facts
    const reconciliationResult = decodeReconciliation(artifact.get('reconciliation')?.payload)
    if (Result.isFailure(reconciliationResult)) {
      return yield* Result.fail({
        _tag: 'ReconciliationArtifactInvalid',
        artifactName: 'reconciliation',
        cause: reconciliationResult.failure,
      } satisfies QualificationAuditFailure)
    }
    const reconciliation = reconciliationResult.success
    const checks = [
      makeAuditCheck(
        'accounting-reconciliation-identity',
        reconciliation.runId === database.run.runId && reconciliation.exact === true,
        `runId=${reconciliation.runId} exact=${reconciliation.exact}`,
      ),
    ]
    if (markedEquity._tag === 'Unavailable') {
      checks.push(makeAuditCheck('qualification-artifact-manifest', false, markedEquity.evidence))
      return checks
    }
    const artifactItemCounts = new Map<string, number>([
      ['evaluation-summary', 0],
      ['input-manifest', 0],
      ['strategy', 0],
      ['buy-and-hold', 0],
      ['direct-volatility-timing', 0],
      ['double-cost-strategy', 0],
      ['simulated-orders', trace.orders.length],
      ['cash-changes', trace.cashChanges.length],
      ['daily-position-marks', trace.dailyMarks.length],
      [auditContract.decisionArtifactName, reference.strategy.decisions.length],
      ['buy-and-hold-series', reference.buyAndHold.daily.length],
      ['direct-volatility-timing-series', reference.directVolTiming.daily.length],
      ['double-cost-strategy-series', reference.doubleCostStrategy.daily.length],
      ['equity-series', markedEquity.proof.equitySeries.length],
      ['marked-equity-reconciliation', 0],
      ['reconciliation', 0],
    ])
    const baseArtifacts = database.artifacts.filter((value) => value.name !== 'qualification-artifact-manifest')
    const supportedArtifactNames = [...artifactItemCounts.keys()].sort()
    const manifestArtifacts: {
      readonly name: string
      readonly schemaVersion: string
      readonly itemCount: number
      readonly contentHash: string
    }[] = []
    for (const value of [...baseArtifacts].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const itemCount = artifactItemCounts.get(value.name)
      if (itemCount === undefined) {
        return yield* Result.fail({
          _tag: 'UnsupportedQualificationArtifact',
          artifactName: value.name,
          supportedArtifactNames,
        } satisfies QualificationAuditFailure)
      }
      manifestArtifacts.push({
        name: value.name,
        schemaVersion: value.schemaVersion,
        itemCount,
        contentHash: value.contentHash,
      })
    }
    const eventsContentHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'events' },
      database.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    )
    const gatesContentHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'gates' },
      database.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
    )
    const qualificationManifest = {
      schemaVersion: 'bayn.qualification-artifact-manifest.v1',
      identity: {
        runId: database.run.runId,
        evaluationSchemaVersion: database.run.evaluationSchemaVersion,
        protocolHash: database.run.protocolHash,
        sourceRevision: database.run.sourceRevision,
        image: { repository: database.run.imageRepository, digest: database.run.imageDigest },
        snapshotId: database.run.snapshotId,
        publicationId: input.manifest.finalizedSnapshot.publicationId,
        inputManifestHash: input.manifest.hash,
        bounds: input.manifest.bounds,
        calendarVersion: input.manifest.finalizedSnapshot.calendarVersion,
      },
      execution: {
        parameterSchemaVersion: database.protocol.schemaVersion,
        parameterHash: database.protocol.parameterHash,
        simulationSchemaVersion: 'bayn.simulation-trace.v3',
        executionModel: input.protocol.executionModel,
        costMultiplierMicros: MICROS_STRING,
      },
      artifacts: manifestArtifacts,
      events: { count: database.events.length, contentHash: eventsContentHash },
      gates: { count: database.gates.length, contentHash: gatesContentHash },
    }
    const qualificationManifestHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'document' },
      qualificationManifest,
    )
    const storedQualificationManifest = artifact.get('qualification-artifact-manifest')
    const qualificationManifestMatches =
      storedQualificationManifest !== undefined &&
      artifactContentHashes.get('qualification-artifact-manifest') === qualificationManifestHash
    checks.push(
      makeAuditCheck(
        'qualification-artifact-manifest',
        qualificationManifestMatches,
        `contentHash=${qualificationManifestHash}`,
      ),
    )
    return checks
  })
