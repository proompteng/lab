import equityEntryAskCap from '../../migrations/0158_equity_entry_ask_cap'
import marketEntryQuestions from '../../migrations/0154_market_entry_questions'
import cryptoEntryAskCap from '../../migrations/0157_crypto_entry_ask_cap'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { PgMigrator } from '@effect/sql-pg'
import { Clock, Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import sequentialEntryInference from '../../migrations/0147_sequential_entry_inference'
import relativeChartVolume from '../../migrations/0148_relative_chart_volume'
import conditionalBaseAnchors from '../../migrations/0149_conditional_base_anchors'
import inferenceRequestVersion from '../../migrations/0150_inference_request_version'
import chartDispatchCheckpoints from '../../migrations/0151_chart_dispatch_checkpoints'

import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { EntryInferenceJournal } from '../jev/entry-inference'
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
import { makeStagedDispatchClaim, makeStagedTerminalReceipt, makeStagedSkipReceipt } from '../jev/staged-checkpoint'
import stagedChartTransport from '../../migrations/0153_staged_chart_transport'
import { retainedStagedQuestionPolicyHash } from '../jev/staged-inference-cost-evidence'
import { DecisionsClient } from '../jev/decisions'
import { JevClient } from '../jev/client'
import { prepareJevRequest } from '../jev/contract'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevEvaluationStore, evaluateClaimedJevOnce } from '../jev/evaluation'
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
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { postgresMigrations } from './postgres-migrations'
import { migrationLoader } from './migrations'
import { canonicalHashV1Result } from '../hash'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes, buildInferenceExpensePlan } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { InferenceStage } from '../inference-costs'
import { JevFailure } from '../jev/contract'
import { runInferenceExpensePass } from '../inference-expense-runtime'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'

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
    planVersion: JevBatchPlanVersion.V7,
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
  schemaVersion: 'bayn.entry-inference-input.v3' as const,
  protocol: {
    ...request.request.protocol,
    schemaVersion: 'bayn.jev.protocol.v24' as const,
    entryQuestionPolicyHash: retainedConditionalQuestionPolicyHash,
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
const expiredFixture = nativeJevFixture()
const expiredBatch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: expiredFixture.observation.payload,
    expiresAt: new Date(
      Date.parse(expiredFixture.observation.payload.observedAt) + expiredFixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V7,
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
      yield* journal.recordVisualClaim(claim)
      const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
      if (terminal !== undefined) yield* journal.recordVisualTerminal(terminal)
    }
    for (const skip of checkpoint.skips) yield* journal.recordBaseStartSkip(skip)
  })
const retainReplayRequest = Effect.gen(function* () {
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
  yield* TestClock.setTime(Date.parse(current.observedAt)).pipe(
    Effect.andThen(
      Effect.flatMap(JevBatchStore, (store) => store.begin(replayBatch, replayFixture.observation.payload)),
    ),
    Effect.provide(TestClock.layer()),
  )
  return current
})

integration('committed sequential provider handoff', () => {
  let runtime: ReturnType<typeof makeRuntime>
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
        if (fixture.portfolio.brokerState.account.accountId === replayAccountId)
          yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
            VALUES (${replayAccountId},${replaySourceHash},${request.observedAt})`
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
        yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(Effect.flatMap(JevBatchStore, (store) => store.begin(batch, fixture.observation.payload))),
          Effect.provide(TestClock.layer()),
        )
      }),
    )
  beforeEach(() => resetDatabase())

  test.each([
    [157, cryptoEntryAskCap, 'bayn.jev.protocol.v26'],
    [158, equityEntryAskCap, 'bayn.jev.protocol.v27'],
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
          const input = {
            ...request.request,
            protocol: { ...request.request.protocol, schemaVersion: retiredProtocol },
          }
          const material = { ...current, request: input, requestHash: Result.getOrThrow(canonicalHashV1Result(input)) }
          const original = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
          yield* sql`INSERT INTO jev_evaluation_requests(request_id,cycle_id,authority_generation_hash,payload)
          VALUES (${original.requestId},${original.cycleId},${original.authorityGenerationHash},${sql.json(original)})`
          const checkpoint = stagedCheckpointFixture(original)
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
          expect(failure.message).toContain('retired entry protocol')
          yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${original.requestId},'CHART',${late.claimHash},${late.terminalHash},${sql.json(late)})`
          expect(
            yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${original.requestId}`,
          ).toEqual([{ payload: late }])
        }),
      ),
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
          protocol: {
            ...request.request.protocol,
            schemaVersion: 'bayn.jev.protocol.v26',
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

  test('one chart admission survives a crash and later metering upgrades discovery without double charging', async () => {
    await resetDatabase(true, expiredFixture, expiredRequest, expiredBatch)
    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const journal = yield* EntryInferenceJournal
        const request = expiredRequest
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
        expect(yield* journal.recordVisualClaim(expiredClaim)).toEqual({ dispatchAllowed: false })
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
        const admissions = yield* Effect.all([journal.recordVisualClaim(claim), journal.recordVisualClaim(claim)], {
          concurrency: 2,
        })
        expect(admissions.filter((value) => value.dispatchAllowed)).toHaveLength(1)
        expect(Result.isFailure(yield* sql.withTransaction(journal.recordVisualClaim(claim)).pipe(Effect.result))).toBe(
          true,
        )
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
          [{ stage: 'BASE_START' }, '23503'],
          [{ stageClaimHash: 'a'.repeat(64) }, '23503'],
          [{ stageTerminalHash: 'b'.repeat(64) }, '23503'],
          [{ stageSkipHash: 'c'.repeat(64) }, '23514'],
          [{ stageClaimHash: null, stageSkipHash: 'c'.repeat(64) }, '23503'],
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
        yield* journal.recordVisualTerminal(terminal)
        yield* journal.recordVisualTerminal(terminal)
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
        expect(saved).toHaveLength(4)
        expect((yield* store.pending).filter((quote) => quote.line.requestId === current.requestId)).toHaveLength(4)
        expect(Result.getOrThrow(buildInferenceExpensePlan([...initial, ...late])).transfers).toHaveLength(1)
        const { terminalHash: __, ...terminalMaterial } = terminal
        const conflict = Result.getOrThrow(
          makeStagedTerminalReceipt({ ...terminalMaterial, recordedAt: current.expiresAt }),
        )
        expect(Result.isFailure(yield* journal.recordVisualTerminal(conflict).pipe(Effect.result))).toBe(true)
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

  test(
    'admits base start once only after its exact committed predecessor and rejects skipped or expired dispatch',
    async () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const journal = yield* EntryInferenceJournal
          const checkpoint = stagedCheckpointFixture(request)
          const chart = checkpoint.claims.find((row) => row.stage === 'CHART')
          const terminal = checkpoint.terminals.find((row) => row.stage === 'CHART')
          const base = checkpoint.claims.find((row) => row.stage === 'BASE_START')
          if (chart === undefined || terminal === undefined || base === undefined)
            throw new Error('Missing staged fixture')
          expect(Result.isFailure(yield* journal.recordVisualClaim(base).pipe(Effect.result))).toBe(true)
          expect(yield* journal.recordVisualClaim(chart)).toEqual({ dispatchAllowed: true })
          yield* journal.recordVisualTerminal(terminal)
          const { claimHash: _hash, ...material } = base
          const changed = Result.getOrThrow(makeStagedDispatchClaim({ ...material, selectedEnd: 'wrong-end' }))
          expect(Result.isFailure(yield* journal.recordVisualClaim(changed).pipe(Effect.result))).toBe(true)
          expect(
            Result.isFailure(
              yield* sql`INSERT INTO jev_staged_dispatch_claims (request_id,stage,claim_hash,payload)
        VALUES (${changed.requestId},${changed.stage},${changed.claimHash},${sql.json(changed)})`.pipe(Effect.result),
            ),
          ).toBe(true)
          const attempts = yield* Effect.all([journal.recordVisualClaim(base), journal.recordVisualClaim(base)], {
            concurrency: 2,
          })
          expect(attempts.filter((value) => value.dispatchAllowed)).toHaveLength(1)
          const skip = Result.getOrThrow(
            makeStagedSkipReceipt({
              schemaVersion: 'bayn.staged-skip-receipt.v1',
              stage: 'BASE_START',
              requestId: request.requestId,
              predecessorHash: terminal.terminalHash,
              reason: 'NO_BASE',
              recordedAt: request.observedAt,
            }),
          )
          expect(Result.isFailure(yield* journal.recordBaseStartSkip(skip).pipe(Effect.result))).toBe(true)
          expect(
            Result.isFailure(
              yield* sql`INSERT INTO jev_staged_skip_receipts (request_id,stage,skip_hash,payload)
        VALUES (${skip.requestId},${skip.stage},${skip.skipHash},${sql.json(skip)})`.pipe(Effect.result),
            ),
          ).toBe(true)
          // A new isolated request graph proves an original-deadline boundary, not a renewed lease.
          const fresh = yield* retainReplayRequest
          const freshCheckpoint = stagedCheckpointFixture(fresh)
          const first = freshCheckpoint.claims.find((row) => row.stage === 'CHART')
          const firstTerminal = freshCheckpoint.terminals.find((row) => row.stage === 'CHART')
          const successor = freshCheckpoint.claims.find((row) => row.stage === 'BASE_START')
          if (first === undefined || firstTerminal === undefined || successor === undefined)
            throw new Error('Missing staged fixture')
          yield* journal.recordVisualClaim(first)
          yield* journal.recordVisualTerminal(firstTerminal)
          yield* sql`UPDATE simulated_execution_clocks SET observed_at=${fresh.expiresAt} WHERE account_id=${replayAccountId}`
          expect(yield* journal.recordVisualClaim(successor)).toEqual({ dispatchAllowed: false })
          expect(
            Result.isFailure(
              yield* sql`INSERT INTO jev_staged_dispatch_claims (request_id,stage,claim_hash,payload)
        VALUES (${successor.requestId},${successor.stage},${successor.claimHash},${sql.json(successor)})`.pipe(
                Effect.result,
              ),
            ),
          ).toBe(true)
        }),
      ),
    30_000,
  )

  test('commits the exact handoff once and binds the completed receipt to it', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EntryInferenceJournal
        yield* retainCheckpoint(request)
        const claims = yield* Effect.all(
          [journal.recordHandoff(completion.handoff), journal.recordHandoff(completion.handoff)],
          { concurrency: 2 },
        )

        expect(claims.filter((value) => value.dispatchAllowed)).toHaveLength(1)
        const store = yield* JevEvaluationStore
        yield* store.record(request, receipt)
        expect((yield* store.read(request.requestId))?.receipt).toEqual(receipt)
      }),
    ))

  test('runs the native evaluator through committed chart evidence before dependent Jev inference', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const request = yield* retainReplayRequest
        const events: string[] = []
        const result = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(evaluateClaimedJevOnce({ request, claimedAt: request.observedAt })),
          Effect.provideService(DecisionsClient, {
            evaluate: (raw) =>
              Effect.gen(function* () {
                events.push(events.length === 0 ? 'chart' : 'base-start')
                return nativeChartInference(raw, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
              }),
          }),
          Effect.provideService(JevClient, {
            evaluate: (raw) =>
              Effect.gen(function* () {
                const prepared = Result.getOrThrow(prepareJevRequest(raw))
                const [stored] = yield* sql`SELECT payload #>> '{disposition,jevRequestHash}' AS request_hash
          FROM jev_inference_handoffs WHERE request_id=${request.requestId}`.pipe(Effect.orDie)
                expect(stored?.['request_hash']).toBe(prepared.requestHash)
                events.push('jev-after-committed-handoff')
                return nativeJevInference(prepared.request, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
              }),
          }),
          Effect.provide(TestClock.layer()),
        )
        expect(events).toEqual(['chart', 'base-start', 'jev-after-committed-handoff'])
        expect(result.inference.jev.status).toBe('RECEIVED')
        expect((yield* (yield* JevEvaluationStore).read(request.requestId))?.receipt).toEqual(result.receipt)
      }),
    ))
  test('rejects a receipt with no committed handoff', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        expect(Result.isFailure(yield* store.record(request, receipt).pipe(Effect.result))).toBe(true)
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

  test('commits the current source-infeasible handoff and receipt without provider evidence', async () =>
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
            planVersion: JevBatchPlanVersion.V7,
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
        const skip = Result.getOrThrow(
          makeStagedSkipReceipt({
            schemaVersion: 'bayn.staged-skip-receipt.v1',
            stage: 'BASE_START',
            requestId: source.requestId,
            predecessorHash: null,
            reason: 'SOURCE_INFEASIBLE',
            recordedAt: source.observedAt,
          }),
        )
        const material = {
          schemaVersion: 'bayn.entry-handoff.v4',
          baseStart: { status: 'NOT_REQUESTED', skip },
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
        yield* (yield* EntryInferenceJournal).recordBaseStartSkip(skip)
        yield* (yield* EntryInferenceJournal).recordHandoff(handoff)
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
        expect((yield* (yield* JevEvaluationStore).record(source, receipt)).status).toBe(JevResolutionStatus.Recorded)
        expect((yield* (yield* JevEvaluationStore).read(source.requestId))?.receipt).toEqual(receipt)
        expect(
          yield* sql`SELECT payload->>'schemaVersion' AS version,payload#>>'{disposition,status}' AS status
          FROM jev_inference_handoffs WHERE request_id=${source.requestId}`,
        ).toEqual([{ version: 'bayn.entry-handoff.v4', status: 'SOURCE_INFEASIBLE' }])
      }),
    ))

  test('retains late chart costs after abandonment without allowing dependent dispatch', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* retainCheckpoint(request)
        yield* store.abandon(request, request.expiresAt)
        expect(yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)).toEqual({
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
        yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)
        yield* evaluations.abandon(request, request.expiresAt)
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const tariff = {
          ...inferenceExpenseRateCard,
          rates: inferenceExpenseRateCard.rates.map((rate) => ({ ...rate, effectiveFrom: '1970-01-01T00:00:00.000Z' })),
        }
        const first = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (first === undefined) throw new Error('Missing partial inference expense source')
        const partial = Result.getOrThrow(makeInferenceExpenseQuotes(first, tariff))
        expect(Result.getOrThrow(buildInferenceExpensePlan(partial)).transfers).toHaveLength(2)
        yield* expenses.freeze(partial)
        expect(yield* expenses.newSources).toEqual([])
        expect(yield* expenses.pending).toHaveLength(3)
        yield* evaluations.record(request, receipt)
        const next = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (next === undefined) throw new Error('Missing late Jev expense source')
        const complete = Result.getOrThrow(makeInferenceExpenseQuotes(next, tariff))
        const chart = (quotes: typeof partial) =>
          quotes.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart)
        expect(chart(complete)?.quoteHash).toBe(chart(partial)?.quoteHash)
        yield* expenses.freeze(complete)
        const pending = yield* expenses.pending
        expect(pending).toHaveLength(4)
        expect(Result.getOrThrow(buildInferenceExpensePlan(pending)).transfers).toHaveLength(3)
        expect(yield* expenses.newSources).toEqual([])
      }),
    ))

  test('stores separate zero-cost quotes for all three stages when the original claim expired before dispatch', async () =>
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
        yield* (yield* JevEvaluationStore).record(request, undispatched)
        const sql = yield* PgClient.PgClient
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const current = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (current === undefined) throw new Error('Missing undispatched source')
        const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(current, inferenceExpenseRateCard))
        yield* expenses.freeze(quotes)
        expect(yield* expenses.pending).toHaveLength(3)
        expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(0)
        expect(yield* expenses.newSources).toEqual([])
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
          yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)
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
          expect(partial.gapCount).toBe(1)
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          yield* evaluations.record(request, receipt)
          const late = yield* runInferenceExpensePass(expenses, client, tariff)
          expect(late.transferCount).toBe(1)
          expect(late.gapCount).toBe(0)
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          const snapshot = yield* readInferenceExpenseSnapshot(
            sql,
            accountId,
            fixture.draft.identity.executionSessionDate,
          )
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
        yield* journal.recordHandoff(completion.handoff)
        expect(
          Result.isFailure(
            yield* journal.recordHandoff({ ...completion.handoff, inputHash: 'f'.repeat(64) }).pipe(Effect.result),
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
            schemaVersion: retiredVersion,
            protocol: {
              ...request.request.protocol,
              schemaVersion: 'bayn.jev.protocol.v24',
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
    ['conditional-base-anchor', conditionalBaseAnchors],
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
