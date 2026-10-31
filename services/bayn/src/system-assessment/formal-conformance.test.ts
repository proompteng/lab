import { OrderStatus, OrderSchema } from '../execution/contracts'
import type { SystemSourceCut } from './source-cut'
import { bracketEvidenceFixture } from './bracket-evidence.test-support'
import { resolveExecutionOrderTerms } from './execution-order-terms'
import { orderedExecutionPlan, executionOrderPlans, type ExecutionOrderPlan } from './execution-plans'
import type { ProtectionIntentEvidence } from './execution-plans'
import { replacementProtectionFixture } from './protection-evidence.test-support'
import { cryptoPersistenceDocumentFixture } from './decision-persistence.test-support'
import { executionIntentIdForDecodedPlan, clientOrderIdForIntentId } from '../execution/intents/domain'
import { bindExecutionEvidence } from './execution-evidence'
import { momentumControlCandidates } from '../strategy/repeated-momentum/signals'
import { makeRepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'
import { momentumRequiredTargetNet, MomentumFundedExitPlanSchema } from '../strategy/repeated-momentum/exit-plan'
import { decideRepeatedMomentumEntry, RepeatedMomentumTargetSchema } from '../strategy/repeated-momentum/decision'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import { nativeJevFixture } from '../jev/native.test-support'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevPurpose } from '../jev/portfolio'
import {
  jevSignalFor,
  jevBenchmarkSignalFor,
  commonMomentumPrices,
  jevEntryQuoteExclusion,
} from '../jev/trading-signals'
import { jevBenchmarkSymbol } from '../jev/markets'
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { Effect, Result, Schema } from 'effect'

import {
  JevAcceptanceInputSchema,
  JevNumericalVerdict,
  JevResearchPolicy,
  evaluateJevAcceptance,
  jevAcceptanceInferenceRateFloor,
} from '../jev/acceptance'
import { advanceQualificationEquity, binaryTradeEdge, cashInventoryTradingPnl, netTradingPnl } from './economics'
import { reliabilityFraction } from './reliability'
import { assessmentFixture, supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { validateSystemRegistration } from './policy'
import { frozenQuantityAtoms } from './frozen-control-report'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { evaluateSystemAssessment, SafetyViolationKind } from './assessment'
import { indexCashHistory, projectSessionCash } from './cash-history'
import { CashAdjustmentKind, cashFlowTotals } from './cash-flows'
import { reportedCashMicros } from '../broker/alpaca/cash-reporting'
import { decideExecutionControllerTick } from '../execution/controller'
import { ceilDiv, desiredQuantityAtoms, notionalMicros } from '../strategy/execution-model/fixed-point'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { MarketKind } from '../instruments'
import { ExecutionEvidenceKind, measureRealism } from './realism'
import { allowsOutcomeEvent, sameMutationOutcome, decideMutationAuthority } from '../execution/mutations/decisions'
import { MutationEventSchema, MutationEventType, type MutationAuthoritySnapshot } from '../execution/mutations/model'
import {
  Authority,
  KillState,
  IntentState,
  OrderSide,
  OrderType,
  TimeInForce,
  ReconciliationStatus,
  type Intent,
} from '../execution/contracts'
import { validateIntentAuthorityBinding } from '../execution/mutation-authority'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  grantedCapitalAuthority,
  makeCapitalGrantRecord,
  makeExecutionAuthority,
  noCapitalAuthority,
  type ExecutionAuthorityInput,
} from '../execution/authority'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { SubmissionDenialReason } from '../execution/submission-denial'
import { holdCompletionSupported, sourceFitsRegisteredSession } from './decision-work'
import { calendarFixture } from './fixtures.test-support'
import { continuousMarketHours } from '../market-hours'
import { registeredSchedule } from './schedule'
import { registrationFixture } from './fixtures.test-support'
import { ObligationClass } from './reliability'
import { jevSignalWindowEndMs } from '../jev/observation-query'
import { controllerClockDurations, nearestRank95 } from './controller-latency'
import { fullBatchClockDuration } from './full-batch-latency'
import { accountEntryProtectionReasons } from '../risk'
import { replayDecisionReleaseAt } from '../intraday-replay/decision-latency'
import { assessBacktestSession } from '../intraday-replay/backtest'
import { preflightTransfers, verifyExactTransfers, type LedgerTransferRecord } from '../ledger-plan'
import { CycleState, type AutonomousCycle } from '../cycle/model'
import { unusedEntryExpiresAt, hasExpiredUnusedEntryAdmission } from '../cycle/entry-admission'
import { isCycleStateTransitionAllowed } from '../cycle/transitions'
import {
  decideActivation,
  decideCompletion,
  decideDecisionBinding,
  makeInitialCycle,
  validateCompletionDocument,
} from '../cycle/store/decisions'
import { attachCycleDecisionStoreEvidence, cycleDecisionStoreEvidence } from '../cycle/store/decision-contract'
import {
  CycleDecisionDocumentSchema,
  type CycleDecisionDocument,
  type ExecutionDecisionDocument,
  type ObserveShadowDecisionDocument,
} from '../shadow-decision-contract'
import { legacyExecutionAuthorityToken, legacyObserveAuthorityToken } from '../execution/legacy-wire'
import { TargetPlanReason, TargetPlanStatus, type TargetPlanResult } from '../target-planner'
import { latencyCalibrationDecisionFixture } from './latency.test-support'
import { capturedAccountsFixture } from './source-cut.test-support'
import { bindSystemSourceCut } from './bind-source'
import { assessSession } from './session'
import { makeOperatingCostReport, OperatingCostCategory } from '../operating-costs'
import { operatingCostFixture } from '../operating-costs.test-support'
import { proportionalCost, indexOperatingCosts } from './cost-attribution'
import {
  expenseRateFixture,
  expenseSourceFixture,
  costReportFromEvidence,
  expenseCoverageFromEvidence,
} from '../inference-expense.test-support'
import { inferenceStageKey, InferenceStage, type InferenceCostLine } from '../inference-costs'
import {
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  type InferenceExpenseRecord,
  type InferenceExpenseSource,
} from '../inference-expense'
import { entryCompletionFixture, entryEvaluationRequestFixture } from '../jev/entry-inference.test-support'
import { makeStagedTerminalReceipt } from '../jev/staged-checkpoint'
import { stagedExpenseSourceFixture } from './formal-inference.test-support'
import { EntryAblationSelection } from '../jev/entry-inference-input'
import { verifyEntryCompletion } from '../jev/entry-inference-evidence'
import type { EntryInferenceCompletion } from '../jev/entry-inference'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevFailure } from '../jev/contract'
import { costWindowConsistent } from '../operating-cost-window'
import { retainedFinancialMarks } from './forward-evidence'
import { accountMarkValue } from './valuation'
import { allocateCostByWeights } from './cost-allocation'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import { nativeArrival } from '../market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture,
  nativeArrivalObservationFixture,
} from '../market-data/streaming/native-arrival.test-support'
import { CaptureDisposition } from '../market-data/streaming/transport-evidence'
import { topicPartitionKey } from '../market-data/streaming/projection'
import { decodeJevResolution, JevResolutionStatus, makeJevResolution } from '../jev/resolution'

import { formalModelExecutable, runFormalModel as model } from './formal-model.test-support'
import { persistenceDocumentFixture } from './decision-persistence.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { decisionAdmissionWitnesses } from './decision-admissions'

const formal = formalModelExecutable === undefined ? describe.skip : describe

formal('pinned Lean executable conformance', () => {
  test('committed admission bounds preserve ownership and causal routing without comparing database clocks', async () => {
    const document = await Effect.runPromise(persistenceDocumentFixture)
    const { cut: base } = emptySourceCutFixture()
    const intentId = document.orderedIntentIds[0]
    const sessionDate = document.executionSession?.executionSession.date
    if (intentId === undefined || sessionDate === undefined) throw new Error('Missing native persistence source')
    const origin = Date.parse(document.createdAt)
    const at = (offset: number) => new Date(origin + offset).toISOString()
    const started = Schema.decodeUnknownSync(MutationEventSchema)({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: testHash('persistence start'),
      mutationId: testHash('persistence mutation'),
      intentId,
      sequence: 1,
      operation: 'SUBMIT',
      eventType: 'SUBMIT_STARTED',
      requestHash: testHash('persistence request'),
      consistencyDelayMs: 1000,
      occurredAt: at(1),
    })
    const generation = document.bindings.authorityGenerationHash
    const inputs: unknown[] = []
    const expected: (string | null)[] = []
    for (const valid of [true, false])
      for (const independent of [true, false])
        for (const routed of [true, false])
          for (const admitted of [-1, 0, 1, 2])
            for (const routing of [0, 1, 2])
              for (const observed of [-1, 5, 10, 11]) {
                const start = { ...started, occurredAt: at(admitted) }
                const terminal = Schema.decodeUnknownSync(MutationEventSchema)({
                  ...start,
                  eventId: testHash('persistence outcome'),
                  sequence: 2,
                  eventType: 'SUBMIT_ACCEPTED',
                  occurredAt: at(Math.max(admitted, routing) + 1),
                  routing: { startedAt: at(routing), requestDispatchedAt: at(routing), completedAt: at(routing + 1) },
                })
                const material = { eventId: start.eventId, decisionId: document.contentHash, observedAt: at(observed) }
                const receipt = {
                  ...material,
                  sourceHash: valid ? testHash(material) : testHash('substituted persistence receipt'),
                }
                const result = decisionAdmissionWitnesses(
                  {
                    ...base,
                    asOf: at(10),
                    decisions: [{ sessionDate, document }],
                    mutations: [start, ...(routed ? [terminal] : [])].map((event) => ({
                      event,
                      authorityGenerationHash: generation,
                      strategyDecisionHash: document.bindings.strategyDecisionHash,
                    })),
                    decisionAdmissions: independent ? [receipt] : [],
                  },
                  generation,
                )
                const witness = Result.isSuccess(result) ? result.success.witnesses[0] : undefined
                expected.push(witness === undefined ? null : String(Date.parse(witness.witnessedAt) - origin))
                inputs.push({
                  operation: 'decisionCommitmentUpperBound',
                  receiptValid: valid,
                  independent,
                  routed,
                  created: '0',
                  admitted: String(admitted),
                  routing: String(routing),
                  observed: String(observed),
                  asOf: '10',
                })
              }
    expect(expected.filter((bound) => bound !== null).length).toBeGreaterThan(0)
    expect(model(inputs)).toEqual(expected)
  }, 30_000)

  test('a late persistence observation is incomplete while an observation before creation is violated', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const decision = input.realism.decisions[0]
    const fill = input.realism.fills[0]
    if (decision === undefined || fill === undefined) throw new Error('Missing supported persistence fixture')
    const created = Date.parse(decision.decisionAt)
    const routing = Date.parse(fill.routingStartedAt)
    const observed = [created - 1, created, routing, routing + 1, routing + 1000]
    const actual = observed.map(
      (knownBy) =>
        Result.getOrThrow(
          measureRealism(
            {
              ...input.realism,
              expectedDecisionIds: [decision.decisionId],
              expectedFillIds: [fill.fillId],
              fills: [fill],
              decisions: [{ ...decision, persistedAt: new Date(knownBy).toISOString() }],
            },
            verifiedSources,
          ),
        ).status,
    )
    expect(
      model(
        observed.map((knownBy) => ({
          operation: 'persistenceObservation',
          created: String(created),
          knownBy: String(knownBy),
          routing: String(routing),
        })),
      ),
    ).toEqual(actual)
  })
  test('momentum exact excess-return arithmetic agrees before any basis-point rounding', () => {
    const integer = fc.bigInt({ min: 1000n, max: 1000000000000n })
    const values = fc.sample(
      fc.record({
        reference: integer,
        bid: integer,
        spread: fc.bigInt({ min: 0n, max: 1000n }),
        benchmarkReference: integer,
        benchmarkBid: integer,
        benchmarkSpread: fc.bigInt({ min: 0n, max: 1000n }),
      }),
      { seed: 730291, numRuns: 500 },
    )
    const inputs = values.map((v) => ({
      symbol: 'AAPL',
      reference: v.reference.toString(),
      bid: v.bid.toString(),
      ask: (v.bid + v.spread).toString(),
      benchmarkReference: v.benchmarkReference.toString(),
      benchmarkBid: v.benchmarkBid.toString(),
      benchmarkAsk: (v.benchmarkBid + v.benchmarkSpread).toString(),
      quoteAllowed: true,
    }))
    const expected = model(inputs.map((prices) => ({ operation: 'momentumScore', prices })))
    values.forEach((v, i) => {
      const result = Result.getOrThrow(
        deriveIntradayMomentumSignalMetrics(
          {
            reference: v.reference,
            bid: v.bid,
            ask: v.bid + v.spread,
            high: v.bid + v.spread + 1n,
            low: v.bid - 1n,
            trade: v.bid,
          },
          'AAPL',
          { reference: v.benchmarkReference, bid: v.benchmarkBid, ask: v.benchmarkBid + v.benchmarkSpread },
        ),
      )
      expect(expected[i]).toMatchObject({
        numerator: result.excessReturn.numerator.toString(),
        denominator: result.excessReturn.denominator.toString(),
      })
    })
  })

  test('momentum native selection agrees with the Lean maximum over common observed prices', () => {
    const returns = [
      { AAPL: 0.02, AMZN: 0.01 },
      { AAPL: 0.01, AMZN: 0.02 },
      { AAPL: 0.02, AMZN: 0.02 },
      { AAPL: -0.01, AMZN: -0.02 },
      { AAPL: 0, AMZN: 0 },
      { AAPL: -0.02, AMZN: 0.0001 },
      ...fc
        .sample(fc.tuple(fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 })), {
          seed: 41277,
          numRuns: 30,
        })
        .map(([a, b]) => ({ AAPL: a / 10000, AMZN: b / 10000 })),
    ]
    const cases = returns.flatMap((changes, index) => {
      const native = nativeJevFixture(
        JevPurpose.Entry,
        undefined,
        'momentum-conformance',
        defaultJevProtocolDocument,
        'a'.repeat(64),
        changes,
      )
      const snapshot = native.snapshot
      const prices = (snapshot.manifest.candidateSymbols ?? []).map((symbol) => {
        const candidate = Result.getOrThrow(jevSignalFor(snapshot, symbol))
        const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(snapshot, jevBenchmarkSymbol(symbol)))
        const common = Result.getOrThrow(
          commonMomentumPrices(snapshot, symbol, jevBenchmarkSymbol(symbol), candidate, benchmark),
        )
        const quote = snapshot.latestQuotes[symbol]
        if (quote === undefined) throw new Error('Missing native quote')
        return {
          symbol,
          reference: common.candidate.reference.toString(),
          bid: common.candidate.bid.toString(),
          ask: common.candidate.ask.toString(),
          benchmarkReference: common.benchmark.reference.toString(),
          benchmarkBid: common.benchmark.bid.toString(),
          benchmarkAsk: common.benchmark.ask.toString(),
          quoteAllowed: Result.getOrThrow(jevEntryQuoteExclusion(quote)) === null,
        }
      })
      const signals = Result.getOrThrow(momentumControlCandidates(snapshot))
      const policy = makeRepeatedMomentumPolicy(native.protocol)
      const evidence = {
        schemaVersion: 'bayn.repeated-momentum-evidence.v1' as const,
        observation: native.observation.payload,
        decidedAt: native.observation.payload.observedAt,
      }
      const target = Result.getOrThrow(decideRepeatedMomentumEntry(evidence, policy))
      expect(Result.isSuccess(Schema.decodeUnknownResult(RepeatedMomentumTargetSchema)(target))).toBe(true)
      const base = { operation: 'momentumSelection', prices, funded: true }
      const winner = signals[0]?.symbol ?? null
      const selected = target.selectedSymbols[0] ?? null
      const values = [
        { input: base, expected: winner },
        { input: { ...base, prices: prices.toReversed() }, expected: winner },
        { input: { ...base, funded: selected !== null }, expected: selected },
      ]
      if (index === 0) {
        const unfunded = nativeJevFixture(
          JevPurpose.Entry,
          undefined,
          'momentum-conformance',
          { ...defaultJevProtocolDocument, maximumGrossWeight: 0.000001, maximumSymbolWeight: 0.000001 },
          'a'.repeat(64),
          changes,
        )
        const noTarget = Result.getOrThrow(
          decideRepeatedMomentumEntry(
            { ...evidence, observation: unfunded.observation.payload },
            makeRepeatedMomentumPolicy(unfunded.protocol),
          ),
        )
        expect(noTarget.signals).toHaveLength(2)
        expect(noTarget.selectedSymbols).toEqual([])
        values.push({ input: { ...base, funded: false }, expected: noTarget.selectedSymbols[0] ?? null })
      }
      return values
    })
    const outputs = model(cases.map((c) => c.input))
    cases.forEach((c, i) => expect(outputs[i]).toEqual(c.expected))
  }, 120000)

  test('momentum funded-plan admission enforces the exact one-percent floor and preserves possible loss', () => {
    const native = nativeJevFixture()
    const policy = makeRepeatedMomentumPolicy(native.protocol)
    const target = Result.getOrThrow(
      decideRepeatedMomentumEntry(
        {
          schemaVersion: 'bayn.repeated-momentum-evidence.v1',
          observation: native.observation.payload,
          decidedAt: native.observation.payload.observedAt,
        },
        policy,
      ),
    )
    const base = target.exitPolicy.plans['AAPL']
    if (base === undefined) throw new Error('Missing funded native momentum position')
    const amounts = [
      1n,
      99n,
      100n,
      101n,
      9999n,
      10000n,
      10001n,
      BigInt(base.acquisitionCostMicros),
      ...fc.sample(fc.bigInt({ min: 1n, max: 1000000000000000000000000000000n }), { seed: 80519, numRuns: 100 }),
    ]
    const required = model(
      amounts.map((acquisition) => ({ operation: 'momentumRequiredTarget', acquisition: acquisition.toString() })),
    )
    amounts.forEach((a, i) => expect(required[i]).toEqual(momentumRequiredTargetNet(a).toString()))
    const cases = amounts.flatMap((acquisition) =>
      [-1n, 0n, 1n].flatMap((targetOffset) =>
        [0n, 1n, acquisition - 1n, acquisition, acquisition + 1n].map((stopNet) => {
          const targetNet = momentumRequiredTargetNet(acquisition) + targetOffset
          return {
            input: {
              operation: 'momentumPayoffs',
              acquisition: acquisition.toString(),
              stopNet: stopNet.toString(),
              targetNet: targetNet.toString(),
            },
            accepted: Result.isSuccess(
              Schema.decodeUnknownResult(MomentumFundedExitPlanSchema)({
                ...base,
                acquisitionCostMicros: acquisition.toString(),
                estimatedStopNetMicros: stopNet.toString(),
                estimatedTargetNetMicros: targetNet.toString(),
              }),
            ),
          }
        }),
      ),
    )
    const results = model(cases.map((c) => c.input))
    cases.forEach((c, i) => expect(results[i]).toEqual(c.accepted))
    const edge = {
      gainMicros: BigInt(base.estimatedTargetNetMicros) - BigInt(base.acquisitionCostMicros),
      lossMicros: BigInt(base.acquisitionCostMicros) - BigInt(base.estimatedStopNetMicros),
      costMicros: 1n,
      winProbabilityNumerator: 0n,
      winProbabilityDenominator: 1n,
    }
    const expected = Result.getOrThrow(binaryTradeEdge(edge))
    expect(BigInt(expected.expectedNetMicros.numerator)).toBeLessThan(0n)
    expect(
      model([
        {
          operation: 'binaryEdge',
          ...Object.fromEntries(Object.entries(edge).map(([key, value]) => [key, value.toString()])),
        },
      ]),
    ).toEqual([expected])
  })

  test('both native controls preserve all five independently registered source commitments', () => {
    const registration = registrationFixture()
    const fields = ['strategyHash', 'parametersHash', 'protocolHash', 'promptsHash', 'executionModelHash'] as const
    const cases = [JevResearchPolicy.Ablation, JevResearchPolicy.Momentum].flatMap((policy) => {
      const expected = registration.policies.find((p) => p.policy === policy)
      if (expected === undefined) throw new Error('Missing registered native control')
      return Array.from({ length: 32 }, (_, mask) => {
        const actual = { ...expected }
        fields.forEach((field, bit) => {
          if ((mask & (1 << bit)) !== 0) actual[field] = testHash({ policy, field, mask })
        })
        const changed = {
          ...registration,
          policies: registration.policies.map((p) => (p.policy === policy ? actual : p)),
        }
        return {
          input: { operation: 'nativeControlAdmission', expected, actual },
          accepted: Result.isSuccess(validateSystemRegistration(changed)),
        }
      })
    })
    const outputs = model(cases.map((c) => c.input))
    cases.forEach((c, i) => expect(outputs[i]).toEqual(c.accepted))
    expect(cases.filter((c) => c.accepted)).toHaveLength(2)
  })

  test('completion admission binds provider omission to ablation and preserves the original deadline', () => {
    const candidate = entryEvaluationRequestFixture()
    const ablation = entryEvaluationRequestFixture(undefined, undefined, EntryAblationSelection.LowestModeledLoss)
    const received = entryCompletionFixture(candidate)
    expect(received.handoff.disposition.status).toBe('READY')
    expect(received.jev.status).toBe('RECEIVED')
    const outcomes: readonly EntryInferenceCompletion['jev'][] = [
      received.jev,
      { status: 'FAILED', failure: JevFailure.Transport, httpStatus: null, responseHash: null, usage: null },
      { status: 'NOT_REQUESTED' },
      { status: 'NOT_DISPATCHED' },
      { status: 'OMITTED_BY_POLICY' },
    ]
    const inputs = []
    const actual = []
    for (const request of [candidate, ablation]) {
      const completed = entryCompletionFixture(request)
      for (const ready of [false, true]) {
        const handoff = ready
          ? completed.handoff
          : {
              ...completed.handoff,
              disposition: { status: 'SOURCE_INFEASIBLE' as const },
            }
        for (const delta of [-1, 0, 9999, 10000, 10001]) {
          const completedAt = new Date(Date.parse(request.observedAt) + delta).toISOString()
          for (const jev of outcomes) {
            inputs.push({
              operation: 'entryCompletionPolicy',
              ablation: request.request.schemaVersion === 'bayn.entry-ablation-input.v1',
              ready,
              outcome: jev.status,
              recordedAt: Date.parse(handoff.recordedAt).toString(),
              completedAt: Date.parse(completedAt).toString(),
              expiresAt: Date.parse(request.expiresAt).toString(),
            })
            actual.push(
              Result.isSuccess(
                verifyEntryCompletion(
                  {
                    input: request.request,
                    expiresAt: request.expiresAt,
                  },
                  { completedAt, jev },
                  handoff,
                ),
              ),
            )
          }
        }
      }
    }
    expect(actual).toContain(true)
    expect(actual).toContain(false)
    expect(model(inputs)).toEqual(actual)
  })

  test('registration binds actual approved risk material to its account and rejects expanded limits', () => {
    const registration = registrationFixture()
    const inputs = []
    const actual = []
    for (const definition of registration.policies)
      for (const environment of [BrokerEnvironment.Live, BrokerEnvironment.Sandbox]) {
        const riskPolicy = Result.getOrThrow(
          makeExecutionRiskPolicy(definition.riskPolicy.accountId, definition.riskPolicy.allowedSymbols, environment),
        )
        const bound = { ...definition, riskPolicy, riskPolicyHash: testHash(riskPolicy) }
        const expanded = { ...riskPolicy, maxGrossExposureMicros: '100000000001' }
        for (const policy of [
          bound,
          { ...bound, riskPolicyHash: testHash('unbound policy') },
          { ...bound, accountBindingHash: testHash('foreign account') },
          { ...bound, riskPolicy: expanded, riskPolicyHash: testHash(expanded) },
          { ...bound, riskPolicy: { ...riskPolicy, accountId: 'foreign' } },
        ]) {
          inputs.push({
            operation: 'registeredRisk',
            declaredPolicyHash: policy.riskPolicyHash,
            materialPolicyHash: testHash(policy.riskPolicy),
            declaredAccountHash: policy.accountBindingHash,
            materialAccountHash: testHash({
              schemaVersion: 'bayn.inference-cost-account.v1',
              accountId: policy.riskPolicy.accountId,
            }),
            limits: {
              order: policy.riskPolicy.maxOrderNotionalMicros,
              symbol: policy.riskPolicy.maxSymbolExposureMicros,
              gross: policy.riskPolicy.maxGrossExposureMicros,
              net: policy.riskPolicy.maxNetExposureMicros,
              turnover: policy.riskPolicy.maxDailyTradedNotionalMicros,
            },
            approvedPolicyHashes: [BrokerEnvironment.Live, BrokerEnvironment.Sandbox].map((environment) =>
              testHash(
                Result.getOrThrow(
                  makeExecutionRiskPolicy(policy.riskPolicy.accountId, policy.riskPolicy.allowedSymbols, environment),
                ),
              ),
            ),
          })
          actual.push(
            Result.isSuccess(
              validateSystemRegistration({
                ...registration,
                policies: registration.policies.map((original) =>
                  original.policy === policy.policy ? policy : original,
                ),
              }),
            ),
          )
        }
      }
    expect(actual.filter(Boolean)).toHaveLength(4)
    expect(model(inputs)).toEqual(actual)
  })
  test('a deployed control cannot change any of its six frozen commitments', () => {
    const registration = registrationFixture()
    const original = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)
    if (original === undefined) throw Error('Missing frozen control')
    const fields = [
      'strategyHash',
      'parametersHash',
      'protocolHash',
      'executionModelHash',
      'promptsHash',
      'continuationAndExitsHash',
    ] as const
    const inputs = []
    const actual = []
    for (let changed = 0; changed < 64; changed++) {
      const identity = Object.fromEntries(
        fields.map((field, index) => [
          field,
          (changed & (1 << index)) === 0 ? original[field] : testHash(`other ${field}`),
        ]),
      )
      inputs.push({ operation: 'deployedControl', ...identity })
      actual.push(
        Result.isSuccess(
          validateSystemRegistration({
            ...registration,
            policies: registration.policies.map((policy) =>
              policy.policy === JevResearchPolicy.Deployed ? { ...policy, ...identity } : policy,
            ),
          }),
        ),
      )
    }
    expect(actual.filter(Boolean)).toHaveLength(1)
    expect(model(inputs)).toEqual(actual)
  })
  test('frozen six-decimal quantities preserve exact nine-decimal fill notional', () => {
    const inputs = []
    const actual = []
    for (const quantity of [0n, 1n, 999n, 1000000n, 98000000n, 1n << 80n, ((1n << 128n) - 1n) / 1000n])
      for (const price of [0n, 1n, 100n, 1000001n, 102010000n]) {
        const atoms = frozenQuantityAtoms(quantity)
        const notional = Result.getOrThrow(notionalMicros(atoms, price))
        expect(notional).toBe((quantity * price + 500000n) / 1000000n)
        inputs.push({ operation: 'frozenQuantity', quantityMicros: quantity.toString(), priceMicros: price.toString() })
        actual.push({ quantityAtoms: atoms.toString(), notionalMicros: notional.toString() })
      }
    expect(model(inputs)).toEqual(actual)
  })
  test('every provider stage needs one current verified priced expense, including failed and late inference', () => {
    const request = entryEvaluationRequestFixture()
    const completion = entryCompletionFixture(request)
    const late = stagedExpenseSourceFixture(
      { ...completion, completedAt: '2026-10-25T07:00:47.000Z' },
      completion.handoff,
      true,
    )
    const undispatchedReceipt = Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: request.expiresAt,
        outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
      }),
    )
    const undispatched: InferenceExpenseSource = {
      ...stagedExpenseSourceFixture(),
      handoff: null,
      stagedCheckpoint: { claims: [], terminals: [], skips: [] },
      receipt: undispatchedReceipt,
      resolution: Result.getOrThrow(
        makeJevResolution(request, undispatchedReceipt, {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: request.requestId,
          status: JevResolutionStatus.Recorded,
          receiptHash: undispatchedReceipt.receiptHash,
        }),
      ),
    }
    const checkpointLifecycles = [undefined, EntryAblationSelection.LowestModeledLoss].flatMap((selection) => {
      const sourceRequest = entryEvaluationRequestFixture(undefined, undefined, selection)
      const completed = entryCompletionFixture(sourceRequest)
      const full = stagedExpenseSourceFixture(completed, completed.handoff, false, sourceRequest)
      const checkpoint = full.stagedCheckpoint
      if (checkpoint === undefined) throw new Error('Missing staged checkpoint')
      return checkpoint.claims.map((claim) => {
        const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
        if (terminal?.outcome.status !== 'RECEIVED') throw new Error('Missing staged response')
        const retainedClaims = checkpoint.claims.filter((row) => claim.stage === 'BASE_START' || row.stage === 'CHART')
        const prefix = {
          claims: retainedClaims,
          terminals: checkpoint.terminals.filter((row) => claim.stage === 'BASE_START' && row.stage === 'CHART'),
          skips: [],
        }
        const pending: InferenceExpenseSource = {
          ...full,
          receipt: null,
          resolution: null,
          handoff: null,
          stagedCheckpoint: prefix,
        }
        const abandoned = {
          ...pending,
          resolution: Result.getOrThrow(
            makeJevResolution(sourceRequest, null, {
              schemaVersion: 'bayn.jev-evaluation-resolution.v1',
              requestId: sourceRequest.requestId,
              status: JevResolutionStatus.Abandoned,
              abandonedAt: sourceRequest.expiresAt,
            }),
          ),
        }
        const lateTerminal = Result.getOrThrow(
          makeStagedTerminalReceipt({
            schemaVersion: 'bayn.staged-terminal-receipt.v1',
            stage: claim.stage,
            requestId: sourceRequest.requestId,
            claimHash: claim.claimHash,
            recordedAt: full.asOf,
            outcome: { status: 'RECEIVED', inference: { ...terminal.outcome.inference, completedAt: full.asOf } },
          }),
        )
        const rejected = Result.getOrThrow(
          makeStagedTerminalReceipt({
            schemaVersion: 'bayn.staged-terminal-receipt.v1',
            stage: claim.stage,
            requestId: sourceRequest.requestId,
            claimHash: claim.claimHash,
            recordedAt: full.asOf,
            outcome: {
              status: 'FAILED',
              failure: {
                category: 'RESPONSE',
                httpStatus: 422,
                responseHash: testHash('rejected staged response'),
                usage: terminal.outcome.inference.response.usage,
              },
            },
          }),
        )
        const withTerminal = (value: typeof terminal) => ({ ...prefix, terminals: [...prefix.terminals, value] })
        return [
          pending,
          abandoned,
          { ...pending, stagedCheckpoint: withTerminal(terminal) },
          { ...abandoned, stagedCheckpoint: withTerminal(lateTerminal) },
          { ...abandoned, stagedCheckpoint: withTerminal(rejected) },
          full,
        ]
      })
    })
    const bundles: InferenceExpenseSource[][] = [
      [expenseSourceFixture()],
      [expenseSourceFixture({ missing: true })],
      [expenseSourceFixture({ rejected: true })],
      [expenseSourceFixture({ notDispatched: true })],
      [stagedExpenseSourceFixture()],
      [stagedExpenseSourceFixture(null)],
      [late],
      [
        stagedExpenseSourceFixture({
          ...completion,
          jev: { status: 'FAILED', failure: JevFailure.Transport, httpStatus: null, responseHash: null, usage: null },
        }),
      ],
      [undispatched],
      ...checkpointLifecycles.flatMap((lifecycle) => lifecycle.map((source) => [source])),
      [
        expenseSourceFixture({ key: 'a' }),
        expenseSourceFixture({ key: 'd', missing: true }),
        expenseSourceFixture({ key: 'e', notDispatched: true }),
      ],
    ]
    const identity = (line: InferenceCostLine) => ({
      request: line.requestId,
      stage: 'stage' in line ? line.stage : InferenceStage.Jev,
      receipt: line.receiptHash,
      handoff: 'handoffHash' in line ? line.handoffHash : null,
      chartClaim: 'chartClaimHash' in line ? line.chartClaimHash : null,
      chartTerminal: 'chartTerminalHash' in line ? line.chartTerminalHash : null,
      stageClaim: 'stageClaimHash' in line ? line.stageClaimHash : null,
      stageTerminal: 'stageTerminalHash' in line ? line.stageTerminalHash : null,
      stageSkip: 'stageSkipHash' in line ? line.stageSkipHash : null,
    })
    const inputs = []
    const actual = []
    for (const sources of bundles) {
      const first = sources[0]
      if (first === undefined) throw new Error('Expense conformance needs a source')
      const rates = first.sessionDate === '1970-01-01' ? expenseRateFixture : inferenceExpenseRateCard
      const priced = sources.flatMap((source) => Result.getOrThrow(makeInferenceExpenseQuotes(source, rates)))
      const unpriced = sources.flatMap((source) =>
        Result.getOrThrow(
          makeInferenceExpenseQuotes(source, { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] }),
        ),
      )
      const firstQuote = priced[0]
      if (firstQuote === undefined) throw new Error('Expense conformance needs a quote')
      const evidence = {
        schemaVersion: sources.some((source) => source.stagedCheckpoint !== undefined)
          ? ('bayn.inference-cost-evidence.v4' as const)
          : ('bayn.inference-cost-evidence.v3' as const),
        accountBindingHash: firstQuote.accountBindingHash,
        sessionDate: first.sessionDate,
        asOf: first.asOf,
        requests: sources.map(({ accountId: _account, sessionDate: _date, asOf: _asOf, ...source }) => source),
      }
      const report = Result.getOrThrow(costReportFromEvidence(evidence, rates))
      expect(report.requestCount).toBe(sources.length)
      expect(report.providerRequestCount).toBe(report.requests.length)
      const choices = report.requests.map((line) => {
        const quote = priced.find((row) => inferenceStageKey(row.line) === inferenceStageKey(line))
        const gap = unpriced.find((row) => inferenceStageKey(row.line) === inferenceStageKey(line))
        if (quote === undefined || gap === undefined) {
          expect('stage' in line && [InferenceStage.BaseStart, InferenceStage.Jev].includes(line.stage)).toBe(true)
          expect(line.estimatedCostPicoUsd).toBeNull()
          expect(first.stagedCheckpoint).toBeDefined()
          expect(first.resolution).toBeNull()
          return [[]]
        }
        const verified = { quote, verifiedAt: first.asOf }
        return [
          [],
          [verified],
          [{ quote, verifiedAt: null }],
          [{ quote: gap, verifiedAt: first.asOf }],
          [verified, verified],
        ]
      })
      const combinations = choices.reduce<InferenceExpenseRecord[][]>(
        (prior, options) => prior.flatMap((rows) => options.map((choice) => [...rows, ...choice])),
        [[]],
      )
      const checkpointPrefix = checkpointLifecycles.find((lifecycle) => lifecycle.includes(first))?.[0]
      const retained =
        first === late
          ? Result.getOrThrow(makeInferenceExpenseQuotes(stagedExpenseSourceFixture(null), rates))
              .filter((quote) => !priced.some((current) => current.quoteHash === quote.quoteHash))
              .map((quote) => ({ quote, verifiedAt: first.asOf }))
          : checkpointPrefix !== undefined && first !== checkpointPrefix
            ? Result.getOrThrow(makeInferenceExpenseQuotes(checkpointPrefix, rates))
                .filter((quote) => !priced.some((current) => current.quoteHash === quote.quoteHash))
                .map((quote) => ({ quote, verifiedAt: first.asOf }))
            : []
      for (const frozen of combinations.flatMap((rows) =>
        retained.length === 0 ? [rows] : [rows, [...retained, ...rows]],
      )) {
        const result = expenseCoverageFromEvidence(evidence, first.accountId, frozen)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ message: 'Inference expense request has conflicting frozen coverage' })
          actual.push(null)
        } else {
          expect(result.success.claimedRequestCount).toBe(sources.length)
          actual.push({
            missingQuoteCount: result.success.missingQuoteCount,
            unverifiedRequestCount: result.success.unverifiedRequestCount,
            gapRequestCount: result.success.gapRequestCount,
            completeMeteredCoverage: result.success.completeMeteredCoverage,
          })
        }
        inputs.push({
          operation: 'inferenceExpenseCoverage',
          lines: report.requests.map(identity),
          frozen: frozen.map((row) => ({
            identity: identity(row.quote.line),
            verified: row.verifiedAt !== null,
            cost: row.quote.line.estimatedCostPicoUsd,
          })),
        })
      }
      expect(Result.isFailure(expenseCoverageFromEvidence(evidence, 'foreign-account', []))).toBe(true)
      expect(
        Result.isFailure(
          expenseCoverageFromEvidence(
            { ...evidence, requests: [] },
            first.accountId,
            priced.map((quote) => ({ quote, verifiedAt: first.asOf })),
          ),
        ),
      ).toBe(true)
    }
    expect(actual.filter((value) => value?.completeMeteredCoverage).length).toBeGreaterThan(5)
    expect(actual.filter((value) => value === null).length).toBeGreaterThan(50)
    expect(actual.filter((value) => value?.completeMeteredCoverage === false).length).toBeGreaterThan(100)
    expect(model(inputs)).toEqual(actual)
  }, 180000)
  test('inference resolution binds exact receipts and preserves the original abandonment deadline', () => {
    const requestId = testHash('inference resolution request')
    const foreignRequest = testHash('other inference request')
    const receiptHash = testHash('inference receipt')
    const otherReceipt = testHash('other inference receipt')
    const inputs = []
    const actual = []
    for (const expires of [0, 1000, 86_400_000])
      for (const requestMatches of [false, true])
        for (const receipt of [
          null,
          { requestId, receiptHash },
          { requestId: foreignRequest, receiptHash },
          { requestId, receiptHash: otherReceipt },
        ])
          for (const status of [JevResolutionStatus.Recorded, JevResolutionStatus.Abandoned])
            for (const delta of [-1, 0, 1]) {
              const request = { requestId, expiresAt: new Date(expires).toISOString() }
              const targetRequest = requestMatches ? requestId : foreignRequest
              const material =
                status === JevResolutionStatus.Recorded
                  ? {
                      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                      status,
                      requestId: targetRequest,
                      receiptHash,
                    }
                  : {
                      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                      status,
                      requestId: targetRequest,
                      abandonedAt: new Date(expires + delta).toISOString(),
                    }
              const result = makeJevResolution(request, receipt, material)
              actual.push(Result.isSuccess(result))
              if (Result.isSuccess(result)) {
                expect(Result.getOrThrow(decodeJevResolution(request, receipt, result.success))).toEqual(result.success)
                expect(
                  Result.isFailure(
                    decodeJevResolution(request, receipt, {
                      ...result.success,
                      resolutionHash: testHash('substituted resolution'),
                    }),
                  ),
                ).toBe(true)
              }
              inputs.push({
                operation: 'inferenceResolution',
                request: requestId,
                expiresAt: String(expires),
                receipt: receipt === null ? null : { request: receipt.requestId, receipt: receipt.receiptHash },
                resolution:
                  status === JevResolutionStatus.Recorded
                    ? {
                        status,
                        request: targetRequest,
                        receipt: receiptHash,
                      }
                    : { status, request: targetRequest, abandonedAt: String(expires + delta) },
              })
            }
    expect(actual.filter(Boolean)).toHaveLength(33)
    expect(model(inputs)).toEqual(actual)
  })
  test('native replay cursor preserves original receipt identity, delivery order and per-partition offsets', () => {
    const epoch = nativeArrivalEpochFixture
    const source = {
      runId: testHash('native order conformance'),
      sourceManifestHash: testHash('native order source'),
      marketSources: epoch.sources,
      deliveryModel: {
        schemaVersion: 'bayn.original-capture-arrivals.v1' as const,
        description: 'Synthetic retained native delivery conformance',
        tieBreak: 'availability-receipt-sequence' as const,
        captureId: epoch.captureId,
        consumerEpoch: epoch.bootstrap.epoch,
        exportManifestHash: testHash('synthetic export'),
        intervalReceiptHash: testHash('synthetic interval'),
        finalConsumerSequence: 4,
      },
    }
    const delivery = (sequence: number, partition: number, offset: string, availableAtMs = 1000, topic = 'crypto') => {
      const observation = nativeArrivalObservationFixture(sequence)
      return nativeArrival(epoch, {
        ...observation,
        availableAtMs,
        projectionSequence: 0,
        disposition: CaptureDisposition.Rejected,
        record: {
          ...observation.record,
          topic,
          partition,
          offset,
          value: '',
          tombstone: true,
          rawValue: null,
          rawValueSha256: null,
          rawByteLength: null,
        },
      })
    }
    const cursors: HistoricalMarketCursor[] = [
      Result.getOrThrow(createHistoricalMarketCursor(source.runId, epoch.sources, undefined, source)),
    ]
    for (let sequence = 1; sequence <= 4; sequence++) {
      const prior = cursors.at(-1)
      if (prior === undefined) throw new Error('Missing native prefix')
      cursors.push(
        Result.getOrThrow(
          advanceHistoricalMarketCursor(prior, delivery(sequence, sequence % 2, String(10 + sequence))),
        ),
      )
    }
    const samples = fc.sample(
      fc.record({
        prefixLength: fc.integer({ min: 0, max: 4 }),
        increment: fc.constantFrom(0, 1, 1, 1, 2),
        time: fc.constantFrom(999, 1000, 1000, 1001),
        partition: fc.integer({ min: 0, max: 2 }),
        offset: fc.bigInt({ min: 0n, max: 10n ** 20n }),
        foreignCapture: fc.constantFrom(false, false, false, true),
        foreignEpoch: fc.constantFrom(false, false, false, true),
        suppliedTimeOnly: fc.constantFrom(false, false, false, true),
        topic: fc.constantFrom('crypto', 'features'),
      }),
      { seed: 20261028, numRuns: 1200 },
    )
    for (let index = 0; index < 150; index++)
      samples.push({
        prefixLength: index % 4,
        increment: 1,
        time: 1000 + (index % 2),
        partition: index % 3,
        offset: BigInt(20 + index),
        foreignCapture: false,
        foreignEpoch: false,
        suppliedTimeOnly: false,
        topic: index % 2 === 0 ? 'crypto' : 'features',
      })
    const cases = samples.map((sample) => {
      const cursor = cursors[sample.prefixLength]
      if (cursor === undefined) throw new Error('Missing native prefix fixture')
      const event = delivery(
        sample.prefixLength + sample.increment,
        sample.partition,
        String(sample.offset),
        sample.time,
        sample.topic,
      )
      const next = {
        ...event,
        receipt: {
          ...event.receipt,
          captureId: sample.foreignCapture ? 'foreign-capture' : event.receipt.captureId,
          consumerEpoch: sample.foreignEpoch ? 'foreign-epoch' : event.receipt.consumerEpoch,
        },
      }
      const observed = sample.suppliedTimeOnly ? { availableAtMs: event.availableAtMs, record: event.record } : next
      const result = advanceHistoricalMarketCursor(cursor, observed)
      if (Result.isSuccess(result)) {
        expect(result.success.processedRecords).toBe(cursor.processedRecords + 1)
        expect(result.success.suppliedOffsets.get(topicPartitionKey(next.record.topic, next.record.partition))).toBe(
          next.record.offset,
        )
        expect(result.success.lastArrival?.receipt).toEqual(next.receipt)
      }
      const previous = cursor.lastArrival
      if (previous !== null && previous.receipt === undefined) throw new Error('Missing native receipt fixture')
      const previousInput =
        previous === null || previous.receipt === undefined
          ? null
          : {
              capture: previous.receipt.captureId,
              epoch: previous.receipt.consumerEpoch,
              sequence: String(previous.receipt.sequence),
              consumerSequence: String(previous.receipt.consumerSequence),
              availableAt: String(previous.availableAtMs),
              offset: previous.offset,
            }
      return {
        actual: Result.isSuccess(result),
        input: {
          operation: 'nativeArrivalProgress',
          scope: { capture: epoch.captureId, epoch: epoch.bootstrap.epoch, finalConsumerSequence: '4' },
          previous: previousInput,
          previousPartitionOffset:
            cursor.suppliedOffsets.get(topicPartitionKey(next.record.topic, next.record.partition)) ?? null,
          next: sample.suppliedTimeOnly
            ? null
            : {
                capture: next.receipt.captureId,
                epoch: next.receipt.consumerEpoch,
                sequence: String(next.receipt.sequence),
                consumerSequence: String(next.receipt.consumerSequence),
                availableAt: String(next.availableAtMs),
                offset: next.record.offset,
              },
        },
      }
    })
    expect(cases.slice(-150).every((value) => value.actual)).toBe(true)
    expect(cases.filter((value) => !value.actual).length).toBeGreaterThan(100)
    expect(model(cases.map((value) => value.input))).toEqual(cases.map((value) => value.actual))
  })
  test('frozen weighted allocation preserves every microdollar across accounts and sessions', () => {
    const samples = [
      ...fc.sample(
        fc.record({
          amount: fc.bigInt({ min: 0n, max: 10n ** 40n }),
          weights: fc.array(fc.bigInt({ min: 1n, max: 10n ** 20n }), { minLength: 1, maxLength: 50 }),
        }),
        { seed: 20261026, numRuns: 1000 },
      ),
      ...fc.sample(
        fc.record({
          amount: fc.bigInt({ min: -10n, max: 100n }),
          weights: fc.array(fc.bigInt({ min: -2n, max: 10n }), { maxLength: 20 }),
        }),
        { seed: 20261027, numRuns: 300 },
      ),
      { amount: 0n, weights: [1n, 2n, 3n] },
      { amount: 1n, weights: [1n, 1n, 1n] },
      { amount: 10n, weights: [1n, 2n, 3n] },
    ]
    expect(
      model(
        samples.map((sample) => ({
          operation: 'allocateCostByWeights',
          amount: String(sample.amount),
          weights: sample.weights.map(String),
        })),
      ),
    ).toEqual(samples.map((sample) => allocateCostByWeights(sample.amount, sample.weights)?.map(String) ?? null))
  })
  test('cash and executable-bid inventory agree with Lean without rounding up or accepting missing inventory', () => {
    const position = fc.record({
      symbol: fc.constantFrom('AAPL', 'NVDA', 'BTC/USD'),
      quantityAtoms: fc.bigInt({ min: 0n, max: 10_000_000_000_000n }).map(String),
      bidPriceMicros: fc.bigInt({ min: 0n, max: 100_000_000_000n }).map(String),
      costBasisMicros: fc.bigInt({ min: 0n, max: 100_000_000_000_000n }).map(String),
    })
    const samples = fc.sample(
      fc.record({
        cashMicros: fc.option(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }).map(String), {
          nil: null,
        }),
        positions: fc.option(fc.array(position, { maxLength: 4 }), { nil: null }),
      }),
      { seed: 70315, numRuns: 1000 },
    )
    samples.push(
      {
        cashMicros: '100',
        positions: [
          { symbol: 'AAPL', quantityAtoms: '1500000001', bidPriceMicros: '100000001', costBasisMicros: '150000000' },
        ],
      },
      { cashMicros: '-100', positions: [] },
      { cashMicros: '100', positions: null },
      { cashMicros: null, positions: [] },
    )
    const actual = samples.map((sample) =>
      accountMarkValue({
        accountBindingHash: 'account',
        sourceHash: 'source',
        at: '2026-09-18T15:30:00.000Z',
        availableAt: '2026-09-18T15:30:00.000Z',
        cashMicros: sample.cashMicros,
        valuation:
          sample.positions === null
            ? null
            : {
                inventorySourceHash: 'inventory',
                positions: sample.positions.map((position) => ({ ...position, quoteSourceHash: 'quote' })),
              },
      }),
    )
    expect(actual.filter((value) => value !== null).length).toBeGreaterThan(100)
    expect(model(samples.map((sample) => ({ operation: 'bidMarkedValue', ...sample })))).toEqual(actual)
  })
  test('cash projection matches Lean over observed anchors, uncertain debit intervals, contradictions and incomplete evidence', () => {
    const at = (second: number) => new Date(Date.UTC(2026, 10, 2, 14, 30, second)).toISOString()
    const base = Date.parse(at(0))
    const seconds = (instant: string) => String((Date.parse(instant) - base) / 1000)
    const generated = fc.sample(
      fc.record({
        changes: fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 110 }),
            delay: fc.integer({ min: 0, max: 20 }),
            amount: fc.integer({ min: -500, max: 500 }),
          }),
          { maxLength: 5 },
        ),
        flows: fc.array(
          fc.record({
            time: fc.integer({ min: 1, max: 120 }),
            amount: fc.integer({ min: 0, max: 500 }),
            kind: fc.constantFrom(...Object.values(CashAdjustmentKind)),
          }),
          { maxLength: 4 },
        ),
        mode: fc.integer({ min: 0, max: 7 }),
      }),
      { seed: 70316, numRuns: 600 },
    )
    const samples = generated.map((sample) => {
      const history = {
        sourceHash: testHash('history'),
        completeFrom: at(0),
        completeThrough: at(130),
        changes: sample.changes.map((c, i) => ({
          sourceHash: testHash(i),
          earliestAt: at(c.start),
          latestAt: at(c.start + c.delay),
          amountMicros: String(c.amount),
        })),
      }
      const flows = {
        schemaVersion: 'bayn.system-cash-flow-evidence.v1' as const,
        accountBindingHash: testHash('account'),
        sessionDate: '2026-11-02' as const,
        asOf: at(130),
        coverage: 'COMPLETE' as const,
        movements: sample.flows.map((f, i) => ({
          movementId: testHash(i),
          sourceHash: testHash(i),
          kind: f.kind,
          at: at(f.time),
          amountMicros: String(f.amount),
        })),
      }
      const marks = [0, 30, 60, 90, 120].map((second) => {
        const change = indexCashHistory(history)(at(second))
        const flow = cashFlowTotals(flows, at(second))
        const observed = 1000n + (change ?? 0n) + flow.external + flow.yieldAmount - flow.paidOperating
        return {
          accountBindingHash: testHash('account'),
          sourceHash: testHash(second),
          at: at(second),
          availableAt: at(130),
          cashMicros:
            second === 30 || second === 90
              ? (observed + (sample.mode === 1 && second === 90 ? 1n : 0n)).toString()
              : null,
          valuation: null,
        }
      })
      if (sample.mode === 2) history.completeThrough = at(119)
      if (sample.mode === 3) history.changes.push(...history.changes)
      if (sample.mode === 4)
        history.changes.push({
          sourceHash: testHash('reversed'),
          earliestAt: at(90),
          latestAt: at(30),
          amountMicros: '1',
        })
      return { marks, history: sample.mode === 5 ? null : history, flows: sample.mode === 6 ? null : flows }
    })
    const actual = samples.map((sample) =>
      Result.getOrThrow(projectSessionCash(sample.marks, sample.history, sample.flows, at(120))).map(
        (m) => m.cashMicros,
      ),
    )
    expect(actual.filter((marks) => marks.every((cash) => cash !== null)).length).toBeGreaterThan(20)
    expect(actual.filter((marks) => marks.every((cash) => cash === null)).length).toBeGreaterThan(10)
    expect(
      model(
        samples.map((sample) => ({
          operation: 'cashProjection',
          closeAt: '120',
          marks: sample.marks.map((mark) => ({ at: seconds(mark.at), cash: mark.cashMicros })),
          history:
            sample.history === null
              ? null
              : {
                  completeFrom: seconds(sample.history.completeFrom),
                  completeThrough: seconds(sample.history.completeThrough),
                  changes: sample.history.changes.map((c) => ({
                    source: c.sourceHash,
                    earliest: seconds(c.earliestAt),
                    latest: seconds(c.latestAt),
                    amount: c.amountMicros,
                  })),
                },
          flows:
            sample.flows === null
              ? null
              : sample.flows.movements.map((f) => ({
                  at: seconds(f.at),
                  amount: (f.kind === CashAdjustmentKind.PaidOperatingCost
                    ? -BigInt(f.amountMicros)
                    : BigInt(f.amountMicros)
                  ).toString(),
                })),
        })),
      ),
    ).toEqual(actual)
  })
  test('every captured mark in the account, session and evidence cut is retained', () => {
    const samples = fc.sample(
      fc.array(
        fc.record({
          account: fc.constantFrom('candidate', 'control'),
          at: fc.integer({ min: -1, max: 121 }),
          availableAt: fc.integer({ min: -1, max: 121 }),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      { seed: 70314, numRuns: 500 },
    )
    samples.push(
      ['candidate', 'control'].flatMap((account) =>
        [-1, 0, 1, 119, 120, 121].flatMap((at) =>
          [-1, 0, 119, 120, 121].map((availableAt) => ({ account, at, availableAt })),
        ),
      ),
    )
    const inputs = samples.map((marks) => ({
      operation: 'retainedFinancialMarks',
      account: 'candidate',
      opening: '0',
      closing: '120',
      asOf: '120',
      marks: marks.map((mark, index) => ({
        ...mark,
        source: String(index),
        at: String(mark.at),
        availableAt: String(mark.availableAt),
      })),
    }))
    const actual = samples.map((marks) => {
      const selected = retainedFinancialMarks(
        marks.map((mark, index) => ({
          accountBindingHash: mark.account,
          sourceHash: String(index),
          at: new Date(mark.at).toISOString(),
          availableAt: new Date(mark.availableAt).toISOString(),
          cashMicros: '0',
          valuation: { inventorySourceHash: String(index), positions: [] },
        })),
        {
          accountBindingHash: 'candidate',
          openAt: new Date(0).toISOString(),
          closeAt: new Date(120).toISOString(),
          asOf: new Date(120).toISOString(),
        },
      )
      expect(selected.map((mark) => mark.at)).toEqual(
        selected.map((mark) => mark.at).toSorted((a, b) => a.localeCompare(b)),
      )
      return selected.map((mark) => mark.sourceHash).toSorted((a, b) => a.localeCompare(b))
    })
    const expected = model(inputs).map((value) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.String))(value).toSorted((a, b) => a.localeCompare(b)),
    )
    expect(actual).toEqual(expected)
  })
  test('window document versions and every allocated recipient agree with the model', () => {
    const key = fc.constantFrom('first', 'second', 'third')
    const samples = fc.sample(
      fc.array(
        fc.record({ identity: key, fingerprint: key, scope: key, requiredScopes: fc.array(key, { maxLength: 3 }) }),
        { maxLength: 20 },
      ),
      { seed: 70312, numRuns: 1000 },
    )
    const valid = fc
      .sample(
        fc.array(
          fc.record({
            identity: fc.uuid(),
            fingerprint: fc.uuid(),
            scopes: fc.uniqueArray(key, { minLength: 1, maxLength: 3 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        { seed: 70313, numRuns: 100 },
      )
      .map((documents) =>
        documents.flatMap((document) =>
          document.scopes.map((scope) => ({
            identity: document.identity,
            fingerprint: document.fingerprint,
            scope,
            requiredScopes: document.scopes,
          })),
        ),
      )
    expect(valid.every(costWindowConsistent)).toBe(true)
    samples.push(...valid)
    expect(model(samples.map((documents) => ({ operation: 'costWindow', documents })))).toEqual(
      samples.map(costWindowConsistent),
    )
  })
  test('cost allocation uses exact integers, complete terminal totals and source-derived request timing', () => {
    const proportions = fc.sample(fc.record({ amount: fc.bigInt(), weight: fc.bigInt(), total: fc.bigInt() }), {
      seed: 70310,
      numRuns: 500,
    })
    for (const amount of [0n, 1n, 10n, 2n ** 100n])
      for (const total of [1n, 3n, 1000000000000000000n])
        for (const weight of [0n, 1n, total / 2n, total - 1n, total]) proportions.push({ amount, weight, total })
    expect(
      model(
        proportions.map(({ amount, weight, total }) => ({
          operation: 'proportionalCost',
          amount: amount.toString(),
          weight: weight.toString(),
          total: total.toString(),
        })),
      ),
    ).toEqual(
      proportions.map(({ amount, weight, total }) => proportionalCost(amount, weight, total)?.toString() ?? null),
    )

    const samples = fc.sample(
      fc.record({
        invoice: fc.bigInt({ min: 0n, max: 2n ** 70n }),
        fixed: fc.bigInt({ min: 0n, max: 2n ** 70n }),
        requests: fc.array(
          fc.record({ startedAt: fc.integer({ min: 0, max: 10000 }), tokens: fc.integer({ min: 0, max: 1000000 }) }),
          { maxLength: 4 },
        ),
      }),
      { seed: 70311, numRuns: 100 },
    )
    const inputs = []
    const expected = []
    const instant = (milliseconds: number) => new Date(milliseconds).toISOString()
    for (const sample of samples) {
      const raw = operatingCostFixture({
        netTradingPnlMicros: '0',
        inferenceInvoiceMicros: sample.invoice.toString(),
        inferenceTariffMicros: '0',
        dataCostMicros: sample.fixed.toString(),
        infrastructureCostMicros: '0',
        researchCostMicros: '0',
      })
      const requests = sample.requests.map((request, index) => {
        const {
          accountId: _,
          sessionDate: _date,
          asOf: _asOf,
          ...source
        } = expenseSourceFixture({
          key: String(index),
          observedAt: instant(request.startedAt),
          inputTokens: request.tokens,
          rejected: index % 2 === 0,
        })
        return source
      })
      const inference = Result.getOrThrow(
        costReportFromEvidence(
          {
            schemaVersion: 'bayn.inference-cost-evidence.v2',
            accountBindingHash: raw.evidence.accountBindingHash,
            sessionDate: raw.evidence.sessionDate,
            asOf: raw.evidence.asOf,
            requests,
          },
          expenseRateFixture,
        ),
      )
      const costs = Result.getOrThrow(makeOperatingCostReport(inference, raw.evidence, raw.verifiedSources))
      const costsAt = indexOperatingCosts(costs, inference, { openAt: instant(1000), closeAt: instant(9000) })
      for (const time of [999, 1000, 1001, 2500, 5000, 8999, 9000, 9001, 5000, 1000, 9000]) {
        inputs.push({
          operation: 'recognizedOperatingCosts',
          fixed: sample.fixed.toString(),
          invoice: sample.invoice.toString(),
          premium: costs.qualificationPremiumMicros,
          opening: '1000',
          closing: '9000',
          time: String(time),
          requests: inference.requestTimings.map((timing) => {
            if (timing.estimatedCostPicoUsd === null) throw new Error('Missing generated cost timing')
            return {
              startedAt: timing.startedAt === null ? null : String(Date.parse(timing.startedAt)),
              weight: timing.estimatedCostPicoUsd,
            }
          }),
        })
        expected.push(costsAt?.(instant(time)) ?? null)
      }
    }
    expect(model(inputs)).toEqual(expected)
  })

  test('qualification equity retains signed session results and never restarts after an unknown balance or profit', () => {
    const samples = fc.sample(
      fc.record({ opening: fc.option(fc.bigInt(), { nil: null }), profit: fc.option(fc.bigInt(), { nil: null }) }),
      { seed: 9091, numRuns: 500 },
    )
    const inputs = samples.map(({ opening, profit }) => ({
      operation: 'qualificationEquity',
      opening: opening?.toString() ?? null,
      profit: profit?.toString() ?? null,
    }))
    const expected = samples.map(
      ({ opening, profit }) => advanceQualificationEquity(opening, profit)?.toString() ?? null,
    )
    expect(model(inputs)).toEqual(expected)
    let balance: bigint | null = 100000000000n
    const path = [-1000000000n, -20000000n, 500000000n, null, 5000000000n].map((profit) => {
      balance = advanceQualificationEquity(balance, profit)
      return balance
    })
    expect(path).toEqual([99000000000n, 98980000000n, 99480000000n, null, null])
  })

  test('captured cash bridges and full operating costs reproduce the Lean economics for every registered policy', () => {
    const { input, cut, verifiedSources } = capturedAccountsFixture()
    const supplied = {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => ({ ...session, financial: null })),
      })),
    }
    const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
    const inputs = []
    const expected = []
    for (const policy of bound.input.policies) {
      const definition = input.registration.policies.find((definition) => definition.policy === policy.policy)
      if (definition === undefined) throw new Error('Missing registered policy')
      for (const session of policy.sessions) {
        const report = Result.getOrThrow(
          assessSession(session, input.registration, definition, input.asOf, bound.verifiedSources),
        )
        const financial = session.financial
        const costs = report.costs
        if (financial === null || costs === null) throw new Error('Missing captured financial fixture')
        const category = (kind: OperatingCostCategory) => {
          const value = costs.categories.find((category) => category.category === kind)?.knownInvoicedCostMicros
          if (value === undefined) throw new Error('Missing cost category')
          return value
        }
        inputs.push({ operation: 'cashInventory', ...financial.cashInventory })
        expected.push(costs.netTradingPnlMicros)
        const amounts = {
          grossRealizedPnlMicros: financial.grossRealizedPnlMicros,
          openingUnrealizedPnlMicros: financial.openingUnrealizedPnlMicros,
          closingUnrealizedPnlMicros: financial.closingUnrealizedPnlMicros,
          executionCostMicros: financial.executionCostMicros,
          cashSettlementRoundingMicros: financial.cashSettlementRoundingMicros,
          inferenceInvoiceMicros: category(OperatingCostCategory.Inference),
          inferenceTariffMicros: costs.knownInferenceTariffCostMicros,
          dataCostMicros: category(OperatingCostCategory.Data),
          infrastructureCostMicros: category(OperatingCostCategory.Infrastructure),
          researchCostMicros: category(OperatingCostCategory.Research),
        }
        inputs.push({ operation: 'economics', ...amounts })
        expected.push({
          netTradingPnlMicros: costs.netTradingPnlMicros,
          totalOperatingCostMicros: costs.totalOperatingCostMicros,
          netEconomicPnlMicros: report.netEconomicPnlMicros,
          qualificationInferenceCostMicros: costs.qualificationInferenceCostMicros,
          qualificationPnlMicros: report.qualificationPnlMicros,
        })
      }
    }
    expect(model(inputs)).toEqual(expected)
  })

  test('cycle transitions, lease expiry, immutable binding and durable completion match production', async () => {
    const { native, document } = await Effect.runPromise(latencyCalibrationDecisionFixture)
    const at = Date.parse(document.createdAt)
    const instant = (value: number) => new Date(value).toISOString()
    const encodeTime = (value: string) => String(Date.parse(value))
    const pending = makeInitialCycle(native.draft, native.observation.payload.observedAt)
    const active: AutonomousCycle = { ...pending, state: CycleState.Active, updatedAt: document.createdAt }
    const bindings: AutonomousCycle['bindings'][] = [
      {},
      { snapshotId: document.bindings.snapshotId },
      { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
      { decisionHash: testHash('foreign cycle decision') },
    ]
    const encodeCycle = (cycle: AutonomousCycle) => ({
      identity: {
        cycleId: cycle.identity.cycleId,
        strategyName: cycle.identity.strategyName,
        strategyProtocolHash: cycle.identity.strategyProtocolHash,
        qualificationRunId: cycle.identity.qualificationRunId,
        accountId: cycle.identity.accountId,
      },
      state: cycle.state,
      createdAt: encodeTime(cycle.createdAt),
      updatedAt: encodeTime(cycle.updatedAt),
      submissionOpenAt: encodeTime(cycle.window.submissionOpenAt),
      submissionCutoffAt: encodeTime(cycle.window.submissionCutoffAt),
      snapshotId: cycle.bindings.snapshotId ?? null,
      decisionHash: cycle.bindings.decisionHash ?? null,
    })
    const outcome = <A extends { readonly _tag: string; readonly reason?: string }>(
      result: Result.Result<A, { readonly failure: string }>,
    ) =>
      Result.isFailure(result)
        ? result.failure.failure
        : result.success._tag === 'Block'
          ? result.success.reason
          : result.success._tag
    const transitionCases = Object.values(CycleState).flatMap((from) =>
      Object.values(CycleState).map((to) => ({ from, to })),
    )
    expect(model(transitionCases.map((c) => ({ operation: 'cycleTransition', ...c })))).toEqual(
      transitionCases.map((c) => isCycleStateTransitionAllowed(c.from, c.to)),
    )
    const lifecycleCases: { cycle: AutonomousCycle; now: number; completed: boolean }[] = []
    for (const createdAt of [
      Date.parse(active.window.submissionOpenAt) - 1,
      at,
      Date.parse(active.window.submissionCutoffAt) - 1,
    ])
      for (const state of Object.values(CycleState))
        for (const binding of bindings) {
          const cycle = {
            ...active,
            state,
            bindings: binding,
            createdAt: instant(createdAt),
            updatedAt: instant(createdAt + 1),
          }
          for (const now of [
            createdAt - 1,
            createdAt,
            createdAt + 1,
            unusedEntryExpiresAt(cycle) - 1,
            unusedEntryExpiresAt(cycle),
            Date.parse(cycle.window.submissionCutoffAt) - 1,
            Date.parse(cycle.window.submissionCutoffAt),
          ])
            for (const completed of [false, true]) lifecycleCases.push({ cycle, now, completed })
        }
    expect(lifecycleCases).toHaveLength(840)
    expect(
      model(
        lifecycleCases.map((c) => ({
          operation: 'cycleLifecycle',
          cycle: encodeCycle(c.cycle),
          now: String(c.now),
          completed: c.completed,
        })),
      ),
    ).toEqual(
      lifecycleCases.map((c) => ({
        unusedEntryExpiresAt: String(unusedEntryExpiresAt(c.cycle)),
        expiredUnusedEntry: hasExpiredUnusedEntryAdmission(c.cycle, instant(c.now)),
        activation: outcome(decideActivation(c.cycle, instant(c.now))),
        completion: outcome(
          decideCompletion(c.cycle, c.completed ? CycleState.Completed : CycleState.NoTrade, instant(c.now)),
        ),
      })),
    )
    const observing: ObserveShadowDecisionDocument = {
      schemaVersion: 'bayn.observe-shadow-decision.v2',
      mode: legacyObserveAuthorityToken,
      dispatchable: false,
      bindings: document.bindings,
      targetPlan: document.targetPlan,
      deltaRisk: document.deltaRisk,
      createdAt: document.createdAt,
      submissionCutoffAt: document.submissionCutoffAt,
      expiresAt: document.expiresAt,
      contentHash: document.contentHash,
    }
    const market = document.bindings.executionMarketData
    if (market === undefined) throw new Error('Missing complete native decision market fixture')
    const { executionMarketData: _execution, decisionMarketData: _decision, ...withoutMarket } = document.bindings
    const documents: CycleDecisionDocument[] = [
      document,
      observing,
      { ...document, contentHash: testHash('foreign document') },
      { ...document, createdAt: instant(at - 1) },
      { ...document, createdAt: instant(at + 1) },
      { ...document, submissionCutoffAt: instant(Date.parse(document.submissionCutoffAt) + 1) },
      { ...document, bindings: { ...document.bindings, snapshotId: testHash('foreign snapshot') } },
      { ...document, bindings: { ...document.bindings, snapshotContentHash: testHash('foreign content') } },
      { ...document, bindings: { ...document.bindings, snapshotFinalizedAt: instant(at - 1) } },
      { ...document, bindings: withoutMarket },
      { ...document, bindings: { ...withoutMarket, decisionMarketData: market } },
      { ...document, bindings: { ...withoutMarket, executionMarketData: market } },
      {
        ...document,
        bindings: {
          ...withoutMarket,
          executionMarketData: market,
          decisionMarketData: { ...market, contentHash: testHash('selected content') },
        },
      },
    ]
    for (const key of ['cycleId', 'strategyName', 'strategyProtocolHash', 'qualificationRunId', 'accountId'] as const)
      documents.push({ ...document, bindings: { ...document.bindings, [key]: testHash({ foreign: key }) } })
    const encodeMarket = (value: typeof market | undefined) =>
      value === undefined
        ? null
        : { snapshotId: value.snapshotId, contentHash: value.contentHash, observedAt: encodeTime(value.observedAt) }
    const encodeDocument = (value: CycleDecisionDocument) => ({
      identity: {
        cycleId: value.bindings.cycleId,
        strategyName: value.bindings.strategyName,
        strategyProtocolHash: value.bindings.strategyProtocolHash,
        accountId: value.bindings.accountId,
        qualificationRunId: value.mode === legacyExecutionAuthorityToken ? value.bindings.qualificationRunId : '',
      },
      contentHash: value.contentHash,
      executionMode: value.mode === legacyExecutionAuthorityToken,
      snapshot: {
        snapshotId: value.bindings.snapshotId,
        contentHash: value.bindings.snapshotContentHash,
        observedAt: encodeTime(value.bindings.snapshotFinalizedAt),
      },
      executionMarketData: encodeMarket(value.bindings.executionMarketData),
      decisionMarketData: encodeMarket(value.bindings.decisionMarketData),
      createdAt: encodeTime(value.createdAt),
      submissionCutoffAt: encodeTime(value.submissionCutoffAt),
    })
    const bindingCases: {
      cycle: AutonomousCycle
      document: CycleDecisionDocument
      now: number
      stored: CycleDecisionDocument[]
    }[] = []
    for (const state of Object.values(CycleState))
      for (const binding of bindings)
        for (const value of documents)
          for (const now of [at - 1, at, unusedEntryExpiresAt(active), Date.parse(active.window.submissionCutoffAt)]) {
            const cycle = { ...active, state, bindings: binding }
            bindingCases.push({ cycle, document: value, now, stored: [value] })
          }
    for (const value of documents)
      for (const stored of [[], [value, value], [{ ...value, createdAt: instant(at + 1) }]])
        bindingCases.push({
          cycle: { ...active, bindings: { decisionHash: value.contentHash } },
          document: value,
          now: at,
          stored,
        })
    expect(bindingCases).toHaveLength(1494)
    const equivalent = Schema.toEquivalence(CycleDecisionDocumentSchema)
    const bindingOutcomes = bindingCases.map((c) =>
      outcome(decideDecisionBinding(c.cycle, c.document, instant(c.now), c.stored)),
    )
    expect(bindingOutcomes).toContain('Persist')
    expect(bindingOutcomes).toContain('Replay')
    expect(bindingOutcomes).toContain('invariant')
    expect(bindingOutcomes).toContain('BLOCKED_UNUSED_ENTRY_EXPIRED')
    expect(
      model(
        bindingCases.map((c) => ({
          operation: 'cycleDecisionBinding',
          cycle: encodeCycle(c.cycle),
          document: encodeDocument(c.document),
          now: String(c.now),
          storedCount: c.stored.length,
          storedEquivalent: c.stored[0] !== undefined && equivalent(c.stored[0], c.document),
        })),
      ),
    ).toEqual(bindingOutcomes)
    const plans: TargetPlanResult[] = [
      document.targetPlan,
      {
        ...document.targetPlan,
        status: TargetPlanStatus.NoTrade,
        reason: TargetPlanReason.TargetsSatisfied,
        intentTargets: [],
      },
      {
        ...document.targetPlan,
        status: TargetPlanStatus.Blocked,
        reason: TargetPlanReason.InputStale,
        intentTargets: [],
      },
    ]
    const completionCases: {
      completed: boolean
      hash: string
      stored: CycleDecisionDocument[]
      override: boolean | undefined
    }[] = []
    for (const completed of [false, true])
      for (const hash of [document.contentHash, testHash('different completion')])
        for (const targetPlan of plans)
          for (const risk of [false, true]) {
            const execution: ExecutionDecisionDocument = {
              ...document,
              targetPlan,
              ...(risk
                ? {
                    riskBlock: {
                      intentId: testHash('risk intent'),
                      decisionId: testHash('risk decision'),
                      reasonCodes: ['BLOCKED'],
                    },
                  }
                : {}),
            }
            for (const value of [execution, { ...observing, targetPlan }])
              for (const attached of [false, true, undefined]) {
                const stored =
                  attached === undefined
                    ? value
                    : attachCycleDecisionStoreEvidence(value, {
                        executionCompletionEvidenceMatches: attached,
                        executionGenerationIsSuperseded: false,
                      })
                for (const override of [undefined, false, true])
                  for (const inventory of [[], [stored], [stored, stored]])
                    completionCases.push({ completed, hash, stored: inventory, override })
              }
          }
    expect(completionCases).toHaveLength(1296)
    const completionOutcomes = completionCases.map((c) =>
      Result.isSuccess(
        validateCompletionDocument(
          {
            _tag: 'VerifyDecision',
            cycle: active,
            decisionHash: c.hash,
            state: c.completed ? CycleState.Completed : CycleState.NoTrade,
          },
          c.stored,
          c.override,
        ),
      ),
    )
    expect(completionOutcomes).toContain(true)
    expect(completionOutcomes).toContain(false)
    expect(
      model(
        completionCases.map((c) => ({
          operation: 'cycleCompletionDocument',
          completed: c.completed,
          decisionHash: c.hash,
          documents: c.stored.map((value) => ({
            contentHash: value.contentHash,
            planned: value.targetPlan.status === TargetPlanStatus.Planned,
            noTrade: value.targetPlan.status === TargetPlanStatus.NoTrade,
            executionMode: value.mode === legacyExecutionAuthorityToken,
            riskBlocked: value.mode === legacyExecutionAuthorityToken && value.riskBlock !== undefined,
            completionEvidence:
              c.override ?? cycleDecisionStoreEvidence(value)?.executionCompletionEvidenceMatches === true,
          })),
        })),
      ),
    ).toEqual(completionOutcomes)
  }, 60000)

  test('ledger preflight and exact transfer verification agree on partial, duplicate and mismatched records', () => {
    const transfer: LedgerTransferRecord = {
      id: (1n << 100n) + 1n,
      debit_account_id: (1n << 120n) + 2n,
      credit_account_id: (1n << 120n) + 3n,
      amount: (1n << 80n) + 17n,
      pending_id: 0n,
      user_data_128: (1n << 110n) + 5n,
      user_data_64: (1n << 60n) + 7n,
      user_data_32: 19,
      timeout: 0,
      ledger: 7002,
      code: 3,
      flags: 0,
      timestamp: 0n,
    }
    const planned = [transfer, { ...transfer, id: transfer.id + 1n }, { ...transfer, id: transfer.id + 2n }]
    const observed = [...planned, { ...transfer, id: transfer.id + 3n }, { ...transfer, amount: transfer.amount + 1n }]
    const inventories: LedgerTransferRecord[][] = [[]]
    let last: LedgerTransferRecord[][] = [[]]
    for (let length = 1; length <= 3; length++) {
      last = last.flatMap((prefix) => observed.map((value) => [...prefix, value]))
      inventories.push(...last)
    }
    const cases: { expected: LedgerTransferRecord[]; actual: LedgerTransferRecord[] }[] = []
    for (let mask = 0; mask < 8; mask++) {
      const expected = planned.filter((_, index) => ((mask >> index) & 1) === 1)
      for (const actual of inventories) cases.push({ expected, actual })
    }
    for (const changed of [
      { ...transfer, id: transfer.id + 10n },
      { ...transfer, debit_account_id: transfer.debit_account_id + 1n },
      { ...transfer, credit_account_id: transfer.credit_account_id + 1n },
      { ...transfer, amount: transfer.amount + 1n },
      { ...transfer, pending_id: 1n },
      { ...transfer, user_data_128: transfer.user_data_128 + 1n },
      { ...transfer, user_data_64: transfer.user_data_64 + 1n },
      { ...transfer, user_data_32: transfer.user_data_32 + 1 },
      { ...transfer, timeout: 1 },
      { ...transfer, ledger: transfer.ledger + 1 },
      { ...transfer, code: transfer.code + 1 },
      { ...transfer, flags: 1 },
      { ...transfer, timestamp: 1n << 60n },
    ])
      cases.push({ expected: [transfer], actual: [changed] })
    cases.push(
      { expected: [transfer, transfer], actual: [transfer] },
      { expected: [transfer, transfer], actual: [transfer, transfer] },
    )
    const encode = (value: LedgerTransferRecord) =>
      Object.fromEntries(Object.entries(value).map(([key, field]) => [key, String(field)]))
    const expected = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ exact: Schema.Boolean, missing: Schema.NullOr(Schema.Array(Schema.String)) })),
    )(
      model(
        cases.map((c) => ({
          operation: 'ledgerTransferVerification',
          expected: c.expected.map(encode),
          actual: c.actual.map(encode),
        })),
      ),
    )
    const actual = cases.map((c) => {
      const preflight = preflightTransfers(c.expected, c.actual)
      return {
        exact: Result.isSuccess(verifyExactTransfers('verify-existing-transfers', 'transfer', c.actual, c.expected)),
        missing: Result.isSuccess(preflight) ? preflight.success.map((value) => String(value.id)) : null,
      }
    })
    expect(actual).toEqual(
      expected.map((value) => ({ ...value, missing: value.missing === null ? null : [...value.missing] })),
    )
    expect(actual.some((value) => value.exact && value.missing?.length === 0)).toBe(true)
    expect(actual.some((value) => !value.exact && value.missing !== null && value.missing.length > 0)).toBe(true)
  })
  test('replay session completion retains every failure, accounting discrepancy and final exposure', () => {
    const cases = Array.from({ length: 1 << 14 }, (_, mask) => {
      const bit = (index: number) => (mask >> index) & 1
      return {
        finalWindow: bit(0) === 1,
        failedPassCount: bit(1),
        unavailableDecisionPassCount: bit(2),
        valuationFailureCount: bit(3),
        reconciliationExact: bit(4) === 1,
        accountingExact: bit(5) === 1,
        discrepancyCount: bit(6),
        cashDifference: String(-bit(7)),
        positionDifference: String(bit(8)),
        equityDifference: String(-bit(9)),
        unknownOrderCount: bit(10),
        unknownMutationCount: bit(11),
        remainingPositionCount: bit(12),
        remainingOpenOrderCount: bit(13),
      }
    })
    const expected = model(
      cases.map((c) => ({
        ...c,
        operation: 'replaySessionComplete',
        failedPassCount: String(c.failedPassCount),
        unavailableDecisionPassCount: String(c.unavailableDecisionPassCount),
        valuationFailureCount: String(c.valuationFailureCount),
        discrepancyCount: String(c.discrepancyCount),
        unknownOrderCount: String(c.unknownOrderCount),
        unknownMutationCount: String(c.unknownMutationCount),
        remainingPositionCount: String(c.remainingPositionCount),
        remainingOpenOrderCount: String(c.remainingOpenOrderCount),
      })),
    )
    const actual = cases.map(
      (c) =>
        assessBacktestSession({
          ...c,
          reconciliation: {
            status: c.reconciliationExact ? ReconciliationStatus.Exact : ReconciliationStatus.Discrepancy,
            unknownOrderCount: c.unknownOrderCount,
            unknownMutationCount: c.unknownMutationCount,
            metrics: {
              accountingExact: c.accountingExact,
              discrepancyCount: c.discrepancyCount,
              cashDifferenceMicros: c.cashDifference,
              positionDifferenceMicros: c.positionDifference,
              equityDifferenceMicros: c.equityDifference,
              brokerPollAgeMs: 0,
              oldestUnknownMutationAgeMs: 0,
            },
          },
        }).completion === 'COMPLETE',
    )
    expect(actual).toEqual([...Schema.decodeUnknownSync(Schema.Array(Schema.Boolean))(expected)])
  })
  test('both native markets remain bounded by the prospectively registered regular sessions', () => {
    const registration = registrationFixture()
    const session = registration.calendar.sessions[0]
    if (session === undefined) throw new Error('Missing registered session')
    const openAt = Date.parse(session.openAt)
    const closeAt = Date.parse(session.closeAt)
    const times = [
      openAt - 1,
      openAt,
      openAt + 1,
      closeAt - 1,
      closeAt,
      closeAt + 1,
      ...fc.sample(fc.integer({ min: openAt - 86_400_000, max: closeAt + 86_400_000 }), {
        seed: 20261026,
        numRuns: 200,
      }),
    ]
    const expected = Schema.decodeUnknownSync(Schema.Array(Schema.Boolean))(
      model(
        times.map((observedAt) => ({
          operation: 'registeredMarketWindow',
          openAt: String(openAt),
          closeAt: String(closeAt),
          observedAt: String(observedAt),
        })),
      ),
    )
    for (const profile of registration.obligations.configuration.protocol.marketProfiles) {
      const manifest = {
        sessionDate: session.sessionDate,
        feed: profile.feed,
        universeId: profile.universeId,
        universeSymbolHash: profile.universeSymbolHash,
        calendar: profile.market === MarketKind.Equity ? calendarFixture(registration) : continuousMarketHours,
      }
      expect(
        times.map((at) => sourceFitsRegisteredSession(manifest, registration, new Date(at).toISOString())),
      ).toEqual([...expected])
    }
  })
  test('every mutation authority state preserves kill restrictions, bounded closure and immutable account binding', () => {
    const cases: {
      mutationOperation: MutationOperation
      closeOnly: boolean
      authority: MutationAuthoritySnapshot | null
    }[] = []
    for (const mutationOperation of Object.values(MutationOperation))
      for (const closeOnly of [false, true]) {
        cases.push({ mutationOperation, closeOnly, authority: null })
        for (const maximum of Object.values(Authority))
          for (const effective of Object.values(Authority))
            for (const killState of Object.values(KillState))
              for (const generationMaximum of [null, ...Object.values(Authority)])
                for (const generationAccountId of [null, 'account'])
                  cases.push({
                    mutationOperation,
                    closeOnly,
                    authority: {
                      maximum,
                      effective,
                      killState,
                      generationMaximum,
                      generationAccountId,
                      generationHash: testHash('immutable generation'),
                    },
                  })
      }
    expect(cases).toHaveLength(196)
    expect(model(cases.map((c) => ({ operation: 'mutationAuthority', ...c })))).toEqual(
      cases.map((c) => {
        const result = decideMutationAuthority(c.mutationOperation, c.authority ?? undefined, c.closeOnly)
        return Result.isSuccess(result) ? result.success : null
      }),
    )
  })

  test('authority construction matches complete strategy identity, grant time boundaries and revocation precedence', () => {
    const generation = testHash('current generation')
    const start = Date.parse('2026-10-26T00:00:00.000Z')
    const strategy = {
      name: 'jev',
      behaviorHash: testHash('behavior'),
      parameterHash: testHash('parameters'),
      parameterSchemaVersion: 'bayn.test.protocol.v1',
    }
    const identity = (environment: BrokerEnvironment, accountId: string) =>
      Result.getOrThrow(
        makeBrokerIdentity({
          schemaVersion: 'bayn.broker-identity.v2',
          provider: BrokerProvider.Alpaca,
          environment,
          accountId,
        }),
      )
    const cases: ExecutionAuthorityInput[] = []
    for (const environment of Object.values(BrokerEnvironment)) {
      const brokerIdentity = identity(environment, 'account')
      for (const brokerAccess of Object.values(BrokerAccess)) {
        for (const capitalAuthority of [noCapitalAuthority, grantedCapitalAuthority(generation)])
          cases.push({
            brokerIdentity,
            brokerAccess,
            capitalAuthority,
            strategy,
            observedAt: new Date(start).toISOString(),
          })
        for (const authorityGenerationHash of [generation, testHash('foreign generation')])
          for (const grantIdentity of [
            brokerIdentity,
            identity(environment, 'foreign-account'),
            identity(
              environment === BrokerEnvironment.Live ? BrokerEnvironment.Sandbox : BrokerEnvironment.Live,
              'account',
            ),
          ])
            for (let mask = 0; mask < 16; mask++) {
              const grant = Result.getOrThrow(
                makeCapitalGrantRecord({
                  schemaVersion: 'bayn.capital-grant.v2',
                  brokerIdentity: grantIdentity,
                  authorityGenerationHash: generation,
                  strategy: {
                    name: mask & 1 ? 'foreign-strategy' : strategy.name,
                    behaviorHash: mask & 2 ? testHash('foreign behavior') : strategy.behaviorHash,
                    parameterHash: mask & 4 ? testHash('foreign parameters') : strategy.parameterHash,
                    parameterSchemaVersion: mask & 8 ? 'foreign-version' : strategy.parameterSchemaVersion,
                  },
                  limits: {
                    maxGrossNotionalMicros: '100000000000',
                    maxOrderNotionalMicros: '10000000000',
                    maxPositionNotionalMicros: '25000000000',
                    maxDailyLossMicros: '1000000000',
                    maxOpenOrders: 5,
                  },
                  validFrom: new Date(start).toISOString(),
                  validUntil: new Date(start + 10).toISOString(),
                  issuedAt: new Date(start - 1).toISOString(),
                  issuedBy: 'synthetic formal fixture',
                }),
              )
              for (const revoked of [false, true])
                for (const offset of [-1, 0, 1, 9, 10])
                  cases.push({
                    brokerIdentity,
                    brokerAccess,
                    strategy,
                    observedAt: new Date(start + offset).toISOString(),
                    capitalAuthority: {
                      ...grantedCapitalAuthority(
                        grant,
                        revoked
                          ? {
                              schemaVersion: 'bayn.capital-grant-revocation.v2',
                              revokedAt: new Date(start).toISOString(),
                              revokedBy: 'synthetic formal fixture',
                              reason: 'test revocation',
                            }
                          : undefined,
                      ),
                      authorityGenerationHash,
                    },
                  })
            }
      }
    }
    const actual = cases.map((input) => {
      const result = makeExecutionAuthority(input)
      if (Result.isFailure(result)) return result.failure._tag
      expect(result.success.brokerIdentity).toEqual(input.brokerIdentity)
      expect(result.success.brokerAccess).toBe(input.brokerAccess)
      expect(result.success.capitalAuthority).toEqual(input.capitalAuthority)
      expect(result.success.strategy).toEqual(input.strategy)
      return result.success.brokerAccess
    })
    expect(cases).toHaveLength(3848)
    expect(actual).toContain(BrokerAccess.ReadOnly)
    expect(actual).toContain(BrokerAccess.Mutation)
    expect(
      model(
        cases.map((input) => {
          const capital = input.capitalAuthority
          const persisted = capital._tag === CapitalAuthorityKind.Granted ? capital.persistedGrant : undefined
          return {
            operation: 'executionAuthority',
            readOnly: input.brokerAccess === BrokerAccess.ReadOnly,
            brokerIdentityHash: input.brokerIdentity.identityHash,
            strategy: input.strategy,
            now: String(Date.parse(input.observedAt)),
            capital:
              capital._tag === CapitalAuthorityKind.None
                ? { kind: capital._tag }
                : {
                    kind: capital._tag,
                    generationHash: capital.authorityGenerationHash,
                    persisted:
                      persisted === undefined
                        ? null
                        : {
                            generationHash: persisted.grant.authorityGenerationHash,
                            brokerIdentityHash: persisted.grant.brokerIdentity.identityHash,
                            strategy: persisted.grant.strategy,
                            validFrom: String(Date.parse(persisted.grant.validFrom)),
                            validUntil: String(Date.parse(persisted.grant.validUntil)),
                            revoked: persisted.revocation !== undefined,
                          },
                  },
          }
        }),
      ),
    ).toEqual(actual)
  })

  test('intent authority rejects each foreign account, strategy and generation with production failure precedence', () => {
    const expected = { account: 'account', strategy: 'jev', generation: testHash('current generation') }
    const authority = Result.getOrThrow(
      makeExecutionAuthority({
        observedAt: '2026-10-26T00:00:00.000Z',
        brokerIdentity: Result.getOrThrow(
          makeBrokerIdentity({
            schemaVersion: 'bayn.broker-identity.v2',
            provider: BrokerProvider.Alpaca,
            environment: BrokerEnvironment.Sandbox,
            accountId: expected.account,
          }),
        ),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: grantedCapitalAuthority(expected.generation),
        strategy: {
          name: expected.strategy,
          behaviorHash: testHash('behavior'),
          parameterHash: testHash('parameters'),
          parameterSchemaVersion: 'bayn.test.protocol.v1',
        },
      }),
    )
    if (authority.brokerAccess !== BrokerAccess.Mutation) throw new Error('Missing mutation authority fixture')
    const bindings = [expected.account, 'foreign-account'].flatMap((account) =>
      [expected.strategy, 'foreign-strategy'].flatMap((strategy) =>
        [expected.generation, testHash('foreign generation')].map((generation) => ({ account, strategy, generation })),
      ),
    )
    expect(model(bindings.map((observed) => ({ operation: 'boundAuthority', expected, observed })))).toEqual(
      bindings.map((observed) => {
        const intent: Intent = {
          schemaVersion: 'bayn.execution-intent.v5',
          accountId: observed.account,
          strategyName: observed.strategy,
          authorityGenerationHash: observed.generation,
          intentId: testHash('intent'),
          riskDecisionId: testHash('risk'),
          cycleId: testHash('cycle'),
          decisionHash: testHash('decision'),
          policyHash: testHash('policy'),
          clientOrderId: 'formal-conformance',
          symbol: 'AAPL',
          side: OrderSide.Buy,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: '1000000000',
          limitPriceMicros: '100000000',
          notionalLimitMicros: '100000000',
          state: IntentState.Approved,
          createdAt: '2026-10-26T00:00:00.000Z',
        }
        const result = validateIntentAuthorityBinding(authority, intent)
        return Result.isSuccess(result) ? 'PASS' : result.failure._tag
      }),
    )
  })

  test('prospective tariffs cover every registered instant through the final close', () => {
    const registration = registrationFixture()
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const tariff = candidate?.inferenceRateCard.rates.find((rate) => rate.provider === 'typesafe')
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (candidate === undefined || tariff === undefined || first === undefined || last === undefined)
      throw new Error('Missing prospective tariff fixture')
    const opening = Date.parse(first.openAt)
    const closing = Date.parse(last.closeAt)
    const middle = Math.floor((opening + closing) / 2)
    const inputs = []
    const actual = []
    for (const start of [-1, 0, 1])
      for (const gap of [0, 1])
        for (const end of [-1, 0, 1])
          for (const reverse of [false, true]) {
            const rates = [
              { starts: opening + start, ends: middle },
              { starts: middle + gap, ends: closing + end },
            ]
            const changes = rates.map((rate) => ({
              ...tariff,
              effectiveFrom: new Date(rate.starts).toISOString(),
              effectiveUntil: new Date(rate.ends).toISOString(),
            }))
            actual.push(
              Result.isSuccess(
                validateSystemRegistration({
                  ...registration,
                  policies: registration.policies.map((policy) =>
                    policy.policy !== candidate.policy
                      ? policy
                      : {
                          ...policy,
                          inferenceRateCard: {
                            ...policy.inferenceRateCard,
                            rates: [
                              ...policy.inferenceRateCard.rates.filter((rate) => rate.provider !== 'typesafe'),
                              ...(reverse ? changes.toReversed() : changes),
                            ],
                          },
                        },
                  ),
                }),
              ),
            )
            inputs.push({
              operation: 'tariffCoversWindow',
              opening: String(opening),
              closing: String(closing),
              rates: rates.map((rate) => ({ starts: String(rate.starts), ends: String(rate.ends) })),
            })
          }
    expect(actual.filter(Boolean)).toHaveLength(4)
    expect(model(inputs)).toEqual(actual)
  })
  test('prospective tariff admission preserves the frozen contract cost floor', () => {
    const floor = Result.getOrThrow(jevAcceptanceInferenceRateFloor())
    const registration = registrationFixture()
    const samples = [
      { inputRate: 41999n, outputRate: 0n },
      { inputRate: 42000n, outputRate: 0n },
      { inputRate: 42001n, outputRate: 0n },
      ...fc.sample(
        fc.record({
          inputRate: fc.bigInt({ min: 0n, max: 84000n }),
          outputRate: fc.bigInt({ min: 0n, max: 84000n }),
        }),
        { seed: 20261026, numRuns: 200 },
      ),
    ]
    expect(
      model(
        samples.map((sample) => ({
          operation: 'tariffMeetsFloor',
          inputRate: String(sample.inputRate),
          outputRate: String(sample.outputRate),
          inputFloor: floor.inputMicrosPerMillionTokens,
          outputFloor: floor.outputMicrosPerMillionTokens,
        })),
      ),
    ).toEqual(
      samples.map((sample) =>
        Result.isSuccess(
          validateSystemRegistration({
            ...registration,
            policies: registration.policies.map((definition) => ({
              ...definition,
              inferenceRateCard: replayRateCardFixture({
                jev: {
                  inputMicrosPerMillionTokens: String(sample.inputRate),
                  outputMicrosPerMillionTokens: String(sample.outputRate),
                },
                chart: {
                  inputMicrosPerMillionTokens: '1',
                  outputMicrosPerMillionTokens: '0',
                  cachedInputMicrosPerMillionTokens: '0',
                  cacheWriteInputMicrosPerMillionTokens: '0',
                },
              }),
            })),
          }),
        ),
      ),
    )
  })
  test('account protection preserves exact micro-dollar limits and absolute loss history', () => {
    const samples = fc.sample(
      fc.record({
        equity: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        dayStart: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        peak: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        dailyLimit: fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        drawdownLimit: fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
      }),
      { seed: 20261026, numRuns: 400 },
    )
    for (const excess of [-1n, 0n, 1n])
      for (const baseline of ['dayStart', 'peak'] as const)
        samples.push({
          equity: 1000000n,
          dayStart: 1000000n,
          peak: 1000000n,
          dailyLimit: 100n,
          drawdownLimit: 100n,
          [baseline]: 1000100n + excess,
        })
    expect(
      model(
        samples.map((sample) => ({
          operation: 'accountProtection',
          ...Object.fromEntries(Object.entries(sample).map(([key, value]) => [key, String(value)])),
        })),
      ),
    ).toEqual(
      samples.map((sample) =>
        accountEntryProtectionReasons(
          {
            accountEquityMicros: sample.equity,
            dayStartEquityMicros: sample.dayStart,
            peakEquityMicros: sample.peak,
          },
          { maxDailyLossMicros: String(sample.dailyLimit), maxDrawdownMicros: String(sample.drawdownLimit) },
        ),
      ),
    )
  })
  test('controller timing and empirical p95 preserve causal ordering, missing clocks and exact ranks', () => {
    const at = fc.integer({ min: -10, max: 20 })
    const clocks = [
      { issuedAt: 0, observedAt: 0, completedAt: 0, witnessedAt: 0 },
      { issuedAt: 1, observedAt: 2, completedAt: 3, witnessedAt: 4 },
      ...fc.sample(fc.record({ issuedAt: at, observedAt: at, completedAt: at, witnessedAt: at }), {
        seed: 20261026,
        numRuns: 400,
      }),
    ]
    expect(
      model(
        clocks.map((clock) => ({
          operation: 'controllerDurations',
          ...Object.fromEntries(Object.entries(clock).map(([key, value]) => [key, String(value)])),
        })),
      ),
    ).toEqual(
      clocks.map((clock) => {
        const durations = controllerClockDurations({
          issuedAt: new Date(clock.issuedAt).toISOString(),
          observedAt: new Date(clock.observedAt).toISOString(),
          completedAt: new Date(clock.completedAt).toISOString(),
          witnessedAt: new Date(clock.witnessedAt).toISOString(),
        })
        return durations === undefined
          ? null
          : Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, String(value)]))
      }),
    )
    const samples = [
      [],
      [-1],
      [0],
      ...[19, 20, 21, 99, 100, 101, 1000].map((count) => Array.from({ length: count }, (_, i) => count - i)),
      ...fc.sample(fc.array(fc.integer({ min: 0, max: 86_400_000 }), { maxLength: 1000 }), {
        seed: 20261026,
        numRuns: 200,
      }),
    ]
    expect(model(samples.map((values) => ({ operation: 'nearestRank95', values: values.map(String) })))).toEqual(
      samples.map((values) => {
        const value = nearestRank95(values)
        return value === null ? null : String(value)
      }),
    )
  })

  test('full batch clocks retain the slowest required stage and reject incomplete or reversed timing', () => {
    const time = fc.integer({ min: -1000, max: 1000 })
    const clocks = [
      { issuedAt: 0, observedAt: 0, batchCompletedAt: 0, completions: [] },
      { issuedAt: 1, observedAt: 2, batchCompletedAt: 3, completions: [4, 6, 5] },
      { issuedAt: 0, observedAt: 0, batchCompletedAt: 0, completions: [0] },
      ...fc.sample(
        fc.record({
          issuedAt: time,
          observedAt: time,
          batchCompletedAt: time,
          completions: fc.array(time, { maxLength: 10 }),
        }),
        { seed: 20261026, numRuns: 400 },
      ),
      ...fc.sample(
        fc.record({
          issuedAt: fc.integer({ min: -2000, max: -1001 }),
          observedAt: fc.integer({ min: -1000, max: -1 }),
          batchCompletedAt: fc.constant(0),
          completions: fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 20 }),
        }),
        { seed: 20261027, numRuns: 200 },
      ),
    ]
    expect(
      model(
        clocks.map((clock) => ({
          operation: 'fullBatchDuration',
          issuedAt: String(clock.issuedAt),
          observedAt: String(clock.observedAt),
          batchCompletedAt: String(clock.batchCompletedAt),
          completions: clock.completions.map(String),
        })),
      ),
    ).toEqual(
      clocks.map((clock) => {
        const duration = fullBatchClockDuration({
          issuedAt: new Date(clock.issuedAt).toISOString(),
          observedAt: new Date(clock.observedAt).toISOString(),
          batchCompletedAt: new Date(clock.batchCompletedAt).toISOString(),
          durableCompletions: clock.completions.map((at) => new Date(at).toISOString()),
        })
        return duration === undefined ? null : String(duration)
      }),
    )
  })

  test('batch release preserves the original command floor, slow work and safe date bounds', () => {
    const dateLimit = 8_640_000_000_000_000
    const boundaries = [-dateLimit - 1, -dateLimit, -1, 0, 1, dateLimit - 1, dateLimit, dateLimit + 1]
    const clocks = [
      ...boundaries.flatMap((issuedAt) =>
        boundaries.flatMap((completedAt) =>
          [-1, 0, 1, Number.MAX_SAFE_INTEGER].map((p95Ms) => ({ issuedAt, completedAt, p95Ms })),
        ),
      ),
      ...fc.sample(
        fc.record({
          issuedAt: fc.integer({ min: -1000, max: 1000 }),
          completedAt: fc.integer({ min: -1000, max: 1000 }),
          p95Ms: fc.integer({ min: -10, max: 1000 }),
        }),
        { seed: 20261028, numRuns: 400 },
      ),
    ]
    expect(
      model(
        clocks.map((clock) => ({
          operation: 'replayDecisionReleaseAt',
          issuedAt: String(clock.issuedAt),
          completedAt: String(clock.completedAt),
          p95Ms: String(clock.p95Ms),
        })),
      ),
    ).toEqual(
      clocks.map((clock) => {
        const release = replayDecisionReleaseAt(clock.issuedAt, clock.completedAt, clock.p95Ms)
        return release === undefined ? null : String(release)
      }),
    )
  })

  test('native minute windows, complete schedules and durable hold timing match the model', () => {
    const registration = registrationFixture()
    const session = registration.calendar.sessions[0]
    if (session === undefined) throw new Error('Missing session')
    const epoch = Date.parse(session.openAt)
    const cases = [-1, 0, 1, 59999, 60000, 60001].flatMap((offset) =>
      [1, 60000, 60002, 120000, 180000, 23400000].map((duration) => ({
        open: epoch + offset,
        close: epoch + offset + duration,
      })),
    )
    expect(
      model(
        cases.map((c) => ({
          operation: 'decisionSchedule',
          open: String(c.open),
          close: String(c.close),
          delay: '2000',
          deadline: String(registration.obligations.decisionWindowMs),
        })),
      ),
    ).toEqual(
      cases.map((c) =>
        Result.getOrThrow(
          registeredSchedule({
            ...registration,
            calendar: {
              ...registration.calendar,
              sessions: [
                { ...session, openAt: new Date(c.open).toISOString(), closeAt: new Date(c.close).toISOString() },
              ],
            },
          }),
        )
          .filter((o) => o.class === ObligationClass.Decision)
          .map((o) => ({ dueAt: String(Date.parse(o.dueAt)), deadlineAt: String(Date.parse(o.deadlineAt)) })),
      ),
    )
    const observed = [-60001, -1, 0, 1, 1999, 2000, 2001, 61999, 62000, 62001].map((offset) => epoch + offset)
    expect(model(observed.map((at) => ({ operation: 'signalWindow', observedAt: String(at), delay: '2000' })))).toEqual(
      observed.map((at) => String(jevSignalWindowEndMs(at, registration.obligations.configuration.protocol))),
    )
    const valid = { observedAt: 1, passObservedAt: 2, completedAt: 3, witnessedAt: 4, validUntil: 5 }
    const time = fc.integer({ min: -10, max: 20 })
    const holds = [
      valid,
      ...(['observedAt', 'passObservedAt', 'completedAt', 'witnessedAt', 'validUntil'] as const).flatMap((key) =>
        [0, 1, 2, 3, 4, 5, 6].map((at) => ({ ...valid, [key]: at })),
      ),
      ...fc.sample(
        fc.record({ observedAt: time, passObservedAt: time, completedAt: time, witnessedAt: time, validUntil: time }),
        { seed: 20261025, numRuns: 300 },
      ),
    ]
    expect(
      model(
        holds.map((h) => ({
          operation: 'holdCompletion',
          ...Object.fromEntries(Object.entries(h).map(([key, value]) => [key, String(value)])),
        })),
      ),
    ).toEqual(
      holds.map((h) =>
        holdCompletionSupported({
          observedAt: new Date(h.observedAt).toISOString(),
          passObservedAt: new Date(h.passObservedAt).toISOString(),
          completedAt: new Date(h.completedAt).toISOString(),
          witnessedAt: new Date(h.witnessedAt).toISOString(),
          validUntil: new Date(h.validUntil).toISOString(),
        }),
      ),
    )
  })
  test('every mutation transition and immutable outcome field agrees with the production admission and replay guards', () => {
    const transitions = Object.values(MutationEventType).flatMap((previous) =>
      Object.values(MutationEventType).map((next) => ({ previous, next })),
    )
    expect(model(transitions.map((pair) => ({ operation: 'mutationTransition', ...pair })))).toEqual(
      transitions.map((pair) => allowsOutcomeEvent(pair.previous, pair.next)),
    )
    const decode = Schema.decodeUnknownSync(MutationEventSchema)
    const base = decode({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: testHash('event'),
      mutationId: testHash('mutation'),
      intentId: testHash('intent'),
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      requestHash: testHash('request'),
      consistencyDelayMs: 1000,
      brokerOrderId: 'broker-order',
      requestId: 'request',
      responseStatus: 500,
      responseContentHash: testHash('response'),
      routing: {
        startedAt: '2026-10-25T14:30:00.000Z',
        requestDispatchedAt: '2026-10-25T14:30:00.500Z',
        completedAt: '2026-10-25T14:30:01.000Z',
      },
      denialReason: SubmissionDenialReason.Unclassified,
      occurredAt: '2026-10-25T14:30:01.000Z',
    })
    const variants = [
      base,
      ...Object.values(MutationEventType).map((eventType) => ({ ...base, eventType })),
      ...['requestId', 'responseStatus', 'responseContentHash', 'routing', 'denialReason', 'brokerOrderId'].map((key) =>
        decode(Object.fromEntries(Object.entries(base).filter(([field]) => field !== key))),
      ),
      ...[
        { requestId: 'different-request' },
        { responseStatus: 200 },
        { responseContentHash: testHash('different-response') },
        { denialReason: SubmissionDenialReason.ExpiredRiskDecision },
        { brokerOrderId: 'different-order' },
        { eventId: testHash('different-event'), sequence: 3, occurredAt: '2026-10-25T14:31:00.000Z' },
        { routing: { ...base.routing, startedAt: '2026-10-25T14:30:00.100Z' } },
        { routing: { ...base.routing, completedAt: '2026-10-25T14:30:01.100Z' } },
        { routing: { ...base.routing, requestDispatchedAt: '2026-10-25T14:30:00.750Z' } },
        { routing: { ...base.routing, requestDispatchedAt: null } },
      ].map((fields) => decode({ ...base, ...fields })),
    ]
    const encode = (event: typeof MutationEventSchema.Type) => ({
      eventType: event.eventType,
      requestId: event.requestId ?? null,
      responseStatus: event.responseStatus ?? null,
      responseContentHash: event.responseContentHash ?? null,
      denialReason: event.denialReason ?? null,
      brokerOrderId: event.brokerOrderId ?? null,
      routing:
        event.routing === undefined
          ? null
          : {
              startedAt: String(Date.parse(event.routing.startedAt)),
              completedAt: String(Date.parse(event.routing.completedAt)),
              requestDispatchedAt:
                event.routing.requestDispatchedAt === null
                  ? null
                  : String(Date.parse(event.routing.requestDispatchedAt)),
            },
    })
    const pairs = variants.flatMap((previous) => variants.map((next) => ({ previous, next })))
    expect(
      model(
        pairs.map((pair) => ({
          operation: 'mutationReplay',
          previous: encode(pair.previous),
          next: encode(pair.next),
        })),
      ),
    ).toEqual(pairs.map((pair) => sameMutationOutcome(pair.previous, pair.next)))
  })
  test('dispatch, persistence, quote freshness and admission deadlines agree at every boundary', () => {
    const valid = {
      decisionAt: 0,
      persistedAt: 1,
      routingStartedAt: 2,
      requestDispatchedAt: 3,
      quoteAvailableAt: 0,
      quoteFreshUntil: 4,
      submissionDeadlineAt: 5,
      filledAt: 4,
      expiresAt: 10,
    }
    const keys = [
      'decisionAt',
      'persistedAt',
      'routingStartedAt',
      'requestDispatchedAt',
      'quoteAvailableAt',
      'quoteFreshUntil',
      'submissionDeadlineAt',
      'filledAt',
      'expiresAt',
    ] as const
    const timestamp = fc.integer({ min: -10, max: 20 })
    const cases = [
      valid,
      ...keys.flatMap((key) => [-1, 0, 1, 2, 3, 4, 5, 10, 11].map((value) => ({ ...valid, [key]: value }))),
      ...fc.sample(
        fc.record({
          decisionAt: timestamp,
          persistedAt: timestamp,
          routingStartedAt: timestamp,
          requestDispatchedAt: timestamp,
          quoteAvailableAt: timestamp,
          quoteFreshUntil: timestamp,
          submissionDeadlineAt: timestamp,
          filledAt: timestamp,
          expiresAt: timestamp,
        }),
        { seed: 9151, numRuns: 300 },
      ),
    ]
    const { input } = supportedAssessmentFixture()
    const decision = input.realism.decisions[0]
    const fill = input.realism.fills[0]
    if (decision === undefined || fill === undefined) throw new Error('Missing conformance fixture')
    const at = (value: number) => new Date(Date.parse('2026-11-02T14:30:00.000Z') + value).toISOString()
    if (fill.pricing._tag !== 'SpotQuote') throw new Error('Expected spot pricing fixture')
    const quote = fill.pricing
    const sources = new Set([decision.snapshotHash, fill.sourceHash, quote.sourceHash])
    expect(
      model(
        cases.map((t) => ({
          operation: 'executionTiming',
          ...Object.fromEntries(keys.map((key) => [key, String(t[key])])),
          pricing: {
            kind: 'SpotQuote',
            source: quote.sourceHash,
            availableAt: String(t.quoteAvailableAt),
            freshUntil: String(t.quoteFreshUntil),
          },
          evidenceKind: ExecutionEvidenceKind.Broker,
          side: fill.side,
          verifiedSources: [...sources],
        })),
      ),
    ).toEqual(
      cases.map((t) => {
        const value = Result.getOrThrow(
          measureRealism(
            {
              expectedDecisionIds: [decision.decisionId],
              expectedFillIds: [fill.fillId],
              unsupportedAssumptions: [],
              decisions: [
                {
                  ...decision,
                  decisionAt: at(t.decisionAt),
                  persistedAt: at(t.persistedAt),
                  inputs: [{ contentHash: decision.snapshotHash, availableAt: at(-100) }],
                },
              ],
              fills: [
                {
                  ...fill,
                  kind: ExecutionEvidenceKind.Broker,
                  decisionId: decision.decisionId,
                  routingStartedAt: at(t.routingStartedAt),
                  requestDispatchedAt: at(t.requestDispatchedAt),
                  pricing: { ...quote, availableAt: at(t.quoteAvailableAt), freshUntil: at(t.quoteFreshUntil) },
                  submissionDeadlineAt: at(t.submissionDeadlineAt),
                  filledAt: at(t.filledAt),
                  expiresAt: at(t.expiresAt),
                },
              ],
            },
            sources,
          ),
        )
        return (
          !value.violations.some(
            (reason) =>
              reason.startsWith('PERSISTED_BEFORE_DECISION:') || reason.startsWith('INVALID_EXECUTION_TIMING:'),
          ) && !value.missing.some((reason) => reason.startsWith('MISSING_PRE_ROUTING_PERSISTENCE:'))
        )
      }),
    )
  })
  test('actual sizing, fee ceiling division and market order terms match the integer model', () => {
    const cases = fc.sample(
      fc.record({
        equity: fc.bigInt({ min: 0n, max: 10n ** 20n }),
        weight: fc.integer({ min: 0, max: 10000 }),
        price: fc.bigInt({ min: 1n, max: 10n ** 15n }),
        increment: fc.bigInt({ min: 1n, max: 10n ** 9n }),
      }),
      { seed: 971, numRuns: 200 },
    )
    expect(
      model(
        cases.map((c) => ({
          operation: 'sizing',
          equity: String(c.equity),
          weight: String(BigInt(c.weight) * 100000000n),
          price: String(c.price),
          increment: String(c.increment),
        })),
      ),
    ).toEqual(
      cases.map((c) =>
        String(
          Result.getOrThrow(
            desiredQuantityAtoms(c.equity, c.weight / 10000, c.price, {
              precision: {
                quantityIncrementAtoms: String(c.increment),
                priceIncrementMicros: '1',
                minimumBuyNotionalMicros: '1',
              },
            }),
          ),
        ),
      ),
    )
    expect(
      model(cases.map((c) => ({ operation: 'ceiling', value: String(c.equity), divisor: String(c.price) }))),
    ).toEqual(cases.map((c) => String(Result.getOrThrow(ceilDiv(c.equity, c.price)))))
    expect(
      model([
        { operation: 'orderTerms', equity: true },
        { operation: 'orderTerms', equity: false },
      ]),
    ).toEqual([cashSpotLimitTimeInForce(MarketKind.Equity), cashSpotLimitTimeInForce(MarketKind.Crypto)])
  })
  test('broker rounding and controller ownership agree at signed ties, stale epochs and counter exhaustion', () => {
    const amounts = fc.sample(fc.bigInt({ min: -(2n ** 120n), max: 2n ** 120n }), { seed: 3137, numRuns: 100 })
    amounts.push(-15000n, -5000n, -1n, 0n, 1n, 5000n, 15000n)
    const cases = amounts.flatMap((amount) =>
      (['1', '10', '100', '1000', '10000'] as const).map((quantum) => ({ amount: String(amount), quantum })),
    )
    expect(model(cases.map((c) => ({ operation: 'reportedCash', ...c })))).toEqual(
      cases.map((c) => reportedCashMicros(c.amount, c.quantum)),
    )
    const ticks = fc.sample(
      fc.record({
        present: fc.boolean(),
        active: fc.boolean(),
        epoch: fc.integer({ min: 1, max: 3 }),
        sequence: fc.constantFrom(0, 1, 2, Number.MAX_SAFE_INTEGER),
        tickEpoch: fc.integer({ min: 1, max: 3 }),
        tickSequence: fc.constantFrom(0, 1, 2, Number.MAX_SAFE_INTEGER),
        source: fc.constantFrom('a'.repeat(40), 'b'.repeat(40)),
        workerSource: fc.constantFrom('a'.repeat(40), 'b'.repeat(40)),
      }),
      { seed: 8711, numRuns: 500 },
    )
    expect(
      model(
        ticks.map((t) => ({
          operation: 'controllerTick',
          ...t,
          epoch: String(t.epoch),
          sequence: String(t.sequence),
          tickEpoch: String(t.tickEpoch),
          tickSequence: String(t.tickSequence),
        })),
      ),
    ).toEqual(
      ticks.map((t) => {
        const decision = decideExecutionControllerTick(
          t.present
            ? {
                schemaVersion: 1,
                active: t.active,
                epoch: t.epoch,
                nextSequence: t.sequence,
                initialSequence: 0,
                planHash: testHash('plan'),
                sourceRevision: t.source,
              }
            : null,
          { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: t.tickEpoch, sequence: t.tickSequence },
          testHash('controller'),
          '2026-11-02T14:30:00.000Z',
          t.workerSource,
        )
        return Result.isFailure(decision)
          ? decision.failure.reason
          : decision.success._tag === 'Advance'
            ? 'Advance'
            : decision.success.reason
      }),
    )
  })

  test('complete qualification and failed evidence, safety and reliability gates agree with Lean', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const unsafe = {
      ...input,
      safety: {
        ...input.safety,
        violations: [
          {
            kind: SafetyViolationKind.Unauthorized,
            sourceHash: input.safety.sourceHash,
            occurredAt: input.registration.calendar.sessions[0]?.openAt ?? '',
          },
        ],
      },
    }
    const failed = { ...input, reliability: { ...input.reliability, completions: [] } }
    const incompleteSources = new Set(verifiedSources)
    incompleteSources.delete(input.obligationCoverageHash)
    const shorter = supportedAssessmentFixture(7)
    const longer = supportedAssessmentFixture(21)
    const reports = [
      [input, verifiedSources],
      [unsafe, verifiedSources],
      [failed, verifiedSources],
      [input, incompleteSources],
      [shorter.input, shorter.verifiedSources],
      [longer.input, longer.verifiedSources],
    ].map(([data, sources]) => {
      if (!(sources instanceof Set)) throw new Error('Expected verified source set')
      return Result.getOrThrow(evaluateSystemAssessment(data, sources))
    })
    const micros = (usd: number) => String(Math.round(usd * 1_000_000))
    const lean = model(
      reports.map((report) => {
        const numerical = report.numerical
        if (numerical === null || !('metrics' in numerical)) throw new Error('Expected complete numerical fixture')
        return {
          operation: 'qualification',
          sessionCount: String(report.policies[0]?.sessions.length),
          netProfit: micros(numerical.metrics.netPnlUsd),
          bestControlProfit: micros(Math.max(...numerical.metrics.controlNetPnlUsd.map((c) => c.netPnlUsd))),
          profitLowerBoundTotal: micros(
            numerical.confidence.meanNetPnlUsdLowerBound * Number(report.policies[0]?.sessions.length),
          ),
          pairedLowerBoundTotals: numerical.confidence.paired.map((p) =>
            micros(p.meanIncrementalNetPnlUsdLowerBound * Number(report.policies[0]?.sessions.length)),
          ),
          profitWithoutBest: micros(numerical.metrics.netAfterDroppingBestSessionUsd),
          additionalCostProfit: micros(numerical.metrics.netAfterAdditionalCostUsd),
          latencyStressProfit: micros(numerical.metrics.p95LatencyStressNetPnlUsd),
          maximumSessionLoss: micros(numerical.metrics.maximumSessionLossUsd),
          maximumDrawdown: micros(numerical.metrics.maximumDrawdownUsd),
          completedEpisodes: String(numerical.metrics.completedEpisodes),
          filledNotional: micros(numerical.metrics.filledNotionalUsd),
          reliability: report.reliability.classes.map((c) => ({ good: c.correctOnTime, scheduled: c.scheduled })),
          safetyViolations: String(report.safety.violations.length),
          completeEvidence: report.evidenceComplete,
          supportedRealism: report.realism.status === 'SUPPORTED',
        }
      }),
    )
    expect(lean).toEqual(reports.map((report) => report.verdict === 'QUALIFIED_PAPER'))
    expect(lean).toEqual([true, false, false, false, false, true])
  })
  test('integer economics, reliability error budgets, and negative expectancy agree across languages', () => {
    const cash = fc
      .sample(
        fc.record({
          opening: fc.bigInt(),
          closing: fc.bigInt(),
          flows: fc.bigInt(),
          yield: fc.bigInt(),
          paid: fc.bigInt({ min: 0n, max: 10n ** 20n }),
        }),
        { seed: 9090, numRuns: 100 },
      )
      .map((row) => ({
        openingEquityMicros: String(row.opening),
        closingEquityMicros: String(row.closing),
        netExternalFlowsMicros: String(row.flows),
        passiveCashYieldMicros: String(row.yield),
        operatingCostsPaidFromAccountMicros: String(row.paid),
      }))
    expect(model(cash.map((row) => ({ operation: 'cashInventory', ...row })))).toEqual(
      cash.map(cashInventoryTradingPnl),
    )
    const amounts = fc
      .sample(
        fc.record({
          grossRealizedPnlMicros: fc.bigInt({ min: -(10n ** 22n), max: 10n ** 22n }),
          openingUnrealizedPnlMicros: fc.bigInt({ min: -10000000000n, max: 10000000000n }),
          closingUnrealizedPnlMicros: fc.bigInt({ min: -10000000000n, max: 10000000000n }),
          executionCostMicros: fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
          cashSettlementRoundingMicros: fc.bigInt({ min: -10000n, max: 10000n }),
          inferenceInvoiceMicros: fc.bigInt({ min: 0n, max: 10n ** 20n }),
          inferenceTariffMicros: fc.bigInt({ min: 0n, max: 10n ** 20n }),
          dataCostMicros: fc.bigInt({ min: 0n, max: 10n ** 20n }),
          infrastructureCostMicros: fc.bigInt({ min: 0n, max: 10n ** 20n }),
          researchCostMicros: fc.bigInt({ min: 0n, max: 10n ** 20n }),
        }),
        { seed: 20260921, numRuns: 200 },
      )
      .map((row) => ({
        grossRealizedPnlMicros: row.grossRealizedPnlMicros.toString(),
        openingUnrealizedPnlMicros: row.openingUnrealizedPnlMicros.toString(),
        closingUnrealizedPnlMicros: row.closingUnrealizedPnlMicros.toString(),
        executionCostMicros: row.executionCostMicros.toString(),
        cashSettlementRoundingMicros: row.cashSettlementRoundingMicros.toString(),
        inferenceInvoiceMicros: row.inferenceInvoiceMicros.toString(),
        inferenceTariffMicros: row.inferenceTariffMicros.toString(),
        dataCostMicros: row.dataCostMicros.toString(),
        infrastructureCostMicros: row.infrastructureCostMicros.toString(),
        researchCostMicros: row.researchCostMicros.toString(),
      }))
    const economics = amounts.map((row) => {
      const fixture = operatingCostFixture({
        ...row,
        netTradingPnlMicros: netTradingPnl({
          grossRealizedPnlMicros: row.grossRealizedPnlMicros.toString(),
          openingUnrealizedPnlMicros: row.openingUnrealizedPnlMicros.toString(),
          closingUnrealizedPnlMicros: row.closingUnrealizedPnlMicros.toString(),
          executionCostMicros: row.executionCostMicros.toString(),
          cashSettlementRoundingMicros: row.cashSettlementRoundingMicros.toString(),
        }).toString(),
      })
      const report = Result.getOrThrow(
        makeOperatingCostReport(fixture.inference, fixture.evidence, fixture.verifiedSources),
      )
      return {
        netTradingPnlMicros: report.netTradingPnlMicros,
        totalOperatingCostMicros: report.totalOperatingCostMicros,
        netEconomicPnlMicros: report.netEconomicPnlMicros,
        qualificationInferenceCostMicros: report.qualificationInferenceCostMicros,
        qualificationPnlMicros: report.qualificationPnlMicros,
      }
    })
    expect(model(amounts.map((row) => ({ operation: 'economics', ...row })))).toEqual(economics)
    const populations = [
      [0n, 0n],
      [1n, 1n],
      [998n, 999n],
      [999n, 1000n],
      [998n, 1000n],
      [999000n, 1000000n],
      [1n, 0n],
    ] as const
    expect(
      model(
        populations.map(([good, scheduled]) => ({
          operation: 'reliability',
          good: good.toString(),
          scheduled: scheduled.toString(),
        })),
      ),
    ).toEqual(populations.map(([good, scheduled]) => reliabilityFraction(good, scheduled)))
    const edge = {
      gainMicros: 2000000n,
      lossMicros: 1000000n,
      costMicros: 100000n,
      winProbabilityNumerator: 3n,
      winProbabilityDenominator: 10n,
    }
    expect(
      model([
        {
          operation: 'binaryEdge',
          ...Object.fromEntries(Object.entries(edge).map(([key, value]) => [key, value.toString()])),
        },
      ]),
    ).toEqual([Result.getOrThrow(binaryTradeEdge(edge))])
  })

  test('the registered-window paired bootstrap matches Lean for odd and even windows, losses and attempt tails', () => {
    for (const [sessionCount, attemptIndex] of [
      [1, 1],
      [3, 2],
      [7, 5],
      [19, 12],
      [20, 1],
      [20, 2],
      [20, 5],
      [20, 12],
      [21, 1],
      [25, 2],
    ]) {
      const { input } = assessmentFixture(registrationFixture(undefined, sessionCount))
      const series = [0, 1, 2, 3].map((policy) =>
        Array.from(
          { length: sessionCount },
          (_, day) => BigInt(250 + (day % 5) * 17 - policy * 100 - (day % 7 === 0 ? 450 : 0)) * 1_000_000n,
        ),
      )
      const acceptance = Schema.decodeUnknownSync(JevAcceptanceInputSchema)({
        schemaVersion: 'bayn.jev-acceptance-input.v1',
        protocolHash: input.registration.acceptanceProtocolHash,
        registration: {
          planHash: testHash(input.registration),
          lockedAt: input.registration.registeredAt,
          attemptIndex,
          sessions: input.registration.calendar.sessions,
        },
        policies: input.registration.policies.map((p, index) => {
          let equity = 100000
          return {
            policy: p.policy,
            definitionHash: testHash(p),
            sessions: input.registration.calendar.sessions.map((s, day) => {
              const pnl = Number(series[index]?.[day]) / 1_000_000
              const opening = equity
              equity += pnl
              return {
                status: 'COMPLETE',
                sessionDate: s.sessionDate,
                evidenceHash: testHash({ index, day }),
                completedEpisodes: 10,
                filledNotionalUsd: 100000,
                netPnlUsd: pnl,
                openingEquityUsd: opening,
                closingEquityUsd: equity,
                minimumEquityUsd: Math.min(opening, equity),
                maximumEquityUsd: Math.max(opening, equity),
                maximumDrawdownUsd: Math.max(0, -pnl),
                maximumMarkGapMs: 60000,
                p95LatencyStress: { status: 'COMPLETE', netPnlUsd: pnl, evidenceHash: testHash({ day, stress: true }) },
              }
            }),
          }
        }),
      })
      const ts = Result.getOrThrow(evaluateJevAcceptance(acceptance))
      expect(ts.verdict).not.toBe(JevNumericalVerdict.Inconclusive)
      if (!('confidence' in ts)) throw new Error('Missing numerical result')
      const [output] = model([
        {
          operation: 'bootstrap',
          candidate: series[0]?.map(String),
          controls: series.slice(1).map((s) => s.map(String)),
          attemptIndex: String(attemptIndex),
        },
      ])
      const lean = Schema.decodeUnknownSync(
        Schema.Struct({
          lowerProfitTotalMicros: Schema.String,
          lowerIncrementalTotalsMicros: Schema.Array(Schema.String),
        }),
      )(output)
      expect(ts.confidence.meanNetPnlUsdLowerBound).toBe(
        Number(lean.lowerProfitTotalMicros) / (sessionCount * 1_000_000),
      )
      expect(ts.confidence.paired.map((p) => p.meanIncrementalNetPnlUsdLowerBound)).toEqual(
        lean.lowerIncrementalTotalsMicros.map((n) => Number(n) / (sessionCount * 1_000_000)),
      )
    }
  })
})

formal('native protection order conformance', () => {
  test('spot and conditional pricing require causal verified sources and native broker authority', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const decision = input.realism.decisions[0]!
    const fill = input.realism.fills[0]!
    const source = testHash('pricing basis')
    const capacity = testHash('pricing capacity')
    const origin = Date.parse('2026-11-02T14:30:00.000Z')
    const at = (offset: number) => new Date(origin + offset).toISOString()
    const inputs: unknown[] = []
    const expected: boolean[] = []
    for (const kind of ['SpotQuote', 'NativeProtection', 'ReconciledLiquidation'] as const)
      for (const evidenceKind of [ExecutionEvidenceKind.Broker, ExecutionEvidenceKind.Model])
        for (const side of [OrderSide.Buy, OrderSide.Sell])
          for (const available of [-1, 0, 2, 3, 4])
            for (const fresh of [2, 4])
              for (const verified of [false, true]) {
                const sources = new Set([...verifiedSources, capacity, ...(verified ? [source] : [])])
                const pricing =
                  kind === 'SpotQuote'
                    ? {
                        _tag: kind,
                        sourceHash: source,
                        availableAt: at(available),
                        freshUntil: at(fresh),
                        bidPriceAtoms: fill.fillPriceAtoms,
                        askPriceAtoms: fill.fillPriceAtoms,
                      }
                    : { _tag: kind, sourceHash: source, availableAt: at(available) }
                const actual = Result.getOrThrow(
                  measureRealism(
                    {
                      expectedDecisionIds: [decision.decisionId],
                      expectedFillIds: [fill.fillId],
                      unsupportedAssumptions: [],
                      decisions: [
                        {
                          ...decision,
                          decisionAt: at(0),
                          persistedAt: at(1),
                          inputs: [{ contentHash: decision.snapshotHash, availableAt: at(-10) }],
                        },
                      ],
                      fills: [
                        {
                          ...fill,
                          pricing,
                          side,
                          kind: evidenceKind,
                          limitPriceAtoms: fill.fillPriceAtoms,
                          supportedCapacityAtoms: fill.requestedQuantityAtoms,
                          capacitySourceHash: capacity,
                          routingStartedAt: at(2),
                          requestDispatchedAt: at(3),
                          submissionDeadlineAt: at(5),
                          filledAt: at(4),
                          expiresAt: at(10),
                        },
                      ],
                    },
                    sources,
                  ),
                )
                expected.push(actual.status === 'SUPPORTED')
                inputs.push({
                  operation: 'executionTiming',
                  decisionAt: '0',
                  persistedAt: '1',
                  routingStartedAt: '2',
                  requestDispatchedAt: '3',
                  submissionDeadlineAt: '5',
                  filledAt: '4',
                  expiresAt: '10',
                  evidenceKind,
                  side,
                  verifiedSources: [...sources],
                  pricing: {
                    kind,
                    source,
                    availableAt: String(available),
                    ...(kind === 'SpotQuote' ? { freshUntil: String(fresh) } : {}),
                  },
                })
              }
    expect(model(inputs)).toEqual(expected)
    expect(expected.some(Boolean)).toBe(true)
    expect(expected.some((value) => !value)).toBe(true)
  })

  test('independent protection reproduces raw ownership, approval, prices and freshness in both native markets', async () => {
    const documents = [
      await Effect.runPromise(persistenceDocumentFixture),
      await Effect.runPromise(cryptoPersistenceDocumentFixture),
    ]
    const inputs: unknown[] = []
    const expected: boolean[] = []
    const reseal = (e: ProtectionIntentEvidence): ProtectionIntentEvidence => {
      const intentId = Result.getOrThrow(executionIntentIdForDecodedPlan(e.plan, e.authorityGenerationHash))
      const { decisionId: _risk, ...risk } = { ...e.riskDecision, intentId, policyHash: e.plan.policyHash }
      const { sourceHash: _hash, ...material } = {
        ...e,
        intentId,
        clientOrderId: clientOrderIdForIntentId(intentId),
        riskDecision: { ...risk, decisionId: testHash(risk) },
      }
      return { ...material, sourceHash: testHash(material) }
    }
    for (const document of documents) {
      for (const kind of document.targetPlan.intentTargets[0]!.symbol.includes('/')
        ? (['StopLimit'] as const)
        : (['Oco', 'StopLimit'] as const)) {
        const f = replacementProtectionFixture(document, kind)
        const e = f.evidence
        const at = f.at
        const cases = [
          e,
          ...[
            { ...e, authorityGenerationHash: testHash('foreign') },
            ...Object.entries({
              accountId: 'foreign',
              cycleId: testHash('foreign'),
              decisionHash: testHash('foreign'),
              policyHash: testHash('foreign'),
              strategyName: 'foreign',
              symbol: 'SPY',
              side: OrderSide.Buy,
              quantityAtoms: (BigInt(e.plan.quantityAtoms) + 1n).toString(),
              limitPriceMicros: (BigInt(e.plan.limitPriceMicros!) + 1000n).toString(),
            }).map(([field, value]) => ({ ...e, plan: { ...e.plan, [field]: value } })),
            ...[-1, 0, 999, 1000, 1002].map((offset) => ({ ...e, plan: { ...e.plan, createdAt: at(offset) } })),
            ...[0, 999, 1000, 1001, 200000].map((offset) => ({
              ...e,
              riskDecision: { ...e.riskDecision, decidedAt: at(offset) },
            })),
            ...[1000, 1001, 1002, 121001, 121002].map((offset) => ({
              ...e,
              riskDecision: { ...e.riskDecision, expiresAt: at(offset) },
            })),
          ].map(reseal),
          { ...e, sourceHash: testHash('foreign') },
          { ...e, intentId: testHash('foreign') },
          { ...e, clientOrderId: 'foreign' },
          { ...e, riskDecision: { ...e.riskDecision, decisionId: testHash('foreign') } },
        ]
        for (const evidence of cases) {
          const plan = evidence.plan
          const terms = plan.protection!
          if (terms._tag === 'Bracket') throw new Error('Expected independent protection')
          const decision = document.strategyDecision
          if (decision === undefined || !('exitPolicy' in decision)) throw new Error('Expected sealed entry')
          const entryPlan = decision.exitPolicy.plans[f.parent.symbol]!
          const owner = {
            account: document.bindings.accountId,
            cycle: document.bindings.cycleId,
            decision: document.bindings.strategyDecisionHash,
            policy: document.bindings.policyHash,
            strategy: document.bindings.strategyName,
            generation: document.bindings.authorityGenerationHash,
            entry: document.contentHash,
            symbol: f.parent.symbol,
          }
          const { sourceHash: _source, ...sourceMaterial } = evidence
          const { decisionId: _risk, ...risk } = evidence.riskDecision
          const { contentHash: _hash, reconciliationId: _id, ...reconciliation } = evidence.reconciliation
          inputs.push({
            operation: 'protectionIntent',
            entry: {
              owner,
              dispatchable: document.dispatchable,
              maximumQuantity: entryPlan.maximumQuantityAtoms,
              stop: entryPlan.levels.stopPriceMicros,
              stopLimit: entryPlan.levels.stopLimitPriceMicros,
              profit: entryPlan.levels.profitLimitPriceMicros,
              createdAt: String(Date.parse(document.createdAt)),
              maximumBrokerAge: String(document.riskPolicy!.maxBrokerStateAgeMs),
              maximumRiskTtl: String(document.riskPolicy!.decisionTtlMs),
            },
            evidence: {
              owner: {
                account: plan.accountId,
                cycle: plan.cycleId,
                decision: plan.decisionHash,
                policy: plan.policyHash,
                strategy: plan.strategyName,
                generation: evidence.authorityGenerationHash,
                entry: terms.entryDecisionHash,
                symbol: plan.symbol,
              },
              sourceHash: evidence.sourceHash,
              expectedSourceHash: testHash(sourceMaterial),
              intent: evidence.intentId,
              expectedIntent: Result.getOrThrow(
                executionIntentIdForDecodedPlan(plan, evidence.authorityGenerationHash),
              ),
              client: evidence.clientOrderId,
              expectedClient: clientOrderIdForIntentId(evidence.intentId),
              riskId: evidence.riskDecision.decisionId,
              expectedRiskId: testHash(risk),
              riskIntent: evidence.riskDecision.intentId,
              riskPolicy: evidence.riskDecision.policyHash,
              riskOutcome: evidence.riskDecision.outcome,
              reconciliationId: evidence.reconciliation.reconciliationId,
              expectedReconciliationId: testHash({
                schemaVersion: 'bayn.paper-reconciliation-id.v1',
                material: reconciliation,
              }),
              reconciliationHash: evidence.reconciliation.contentHash,
              expectedReconciliationHash: testHash({
                ...reconciliation,
                reconciliationId: evidence.reconciliation.reconciliationId,
              }),
              reconciliationAccount: evidence.reconciliation.accountId,
              reconciliationStatus: evidence.reconciliation.status,
              replan: plan.replanGenerationHash,
              expectedReplan: testHash({
                entryDecisionHash: document.contentHash,
                reconciliationId: evidence.reconciliation.reconciliationId,
                protection: terms,
              }),
              side: plan.side,
              kind: terms._tag,
              orderType: plan.orderType,
              timeInForce: plan.timeInForce,
              quantity: plan.quantityAtoms,
              limitPrice: plan.limitPriceMicros,
              stop: terms.stopPriceMicros,
              stopLimit: terms._tag === 'Oco' ? terms.stopLimitPriceMicros : '0',
              profit: terms._tag === 'Oco' ? terms.profitLimitPriceMicros : '0',
              createdAt: String(Date.parse(plan.createdAt)),
              decidedAt: String(Date.parse(evidence.riskDecision.decidedAt)),
              expiresAt: String(Date.parse(evidence.riskDecision.expiresAt)),
              reconciledAt: String(Date.parse(evidence.reconciliation.reconciledAt)),
            },
          })
          const actual = executionOrderPlans(f.cut.decisions, [evidence])
          expected.push(Result.isSuccess(actual))
          if (Result.isSuccess(actual)) {
            const bound = actual.success.get(evidence.intentId)!
            expect(bound.decisionId).toBe(evidence.intentId)
            expect(bound.createdAt).toBe(evidence.riskDecision.decidedAt)
            expect(bound.submissionDeadlineAt).toBe(evidence.riskDecision.expiresAt)
          }
        }
      }
    }
    expect(model(inputs)).toEqual(expected)
    expect(expected.filter(Boolean).length).toBeGreaterThan(0)
    expect(expected.filter((value) => !value).length).toBeGreaterThan(0)
  }, 30000)

  type Receipt = SystemSourceCut['orders'][number]
  const leanReceipt = (row: Receipt) => ({
    owner: {
      intent: row.intentId,
      decision: row.decisionId,
      generation: row.authorityGenerationHash,
      account: row.order.accountId,
      symbol: row.order.symbol,
    },
    orderIntent: row.order.intentId ?? null,
    brokerId: row.order.brokerOrderId,
    clientId: row.order.clientOrderId,
    parentId: row.order.parentBrokerOrderId ?? null,
    side: row.order.side,
    orderType: row.order.orderType,
    timeInForce: row.order.timeInForce,
    quantity: row.order.quantityAtoms ?? null,
    notional: row.order.notionalMicros ?? null,
    limitPrice: row.order.limitPriceMicros ?? null,
    stopPrice: row.order.stopPriceMicros ?? null,
  })
  const leanTarget = (plan: ExecutionOrderPlan) => {
    const { document, target, risk } = plan
    const protection = risk.protection
    return {
      owner: {
        intent: plan.intentId,
        decision: plan.decisionId,
        generation: document.bindings.authorityGenerationHash,
        account: document.bindings.accountId,
        symbol: target.symbol,
      },
      side: target.side,
      orderType: target.orderType,
      timeInForce: target.timeInForce,
      quantity: target.quantityAtoms,
      limitPrice: risk.limitPriceMicros,
      protection:
        protection === undefined
          ? { kind: 'NONE' }
          : protection._tag === 'StopLimit'
            ? { kind: protection._tag, trigger: protection.stopPriceMicros }
            : {
                kind: protection._tag,
                trigger: protection.stopPriceMicros,
                limit: protection.stopLimitPriceMicros,
                profit: protection.profitLimitPriceMicros,
              },
    }
  }
  test('raw normalized orders reproduce sealed native groups, ownership and fractional residuals', async () => {
    const document = await Effect.runPromise(persistenceDocumentFixture)
    const f = bracketEvidenceFixture(document)
    const root = f.cut.orders[0]!
    const children = f.cut.orders.slice(1)
    const cases: { id: string; root: Receipt; children: readonly Receipt[]; document: ExecutionDecisionDocument }[] = []
    const addGroup = (root: Receipt, children: readonly Receipt[], document: ExecutionDecisionDocument) => {
      for (const id of [root.order.brokerOrderId, ...children.map((row) => row.order.brokerOrderId), 'absent'])
        cases.push({ id, root, children, document })
    }
    for (const legs of [
      children,
      [...children].reverse(),
      children.slice(0, 1),
      children.slice(1),
      [],
      [...children, children[0]!],
    ])
      addGroup(root, legs, document)
    const orderPatches: readonly { [K in keyof Receipt['order']]?: Receipt['order'][K] | undefined }[] = [
      { quantityAtoms: '1' },
      { quantityAtoms: f.parent.quantityAtoms! },
      { quantityAtoms: '99999999999999999999' },
      { quantityAtoms: undefined },
      { limitPriceMicros: '1' },
      { stopPriceMicros: '1' },
      { stopPriceMicros: undefined },
      { accountId: 'foreign' },
      { symbol: 'AMZN' },
      { intentId: testHash('foreign') },
      { intentId: undefined },
      { parentBrokerOrderId: 'unknown' },
      { parentBrokerOrderId: undefined },
      { side: OrderSide.Buy },
      { side: OrderSide.Sell },
      { timeInForce: TimeInForce.GoodUntilCanceled },
      { orderType: OrderType.Limit },
      { orderType: OrderType.StopLimit },
      { notionalMicros: '1' },
      { clientOrderId: children[0]!.order.clientOrderId },
      { brokerOrderId: root.order.brokerOrderId },
    ]
    const rows = [root, ...children]
    for (let index = 0; index < rows.length; index++) {
      for (const patch of orderPatches) {
        const parsed = Schema.decodeUnknownResult(OrderSchema)(
          Object.fromEntries(
            Object.entries({ ...rows[index]!.order, ...patch }).filter(([, value]) => value !== undefined),
          ),
        )
        if (Result.isFailure(parsed)) continue
        const changed = rows.map((row, i) => (i === index ? { ...row, order: parsed.success } : row))
        addGroup(changed[0]!, changed.slice(1), document)
      }
      for (const patch of [
        { intentId: testHash('foreign') },
        { decisionId: testHash('foreign') },
        { authorityGenerationHash: testHash('foreign') },
      ]) {
        const changed = rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
        addGroup(changed[0]!, changed.slice(1), document)
      }
    }
    const risk = document.deltaRisk[0]!
    const { protection: _protection, ...unprotectedRisk } = risk
    if (document.targetPlan.status !== 'PLANNED') throw new Error('Expected native target plan')
    const target = document.targetPlan.intentTargets[0]!
    for (const kind of ['NONE', 'StopLimit', 'Oco'] as const) {
      const protection =
        kind === 'NONE'
          ? undefined
          : kind === 'StopLimit'
            ? { _tag: kind, stopPriceMicros: f.terms.stopPriceMicros, entryDecisionHash: document.contentHash }
            : { ...f.terms, _tag: kind, entryDecisionHash: document.contentHash }
      const isStop = kind === 'StopLimit'
      const limit =
        kind === 'Oco' ? f.terms.profitLimitPriceMicros : isStop ? f.terms.stopLimitPriceMicros : risk.limitPriceMicros
      const side = kind === 'NONE' ? target.side : OrderSide.Sell
      const orderType = isStop ? OrderType.StopLimit : target.orderType
      const timeInForce = isStop ? TimeInForce.GoodUntilCanceled : target.timeInForce
      const variant: ExecutionDecisionDocument = {
        ...document,
        targetPlan: { ...document.targetPlan, intentTargets: [{ ...target, side, orderType, timeInForce }] },
        deltaRisk: [
          { ...unprotectedRisk, limitPriceMicros: limit, ...(protection === undefined ? {} : { protection }) },
        ],
      }
      const parent = {
        ...root,
        order: {
          ...root.order,
          side,
          orderType,
          timeInForce,
          limitPriceMicros: limit,
          ...(isStop ? { stopPriceMicros: f.terms.stopPriceMicros } : {}),
        },
      }
      addGroup(parent, kind === 'Oco' ? [children[1]!] : [], variant)
      addGroup(parent, children, variant)
    }
    const output = model(
      cases.map((row) => ({
        operation: 'nativeOrderGroup',
        id: row.id,
        root: leanReceipt(row.root),
        children: row.children.map(leanReceipt),
        target: leanTarget(Result.getOrThrow(orderedExecutionPlan(row.document, 0))),
      })),
    )
    const expected = cases.map((row) => {
      const result = resolveExecutionOrderTerms(
        row.id,
        row.root,
        row.children,
        Result.getOrThrow(orderedExecutionPlan(row.document, 0)),
      )
      if (Result.isFailure(result)) return { status: 'INVALID' }
      if (result.success._tag === 'Missing') return { status: 'MISSING' }
      return {
        status: 'BOUND',
        quantity: result.success.quantityAtoms,
        limitPrice: result.success.limitPriceMicros,
        protection: result.success.protection,
      }
    })
    expect(output).toEqual(expected)
    expect(expected.some((row) => row.status === 'BOUND')).toBe(true)
    expect(expected.some((row) => row.status === 'MISSING')).toBe(true)
    expect(expected.some((row) => row.status === 'INVALID')).toBe(true)
  }, 30000)

  test('independently approved OCO and fractional GTC stop groups conform from raw broker fields', async () => {
    const documents = [
      await Effect.runPromise(persistenceDocumentFixture),
      await Effect.runPromise(cryptoPersistenceDocumentFixture),
    ]
    const inputs: unknown[] = []
    const expected: unknown[] = []
    for (const document of documents)
      for (const kind of document.targetPlan.intentTargets[0]!.symbol.includes('/')
        ? (['StopLimit'] as const)
        : (['Oco', 'StopLimit'] as const)) {
        const f = replacementProtectionFixture(document, kind)
        const plan = Result.getOrThrow(executionOrderPlans(f.cut.decisions, f.cut.protectionIntents)).get(
          f.evidence.intentId,
        )!
        const rows = f.cut.orders.filter((row) => row.intentId === plan.intentId)
        const original = rows[0]!
        for (const patch of [
          {},
          { decisionId: document.contentHash },
          { intentId: testHash('foreign') },
          { authorityGenerationHash: testHash('foreign') },
          { order: { ...original.order, quantityAtoms: (BigInt(original.order.quantityAtoms!) + 1n).toString() } },
          { order: { ...original.order, limitPriceMicros: '1' } },
          { order: { ...original.order, stopPriceMicros: '1' } },
          { order: { ...original.order, timeInForce: TimeInForce.ImmediateOrCancel } },
        ]) {
          const root = { ...original, ...patch }
          for (const children of [rows.slice(1), []])
            for (const id of [root.order.brokerOrderId, ...children.map((row) => row.order.brokerOrderId), 'missing']) {
              inputs.push({
                operation: 'nativeOrderGroup',
                id,
                root: leanReceipt(root),
                children: children.map(leanReceipt),
                target: leanTarget(plan),
              })
              const result = resolveExecutionOrderTerms(id, root, children, plan)
              expected.push(
                Result.isFailure(result)
                  ? { status: 'INVALID' }
                  : result.success._tag === 'Missing'
                    ? { status: 'MISSING' }
                    : {
                        status: 'BOUND',
                        quantity: result.success.quantityAtoms,
                        limitPrice: result.success.limitPriceMicros,
                        protection: result.success.protection,
                      },
              )
            }
        }
      }
    expect(model(inputs)).toEqual(expected)
    expect(expected).toContainEqual(expect.objectContaining({ status: 'BOUND' }))
    expect(expected).toContainEqual({ status: 'INVALID' })
    expect(expected).toContainEqual({ status: 'MISSING' })
  }, 30000)

  test('actual bracket binding follows the chronological shared disposal budget across both legs', async () => {
    const document = await Effect.runPromise(persistenceDocumentFixture)
    const f = bracketEvidenceFixture(document)
    const inputs: { operation: string; available: string; disposed: string; quantity: string }[] = []
    const cases: { leanStart: number; leanEnd: number; accepted: boolean }[] = []
    const amounts = [1n, 500000000n, 1000000000n, BigInt(f.parent.quantityAtoms!)]
    for (const entry of amounts)
      for (const profit of amounts)
        for (const stop of amounts)
          for (const early of [false, true]) {
            const path = [
              { order: f.parent, quantity: entry, price: f.parent.limitPriceMicros!, offset: early ? 30 : 10 },
              { order: f.profit, quantity: profit, price: f.terms.profitLimitPriceMicros, offset: 20 },
              { order: f.stop, quantity: stop, price: f.terms.stopLimitPriceMicros, offset: 40 },
            ].sort((a, b) => a.offset - b.offset)
            let available = 0n
            let disposed = 0n
            const leanStart = inputs.length
            for (const row of path) {
              if (row.order.side === OrderSide.Buy) available += row.quantity
              else {
                inputs.push({
                  operation: 'protectiveDisposalBudget',
                  available: available.toString(),
                  disposed: disposed.toString(),
                  quantity: row.quantity.toString(),
                })
                disposed += row.quantity
              }
            }
            const fills = path.map((row, index) => ({
              sourceSequence: String(index + 1),
              fillId: testHash(row.offset),
              brokerOrderId: row.order.brokerOrderId,
              intentId: f.cut.fills[0]!.intentId,
              decisionId: document.contentHash,
              sourceHash: testHash({ ...row, quantity: row.quantity.toString() }),
              side: row.order.side,
              quantityAtoms: row.quantity.toString(),
              priceAtoms: (BigInt(row.price) * 1000n).toString(),
              occurredAt: f.at(row.offset),
            }))
            const supplied = fills.map((fill) => ({
              ...f.supplied[0]!,
              fillId: fill.fillId,
              sourceHash: fill.sourceHash,
              orderId: fill.brokerOrderId,
              side: fill.side,
              fillQuantityAtoms: fill.quantityAtoms,
              fillPriceAtoms: fill.priceAtoms,
              filledAt: fill.occurredAt,
            }))
            const orders = f.cut.orders.map((row) => {
              const material = {
                eventId: row.eventId,
                occurredAt: row.occurredAt,
                order: { ...row.order, status: OrderStatus.PartiallyFilled, quantityAtoms: f.parent.quantityAtoms! },
              }
              return { ...row, ...material, sourceHash: testHash(material) }
            })
            const result = bindExecutionEvidence(
              supplied,
              { ...f.cut, fills, orders },
              document.bindings.authorityGenerationHash,
            )
            cases.push({ leanStart, leanEnd: inputs.length, accepted: Result.isSuccess(result) })
          }
    const budgets = model(inputs)
    expect(cases.map((row) => budgets.slice(row.leanStart, row.leanEnd).every((result) => result === true))).toEqual(
      cases.map((row) => row.accepted),
    )
    expect(cases.some((row) => row.accepted)).toBe(true)
    expect(cases.some((row) => !row.accepted)).toBe(true)
  }, 30000)
})
