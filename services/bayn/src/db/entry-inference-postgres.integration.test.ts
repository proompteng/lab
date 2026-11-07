import jevBoxInference from '../../migrations/0187_jev_box_inference'
import { retainedJevProtocolV39Document } from '../jev/protocol'
import effectiveEntryAllowanceInput from '../../migrations/0184_effective_entry_allowance_input'
import webullEntryContext from '../../migrations/0178_webull_entry_context'
import expenseSourceQueue from '../../migrations/0173_inference_expense_source_queue'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import jevOnlyInference from '../../migrations/0172_jev_only_inference'
import datedExecutionFees from '../../migrations/0171_dated_execution_fees'
import * as observedChartStages from '../jev/retained-observed-staged-chart-questions'
import { retainedIntradayExecutionModel } from '../strategy/intraday-market'
import candidateEntryEvidence from '../../migrations/0166_candidate_entry_evidence'
import chartStructureBeforeFunding from '../../migrations/0167_chart_structure_before_funding'
import observedResistance from '../../migrations/0165_observed_resistance'
import * as retainedCandidateChartStages from '../jev/retained-candidate-staged-chart-questions'
import {
  jevProtocolSchemaForQuestionPolicy,
  RetainedJevProtocolV30Schema,
  RetainedJevProtocolV31Schema,
  RetainedJevProtocolV32Schema,
  RetainedJevProtocolV33Schema,
  RetainedJevProtocolV34Schema,
  RetainedJevProtocolV35Schema,
  RetainedJevProtocolV36Schema,
} from '../jev/protocol'
import * as retainedChartStages from '../jev/retained-filtered-staged-chart-questions'
import focusedEntryEvidence from '../../migrations/0164_focused_entry_evidence'
import equityBenchmarkContext from '../../migrations/0162_equity_benchmark_context'
import cryptoHistoryContext from '../../migrations/0161_crypto_history_context'
import { evaluateAdmittedFixture } from '../jev/evaluation.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import cryptoQuoteEvidence from '../../migrations/0160_crypto_quote_evidence'
import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import equityEntryAskCap from '../../migrations/0158_equity_entry_ask_cap'
import marketEntryQuestions from '../../migrations/0154_market_entry_questions'
import cryptoEntryAskCap from '../../migrations/0157_crypto_entry_ask_cap'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { PgMigrator } from '@effect/sql-pg'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import sequentialEntryInference from '../../migrations/0147_sequential_entry_inference'
import relativeChartVolume from '../../migrations/0148_relative_chart_volume'
import conditionalBaseAnchors from '../../migrations/0149_conditional_base_anchors'
import inferenceRequestVersion from '../../migrations/0150_inference_request_version'
import chartDispatchCheckpoints from '../../migrations/0151_chart_dispatch_checkpoints'

import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { EntryInferenceJournal, type EntryHandoff } from '../jev/entry-inference'
import { makeChartDispatchClaim, makeChartTerminalReceipt } from '../jev/chart-checkpoint'
import {
  makeFundedEvaluationRequest,
  entryCompletionFixture as fundedCompletionFixture,
  chartInferenceFixture as fundedChartInferenceFixture,
  makeFundedEvaluationReceipt,
} from '../jev/funded-entry.test-support'
import {
  nativeChartInference,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from '../jev/entry-inference.test-support'
import { makeStagedDispatchClaim, makeStagedTerminalReceipt } from '../jev/staged-checkpoint'
import stagedChartTransport from '../../migrations/0153_staged_chart_transport'
import {
  retainedStagedQuestionPolicyHash,
  retainedMarketQuestionPolicyHash,
} from '../jev/staged-inference-cost-evidence'
import { JevClient } from '../jev/client'
import { prepareJevRequest } from '../jev/contract'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevEvaluationStore, type JevDispatch } from '../jev/evaluation'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevPurpose } from '../jev/portfolio'
import { makeNativeChartEvidence } from '../jev/chart-evidence'
import { makeInitialChartStageRequest } from '../jev/staged-chart-questions'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import {
  entryCompletionFixture as conditionalCompletionFixture,
  makeConditionalEvaluationReceipt,
} from '../jev/conditional-entry.test-support'
import {
  decodeConditionalEvaluationRequest,
  retainedConditionalQuestionPolicyHash,
} from '../jev/sequential-inference-cost-evidence'
import { verifyEntryInferenceSource } from '../jev/entry-inference-input'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { nativeJevFixture, nativeJevInference } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { reconstructRetainedJevTradingSignalBatch } from '../jev/retained-jev-trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { postgresMigrations } from './postgres-migrations'
import { migrationLoader } from './migrations'
import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes, buildInferenceExpensePlan } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { formalModelExecutable, runFormalModel } from '../system-assessment/formal-model.test-support'
import { IsoDateSchema } from '../schemas'
import { StagedDispatchClaimSchema, type StagedDispatchClaim } from '../jev/staged-checkpoint'
import { InferenceStage, InferenceUsageStatus } from '../inference-costs'
import { JevFailure } from '../jev/contract'
import { runInferenceExpensePass } from '../inference-expense-runtime'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { acquireInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Authority } from '../execution/contracts'
import { makeAuthorityPostgres } from './execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from './execution-store/observe-authority'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://localhost/bayn_sequential_entry_0391_test'
const replaySourceHash = 'e'.repeat(64)
const replayAccountId = `replay-${replaySourceHash}`
const fixture = nativeJevFixture(undefined, undefined, replayAccountId)
const batch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: new Date(
      Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const candidate = batch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing native entry request')
const request = candidate.request
const completion = entryCompletionFixture(request)
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v3',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: { status: JevOutcome.Completed, completion },
  }),
)
const conditionalInput = {
  ...request.request,
  numericalState: { ...request.request.numericalState, schemaVersion: 'bayn.jev-entry-state.v22' },
  schemaVersion: 'bayn.entry-inference-input.v3' as const,
  protocol: {
    ...retainedJevProtocolV39Document,
    executionModel: retainedIntradayExecutionModel,
    schemaVersion: 'bayn.jev.protocol.v24' as const,
    entrySignalPolicy: 'openai-decisions-then-jev' as const,
    inputDefinition: 'bayn.jev-entry-state.v22' as const,
    lookbackMinutes: 30 as const,
    entryQuestionPolicyHash: retainedConditionalQuestionPolicyHash,
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
  },
}
const { requestId: _currentId, ...currentMaterial } = request
const conditionalMaterial = {
  ...currentMaterial,
  schemaVersion: 'bayn.jev-evaluation-request.v2' as const,
  request: conditionalInput,
  requestHash: Result.getOrThrow(verifyEntryInferenceSource(conditionalInput)).requestHash,
}
const conditionalRequest = Result.getOrThrow(
  decodeConditionalEvaluationRequest({
    ...conditionalMaterial,
    requestId: Result.getOrThrow(canonicalHashV1Result(conditionalMaterial)),
  }),
)
const conditionalCompletion = conditionalCompletionFixture(conditionalRequest)
const conditionalReceipt = Result.getOrThrow(
  makeConditionalEvaluationReceipt(conditionalRequest, {
    startedAt: conditionalRequest.observedAt,
    completedAt: conditionalRequest.observedAt,
    outcome: { status: 'COMPLETED', completion: conditionalCompletion },
  }),
)
const runtimeLayer = Layer.mergeAll(
  CycleStoreLive,
  CandidateObservationStoreLive,
  JevBatchStoreLive,
  JevEvaluationStoreLive,
  EntryInferenceJournalLive,
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })),
  Layer.provideMerge(NodeServices.layer),
)
const makeRuntime = () => ManagedRuntime.make(runtimeLayer)
const defaultRequest = request
const replayFixture = fixture
const replayBatch = batch
const expiredFixture = nativeJevFixture(undefined, undefined, `replay-${'c'.repeat(64)}`)
const expiredBatch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: expiredFixture.observation.payload,
    expiresAt: new Date(
      Date.parse(expiredFixture.observation.payload.observedAt) + expiredFixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const expiredCandidate = expiredBatch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
if (expiredCandidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing real expired request')
const expiredRequest = expiredCandidate.request
const retainCheckpoint = (current: typeof request) =>
  Effect.gen(function* () {
    const journal = yield* EntryInferenceJournal
    const checkpoint = stagedCheckpointFixture(current)
    for (const claim of checkpoint.claims) {
      yield* persistVisualClaimFixture(journal, claim)
      const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
      if (terminal !== undefined)
        yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
    }
  })
const retainReplayDispatch = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  // Native fixtures intentionally reuse synthetic reconciliation identities; keep the replay graph isolated.
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
  const selected = replayBatch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
  if (selected?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing replay entry request')
  const current = selected.request
  yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
    VALUES (${replayAccountId},${replaySourceHash},${current.observedAt})`
  yield* (yield* CycleStore).acquire(replayFixture.draft, current.observedAt)
  yield* sql`INSERT INTO authority_generations (generation_hash,schema_version,maximum,authority_version,activated_at)
    VALUES (${current.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${current.observedAt})
    ON CONFLICT (generation_hash) DO NOTHING`
  const r = replayFixture.portfolio.brokerState.reconciliation
  yield* sql`INSERT INTO reconciliations (reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
    VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${r.expectedHash},${r.observedHash},${r.contentHash},${r.status},'[]'::jsonb,${r.reconciledAt})`
  yield* (yield* CandidateObservationStore).record(replayFixture.observation)
  const admission = yield* TestClock.setTime(Date.parse(current.observedAt)).pipe(
    Effect.andThen(
      Effect.flatMap(JevBatchStore, (store) => store.begin(replayBatch, replayFixture.observation.payload)),
    ),
    Effect.provide(TestClock.layer()),
  )
  const dispatch = admission.dispatches.find((entry) => entry.request.requestId === current.requestId)
  if (dispatch === undefined) throw new Error('Missing initial replay admission')
  return dispatch
})
const retainReplayRequest = retainReplayDispatch.pipe(Effect.map((dispatch) => dispatch.request))

integration('committed sequential provider handoff', () => {
  let runtime: ReturnType<typeof makeRuntime>
  let initialDispatch: JevDispatch | undefined
  beforeAll(() => {
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Provider handoff tests require an isolated local _test database')
    runtime = makeRuntime()
  })
  afterAll(async () => runtime?.dispose())
  const resetDatabase = async (
    withRequestVersion = true,
    fixture = replayFixture,
    request = defaultRequest,
    batch = replayBatch,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        if (withRequestVersion) yield* postgresMigrations
        else
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 150))),
            table: 'schema_migrations',
          })
        if (!withRequestVersion) yield* chartDispatchCheckpoints
        const accountId = fixture.portfolio.brokerState.account.accountId
        if (accountId.startsWith('replay-'))
          yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
            VALUES (${accountId},${accountId.slice('replay-'.length)},${request.observedAt})`
        yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
      VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations (reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
      VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${r.expectedHash},${r.observedHash},${r.contentHash},${r.status},'[]'::jsonb,${r.reconciledAt})`
        if (!withRequestVersion) {
          yield* sql`INSERT INTO jev_evaluation_requests (request_id,cycle_id,authority_generation_hash,payload)
            VALUES (${conditionalRequest.requestId},${conditionalRequest.cycleId},${conditionalRequest.authorityGenerationHash},${sql.json(conditionalRequest)})`
          return
        }
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        return yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(Effect.flatMap(JevBatchStore, (store) => store.begin(batch, fixture.observation.payload))),
          Effect.provide(TestClock.layer()),
        )
      }),
    )
  beforeEach(async () => {
    initialDispatch = undefined
    const admission = await resetDatabase()
    initialDispatch = admission?.dispatches.find((dispatch) => dispatch.request.requestId === defaultRequest.requestId)
  }, 30_000)

  test.each([
    [157, cryptoEntryAskCap, 'bayn.jev.protocol.v26'],
    [158, equityEntryAskCap, 'bayn.jev.protocol.v27'],
    [160, cryptoQuoteEvidence, 'bayn.jev.protocol.v28'],
    [161, cryptoHistoryContext, 'bayn.jev.protocol.v29'],
    [162, equityBenchmarkContext, 'bayn.jev.protocol.v30'],
    [164, focusedEntryEvidence, 'bayn.jev.protocol.v31'],
    [165, observedResistance, 'bayn.jev.protocol.v32'],
    [166, candidateEntryEvidence, 'bayn.jev.protocol.v33'],
    [167, chartStructureBeforeFunding, 'bayn.jev.protocol.v34'],
    [171, datedExecutionFees, 'bayn.jev.protocol.v35'],
    [172, jevOnlyInference, 'bayn.jev.protocol.v36'],
  ] as const)(
    'ask-cap migration %s preserves retired execution bytes and late financial evidence',
    async (id, cutover, retiredProtocol) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([version]) => version < id))),
            table: 'schema_migrations',
          })
          yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
          VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
          yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
          VALUES (${request.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${request.observedAt})`
          const { requestId: _, ...current } = request
          const protocolMaterial =
            retiredProtocol === 'bayn.jev.protocol.v30' ||
            retiredProtocol === 'bayn.jev.protocol.v31' ||
            retiredProtocol === 'bayn.jev.protocol.v32' ||
            retiredProtocol === 'bayn.jev.protocol.v33' ||
            retiredProtocol === 'bayn.jev.protocol.v34' ||
            retiredProtocol === 'bayn.jev.protocol.v35' ||
            retiredProtocol === 'bayn.jev.protocol.v36'
              ? {
                  ...retainedJevProtocolV39Document,
                  entrySignalPolicy: 'openai-decisions-then-jev' as const,
                  executionModel:
                    retiredProtocol === 'bayn.jev.protocol.v36'
                      ? request.request.protocol.executionModel
                      : retainedIntradayExecutionModel,
                  schemaVersion: retiredProtocol,
                  inputDefinition:
                    retiredProtocol === 'bayn.jev.protocol.v34' ||
                    retiredProtocol === 'bayn.jev.protocol.v35' ||
                    retiredProtocol === 'bayn.jev.protocol.v36'
                      ? ('bayn.jev-entry-state.v23' as const)
                      : ('bayn.jev-entry-state.v22' as const),
                  entryQuestionPolicyHash:
                    retiredProtocol === 'bayn.jev.protocol.v35' || retiredProtocol === 'bayn.jev.protocol.v36'
                      ? 'f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325'
                      : retiredProtocol === 'bayn.jev.protocol.v33' || retiredProtocol === 'bayn.jev.protocol.v34'
                        ? '864658b2565a176ecad7e6e2460a9f9be9340bf9f304d5af41db81ce49551158'
                        : retiredProtocol === 'bayn.jev.protocol.v32'
                          ? 'c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03'
                          : retainedMarketQuestionPolicyHash,
                  candidateEvidencePolicy:
                    retiredProtocol === 'bayn.jev.protocol.v31' ||
                    retiredProtocol === 'bayn.jev.protocol.v32' ||
                    retiredProtocol === 'bayn.jev.protocol.v33' ||
                    retiredProtocol === 'bayn.jev.protocol.v34' ||
                    retiredProtocol === 'bayn.jev.protocol.v35' ||
                    retiredProtocol === 'bayn.jev.protocol.v36'
                      ? IntradayCandidateEvidencePolicy.MarketQuotesV2
                      : IntradayCandidateEvidencePolicy.MarketQuotes,
                }
              : {
                  ...retainedJevProtocolV39Document,
                  entrySignalPolicy: 'openai-decisions-then-jev' as const,
                  executionModel: retainedIntradayExecutionModel,
                  schemaVersion: retiredProtocol,
                  inputDefinition: 'bayn.jev-entry-state.v22' as const,
                  entryQuestionPolicyHash: retainedMarketQuestionPolicyHash,
                  lookbackMinutes: 30 as const,
                  candidateEvidencePolicy:
                    retiredProtocol === 'bayn.jev.protocol.v29'
                      ? IntradayCandidateEvidencePolicy.MarketQuotes
                      : IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
                }
          const protocol = yield* Schema.decodeUnknownEffect(
            Schema.Union([
              jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v26'),
              jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v27'),
              jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v28'),
              jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v29'),
              RetainedJevProtocolV30Schema,
              RetainedJevProtocolV31Schema,
              RetainedJevProtocolV32Schema,
              RetainedJevProtocolV33Schema,
              RetainedJevProtocolV34Schema,
              RetainedJevProtocolV35Schema,
              RetainedJevProtocolV36Schema,
            ]),
          )(protocolMaterial)
          const input = {
            ...request.request,
            numericalState: { ...request.request.numericalState, schemaVersion: protocol.inputDefinition },
            schemaVersion:
              retiredProtocol === 'bayn.jev.protocol.v35' || retiredProtocol === 'bayn.jev.protocol.v36'
                ? ('bayn.entry-inference-input.v8' as const)
                : retiredProtocol === 'bayn.jev.protocol.v34'
                  ? ('bayn.entry-inference-input.v7' as const)
                  : retiredProtocol === 'bayn.jev.protocol.v30' ||
                      retiredProtocol === 'bayn.jev.protocol.v31' ||
                      retiredProtocol === 'bayn.jev.protocol.v32' ||
                      retiredProtocol === 'bayn.jev.protocol.v33'
                    ? ('bayn.entry-inference-input.v6' as const)
                    : ('bayn.entry-inference-input.v5' as const),
            protocol,
          }
          const material = { ...current, request: input, requestHash: Result.getOrThrow(canonicalHashV1Result(input)) }
          const original = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${original.requestId},${original.cycleId},${original.authorityGenerationHash},${sql.json(original)})`
          const checkpoint = stagedCheckpointFixture(
            original,
            original.observedAt,
            retiredProtocol === 'bayn.jev.protocol.v35' || retiredProtocol === 'bayn.jev.protocol.v36'
              ? observedChartStages
              : retiredProtocol === 'bayn.jev.protocol.v33' || retiredProtocol === 'bayn.jev.protocol.v34'
                ? retainedCandidateChartStages
                : retainedChartStages,
          )
          const first = checkpoint.claims[0]
          const terminal = checkpoint.terminals[0]
          if (first === undefined || terminal === undefined) throw new Error('Expected original chart evidence')
          const { claimHash: _claimHash, ...claimMaterial } = first
          const claim = Result.getOrThrow(makeStagedDispatchClaim({ ...claimMaterial, requestId: original.requestId }))
          yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
          VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`
          yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',state_version=state_version+1,
            updated_at=terminal.at,terminal_at=terminal.at FROM terminal WHERE cycle_id=${original.cycleId}`
          const before =
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${original.requestId}`
          yield* sql.withTransaction(cutover)
          expect(
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${original.requestId}`,
          ).toEqual(before)
          expect(
            yield* sql`SELECT payload FROM jev_staged_dispatch_claims WHERE request_id=${original.requestId}`,
          ).toEqual([{ payload: claim }])
          const rejectedRequest =
            yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${'d'.repeat(64)},${original.cycleId},${original.authorityGenerationHash},${sql.json({ ...original, requestId: 'd'.repeat(64) })})`.pipe(
              Effect.result,
            )
          if (Result.isSuccess(rejectedRequest)) throw new Error('Retired v26 request was accepted')
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              code: Schema.Literal('23514'),
              constraint: Schema.Literal('jev_evaluation_requests_check'),
            }),
          )(rejectedRequest.failure.reason.cause)
          const rejectedDispatch =
            yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
          VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`.pipe(Effect.result)
          if (Result.isSuccess(rejectedDispatch)) throw new Error('Retired v26 provider dispatch was accepted')
          yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
            rejectedDispatch.failure.reason.cause,
          )
          const { terminalHash: _terminalHash, ...terminalMaterial } = terminal
          const late = Result.getOrThrow(
            makeStagedTerminalReceipt({
              ...terminalMaterial,
              requestId: original.requestId,
              claimHash: claim.claimHash,
            }),
          )
          const rejectedHandoff = yield* sql`INSERT INTO jev_inference_handoffs(request_id,handoff_hash,payload)
          VALUES (${original.requestId},${'e'.repeat(64)},'{}'::jsonb)`.pipe(Effect.result)
          if (Result.isSuccess(rejectedHandoff)) throw new Error('Retired v26 execution handoff was accepted')
          const failure = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ code: Schema.Literal('23514'), message: Schema.String }),
          )(rejectedHandoff.failure.reason.cause)
          expect(failure.message).toContain(
            retiredProtocol === 'bayn.jev.protocol.v35' || retiredProtocol === 'bayn.jev.protocol.v36'
              ? 'entry handoff differs from its original versioned source'
              : 'retired entry protocol',
          )
          yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${original.requestId},'CHART',${late.claimHash},${late.terminalHash},${sql.json(late)})`
          expect(
            yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${original.requestId}`,
          ).toEqual([{ payload: late }])
        }),
      ),
  )

  test.skipIf(formalModelExecutable === undefined)(
    'Box chart dispatch transactions conform to Lean at original deadlines and across durable state',
    async () => {
      const identity = (claim: StagedDispatchClaim) => ({
        hash: claim.claimHash,
        payload: Result.getOrThrow(canonicalJsonV1Result(claim)),
      })
      const scenarios = [
        { state: 'fresh', claim: 0, commit: 0, ambient: false },
        { state: 'fresh', claim: 0, commit: 9999, ambient: false },
        { state: 'fresh', claim: 0, commit: 10000, ambient: false },
        { state: 'fresh', claim: 0, commit: 10001, ambient: false },
        { state: 'fresh', claim: 1, commit: 0, ambient: false },
        { state: 'fresh', claim: -1, commit: 0, ambient: false },
        { state: 'fresh', claim: 10000, commit: 10000, ambient: false },
        { state: 'fresh', claim: 0, commit: 0, ambient: true },
        { state: 'claimed', claim: 0, commit: 0, ambient: false },
        { state: 'claimed', claim: 0, commit: 10000, ambient: false },
        { state: 'claimed', claim: 1, commit: 1, ambient: false },
        { state: 'claimed', claim: 0, commit: 0, ambient: true },
        { state: 'handed-off', claim: 0, commit: 0, ambient: false },
        { state: 'resolved', claim: 0, commit: 10000, ambient: false },
        { state: 'quoted', claim: 0, commit: 0, ambient: false },
      ]
      const inputs = []
      const actual = []
      for (const stage of ['CHART'] as const)
        for (const scenario of scenarios) {
          const observed = await runtime.runPromise(
            Effect.gen(function* () {
              const current = yield* retainReplayRequest
              const sql = yield* PgClient.PgClient
              const journal = yield* EntryInferenceJournal
              const at = (offset: number) => new Date(Date.parse(current.observedAt) + offset).toISOString()
              expect(Date.parse(current.expiresAt) - Date.parse(current.observedAt)).toBe(10000)
              const checkpoint = stagedCheckpointFixture(current)
              const claim = checkpoint.claims.find((row) => row.stage === stage)
              if (claim === undefined) throw new Error('Missing stage claim')
              if (scenario.state === 'claimed')
                expect(yield* persistVisualClaimFixture(journal, claim)).toEqual({
                  dispatchAllowed: false,
                })
              if (scenario.state === 'handed-off') {
                yield* retainCheckpoint(current)
                yield* persistHandoffFixture(journal, entryCompletionFixture(current).handoff)
              }
              if (scenario.state === 'resolved') yield* (yield* JevEvaluationStore).abandon(current, current.expiresAt)
              if (scenario.state === 'quoted') {
                yield* persistVisualClaimFixture(journal, claim)
                const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(current.observedAt.slice(0, 10))
                const quotes = Result.getOrThrow(
                  makeInferenceExpenseQuotes(
                    {
                      accountId: replayAccountId,
                      sessionDate,
                      asOf: current.observedAt,
                      requestId: current.requestId,
                      cycleId: current.cycleId,
                      authorityGenerationHash: current.authorityGenerationHash,
                      request: current,
                      receipt: null,
                      resolution: null,
                      handoff: null,
                      stagedCheckpoint: {
                        claims: checkpoint.claims.filter((row) => row.stage === 'CHART'),
                        terminals: [],
                        skips: [],
                      },
                    },
                    inferenceExpenseRateCard,
                  ),
                )
                yield* makeInferenceExpenseStore(sql, replayAccountId, sessionDate).freeze(quotes)
              }
              yield* sql`UPDATE simulated_execution_clocks SET observed_at=${at(scenario.commit)} WHERE account_id=${replayAccountId}`
              const readState = Effect.gen(function* () {
                const [state] = yield* Schema.decodeUnknownEffect(
                  Schema.Tuple([
                    Schema.Struct({
                      claim: Schema.Unknown,
                      resolved: Schema.Boolean,
                      handedOff: Schema.Boolean,
                      stageQuoted: Schema.Boolean,
                    }),
                  ]),
                )(
                  yield* sql`SELECT
                (SELECT payload FROM jev_staged_dispatch_claims WHERE request_id=${current.requestId} AND stage=${stage}) AS claim,
                EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=${current.requestId}) AS resolved,
                EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=${current.requestId}) AS "handedOff",
                EXISTS (SELECT 1 FROM inference_expense_quotes WHERE request_id=${current.requestId} AND provider_stage=${stage}) AS "stageQuoted"`,
                )
                return {
                  stored:
                    state.claim === null
                      ? null
                      : identity(yield* Schema.decodeUnknownEffect(StagedDispatchClaimSchema)(state.claim)),
                  resolved: state.resolved,
                  handedOff: state.handedOff,
                  stageQuoted: state.stageQuoted,
                }
              })
              const { claimHash: _hash, ...material } = claim
              const input = Result.getOrThrow(makeStagedDispatchClaim({ ...material, claimedAt: at(scenario.claim) }))
              const before = yield* readState
              const record = persistVisualClaimFixture(journal, input)
              const result = yield* (scenario.ambient ? sql.withTransaction(record) : record).pipe(Effect.result)
              const after = yield* readState
              if (Result.isFailure(result)) expect(after).toEqual(before)
              return {
                input: {
                  operation: 'visualClaim',
                  state: before,
                  ambientTransaction: scenario.ambient,
                  input: identity(input),
                  observedAt: String(Date.parse(current.observedAt)),
                  claimedAt: String(Date.parse(input.claimedAt)),
                  commitAt: String(Date.parse(at(scenario.commit))),
                  expiresAt: String(Date.parse(current.expiresAt)),
                },
                result: Result.isFailure(result)
                  ? null
                  : { dispatchAllowed: result.success.dispatchAllowed, state: after },
              }
            }),
          )
          inputs.push(observed.input)
          actual.push(observed.result)
        }
      expect(actual.filter((result) => result?.dispatchAllowed)).toHaveLength(0)
      expect(actual.filter((result) => result === null)).toHaveLength(6)
      expect(runFormalModel(inputs)).toEqual(actual)
    },
    180_000,
  )

  test.skipIf(formalModelExecutable === undefined)(
    'committed handoff transactions conform to Lean under replay, abandonment and contention',
    async () => {
      const identity = (handoff: EntryHandoff) => ({
        hash: handoff.handoffHash,
        payload: Result.getOrThrow(canonicalJsonV1Result(handoff)),
      })
      const source = {
        requestId: request.requestId,
        input: request.request,
        observedAt: request.observedAt,
        expiresAt: request.expiresAt,
      }
      const { handoffHash: _hash, ...material } = completion.handoff
      const changedMaterial = {
        ...material,
        recordedAt: new Date(Date.parse(material.recordedAt) + 1).toISOString(),
      }
      const changed = Result.getOrThrow(
        decodeEntryHandoff(source, {
          ...changedMaterial,
          handoffHash: Result.getOrThrow(canonicalHashV1Result(changedMaterial)),
        }),
      )
      const readState = Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [state] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ handoff: Schema.Unknown, resolved: Schema.Boolean })]),
        )(
          yield* sql`SELECT
        (SELECT payload FROM jev_inference_handoffs WHERE request_id=${request.requestId}) AS handoff,
        EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=${request.requestId}) AS resolved`,
        )
        return {
          stored:
            state.handoff === null
              ? null
              : identity(yield* Effect.fromResult(decodeEntryHandoff(source, state.handoff))),
          resolved: state.resolved,
        }
      })
      const inputs = []
      const actual = []
      for (const existing of [false, true])
        for (const resolved of [false, true])
          for (const ambientTransaction of [false, true])
            for (const input of [completion.handoff, changed]) {
              if (inputs.length > 0) await resetDatabase()
              const observed = await runtime.runPromise(
                Effect.gen(function* () {
                  const journal = yield* EntryInferenceJournal
                  const store = yield* JevEvaluationStore
                  const sql = yield* PgClient.PgClient
                  yield* retainCheckpoint(request)
                  if (existing) yield* persistHandoffFixture(journal, completion.handoff)
                  if (resolved) yield* store.abandon(request, request.expiresAt)
                  const before = yield* readState
                  const record = persistHandoffFixture(journal, input)
                  const result = yield* (ambientTransaction ? sql.withTransaction(record) : record).pipe(Effect.result)
                  const after = yield* readState
                  if (Result.isFailure(result)) {
                    expect(after).toEqual(before)
                    return { before, result: null }
                  }
                  return { before, result: { dispatchAllowed: result.success.dispatchAllowed, state: after } }
                }),
              )
              inputs.push({
                operation: 'inferenceHandoff',
                state: observed.before,
                ambientTransaction,
                input: identity(input),
              })
              actual.push(observed.result)
            }
      expect(inputs).toHaveLength(16)
      expect(actual.filter((result) => result?.dispatchAllowed)).toHaveLength(2)
      expect(runFormalModel(inputs)).toEqual(actual)

      await resetDatabase()
      const concurrent = await runtime.runPromise(
        Effect.gen(function* () {
          const journal = yield* EntryInferenceJournal
          yield* retainCheckpoint(request)
          const before = yield* readState
          const outcomes = yield* Effect.all(
            Array.from({ length: 8 }, () => persistHandoffFixture(journal, completion.handoff)),
            { concurrency: 8 },
          )
          return { before, after: yield* readState, outcomes }
        }),
      )
      expect(
        runFormalModel([
          {
            operation: 'inferenceHandoff',
            state: concurrent.before,
            ambientTransaction: false,
            input: identity(completion.handoff),
          },
          ...Array.from({ length: 7 }, () => ({
            operation: 'inferenceHandoff',
            state: concurrent.after,
            ambientTransaction: false,
            input: identity(completion.handoff),
          })),
        ]),
      ).toEqual(
        concurrent.outcomes
          .map((outcome) => ({ ...outcome, state: concurrent.after }))
          .sort((left, right) => Number(right.dispatchAllowed) - Number(left.dispatchAllowed)),
      )
      expect(concurrent.outcomes.filter((outcome) => outcome.dispatchAllowed)).toHaveLength(1)
    },
    180_000,
  )

  test('market policy cutover preserves original staged claims and rejects retired-policy requests and dispatch', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 154))),
          table: 'schema_migrations',
        })
        yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
        VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
        yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
        yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
        VALUES (${request.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${request.observedAt})`
        const { requestId: _, ...current } = request
        const input = {
          ...request.request,
          schemaVersion: 'bayn.entry-inference-input.v5',
          protocol: {
            ...retainedJevProtocolV39Document,
            executionModel: retainedIntradayExecutionModel,
            schemaVersion: 'bayn.jev.protocol.v26',
            entrySignalPolicy: 'openai-decisions-then-jev' as const,
            inputDefinition: 'bayn.jev-entry-state.v22' as const,
            lookbackMinutes: 30,
            candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
            entryQuestionPolicyHash: retainedStagedQuestionPolicyHash,
          },
        }
        const material = { ...current, request: input, requestHash: Result.getOrThrow(canonicalHashV1Result(input)) }
        const original = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
        yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
        VALUES (${original.requestId},${original.cycleId},${original.authorityGenerationHash},${sql.json(original)})`
        const checkpoint = stagedCheckpointFixture(request)
        const first = checkpoint.claims[0]
        const completed = checkpoint.terminals[0]
        if (first === undefined || completed === undefined) throw new Error('Expected a staged chart fixture')
        const { claimHash: _claimHash, ...claimMaterial } = first
        const claim = Result.getOrThrow(makeStagedDispatchClaim({ ...claimMaterial, requestId: original.requestId }))
        yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
        VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`
        yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
        UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',state_version=state_version+1,
          updated_at=terminal.at,terminal_at=terminal.at FROM terminal WHERE cycle_id=${original.cycleId}`
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${original.requestId}`
        yield* sql.withTransaction(marketEntryQuestions)
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${original.requestId}`,
        ).toEqual(before)
        expect(
          yield* sql`SELECT payload FROM jev_staged_dispatch_claims WHERE request_id=${original.requestId}`,
        ).toEqual([{ payload: claim }])
        const rejectedRequest =
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
        VALUES (${'d'.repeat(64)},${original.cycleId},${original.authorityGenerationHash},${sql.json({ ...original, requestId: 'd'.repeat(64) })})`.pipe(
            Effect.result,
          )
        expect(Result.isFailure(rejectedRequest)).toBe(true)
        const rejectedClaim = yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
        VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`.pipe(Effect.result)
        if (Result.isSuccess(rejectedClaim)) throw new Error('Retired staged policy was allowed to dispatch')
        yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
          rejectedClaim.failure.reason.cause,
        )
        const { terminalHash: _terminalHash, ...terminalMaterial } = completed
        const terminal = Result.getOrThrow(
          makeStagedTerminalReceipt({ ...terminalMaterial, requestId: original.requestId, claimHash: claim.claimHash }),
        )
        yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
        VALUES (${original.requestId},'CHART',${claim.claimHash},${terminal.terminalHash},${sql.json(terminal)})`
        expect(
          yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${original.requestId}`,
        ).toEqual([{ payload: terminal }])
      }),
    ))

  test.each(['bayn.jev.protocol.v38', 'bayn.jev.protocol.v39'] as const)(
    'Box cutover retains %s requests and claims while admitting only v40',
    async (retainedVersion) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(
              Effect.map((rows) =>
                rows.filter(([id]) => id < (retainedVersion === 'bayn.jev.protocol.v38' ? 184 : 187)),
              ),
            ),
            table: 'schema_migrations',
          })
          yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
          VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
          const broker = Result.getOrThrow(
            makeBrokerIdentity({
              schemaVersion: 'bayn.broker-identity.v2',
              provider: BrokerProvider.Alpaca,
              environment: BrokerEnvironment.Sandbox,
              accountId: replayAccountId,
            }),
          )
          const authority = makeObserveAuthorityInterpreter(
            sql,
            makeAuthorityPostgres(sql, { now: sql`${request.observedAt}::timestamptz` }),
            broker,
          )
          const initialized = yield* authority.ensureAuthorityGeneration({
            generationHash: request.authorityGenerationHash,
            maximum: Authority.Observe,
          })
          expect(initialized).toMatchObject({ maximum: Authority.Observe, effective: Authority.Observe, kill: 'CLEAR' })
          yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
          const originalPlan = Result.getOrThrow(
            reconstructRetainedJevTradingSignalBatch({
              observation: {
                ...fixture.observation.payload,
                protocol: { ...retainedJevProtocolV39Document, schemaVersion: retainedVersion },
              },
              expiresAt: request.expiresAt,
              planVersion: JevBatchPlanVersion.V8,
            }),
          )
          const candidate = originalPlan.candidates.find((entry) => entry.status === JevCandidatePlanStatus.Requested)
          if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected retained v38 evidence')
          const original = candidate.request
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${original.requestId},${original.cycleId},${original.authorityGenerationHash},${sql.json(original)})`
          const checkpoint = stagedCheckpointFixture(original)
          const claim = checkpoint.claims[0]
          const terminal = checkpoint.terminals[0]
          if (claim === undefined || terminal === undefined) throw new Error('Expected retained chart stage')
          yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
          VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`
          yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',state_version=state_version+1,
            updated_at=terminal.at,terminal_at=terminal.at FROM terminal WHERE cycle_id=${original.cycleId}`
          const reconciliation = fixture.portfolio.brokerState.reconciliation
          yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
          VALUES (${reconciliation.reconciliationId},${reconciliation.schemaVersion},${broker.accountId},
            ${reconciliation.expectedHash},${reconciliation.observedHash},${reconciliation.contentHash},
            ${reconciliation.status},'[]'::jsonb,clock_timestamp())`
          const requestsBefore = yield* sql`SELECT payload::text FROM jev_evaluation_requests ORDER BY request_id`
          const claimsBefore =
            yield* sql`SELECT payload::text FROM jev_staged_dispatch_claims ORDER BY request_id,stage`
          const authorityBefore =
            yield* sql`SELECT row_to_json(g)::text AS payload FROM authority_generations g ORDER BY generation_hash`
          const authorityStateBefore = yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a`
          expect(authorityStateBefore).toHaveLength(1)
          expect(
            yield* sql`SELECT g.account_id FROM authority_state a JOIN authority_generations g USING (generation_hash)`,
          ).toEqual([{ account_id: broker.accountId }])
          if (retainedVersion === 'bayn.jev.protocol.v38') yield* sql.withTransaction(effectiveEntryAllowanceInput)
          yield* sql.withTransaction(jevBoxInference)
          expect(yield* sql`SELECT payload::text FROM jev_evaluation_requests ORDER BY request_id`).toEqual(
            requestsBefore,
          )
          expect(yield* sql`SELECT payload::text FROM jev_staged_dispatch_claims ORDER BY request_id,stage`).toEqual(
            claimsBefore,
          )
          expect(
            yield* sql`SELECT row_to_json(g)::text AS payload FROM authority_generations g ORDER BY generation_hash`,
          ).toEqual(authorityBefore)
          expect(yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a`).toEqual(
            authorityStateBefore,
          )
          const rejectedDispatch =
            yield* sql`INSERT INTO jev_staged_dispatch_claims(request_id,stage,claim_hash,payload)
          VALUES (${original.requestId},'CHART',${claim.claimHash},${sql.json(claim)})`.pipe(Effect.result)
          if (Result.isSuccess(rejectedDispatch)) throw new Error('A retained v38 request was allowed new dispatch')
          yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
            rejectedDispatch.failure.reason.cause,
          )
          yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${original.requestId},'CHART',${claim.claimHash},${terminal.terminalHash},${sql.json(terminal)})`
          const successorFixture = nativeJevFixture(
            JevPurpose.Entry,
            new Date(Date.parse(request.observedAt) + 60_000).toISOString(),
            replayAccountId,
            undefined,
            Result.getOrThrow(canonicalHashV1Result({ cutover: 'v39', previousCycleId: original.cycleId })),
          )
          const successorPlan = Result.getOrThrow(
            makeJevTradingSignalBatch({
              observation: successorFixture.observation.payload,
              expiresAt: new Date(
                Date.parse(successorFixture.observation.payload.observedAt) +
                  successorFixture.protocol.inferenceValidityMs,
              ).toISOString(),
              planVersion: JevBatchPlanVersion.V8,
            }),
          )
          const successorCandidate = successorPlan.candidates.find(
            (entry) => entry.status === JevCandidatePlanStatus.Requested,
          )
          if (successorCandidate?.status !== JevCandidatePlanStatus.Requested)
            throw new Error('Expected current post-cutover request')
          const successor = successorCandidate.request
          // One symbol/source/generation belongs to one request. The successor gets a new native cycle and source;
          // the retained request is never replaced or admitted again under a different protocol identity.
          expect(successor.cycleId).not.toBe(original.cycleId)
          expect(successor.snapshotId).not.toBe(original.snapshotId)
          yield* sql`UPDATE simulated_execution_clocks SET observed_at=${successor.observedAt} WHERE account_id=${replayAccountId}`
          yield* (yield* CycleStore).acquire(successorFixture.draft, successor.observedAt)
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${successor.requestId},${successor.cycleId},${successor.authorityGenerationHash},${sql.json(successor)})`
          for (const [index, changed] of [
            original.request,
            {
              ...successor.request,
              protocol: { ...successor.request.protocol, schemaVersion: 'bayn.jev.protocol.v38' },
            },
            {
              ...successor.request,
              numericalState: {
                ...successor.request.numericalState,
                entryEconomics: { maximumEntryQuoteDriftBps: 10, maximumEntryLimitSlippageBps: 0 },
              },
            },
            {
              ...successor.request,
              numericalState: {
                ...successor.request.numericalState,
                entryEconomics: { maximumEntryQuoteDriftBps: 0, maximumEntryLimitSlippageBps: '0' },
              },
            },
            { ...successor.request, numericalState: { ...successor.request.numericalState, entryEconomics: {} } },
          ].entries()) {
            const id = Result.getOrThrow(canonicalHashV1Result({ invalidInput: index }))
            const rejected =
              yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
            VALUES (${id},${successor.cycleId},${successor.authorityGenerationHash},${sql.json({ ...successor, requestId: id, request: changed })})`.pipe(
                Effect.result,
              )
            if (Result.isSuccess(rejected))
              throw new Error('Mixed or misleading allowance input reached the current DB contract')
            yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
              rejected.failure.reason.cause,
            )
          }
        }),
      ),
  )

  test('one chart admission survives a crash and later metering upgrades discovery without double charging', async () => {
    await resetDatabase(true, expiredFixture, expiredRequest, expiredBatch)
    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const request = expiredRequest
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${request.expiresAt}
          WHERE account_id=${expiredFixture.portfolio.brokerState.account.accountId}`
        const expiredVisual = stagedCheckpointFixture(request).terminals[0]
        if (expiredVisual?.outcome.status !== 'RECEIVED') throw new Error('Missing visual fixture')
        const expiredClaim = Result.getOrThrow(
          makeStagedDispatchClaim({
            schemaVersion: 'bayn.staged-dispatch-claim.v1',
            stage: 'CHART',
            predecessorHash: null,
            selectedEnd: null,
            requestId: request.requestId,
            providerRequestHash: expiredVisual.outcome.inference.requestHash,
            claimedAt: request.observedAt,
            expiresAt: request.expiresAt,
          }),
        )
        expect(yield* persistVisualClaimFixture(journal, expiredClaim)).toEqual({ dispatchAllowed: false })
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_staged_dispatch_claims (request_id,stage,claim_hash,payload)
            VALUES (${request.requestId},'CHART',${expiredClaim.claimHash},${sql.json(expiredClaim)})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        const current = yield* retainReplayRequest
        const visualTerminal = stagedCheckpointFixture(current).terminals[0]
        if (visualTerminal?.outcome.status !== 'RECEIVED') throw new Error('Missing visual fixture')
        const visual = visualTerminal.outcome.inference
        const claim = Result.getOrThrow(
          makeStagedDispatchClaim({
            schemaVersion: 'bayn.staged-dispatch-claim.v1',
            stage: 'CHART',
            predecessorHash: null,
            selectedEnd: null,
            requestId: current.requestId,
            providerRequestHash: visual.requestHash,
            claimedAt: current.observedAt,
            expiresAt: current.expiresAt,
          }),
        )
        const admissions = yield* Effect.all(
          [persistVisualClaimFixture(journal, claim), persistVisualClaimFixture(journal, claim)],
          {
            concurrency: 2,
          },
        )
        expect(admissions.filter((value) => value.dispatchAllowed)).toHaveLength(0)
        expect(
          Result.isFailure(yield* sql.withTransaction(persistVisualClaimFixture(journal, claim)).pipe(Effect.result)),
        ).toBe(true)
        const store = makeInferenceExpenseStore(sql, replayAccountId, '1970-01-01')
        // A synthetic tariff prices this September fixture only; never backdate the production rate card.
        const fixtureRateCard = {
          ...inferenceExpenseRateCard,
          rates: inferenceExpenseRateCard.rates.map((rate) => ({
            ...rate,
            source: 'Synthetic checkpoint lifecycle fixture tariff, not provider pricing evidence.',
            effectiveFrom: '1970-01-01T00:00:00.000Z',
          })),
        }
        const find = (rows: readonly { readonly requestId: string }[]) =>
          rows.some((row) => row.requestId === current.requestId)
        const initialSource = (yield* store.newSources).find((row) => row.requestId === current.requestId)
        if (initialSource === undefined) throw new Error('Missing unresolved checkpoint expense')
        const initial = Result.getOrThrow(makeInferenceExpenseQuotes(initialSource, fixtureRateCard))
        expect(initial).toHaveLength(1)
        expect(initial.every((quote) => quote.line.usageStatus === 'UNKNOWN_USAGE')).toBe(true)
        yield* store.freeze(initial)
        expect(
          yield* sql`SELECT provider_stage,stage_claim_hash,stage_terminal_hash,stage_skip_hash
          FROM inference_expense_quotes WHERE request_id=${current.requestId}`,
        ).toEqual([
          {
            provider_stage: 'CHART',
            stage_claim_hash: claim.claimHash,
            stage_terminal_hash: null,
            stage_skip_hash: null,
          },
        ])
        const initialQuote = initial[0]
        if (initialQuote === undefined) throw new Error('Missing initial staged quote')
        expect(initialQuote.schemaVersion).toBe('bayn.inference-expense-quote.v4')
        // BEFORE INSERT must inspect payload identities, not the still-uncomputed generated columns.
        // Check constraints and stage-scoped foreign keys continue to reject forged identities afterward.
        for (const [changes, code] of [
          [{ stage: null }, '23514'],
          [{ stage: 'UNKNOWN' }, '23514'],
          [{ stage: 'JEV', stageClaimHash: null }, '23514'],
          [{ stageClaimHash: null }, '23514'],
          [{ stage: 'BASE_START' }, '23514'],
          [{ stageClaimHash: 'a'.repeat(64) }, '23503'],
          [{ stageTerminalHash: 'b'.repeat(64) }, '23503'],
          [{ stageSkipHash: 'c'.repeat(64) }, '23514'],
          [{ stageClaimHash: null, stageSkipHash: 'c'.repeat(64) }, '23514'],
        ] as const) {
          const { quoteHash: _oldHash, ...material } = initialQuote
          const forgedMaterial = { ...material, line: { ...material.line, ...changes } }
          const forged = { ...forgedMaterial, quoteHash: Result.getOrThrow(canonicalHashV1Result(forgedMaterial)) }
          const rejected = yield* sql`INSERT INTO inference_expense_quotes (quote_hash,account_id,session_date,payload)
            VALUES (${forged.quoteHash},${replayAccountId},${forged.sessionDate}::date,${sql.json(forged)})`.pipe(
            Effect.result,
          )
          if (Result.isSuccess(rejected)) throw new Error('Forged staged quote identity was accepted')
          yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal(code) }))(
            rejected.failure.reason.cause,
          )
        }
        expect(find(yield* store.newSources)).toBe(false)
        // Advance only this explicit replay account's durable clock beyond the original deadline.
        const lateAt = new Date(Date.parse(current.expiresAt) + 20).toISOString()
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${lateAt} WHERE account_id=${replayAccountId}`
        yield* (yield* JevEvaluationStore).abandon(current, lateAt)
        const abandonedSource = (yield* store.newSources).find((row) => row.requestId === current.requestId)
        if (abandonedSource === undefined) throw new Error('Missing first resolved Jev expense')
        const abandoned = Result.getOrThrow(makeInferenceExpenseQuotes(abandonedSource, fixtureRateCard))
        yield* store.freeze(abandoned)
        expect(find(yield* store.newSources)).toBe(false)
        const terminal = Result.getOrThrow(
          makeStagedTerminalReceipt({
            schemaVersion: 'bayn.staged-terminal-receipt.v1',
            stage: 'CHART',
            requestId: current.requestId,
            claimHash: claim.claimHash,
            recordedAt: lateAt,
            outcome: { status: 'RECEIVED', inference: visual },
          }),
        )
        yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
        yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
        const lateSource = (yield* store.newSources).find((row) => row.requestId === current.requestId)
        if (lateSource === undefined) throw new Error('Late chart metering was not rediscovered')
        const historicalRates = Result.getOrThrow(makeInferenceExpenseQuotes(lateSource, inferenceExpenseRateCard))
        expect(
          historicalRates.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart)?.line
            .estimatedCostPicoUsd,
        ).toBeNull()
        expect(Result.getOrThrow(buildInferenceExpensePlan(historicalRates)).transfers).toHaveLength(0)
        const late = Result.getOrThrow(makeInferenceExpenseQuotes(lateSource, fixtureRateCard))
        yield* store.freeze(late)
        expect(find(yield* store.newSources)).toBe(false)
        const saved = yield* sql`SELECT payload FROM inference_expense_quotes WHERE request_id=${current.requestId}`
        expect(saved).toHaveLength(3)
        expect((yield* store.pending).filter((quote) => quote.line.requestId === current.requestId)).toHaveLength(3)
        expect(Result.getOrThrow(buildInferenceExpensePlan([...initial, ...late])).transfers).toHaveLength(1)
        const { terminalHash: __, ...terminalMaterial } = terminal
        const conflict = Result.getOrThrow(
          makeStagedTerminalReceipt({ ...terminalMaterial, recordedAt: current.expiresAt }),
        )
        expect(
          Result.isFailure(
            yield* persistVisualTransitionFixture(journal, { terminal: conflict, successor: { kind: 'NONE' } }).pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`UPDATE jev_staged_dispatch_claims SET payload=payload WHERE request_id=${current.requestId}`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`DELETE FROM jev_staged_terminal_receipts WHERE request_id=${current.requestId}`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        const notDispatched = Result.getOrThrow(
          makeJevEvaluationReceipt(current, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: current.requestId,
            startedAt: current.observedAt,
            completedAt: current.expiresAt,
            outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
          }),
        )
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_evaluation_receipts (request_id,receipt_hash,payload)
        VALUES (${current.requestId},${notDispatched.receiptHash},${sql.json(notDispatched)})`.pipe(Effect.result),
          ),
        ).toBe(true)
      }),
    )
  }, 30_000)

  test('backfills a completed current request without changing provider evidence or expense discovery', async () => {
    await resetDatabase(false)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const request = conditionalRequest,
          completion = conditionalCompletion,
          receipt = conditionalReceipt
        yield* sql`INSERT INTO jev_inference_handoffs (request_id,handoff_hash,payload)
          VALUES (${request.requestId},${completion.handoff.handoffHash},${sql.json(completion.handoff)})`
        yield* sql`INSERT INTO jev_evaluation_receipts (request_id,receipt_hash,payload)
          VALUES (${request.requestId},${receipt.receiptHash},${sql.json(receipt)})`
        const resolution = Result.getOrThrow(
          makeJevResolution(request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        yield* sql`INSERT INTO jev_evaluation_resolutions (request_id,resolution_hash,payload)
          VALUES (${request.requestId},${resolution.resolutionHash},${sql.json(resolution)})`
        const evidence = () => sql`SELECT request.payload::text AS request_bytes,
          receipt.payload::text AS receipt_bytes, receipt.receipt_hash,
          handoff.payload::text AS handoff_bytes, handoff.handoff_hash
          FROM jev_evaluation_requests AS request
          JOIN jev_evaluation_receipts AS receipt USING (request_id)
          JOIN jev_inference_handoffs AS handoff USING (request_id)
          WHERE request_id=${request.requestId}`
        const before = yield* evidence()
        expect(before).toHaveLength(1)
        const oldDiscovery = yield* sql`SELECT request.request_id
          FROM jev_evaluation_requests AS request
          JOIN autonomous_cycles AS cycle USING (cycle_id)
          JOIN jev_evaluation_resolutions AS resolution USING (request_id)
          WHERE cycle.account_id=${fixture.portfolio.brokerState.account.accountId}
          AND cycle.execution_session_date >= '1970-01-01'::date
          AND (SELECT count(*) FROM inference_expense_quotes AS quote WHERE quote.request_id=request.request_id)
            < CASE WHEN request.payload->>'schemaVersion'='bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END
          ORDER BY request.request_id COLLATE "C" LIMIT 64`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ request_id: Schema.String })))),
        )
        yield* inferenceRequestVersion
        expect(yield* evidence()).toEqual(before)
        expect(
          yield* sql`SELECT schema_version FROM jev_evaluation_requests WHERE request_id=${request.requestId}`,
        ).toEqual([{ schema_version: request.schemaVersion }])
        const discovered = yield* sql`SELECT request.request_id
          FROM jev_evaluation_requests request JOIN autonomous_cycles cycle USING(cycle_id)
          JOIN jev_evaluation_resolutions resolution USING(request_id)
          WHERE cycle.account_id=${fixture.portfolio.brokerState.account.accountId}
            AND cycle.execution_session_date >= '1970-01-01'::date
            AND (SELECT count(*) FROM inference_expense_quotes quote WHERE quote.request_id=request.request_id)
              < CASE WHEN request.schema_version='bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END
          ORDER BY request.request_id COLLATE "C" LIMIT 64`
        expect(discovered).toEqual([...oldDiscovery])
        expect(discovered).toEqual([{ request_id: request.requestId }])
      }),
    )
  })

  const chartTransition = () => {
    const checkpoint = stagedCheckpointFixture(request)
    const chart = checkpoint.claims[0]
    const terminal = checkpoint.terminals[0]
    if (chart === undefined || terminal === undefined) throw new Error('Missing Box chart fixture')
    return { chart, terminal, successor: { kind: 'HANDOFF' as const, handoff: completion.handoff } }
  }

  test('commits a Box chart terminal and its dependent Jev handoff in one transaction', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        expect(yield* persistVisualTransitionFixture(journal, { terminal, successor })).toEqual({
          dispatchAllowed: true,
        })
        const rows = yield* sql<{
          transaction: string
        }>`SELECT xmin::text AS transaction FROM jev_staged_terminal_receipts
        WHERE request_id=${request.requestId}
        UNION ALL SELECT xmin::text FROM jev_inference_handoffs WHERE request_id=${request.requestId}`
        expect(rows).toHaveLength(2)
        expect(new Set(rows.map((row) => row.transaction)).size).toBe(1)
        expect(yield* sql`SELECT stage FROM jev_staged_dispatch_claims WHERE request_id=${request.requestId}`).toEqual([
          { stage: 'CHART' },
        ])
        expect(yield* sql`SELECT stage FROM jev_staged_skip_receipts WHERE request_id=${request.requestId}`).toEqual([])
      }),
    ))

  test('an atomic Box transition serializes retries and refuses an ambient transaction', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        const transition = persistVisualTransitionFixture(journal, { terminal, successor })
        expect(Result.isFailure(yield* sql.withTransaction(transition).pipe(Effect.result))).toBe(true)
        expect(
          yield* sql`SELECT stage FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([])
        const attempts = yield* Effect.all([transition, transition], { concurrency: 2 })
        expect(attempts.filter((value) => value.dispatchAllowed)).toHaveLength(1)
        expect(
          yield* sql`SELECT stage FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ stage: 'CHART' }])
      }),
    ))

  test('an invalid Box handoff retains the paid terminal without admitting dependent inference', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        expect(
          Result.isFailure(
            yield* persistVisualTransitionFixture(journal, {
              terminal,
              successor: { ...successor, handoff: { ...successor.handoff, inputHash: 'f'.repeat(64) } },
            }).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          yield* sql`SELECT terminal_hash FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ terminal_hash: terminal.terminalHash }])
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([])
        expect(yield* persistVisualTransitionFixture(journal, { terminal, successor: { kind: 'NONE' } })).toEqual({
          dispatchAllowed: false,
        })
      }),
    ))

  test('a late Box handoff remains durable for accounting before the provider deadline check', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${request.expiresAt} WHERE account_id=${replayAccountId}`
        expect(yield* persistVisualTransitionFixture(journal, { terminal, successor })).toEqual({
          dispatchAllowed: true,
        })
        expect(
          yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ payload: terminal }])
      }),
    ))

  test('a failed Box handoff preserves paid evidence for cost discovery', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        yield* sql`CREATE FUNCTION reject_box_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture rejected handoff' USING ERRCODE='23514'; END $$`
        yield* sql`CREATE TRIGGER reject_box_handoff BEFORE INSERT ON jev_inference_handoffs
        FOR EACH ROW EXECUTE FUNCTION reject_box_handoff()`
        expect(
          Result.isFailure(yield* persistVisualTransitionFixture(journal, { terminal, successor }).pipe(Effect.result)),
        ).toBe(true)
        expect(
          yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ payload: terminal }])
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([])
        const source = (yield* makeInferenceExpenseStore(sql, replayAccountId, '1970-01-01').newSources).find(
          (row) => row.requestId === request.requestId,
        )
        if (source === undefined) throw new Error('Missing paid terminal expense source')
        const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
        expect(quotes.find((quote) => 'stage' in quote.line && quote.line.stage === 'CHART')?.line.usageStatus).toBe(
          InferenceUsageStatus.Received,
        )
      }),
    ))

  test('interruption while acquiring a Box transition lock retains the paid terminal and releases the transaction', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const { chart, terminal, successor } = chartTransition()
        yield* persistVisualClaimFixture(journal, chart)
        const locked = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT request_id FROM jev_evaluation_requests WHERE request_id=${request.requestId} FOR UPDATE`
              yield* Deferred.succeed(locked, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(locked)
        const attempt = yield* persistVisualTransitionFixture(journal, { terminal, successor }).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        const interruption = yield* Fiber.interrupt(attempt).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        yield* Fiber.join(interruption).pipe(Effect.timeout('5 seconds'))
        const exit = yield* Fiber.await(attempt)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(
          yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ payload: terminal }])
      }),
    ))

  test('rejects a retired provider response on a current Jev stage before admitting financial evidence', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const current = stagedCheckpointFixture(request)
        const claim = current.claims[0]
        const terminal = current.terminals[0]
        if (claim === undefined || terminal?.outcome.status !== 'RECEIVED')
          throw new Error('Missing current chart fixture')
        yield* persistVisualClaimFixture(yield* EntryInferenceJournal, claim)
        const substituted = {
          ...terminal,
          outcome: {
            ...terminal.outcome,
            inference: {
              ...terminal.outcome.inference,
              response: { ...terminal.outcome.inference.response, model: 'gpt-6-luna' },
            },
          },
        }
        const rejected =
          yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
        VALUES (${request.requestId},'CHART',${claim.claimHash},${terminal.terminalHash},${sql.json(substituted)})`.pipe(
            Effect.result,
          )
        if (Result.isSuccess(rejected)) throw new Error('Retired provider was admitted for current Jev inference')
        yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
          rejected.failure.reason.cause,
        )
        expect(
          yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([])
        yield* persistVisualTransitionFixture(yield* EntryInferenceJournal, { terminal, successor: { kind: 'NONE' } })
        expect(
          (yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${request.requestId}`).length,
        ).toBe(1)
      }),
    ))

  test('commits the exact handoff once and binds the completed receipt to it', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EntryInferenceJournal
        yield* retainCheckpoint(request)
        const claims = yield* Effect.all(
          [persistHandoffFixture(journal, completion.handoff), persistHandoffFixture(journal, completion.handoff)],
          { concurrency: 2 },
        )

        expect(claims.filter((value) => value.dispatchAllowed)).toHaveLength(1)
        const store = yield* JevEvaluationStore
        yield* persistEvaluationFixture(store, request, receipt)
        expect((yield* store.read(request.requestId))?.receipt).toEqual(receipt)
      }),
    ))

  test.each([0.9, 0.1])('native evaluator commits base presence %s before dependent Jev inference', async (presence) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        // beforeEach already admitted this exact replay graph. Rebuilding the
        // schema here repeats every migration inside the evaluator's test budget.
        const dispatch = initialDispatch
        if (dispatch === undefined) throw new Error('Missing initial replay admission')
        const request = dispatch.request
        expect(request).toEqual(defaultRequest)
        const events: string[] = []
        const result = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(evaluateAdmittedFixture(dispatch)),
          Effect.provideService(
            JevClient,
            entryProviderFixture(
              {
                evaluate: (raw) =>
                  Effect.gen(function* () {
                    const prepared = Result.getOrThrow(prepareJevRequest(raw))
                    const [stored] = yield* sql`SELECT payload #>> '{disposition,jevRequestHash}' AS request_hash
          FROM jev_inference_handoffs WHERE request_id=${request.requestId}`.pipe(Effect.orDie)
                    expect(stored?.['request_hash']).toBe(prepared.requestHash)
                    if (presence <= 0.3)
                      expect(
                        Object.keys(prepared.request.questions).some((name) => name.includes('base_breakout')),
                      ).toBe(false)
                    events.push('jev-after-committed-handoff')
                    return nativeJevInference(
                      prepared.request,
                      utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                    )
                  }),
              },
              {
                evaluate: (raw) =>
                  Effect.gen(function* () {
                    events.push(events.length === 0 ? 'chart' : 'base-start')
                    const inference = nativeChartInference(
                      raw,
                      utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                    )
                    if (!('base_present' in inference.response.answers)) return inference
                    const response = {
                      ...inference.response,
                      answers: {
                        ...inference.response.answers,
                        base_present: { type: 'noul' as const, noul: presence },
                      },
                    }
                    return { ...inference, response, responseHash: Result.getOrThrow(canonicalHashV1Result(response)) }
                  }),
              },
            ),
          ),
          Effect.provide(TestClock.layer()),
        )
        expect(events).toEqual(
          presence <= 0.3 ? ['chart', 'jev-after-committed-handoff'] : ['chart', 'jev-after-committed-handoff'],
        )
        expect(result.inference.jev.status).toBe('RECEIVED')
        expect(
          yield* sql`SELECT payload->>'reason' AS reason FROM jev_staged_skip_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([])
        expect((yield* (yield* JevEvaluationStore).read(request.requestId))?.receipt).toEqual(result.receipt)
      }),
    ),
  )
  test('rejects a receipt with no committed handoff', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        expect(Result.isFailure(yield* persistEvaluationFixture(store, request, receipt).pipe(Effect.result))).toBe(
          true,
        )
        expect((yield* store.read(request.requestId))?.receipt).toBeNull()
      }),
    ))

  test('rejects a retired handoff contract for a current input without creating provider evidence', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const { handoffHash: _, ...current } = completion.handoff
        const material = { ...current, schemaVersion: 'bayn.entry-handoff.v1' }
        const historical = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
        const rejected = yield* sql`INSERT INTO jev_inference_handoffs (request_id,handoff_hash,payload)
          VALUES (${request.requestId},${historical.handoffHash},${sql.json(historical)})`.pipe(Effect.result)
        if (Result.isSuccess(rejected)) throw new Error('A retired handoff was attached to current inference')
        yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
          rejected.failure.reason.cause,
        )
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([])
      }),
    ))

  test('atomically commits the source-infeasible handoff and receipt without provider evidence', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sourceFixture = nativeJevFixture(
          JevPurpose.Entry,
          request.observedAt,
          fixture.portfolio.brokerState.account.accountId,
          { ...fixture.protocol, maximumGrossWeight: 0.000001, maximumSymbolWeight: 0.000001 },
          'e'.repeat(64),
        )
        const sourceBatch = yield* Effect.fromResult(
          makeJevTradingSignalBatch({
            observation: sourceFixture.observation.payload,
            expiresAt: request.expiresAt,
            planVersion: JevBatchPlanVersion.V8,
          }),
        )
        const planned = sourceBatch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
        if (planned?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing source-infeasible request')
        const source = planned.request
        yield* (yield* CycleStore).acquire(sourceFixture.draft, source.observedAt)
        yield* (yield* CandidateObservationStore).record(sourceFixture.observation)
        yield* TestClock.setTime(Date.parse(source.observedAt)).pipe(
          Effect.andThen(
            Effect.flatMap(JevBatchStore, (store) => store.begin(sourceBatch, sourceFixture.observation.payload)),
          ),
          Effect.provide(TestClock.layer()),
        )
        const chart = yield* Effect.fromResult(makeNativeChartEvidence(source.request.chartSource))
        const visual = yield* Effect.fromResult(
          makeInitialChartStageRequest({
            chart,
            protocol: source.request.protocol,
            funding: source.request.funding,
          }),
        )
        const material = {
          schemaVersion: 'bayn.entry-handoff.v5',
          requestId: source.requestId,
          inputHash: source.requestHash,
          visualRequestHash: visual.requestHash,
          recordedAt: source.observedAt,
          disposition: { status: 'SOURCE_INFEASIBLE' },
        }
        const handoff = yield* Effect.fromResult(
          decodeEntryHandoff(
            {
              requestId: source.requestId,
              input: source.request,
              observedAt: source.observedAt,
              expiresAt: source.expiresAt,
            },
            { ...material, handoffHash: yield* Effect.fromResult(canonicalHashV1Result(material)) },
          ),
        )
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION reject_test_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'simulated handoff write failure'; END
        $$`
        yield* sql`CREATE TRIGGER reject_test_handoff BEFORE INSERT ON jev_inference_handoffs
          FOR EACH ROW EXECUTE FUNCTION reject_test_handoff()`
        expect(
          Result.isFailure(yield* persistHandoffFixture(yield* EntryInferenceJournal, handoff).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* sql`SELECT skip_hash FROM jev_staged_skip_receipts WHERE request_id=${source.requestId}`).toEqual(
          [],
        )
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${source.requestId}`,
        ).toEqual([])
        yield* sql`DROP TRIGGER reject_test_handoff ON jev_inference_handoffs`
        yield* sql`DROP FUNCTION reject_test_handoff()`
        yield* persistHandoffFixture(yield* EntryInferenceJournal, handoff)
        expect(yield* sql`SELECT skip_hash FROM jev_staged_skip_receipts WHERE request_id=${source.requestId}`).toEqual(
          [],
        )
        const receipt = yield* Effect.fromResult(
          makeJevEvaluationReceipt(source, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: source.requestId,
            startedAt: source.observedAt,
            completedAt: source.observedAt,
            outcome: {
              status: JevOutcome.Completed,
              completion: { handoff, completedAt: source.observedAt, jev: { status: 'NOT_REQUESTED' } },
            },
          }),
        )
        expect((yield* persistEvaluationFixture(yield* JevEvaluationStore, source, receipt)).status).toBe(
          JevResolutionStatus.Recorded,
        )
        expect((yield* (yield* JevEvaluationStore).read(source.requestId))?.receipt).toEqual(receipt)
        expect(
          yield* sql`SELECT payload->>'schemaVersion' AS version,payload#>>'{disposition,status}' AS status
          FROM jev_inference_handoffs WHERE request_id=${source.requestId}`,
        ).toEqual([{ version: 'bayn.entry-handoff.v5', status: 'SOURCE_INFEASIBLE' }])
      }),
    ))

  test('retains late chart costs after abandonment without allowing dependent dispatch', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* retainCheckpoint(request)
        yield* store.abandon(request, request.expiresAt)
        expect(yield* persistHandoffFixture(yield* EntryInferenceJournal, completion.handoff)).toEqual({
          dispatchAllowed: false,
        })
        const sql = yield* PgClient.PgClient
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([{ handoff_hash: completion.handoff.handoffHash }])
        expect((yield* store.read(request.requestId))?.resolution?.status).toBe(JevResolutionStatus.Abandoned)
      }),
    ))

  test('freezes a partial chart expense and later adds Jev cost without duplicating the chart', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const evaluations = yield* JevEvaluationStore
        yield* retainCheckpoint(request)
        yield* persistHandoffFixture(yield* EntryInferenceJournal, completion.handoff)
        yield* evaluations.abandon(request, request.expiresAt)
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const tariff = {
          ...inferenceExpenseRateCard,
          rates: inferenceExpenseRateCard.rates.map((rate) => ({ ...rate, effectiveFrom: '1970-01-01T00:00:00.000Z' })),
        }
        const first = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (first === undefined) throw new Error('Missing partial inference expense source')
        const partial = Result.getOrThrow(makeInferenceExpenseQuotes(first, tariff))
        expect(Result.getOrThrow(buildInferenceExpensePlan(partial)).transfers).toHaveLength(1)
        yield* expenses.freeze(partial)
        expect((yield* expenses.newSources).filter((source) => source.requestId === request.requestId)).toEqual([])
        expect(yield* expenses.pending).toHaveLength(2)
        yield* persistEvaluationFixture(evaluations, request, receipt)
        const next = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (next === undefined) throw new Error('Missing late Jev expense source')
        const complete = Result.getOrThrow(makeInferenceExpenseQuotes(next, tariff))
        const chart = (quotes: typeof partial) =>
          quotes.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart)
        expect(chart(complete)?.quoteHash).toBe(chart(partial)?.quoteHash)
        yield* expenses.freeze(complete)
        const pending = yield* expenses.pending
        expect(pending).toHaveLength(3)
        expect(Result.getOrThrow(buildInferenceExpensePlan(pending)).transfers).toHaveLength(2)
        expect((yield* expenses.newSources).filter((source) => source.requestId === request.requestId)).toEqual([])
      }),
    ))

  test('rejects a zero-cost receipt for an admitted CHART claim and retains unknown expense coverage', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const undispatched = Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: request.expiresAt,
            outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
          }),
        )
        const evaluations = yield* JevEvaluationStore
        expect(
          Result.isFailure(yield* persistEvaluationFixture(evaluations, request, undispatched).pipe(Effect.result)),
        ).toBe(true)
        expect((yield* evaluations.read(request.requestId))?.receipt).toBeNull()
        yield* evaluations.abandon(request, request.expiresAt)
        const sql = yield* PgClient.PgClient
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const current = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (current === undefined) throw new Error('Missing undispatched source')
        const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(current, inferenceExpenseRateCard))
        expect(
          quotes.every(
            (quote) => quote.line.usageStatus === 'UNKNOWN_USAGE' && quote.line.estimatedCostPicoUsd === null,
          ),
        ).toBe(true)
        yield* expenses.freeze(quotes)
        expect(yield* expenses.pending).toHaveLength(2)
        expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(0)
        expect((yield* expenses.newSources).filter((source) => source.requestId === request.requestId)).toEqual([])
      }),
    ))

  const nativeLedgerTest = baynTestTigerBeetleAddress === undefined ? test.skip : test
  nativeLedgerTest('posts chart cost and late Jev cost to the real ledger exactly once across recovery', async () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = baynTestTigerBeetleAddress
          if (address === undefined || !/^127\.0\.0\.1:\d+$/.test(address))
            throw new Error('Staged expense acceptance requires an isolated loopback TigerBeetle cluster')
          const sql = yield* PgClient.PgClient
          const evaluations = yield* JevEvaluationStore
          yield* retainCheckpoint(request)
          yield* persistHandoffFixture(yield* EntryInferenceJournal, completion.handoff)
          yield* evaluations.abandon(request, request.expiresAt)
          const accountId = fixture.portfolio.brokerState.account.accountId
          const expenses = makeInferenceExpenseStore(sql, accountId, '1970-01-01')
          const tariff = {
            ...inferenceExpenseRateCard,
            rates: inferenceExpenseRateCard.rates.map((rate) => ({
              ...rate,
              effectiveFrom: '1970-01-01T00:00:00.000Z',
            })),
          }
          const client = yield* makeTigerBeetleRequestClient({
            operationTimeoutMs: 5_000,
            tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
          })
          const partial = yield* runInferenceExpensePass(expenses, client, tariff)
          expect(partial.transferCount).toBe(2)
          expect(partial.gapCount).toBe(
            batch.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested).length,
          )
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          yield* persistEvaluationFixture(evaluations, request, receipt)
          const late = yield* runInferenceExpensePass(expenses, client, tariff)
          expect(late.transferCount).toBe(1)
          expect(late.gapCount).toBe(0)
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          const snapshot = yield* acquireInferenceExpenseSnapshot(
            sql,
            accountId,
            fixture.draft.identity.executionSessionDate,
          ).pipe(Effect.flatMap(({ verify }) => verify))
          const ledger = yield* readInferenceExpenseLedger(
            client,
            snapshot,
            expenses.currentSession(snapshot.evidence.sessionDate),
          )
          expect(ledger.transferCount).toBe(3)
          expect(BigInt(ledger.knownEstimatedCostPicoUsd)).toBe(
            BigInt(partial.estimatedCostPicoUsd) + BigInt(late.estimatedCostPicoUsd),
          )
          expect((yield* expenses.session(snapshot.evidence.sessionDate)).every((row) => row.verifiedAt !== null)).toBe(
            true,
          )
        }),
      ),
    ),
  )

  test('rejects changed handoff bytes and mutation of committed evidence', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EntryInferenceJournal
        yield* retainCheckpoint(request)
        yield* persistHandoffFixture(journal, completion.handoff)
        expect(
          Result.isFailure(
            yield* persistHandoffFixture(journal, { ...completion.handoff, inputHash: 'f'.repeat(64) }).pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        const sql = yield* PgClient.PgClient
        expect(
          Result.isFailure(
            yield* sql`DELETE FROM jev_inference_handoffs WHERE request_id=${request.requestId}`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(Result.isFailure(yield* sql`TRUNCATE jev_inference_handoffs`.pipe(Effect.result))).toBe(true)
      }),
    ))

  const retainedRequest = (expiresAt: string) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql`DROP SCHEMA public CASCADE`
      yield* sql`CREATE SCHEMA public`
      yield* PgMigrator.run({
        loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 147))),
        table: 'schema_migrations',
      })
      yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
        VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
      yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
      yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
      VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
      const { requestId: _, ...original } = request
      const material = {
        ...original,
        schemaVersion: 'bayn.jev-evaluation-request.v1',
        expiresAt,
        request: {
          model: 'jev-1.13.0',
          state: {},
          questions: { relevant: { type: 'noul', instructions: 'Retained historical question' } },
        },
      }
      const payload = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
      yield* sql`INSERT INTO jev_evaluation_requests (request_id,cycle_id,authority_generation_hash,payload)
      VALUES (${payload.requestId},${payload.cycleId},${payload.authorityGenerationHash},${sql.json(payload)})`
      return payload
    })

  test('preserves historical request bytes while rejecting retired executable writes', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const historical = yield* retainedRequest('2000-01-01T00:00:00.000Z')
        const sql = yield* PgClient.PgClient
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`
        yield* sql.withTransaction(sequentialEntryInference)
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
        ).toEqual(before)
        const attempted = { ...historical, requestId: 'd'.repeat(64), symbol: 'AMZN' }
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_evaluation_requests (request_id,cycle_id,authority_generation_hash,payload)
      VALUES (${attempted.requestId},${attempted.cycleId},${attempted.authorityGenerationHash},${sql.json(attempted)})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_inference_handoffs (request_id,handoff_hash,payload)
      VALUES (${historical.requestId},${completion.handoff.handoffHash},${sql.json({ ...completion.handoff, requestId: historical.requestId })})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    ))

  test('refuses cutover while an original provider claim remains unexpired', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const historical = yield* retainedRequest('9999-12-31T23:59:59.999Z')
        const sql = yield* PgClient.PgClient
        expect(Result.isFailure(yield* sql.withTransaction(sequentialEntryInference).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT to_regclass('public.jev_inference_handoffs')::text AS handoff_table`).toEqual([
          { handoff_table: null },
        ])
        expect(
          yield* sql`SELECT payload FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
        ).toEqual([{ payload: historical }])
      }),
    ))

  test.each([true, false])(
    'retains funded v25 financial evidence but retires dispatch after migration 153: claimed=%s',
    async (claimed) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const historical = makeFundedEvaluationRequest(request)
          const visual = fundedChartInferenceFixture(historical.request, historical.observedAt)
          const finished = fundedCompletionFixture(historical)
          const oldReceipt = Result.getOrThrow(
            makeFundedEvaluationReceipt(historical, {
              startedAt: historical.observedAt,
              completedAt: historical.observedAt,
              outcome: { status: 'COMPLETED', completion: finished },
            }),
          )
          const claim = Result.getOrThrow(
            makeChartDispatchClaim({
              schemaVersion: 'bayn.chart-dispatch-claim.v1',
              stage: 'CHART',
              requestId: historical.requestId,
              providerRequestHash: visual.requestHash,
              claimedAt: historical.observedAt,
              expiresAt: historical.expiresAt,
            }),
          )
          const terminal = Result.getOrThrow(
            makeChartTerminalReceipt({
              schemaVersion: 'bayn.chart-terminal-receipt.v1',
              requestId: historical.requestId,
              claimHash: claim.claimHash,
              recordedAt: historical.observedAt,
              outcome: { status: 'RECEIVED', inference: visual },
            }),
          )
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id <= 152))),
            table: 'schema_migrations',
          })
          yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
          VALUES (${replayAccountId},${replaySourceHash},${historical.observedAt})`
          yield* (yield* CycleStore).acquire(fixture.draft, historical.observedAt)
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
          VALUES (${historical.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${historical.observedAt})`
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${historical.requestId},${historical.cycleId},${historical.authorityGenerationHash},${sql.json(historical)})`
          if (claimed)
            yield* sql`INSERT INTO jev_chart_dispatch_claims(request_id,claim_hash,payload)
            VALUES (${historical.requestId},${claim.claimHash},${sql.json(claim)})`
          yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',
          state_version=state_version+1,updated_at=terminal.at,terminal_at=terminal.at
          FROM terminal WHERE cycle_id=${historical.cycleId}`
          const before =
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`
          yield* sql.withTransaction(stagedChartTransport)
          yield* sql.withTransaction(marketEntryQuestions)
          expect(
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
          ).toEqual(before)
          if (!claimed) {
            expect(
              yield* sql`SELECT clock_timestamp() >= ${historical.expiresAt}::timestamptz AS wall_expired,
            execution_account_commit_now(${replayAccountId}) < ${historical.expiresAt}::timestamptz AS replay_unexpired`,
            ).toEqual([{ wall_expired: true, replay_unexpired: true }])
            const rejected = yield* sql`INSERT INTO jev_chart_dispatch_claims(request_id,claim_hash,payload)
            VALUES (${historical.requestId},${claim.claimHash},${sql.json(claim)})`.pipe(Effect.result)
            if (Result.isSuccess(rejected)) throw new Error('Retired replay chart dispatch was admitted')
            yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                code: Schema.Literal('23514'),
                message: Schema.Literal('retired chart contract cannot admit a new provider dispatch'),
              }),
            )(rejected.failure.reason.cause)
            expect(
              yield* sql`SELECT claim_hash FROM jev_chart_dispatch_claims WHERE request_id=${historical.requestId}`,
            ).toEqual([])
            return
          }
          yield* sql.withTransaction(expenseSourceQueue)
          const expenses = makeInferenceExpenseStore(sql, replayAccountId, '1970-01-01')
          const initialSource = (yield* expenses.newSources).find((value) => value.requestId === historical.requestId)
          if (initialSource === undefined) throw new Error('Missing retained funded claim')
          const initial = Result.getOrThrow(makeInferenceExpenseQuotes(initialSource, inferenceExpenseRateCard))
          expect(initial).toHaveLength(1)
          expect(initial[0]?.schemaVersion).toBe('bayn.inference-expense-quote.v3')
          yield* expenses.freeze(initial)
          yield* sql`INSERT INTO jev_chart_terminal_receipts(request_id,claim_hash,terminal_hash,payload)
          VALUES (${historical.requestId},${claim.claimHash},${terminal.terminalHash},${sql.json(terminal)})`
          yield* sql`INSERT INTO jev_inference_handoffs(request_id,handoff_hash,payload)
          VALUES (${historical.requestId},${finished.handoff.handoffHash},${sql.json(finished.handoff)})`
          yield* sql`INSERT INTO jev_evaluation_receipts(request_id,receipt_hash,payload)
          VALUES (${historical.requestId},${oldReceipt.receiptHash},${sql.json(oldReceipt)})`
          const lateSource = (yield* expenses.newSources).find((value) => value.requestId === historical.requestId)
          if (lateSource === undefined) throw new Error('Missing retained funded terminal cost')
          const late = Result.getOrThrow(makeInferenceExpenseQuotes(lateSource, inferenceExpenseRateCard))
          yield* expenses.freeze(late)
          expect(yield* expenses.pending).toHaveLength(2)
          expect(yield* expenses.newSources).toEqual([])
          const rejected =
            yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${historical.requestId},${historical.cycleId},${historical.authorityGenerationHash},${sql.json(historical)})`.pipe(
              Effect.result,
            )
          if (Result.isSuccess(rejected)) throw new Error('Retired funded request was admitted')
          yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('23514') }))(
            rejected.failure.reason.cause,
          )
        }),
      ),
  )

  test.each([
    ['image', 148, 'bayn.entry-inference-input.v1', relativeChartVolume],
    ['question', 149, 'bayn.entry-inference-input.v2', conditionalBaseAnchors],
  ] as const)(
    'retains original chart requests and rejects retired %s contract writes',
    async (_name, migrationId, retiredVersion, migration) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < migrationId))),
            table: 'schema_migrations',
          })
          yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
            VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
          yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
          yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
          const { requestId: _, ...original } = request
          const oldInput = {
            ...request.request,
            numericalState: { ...request.request.numericalState, schemaVersion: 'bayn.jev-entry-state.v22' },
            schemaVersion: retiredVersion,
            protocol: {
              ...retainedJevProtocolV39Document,
              executionModel: retainedIntradayExecutionModel,
              schemaVersion: 'bayn.jev.protocol.v24',
              entrySignalPolicy: 'openai-decisions-then-jev' as const,
              inputDefinition: 'bayn.jev-entry-state.v22' as const,
              entryQuestionPolicyHash: 'd35ee4093641285aa36385c4ab35de978de7485ff754bebb523648adf80c8939',
            },
          }
          const oldMaterial = {
            ...original,
            schemaVersion: 'bayn.jev-evaluation-request.v2',
            request: oldInput,
            requestHash: Result.getOrThrow(canonicalHashV1Result(oldInput)),
          }
          const historical = { ...oldMaterial, requestId: Result.getOrThrow(canonicalHashV1Result(oldMaterial)) }
          yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${historical.requestId}, ${historical.cycleId}, ${historical.authorityGenerationHash}, ${sql.json(historical)})`
          yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
          state_version = state_version + 1, updated_at = terminal.at, terminal_at = terminal.at
          FROM terminal WHERE cycle_id = ${historical.cycleId}`
          const before =
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${historical.requestId}`
          yield* sql.withTransaction(migration)
          if (migrationId === 149) {
            yield* inferenceRequestVersion
            expect(
              yield* sql`SELECT schema_version FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
            ).toEqual([{ schema_version: historical.schemaVersion }])
          }
          expect(
            yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${historical.requestId}`,
          ).toEqual(before)
          const attempted = { ...historical, requestId: 'd'.repeat(64), symbol: 'AMZN' }
          const rejected =
            yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${attempted.requestId}, ${attempted.cycleId}, ${attempted.authorityGenerationHash}, ${sql.json(attempted)})`.pipe(
              Effect.result,
            )
          if (Result.isSuccess(rejected)) throw new Error('Retired chart input was accepted')
          expect(rejected.failure.reason._tag).toBe('ConstraintError')
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              code: Schema.Literal('23514'),
              constraint: Schema.Literal('jev_evaluation_requests_check'),
            }),
          )(rejected.failure.reason.cause)
        }),
      ),
  )

  test.each([
    ['relative-chart-volume', relativeChartVolume],
    ['staged-chart-transport', stagedChartTransport],
    ['market-entry-question', marketEntryQuestions],
    ['crypto-entry-ask-cap', cryptoEntryAskCap],
    ['crypto-quote-evidence', cryptoQuoteEvidence],
    ['crypto-history-context', cryptoHistoryContext],
    ['focused-entry-evidence', focusedEntryEvidence],
    ['observed-resistance', observedResistance],
    ['conditional-base-anchor', conditionalBaseAnchors],
    ['dated-execution-fee', datedExecutionFees],
    ['Jev-only', jevOnlyInference],
    ['Webull-context', webullEntryContext],
    ['effective-entry-allowance', effectiveEntryAllowanceInput],
    ['Jev Box', jevBoxInference],
  ] as const)('refuses the %s cutover while a native cycle is active', async (name, migration) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`
        const rejected = yield* sql.withTransaction(migration).pipe(Effect.result)
        if (Result.isSuccess(rejected)) throw new Error('Image contract changed while a native cycle was active')
        const native = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.Literal('55000'), message: Schema.String }),
        )(rejected.failure.reason.cause)
        expect(native.message).toContain(`${name} cutover requires terminal cycles`)
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`,
        ).toEqual(before)
      }),
    ),
  )

  test.each([
    {
      name: 'clear PAPER authority',
      state: { maximum: 'PAPER', effective: 'PAPER', kill: 'CLEAR', reason: null },
      reconciliation: 'fresh',
    },
    {
      name: 'PAPER awaiting native OBSERVE settlement',
      state: {
        maximum: 'PAPER',
        effective: 'OBSERVE',
        kill: 'ACTIVE',
        reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
      },
      reconciliation: 'fresh',
    },
    {
      name: 'OBSERVE under an operator hold',
      state: { maximum: 'OBSERVE', effective: 'OBSERVE', kill: 'ACTIVE', reason: 'operator hold' },
      reconciliation: 'fresh',
    },
    ...['missing', 'stale', 'future', 'nonexact', 'before-mutation'].map((reconciliation) => ({
      name: `clear OBSERVE with ${reconciliation} reconciliation`,
      state: { maximum: 'OBSERVE', effective: 'OBSERVE', kill: 'CLEAR', reason: null },
      reconciliation,
    })),
  ])('v39 cutover refuses $name without changing authority or retained request/claim bytes', async (scenario) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* retainCheckpoint(request)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
            UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',state_version=state_version+1,
              updated_at=terminal.at,terminal_at=terminal.at FROM terminal WHERE cycle_id=${request.cycleId}`
            yield* sql`CREATE TEMP TABLE authority_generations (generation_hash text, account_id text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE authority_state (generation_hash text, maximum text, effective text, kill_state text, reason text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE reconciliations (account_id text,status text,reconciled_at timestamptz,reconciliation_id text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE intents (intent_id text,account_id text,state text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE mutation_events (intent_id text,occurred_at timestamptz) ON COMMIT DROP`
            yield* sql`INSERT INTO authority_generations VALUES (${'a'.repeat(64)},'paper-cutover')`
            yield* sql`INSERT INTO authority_state VALUES (${'a'.repeat(64)},${scenario.state.maximum},
              ${scenario.state.effective},${scenario.state.kill},${scenario.state.reason})`
            if (scenario.reconciliation !== 'missing') {
              const ageSeconds =
                scenario.reconciliation === 'stale'
                  ? -61
                  : scenario.reconciliation === 'future'
                    ? 3600
                    : scenario.reconciliation === 'before-mutation'
                      ? -1
                      : 0
              yield* sql`INSERT INTO reconciliations VALUES ('paper-cutover',
                ${scenario.reconciliation === 'nonexact' ? 'DISCREPANCY' : 'EXACT'},
                clock_timestamp()+${ageSeconds}*interval '1 second',${'b'.repeat(64)})`
            }
            if (scenario.reconciliation === 'before-mutation') {
              yield* sql`INSERT INTO intents VALUES (${'c'.repeat(64)},'paper-cutover','TERMINAL')`
              yield* sql`INSERT INTO mutation_events VALUES (${'c'.repeat(64)},clock_timestamp())`
            }
            const authorityBefore = yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a`
            const generationsBefore = yield* sql`SELECT row_to_json(g)::text AS payload FROM authority_generations g`
            const requestsBefore = yield* sql`SELECT payload::text FROM jev_evaluation_requests ORDER BY request_id`
            const claimsBefore =
              yield* sql`SELECT payload::text FROM jev_staged_dispatch_claims ORDER BY request_id,stage`
            expect(claimsBefore.length).toBeGreaterThan(0)
            const rejected = yield* sql.withTransaction(effectiveEntryAllowanceInput).pipe(Effect.result)
            if (Result.isSuccess(rejected)) throw new Error(`The protocol cutover accepted ${scenario.name}`)
            expect(rejected.failure).toMatchObject({
              reason: {
                cause: {
                  code: '55000',
                  message: expect.stringContaining(
                    'effective-entry-allowance cutover requires terminal cycles, OBSERVE authority',
                  ),
                },
              },
            })
            expect(yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a`).toEqual(authorityBefore)
            expect(yield* sql`SELECT row_to_json(g)::text AS payload FROM authority_generations g`).toEqual(
              generationsBefore,
            )
            expect(yield* sql`SELECT payload::text FROM jev_evaluation_requests ORDER BY request_id`).toEqual(
              requestsBefore,
            )
            expect(yield* sql`SELECT payload::text FROM jev_staged_dispatch_claims ORDER BY request_id,stage`).toEqual(
              claimsBefore,
            )
          }),
        )
      }),
    ),
  )

  test('dated fee cutover refuses a held position without changing authority', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
        UPDATE autonomous_cycles SET state='BLOCKED',terminal_reason='BLOCKED_AUTHORITY',state_version=state_version+1,
          updated_at=terminal.at,terminal_at=terminal.at FROM terminal WHERE cycle_id=${request.cycleId}`
        yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at)
        VALUES (${'1'.repeat(64)},'bayn.paper-position-snapshot.v1',${replayAccountId},${'2'.repeat(64)},${'3'.repeat(64)},1,clock_timestamp())`
        const before =
          yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a ORDER BY generation_hash`
        const result = yield* sql.withTransaction(datedExecutionFees).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            reason: {
              cause: { code: '55000', message: expect.stringContaining('dated-execution-fee cutover requires') },
            },
          })
        expect(
          yield* sql`SELECT row_to_json(a)::text AS payload FROM authority_state a ORDER BY generation_hash`,
        ).toEqual(before)
        expect(yield* sql`SELECT position_count FROM position_snapshots`).toEqual([{ position_count: 1 }])
      }),
    ))

  test.each([
    { effective: 'PAPER', kill: 'CLEAR', reason: null, changes: true },
    { effective: 'OBSERVE', kill: 'ACTIVE', reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER', changes: true },
    { effective: 'OBSERVE', kill: 'ACTIVE', reason: 'operator hold', changes: false },
    { effective: 'PAPER', kill: 'ACTIVE', reason: 'operator hold', changes: false },
    { effective: 'OBSERVE', kill: 'ACTIVE', reason: 'reconciliation discrepancy', changes: false },
  ])('restricts the changed strategy while preserving other authority holds: %j', async (state) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
            UPDATE autonomous_cycles SET state='BLOCKED', terminal_reason='BLOCKED_AUTHORITY',
              state_version=state_version+1, updated_at=terminal.at, terminal_at=terminal.at
              FROM terminal WHERE cycle_id=${request.cycleId}`
            yield* sql`CREATE TEMP TABLE authority_generations (generation_hash text, account_id text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE authority_state (
              generation_hash text,maximum text,effective text,kill_state text,reason text,version bigint,updated_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE reconciliations (
              account_id text,status text,reconciled_at timestamptz,reconciliation_id text
            ) ON COMMIT DROP`
            yield* sql`INSERT INTO authority_generations VALUES (${'a'.repeat(64)},'paper-cutover')`
            yield* sql`INSERT INTO authority_state VALUES (${'a'.repeat(64)},'PAPER',${state.effective},
              ${state.kill},${state.reason},1,clock_timestamp())`
            yield* sql`INSERT INTO reconciliations VALUES ('paper-cutover','EXACT',clock_timestamp(),${'b'.repeat(64)})`
            const before =
              yield* sql`SELECT generation_hash,maximum,effective,kill_state,reason,version::text AS version FROM authority_state`
            yield* conditionalBaseAnchors
            expect(
              yield* sql`SELECT generation_hash,maximum,effective,kill_state,reason,version::text AS version FROM authority_state`,
            ).toEqual(
              state.changes
                ? [
                    {
                      generation_hash: 'a'.repeat(64),
                      maximum: 'PAPER',
                      effective: 'OBSERVE',
                      kill_state: 'ACTIVE',
                      reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
                      version: '2',
                    },
                  ]
                : before,
            )
          }),
        )
      }),
    ),
  )
})
