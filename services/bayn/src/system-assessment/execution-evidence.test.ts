import { beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { MutationEventSchema } from '../execution/mutations/model'
import { bindExecutionEvidence } from './execution-evidence'
import { SystemSourceCutSchema } from './source-cut'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { ExecutionEvidenceKind, measureRealism, RealismStatus } from './realism'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { decideJevEntry } from '../jev/decision'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  const native = nativeJevFixture()
  const evidence = nativeJevDecisionEvidence(native)
  const target = Result.getOrThrow(decideJevEntry(evidence))
  const {
    candidateEvidencePolicy: _candidates,
    benchmarkEvidencePolicy: _benchmarks,
    candidateSymbols: _symbols,
    benchmarkSymbols: _benchmarkSymbols,
    ...query
  } = native.query
  const pricing = streamingFixtureFromRaw(native.snapshot, {
    ...query,
    observedAt: target.decidedAt,
    symbols: target.selectedSymbols,
    purpose: IntradaySnapshotPurpose.EntryPricing,
  }).snapshot
  document = await Effect.runPromise(matchedCommittedDecisionFixture(native, evidence, '100000000000', pricing))
})
const fixture = () => {
  const { input } = supportedAssessmentFixture()
  const fill = input.realism.fills[0]
  const target = document.targetPlan.intentTargets[0]
  const intentId = document.orderedIntentIds[0]
  const risk = document.deltaRisk[0]
  if (fill === undefined || target === undefined || intentId === undefined || risk === undefined)
    throw new Error('Expected a real executable target fixture')
  const at = (ms: number) => new Date(Date.parse(document.createdAt) + ms).toISOString()
  const routing = { startedAt: at(2), requestDispatchedAt: at(3), completedAt: at(5) }
  const fills = [4, 5].map((ms) => ({
    fillId: testHash({ ms }),
    intentId,
    decisionId: document.contentHash,
    sourceHash: testHash({ receipt: ms }),
    side: target.side,
    quantityAtoms: '1',
    priceAtoms: (BigInt(risk.limitPriceMicros) * 1000n).toString(),
    occurredAt: at(ms),
  }))
  const mutations = [
    {
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      strategyDecisionHash: document.bindings.strategyDecisionHash,
      event: Schema.decodeUnknownSync(MutationEventSchema)({
        schemaVersion: 'bayn.paper-mutation-event.v1',
        eventId: testHash('outcome'),
        mutationId: testHash('mutation'),
        intentId,
        sequence: 2,
        operation: 'SUBMIT',
        eventType: 'SUBMIT_ACCEPTED',
        requestHash: testHash('request'),
        consistencyDelayMs: 1000,
        occurredAt: at(5),
        routing,
      }),
    },
  ]
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    schemaVersion: 'bayn.system-source-cut.v2',
    registrationHash: testHash('registration'),
    asOf: at(10),
    runtimeConfigurationHash: testHash('config'),
    financial: [
      {
        policy: 'JEV',
        sourceHash: testHash('financial'),
        accountBindingHash: testHash('account'),
        definitionHash: testHash('definition'),
        cashHistory: null,
        sessions: [],
      },
    ],
    inference: [],
    inferenceLedgerEvidenceHash: testHash('ledger'),
    decisions: [{ sessionDate: document.executionSession?.executionSession.date, document }],
    batches: [],
    mutations,
    fills,
    accountMarks: [],
    controllerPasses: [],
    durableObservations: [],
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  })
  const supplied = fills.toReversed().map((actual) => ({
    ...fill,
    kind: ExecutionEvidenceKind.Broker,
    fillId: actual.fillId,
    intentId,
    decisionId: document.contentHash,
    positionOwnerGenerationHash: document.bindings.authorityGenerationHash,
    sourceHash: actual.sourceHash,
    side: actual.side,
    fillQuantityAtoms: actual.quantityAtoms,
    fillPriceAtoms: actual.priceAtoms,
    filledAt: actual.occurredAt,
    requestedQuantityAtoms: '9999999999999',
    limitPriceAtoms: '1',
    priceTickAtoms: '1',
    quantityStepAtoms: '999999999',
  }))
  return { at, cut, supplied, target, risk, routing }
}
describe('durable execution realism bindings', () => {
  test('reproduces order terms, cumulative partial fills and measured dispatch from the actual decision and journal', () => {
    const { at, cut, supplied, target, risk, routing } = fixture()
    const bound = Result.getOrThrow(bindExecutionEvidence(supplied, cut, document.bindings.authorityGenerationHash))
    expect(bound.missing).toEqual([])
    expect(bound.fills.map((f) => f.cumulativeFilledQuantityAtoms)).toEqual(['1', '2'])
    expect(bound.fills[0]).toMatchObject({
      requestedQuantityAtoms: target.quantityAtoms,
      limitPriceAtoms: (BigInt(risk.limitPriceMicros) * 1000n).toString(),
      routingStartedAt: routing.startedAt,
      requestDispatchedAt: routing.requestDispatchedAt,
      expiresAt: document.executionSession?.executionSession.closeAt,
      quantityStepAtoms: document.plannerInput?.precision.quantityIncrementAtoms,
    })
    const realism = Result.getOrThrow(
      measureRealism(
        {
          expectedDecisionIds: [document.contentHash],
          expectedFillIds: bound.fills.map((f) => f.fillId),
          decisions: [
            {
              decisionId: document.contentHash,
              policyDefinitionHash: testHash('definition'),
              authorityGenerationHash: document.bindings.authorityGenerationHash,
              snapshotHash: document.bindings.snapshotContentHash,
              decisionAt: document.createdAt,
              persistedAt: at(1),
              inputs: [
                {
                  contentHash: document.bindings.snapshotContentHash,
                  availableAt: document.bindings.snapshotFinalizedAt,
                },
              ],
            },
          ],
          fills: bound.fills,
          unsupportedAssumptions: [],
        },
        new Set([...bound.sources, document.bindings.snapshotContentHash]),
      ),
    )
    expect(realism).toMatchObject({ status: RealismStatus.Supported, violations: [], missing: [] })
  })
  test('absent routing or order facts stay missing, and forged receipts or generations cannot be substituted', () => {
    const { cut, supplied } = fixture()
    const generation = document.bindings.authorityGenerationHash
    expect(Result.getOrThrow(bindExecutionEvidence(supplied, { ...cut, mutations: [] }, generation)).missing).toContain(
      `MISSING_BROKER_ROUTING:${cut.fills[0]?.fillId}`,
    )
    expect(Result.getOrThrow(bindExecutionEvidence(supplied, { ...cut, decisions: [] }, generation)).missing).toContain(
      `MISSING_DURABLE_ORDER_TERMS:${cut.fills[0]?.fillId}`,
    )
    expect(
      Result.isFailure(
        bindExecutionEvidence(
          supplied.map((f) => ({ ...f, fillQuantityAtoms: '2' })),
          cut,
          generation,
        ),
      ),
    ).toBe(true)
    expect(Result.isFailure(bindExecutionEvidence(supplied, cut, testHash('wrong generation')))).toBe(true)
  })
})
