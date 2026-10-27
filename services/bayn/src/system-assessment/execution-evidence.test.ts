import { persistenceDocumentFixture } from './decision-persistence.test-support'
import { beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { MutationEventSchema } from '../execution/mutations/model'
import { bindExecutionEvidence, captureExecutionOrders } from './execution-evidence'
import { SystemSourceCutSchema } from './source-cut'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { ExecutionEvidenceKind, measureRealism, RealismStatus } from './realism'
import { OrderStatus, TimeInForce } from '../execution/contracts'
import { executionQualityFixture } from '../forward-performance/execution-quality.test-support'
import { TargetPlanStatus } from '../target-planner'
import { decisionAdmissionWitnesses } from './decision-admissions'
import { earliestDurableWitnesses } from './obligation-witnesses'
import { bindSystemSourceCut } from './bind-source'
import { capturedAccountsFixture } from './source-cut.test-support'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  document = await Effect.runPromise(persistenceDocumentFixture)
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
    schemaVersion: 'bayn.system-source-cut.v3',
    decisionAdmissions: [],
    orders: [],
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
  const admittedFixture = () => {
    const value = fixture()
    const outcome = value.cut.mutations[0]
    if (outcome === undefined) throw new Error('Missing routed mutation')
    const { routing: _routing, ...previous } = outcome.event
    const event = Schema.decodeUnknownSync(MutationEventSchema)({
      ...previous,
      eventId: testHash('admitted source'),
      eventType: 'SUBMIT_STARTED',
      sequence: 1,
      occurredAt: value.at(1),
    })
    const material = { eventId: event.eventId, decisionId: document.contentHash, observedAt: value.at(9) }
    const receipt = { ...material, sourceHash: testHash(material) }
    return {
      ...value,
      receipt,
      cut: {
        ...value.cut,
        mutations: [{ ...outcome, event }, ...value.cut.mutations],
        decisionAdmissions: [receipt],
        durableObservations: [
          {
            kind: 'DECISION' as const,
            sourceHash: document.contentHash,
            sourceAt: document.createdAt,
            witnessedAt: value.at(9),
            correct: true,
          },
        ],
      },
    }
  }

  test('a committed admission bounds decision persistence before routing despite a later controller observation', () => {
    const f = admittedFixture()
    const bound = Result.getOrThrow(decisionAdmissionWitnesses(f.cut, document.bindings.authorityGenerationHash))
    expect(bound.sources.has(f.receipt.sourceHash)).toBe(true)
    expect(bound.witnesses).toEqual([
      {
        kind: 'DECISION',
        sourceHash: document.contentHash,
        sourceAt: document.createdAt,
        witnessedAt: f.routing.startedAt,
        correct: true,
      },
    ])
    const witnesses = earliestDurableWitnesses({
      ...f.cut,
      durableObservations: [...f.cut.durableObservations, ...bound.witnesses],
    })
    expect(witnesses.get(`DECISION:${document.contentHash}`)?.witnessedAt).toBe(f.routing.startedAt)
    const pending = Result.getOrThrow(
      decisionAdmissionWitnesses(
        { ...f.cut, mutations: f.cut.mutations.filter((row) => row.event.sequence === 1) },
        document.bindings.authorityGenerationHash,
      ),
    )
    expect(pending.witnesses).toEqual([])
  })

  test('source binding consumes the certified routing bound while an uncertified observation stays late', () => {
    const f = admittedFixture()
    const { input, cut: financialCut, verifiedSources } = capturedAccountsFixture()
    const candidate = input.registration.policies.find((policy) => policy.policy === 'JEV')
    if (candidate === undefined) throw new Error('Missing registered candidate')
    const definition = { ...candidate, authorityGenerationHash: document.bindings.authorityGenerationHash }
    const registration = {
      ...input.registration,
      policies: input.registration.policies.map((policy) => (policy.policy === 'JEV' ? definition : policy)),
    }
    const cut = {
      ...financialCut,
      registrationHash: testHash(registration),
      decisions: f.cut.decisions,
      mutations: f.cut.mutations,
      decisionAdmissions: f.cut.decisionAdmissions,
      durableObservations: f.cut.durableObservations,
    }
    const captured = {
      ...cut,
      financial: cut.financial.map((account) =>
        account.policy === 'JEV' ? { ...account, definitionHash: testHash(definition) } : account,
      ),
    }
    const supplied = {
      ...input,
      registration,
      registrationReceiptHash: testHash(registration),
      sourceCutHash: testHash(captured),
      realism: {
        ...input.realism,
        expectedDecisionIds: [document.contentHash],
        expectedFillIds: [],
        fills: [],
        decisions: [
          {
            decisionId: document.contentHash,
            policyDefinitionHash: testHash(definition),
            authorityGenerationHash: definition.authorityGenerationHash,
            snapshotHash: document.bindings.snapshotContentHash,
            decisionAt: document.createdAt,
            persistedAt: f.at(9),
            inputs: [],
          },
        ],
      },
    }
    const actual = Result.getOrThrow(bindSystemSourceCut(supplied, captured, verifiedSources))
    expect(actual.input.realism.decisions[0]?.persistedAt).toBe(f.routing.startedAt)
    const absent = { ...captured, decisionAdmissions: [] }
    const unknown = Result.getOrThrow(
      bindSystemSourceCut({ ...supplied, sourceCutHash: testHash(absent) }, absent, verifiedSources),
    )
    expect(unknown.input.realism.decisions[0]?.persistedAt).toBe(f.at(9))
    expect(actual.verifiedSources.has(f.receipt.sourceHash)).toBe(true)
  })

  test('admission bounds reject substituted receipts, identities, outcomes, clocks and duplicate claims', () => {
    const f = admittedFixture()
    const event = f.cut.mutations[0]
    const outcome = f.cut.mutations[1]
    if (event === undefined || outcome === undefined) throw new Error('Missing mutation graph')
    for (const cut of [
      { ...f.cut, decisionAdmissions: [f.receipt, f.receipt] },
      { ...f.cut, decisionAdmissions: [{ ...f.receipt, sourceHash: testHash('substituted receipt') }] },
      { ...f.cut, decisions: [] },
      { ...f.cut, mutations: [outcome] },
      { ...f.cut, mutations: [{ ...event, authorityGenerationHash: testHash('foreign generation') }, outcome] },
      { ...f.cut, mutations: [{ ...event, event: { ...event.event, intentId: testHash('foreign intent') } }, outcome] },
      {
        ...f.cut,
        mutations: [event, { ...outcome, event: { ...outcome.event, requestHash: testHash('foreign request') } }],
      },
      {
        ...f.cut,
        mutations: [
          event,
          { ...outcome, event: { ...outcome.event, routing: { ...f.routing, startedAt: document.createdAt } } },
        ],
      },
    ])
      expect(Result.isFailure(decisionAdmissionWitnesses(cut, document.bindings.authorityGenerationHash))).toBe(true)
  })
  const iocFixture = (status = OrderStatus.Canceled) => {
    const value = fixture()
    const plan = document.targetPlan
    if (plan.status !== TargetPlanStatus.Planned) throw new Error('Expected an admitted order plan')
    const decision: ExecutionDecisionDocument = {
      ...document,
      targetPlan: {
        ...plan,
        intentTargets: plan.intentTargets.map((target) => ({
          ...target,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityAtoms: status === OrderStatus.Filled ? '2' : target.quantityAtoms,
        })),
      },
    }
    const order = {
      intentId: document.orderedIntentIds[0]!,
      decisionId: document.contentHash,
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      sourceHash: testHash({ terminalOrder: status }),
      side: value.target.side,
      quantityAtoms: decision.targetPlan.intentTargets[0]!.quantityAtoms,
      filledQuantityAtoms: '2',
      status,
      occurredAt: value.at(6),
      observedAt: value.at(7),
    }
    return {
      ...value,
      order,
      cut: { ...value.cut, decisions: [{ ...value.cut.decisions[0]!, document: decision }], orders: [order] },
    }
  }

  test('capture binds terminal evidence to the exact forward account, intent, document and retained order hash', () => {
    const forward = executionQualityFixture(2)
    const first = forward.executionEvidence[0]!
    const order = first.terminalOrder!
    const generation = testHash('captured generation')
    const captured = Result.getOrThrow(captureExecutionOrders(forward.executionEvidence, first.accountId, generation))
    expect(captured).toHaveLength(2)
    expect(captured[0]).toMatchObject({
      intentId: first.intentId,
      decisionId: first.decisionDocumentHash,
      authorityGenerationHash: generation,
      sourceHash: testHash(order),
      occurredAt: order.occurredAt,
      observedAt: order.observedAt,
      quantityAtoms: order.quantityAtoms,
      filledQuantityAtoms: order.filledQuantityAtoms,
    })
    for (const changed of [
      { ...order, accountId: 'another account' },
      { ...order, intentId: testHash('another intent') },
      { ...order, symbol: 'another symbol' },
      { ...order, side: 'BUY' as const },
    ])
      expect(
        Result.isFailure(captureExecutionOrders([{ ...first, terminalOrder: changed }], first.accountId, generation)),
      ).toBe(true)
    expect(Result.isFailure(captureExecutionOrders([first], 'another account', generation))).toBe(true)
    const { terminalOrder: _order, ...missing } = first
    expect(Result.getOrThrow(captureExecutionOrders([missing], first.accountId, generation))).toEqual([])
  })

  test.each([OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired])(
    'IOC %s receipts bind every partial fill to the same durable terminal time',
    (status) => {
      const { cut, supplied, order } = iocFixture(status)
      const result = Result.getOrThrow(bindExecutionEvidence(supplied, cut, document.bindings.authorityGenerationHash))
      expect(result.missing).toEqual([])
      expect(result.fills.map((fill) => fill.expiresAt)).toEqual([order.occurredAt, order.occurredAt])
      expect(result.sources.has(order.sourceHash)).toBe(true)
      expect(result.fills.map((fill) => fill.cumulativeFilledQuantityAtoms)).toEqual(['1', '2'])
    },
  )

  test('IOC expiry cannot come from a supplied timestamp, open order, unobserved terminal or another intent', () => {
    const { cut, supplied, order, at } = iocFixture()
    for (const orders of [
      [],
      [{ ...order, status: OrderStatus.PartiallyFilled }],
      [{ ...order, status: OrderStatus.Rejected }],
      [{ ...order, observedAt: at(11) }],
      [{ ...order, intentId: testHash('foreign intent') }],
    ]) {
      const result = Result.getOrThrow(
        bindExecutionEvidence(supplied, { ...cut, orders }, document.bindings.authorityGenerationHash),
      )
      expect(result.missing).toEqual(cut.fills.map((fill) => `MISSING_IOC_TERMINAL_ORDER:${fill.fillId}`))
      expect(result.sources.has(order.sourceHash)).toBe(false)
    }
  })

  test('IOC terminal identity, quantity and chronology must match the admitted order and all captured fills', () => {
    const { cut, supplied, order, at } = iocFixture()
    for (const changed of [
      { ...order, decisionId: testHash('other decision') },
      { ...order, authorityGenerationHash: testHash('stale generation') },
      { ...order, quantityAtoms: '1' },
      { ...order, filledQuantityAtoms: '1' },
      { ...order, side: order.side === 'BUY' ? ('SELL' as const) : ('BUY' as const) },
      { ...order, occurredAt: at(8) },
      { ...order, status: OrderStatus.Filled },
    ])
      expect(
        Result.isFailure(
          bindExecutionEvidence(supplied, { ...cut, orders: [changed] }, document.bindings.authorityGenerationHash),
        ),
      ).toBe(true)
    expect(
      Result.isFailure(
        bindExecutionEvidence(supplied, { ...cut, orders: [order, order] }, document.bindings.authorityGenerationHash),
      ),
    ).toBe(true)
  })

  test('a fill after the retained IOC terminal instant is an execution timing violation', () => {
    const { cut, supplied, order, at } = iocFixture()
    const result = Result.getOrThrow(
      bindExecutionEvidence(
        supplied,
        { ...cut, orders: [{ ...order, occurredAt: at(3) }] },
        document.bindings.authorityGenerationHash,
      ),
    )
    const realism = Result.getOrThrow(
      measureRealism(
        {
          expectedDecisionIds: [],
          expectedFillIds: result.fills.map((fill) => fill.fillId),
          decisions: [],
          fills: result.fills,
          unsupportedAssumptions: result.missing,
        },
        result.sources,
      ),
    )
    expect(realism.status).toBe(RealismStatus.Violated)
    expect(realism.violations).toContain(`INVALID_EXECUTION_TIMING:${cut.fills[0]?.fillId}`)
  })

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
