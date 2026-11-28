import { beginRecordedJevBatch } from '../jev/batch-admission.test-support'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import nonDispatchEvidence from '../../migrations/0201_not_dispatched_visual_evidence'
import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { canonicalHashV1Result } from '../hash'
import { buildInferenceExpensePlan, inferenceExpenseRateCard, makeInferenceExpenseQuotes } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { JevClient } from '../jev/client'
import { evaluateClaimedEntryInferences } from '../jev/entry-inference-batch'
import { JevCandidatePlanStatus, JevBatchPlanVersion } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { StagedTerminalReceiptSchema } from '../jev/staged-checkpoint'
import { defaultJevProtocolDocument, retainedJevProtocolV41Document } from '../jev/protocol'
import { nativeJevFixture } from '../jev/native.test-support'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { migrationLoader } from './migrations'

const integration = baynTestPostgresUrl === undefined ? test.skip : test
const url = baynTestPostgresUrl ?? 'postgresql://postgres@127.0.0.1:55432/bayn_non_dispatch_test'
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('Visual non-dispatch migration requires an isolated local _test database')
const layer = Layer.mergeAll(
  CycleStoreLive,
  CandidateObservationStoreLive,
  JevBatchStoreLive,
  EntryInferenceJournalLive,
  JevEvaluationStoreLive,
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 2 })),
  Layer.provideMerge(NodeServices.layer),
)
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const signed = <A extends object>(material: A) => ({ ...material, quoteHash: hash(material) })

const retain = (account: string, protocol: unknown = defaultJevProtocolDocument) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const fixture = nativeJevFixture(undefined, undefined, account, protocol)
    const observedAt = fixture.observation.payload.observedAt
    const batch = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: fixture.observation.payload,
        expiresAt: new Date(Date.parse(observedAt) + fixture.protocol.inferenceValidityMs).toISOString(),
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const candidate = batch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing native request')
    const request = candidate.request
    yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
      VALUES (${account},${account.slice('replay-'.length)},${observedAt})`
    yield* (yield* CycleStore).acquire(fixture.draft, observedAt)
    yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
      VALUES (${request.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${observedAt})
      ON CONFLICT DO NOTHING`
    const r = fixture.portfolio.brokerState.reconciliation
    yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,
      content_hash,status,discrepancies,reconciled_at)
      VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${r.expectedHash},${r.observedHash},
        ${r.contentHash},${r.status},'[]'::jsonb,${r.reconciledAt})`
    yield* (yield* CandidateObservationStore).record(fixture.observation)
    const store = yield* JevBatchStore
    const admission = yield* TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(beginRecordedJevBatch(store, batch, fixture.observation.payload)),
      Effect.provide(TestClock.layer()),
    )
    const claim = admission.dispatches?.find(
      (dispatch) => dispatch.request.requestId === request.requestId,
    )?.visualClaim
    if (claim == null) throw new Error('Missing original provider claim')
    const next = batch.candidates.find(
      (value) => value.status === JevCandidatePlanStatus.Requested && value.request.requestId !== request.requestId,
    )
    if (next?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing second native request')
    const nextClaim = admission.dispatches?.find(
      (dispatch) => dispatch.request.requestId === next.request.requestId,
    )?.visualClaim
    if (nextClaim == null) throw new Error('Missing second original claim')
    return {
      request,
      claim,
      account,
      rights: admission.dispatches,
      batchId: batch.batchId,
      dispatches: admission.dispatches?.map((dispatch) => ({
        requestId: dispatch.request.requestId,
        claimedAt: dispatch.claimedAt,
        visualClaim: dispatch.visualClaim,
      })),
      alternate: { request: next.request, claim: nextClaim, account },
    }
  })

integration(
  'native expired dispatch journals and freezes both verified zero-cost stages without provider work',
  async () => {
    let providerCalls = 0
    const provider = Layer.succeed(JevClient, {
      evaluate: () =>
        Effect.sync(() => {
          providerCalls += 1
        }).pipe(Effect.andThen(Effect.die('Unexpected provider dispatch'))),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })
        const native = yield* retain(`replay-${'7'.repeat(64)}`)
        if (native.rights === null) throw new Error('Missing native dispatch rights')
        const lateAt = new Date(Date.parse(native.request.expiresAt) + 223).toISOString()
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${lateAt} WHERE account_id=${native.account}`
        const result = yield* TestClock.setTime(Date.parse(lateAt)).pipe(
          Effect.andThen(evaluateClaimedEntryInferences(native.rights).pipe(Effect.result)),
          Effect.provide(TestClock.layer()),
        )
        if (Result.isSuccess(result)) throw new Error('Expired native dispatch succeeded')
        expect(result.failure).toMatchObject({ _tag: 'EntryInferenceError', category: 'DEADLINE' })
        expect(providerCalls).toBe(0)
        const requests = native.rights.map((right) => right.request.requestId).sort()
        const terminals = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              request_id: Schema.String,
              payload: StagedTerminalReceiptSchema,
            }),
          ),
        )(yield* sql`SELECT request_id,payload FROM jev_staged_terminal_receipts ORDER BY request_id`)
        expect(terminals.map((row) => row.request_id)).toEqual(requests)
        expect(terminals.every((row) => row.payload.schemaVersion === 'bayn.staged-terminal-receipt.v2')).toBe(true)
        const store = makeInferenceExpenseStore(sql, native.account, '1970-01-01')
        const sources = yield* store.newSources
        expect(sources.map((source) => source.requestId).sort()).toEqual(requests)
        const quotes = sources.flatMap((source) =>
          Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard)),
        )
        expect(quotes).toHaveLength(requests.length * 2)
        expect(quotes.every((quote) => quote.schemaVersion === 'bayn.inference-expense-quote.v5')).toBe(true)
        expect(
          quotes.every(
            (quote) => quote.line.usageStatus === 'NOT_DISPATCHED' && quote.line.estimatedCostPicoUsd === '0',
          ),
        ).toBe(true)
        expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toEqual([])
        yield* store.freeze(quotes)
        const pending = yield* store.pending
        expect(pending.map((quote) => quote.quoteHash).sort()).toEqual(quotes.map((quote) => quote.quoteHash).sort())
        expect(yield* store.newSources).toEqual([])
        yield* store.acknowledge(pending)
        const saved = yield* store.session(native.request.observedAt.slice(0, 10))
        expect(saved.map(({ quote }) => quote.quoteHash).sort()).toEqual(quotes.map((quote) => quote.quoteHash).sort())
        expect(saved.every((row) => row.verifiedAt !== null)).toBe(true)
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_inference_handoffs`).toEqual([{ count: 0 }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([{ count: 0 }])
        expect(providerCalls).toBe(0)
      }).pipe(Effect.provide(provider), Effect.provide(layer)),
    )
  },
  60_000,
)

integration.each(['ORIGINAL_EXPIRY', 'ADMISSION_EXPIRY'] as const)(
  'keeps retained evidence and requires positive %s proof for both undispatched stages',
  async (reason) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id <= 200))),
          table: 'schema_migrations',
        })
        const legacy = yield* retain(`replay-${'5'.repeat(64)}`, retainedJevProtocolV41Document)
        const legacyQuote = signed({
          schemaVersion: 'bayn.inference-expense-quote.v4',
          accountBindingHash: hash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId: legacy.account }),
          sessionDate: legacy.request.observedAt.slice(0, 10),
          line: {
            requestId: legacy.request.requestId,
            cycleId: legacy.request.cycleId,
            model: 'jev-1.14.0',
            purpose: 'ENTRY',
            receiptHash: null,
            resolutionHash: null,
            handoffHash: null,
            usageStatus: 'UNKNOWN_USAGE',
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            rateHash: null,
            estimatedCostPicoUsd: null,
            stage: 'CHART',
            stageClaimHash: legacy.claim.claimHash,
            stageTerminalHash: null,
            stageSkipHash: null,
          },
          rate: null,
        })
        yield* sql`INSERT INTO inference_expense_quotes(quote_hash,account_id,session_date,payload)
          VALUES (${legacyQuote.quoteHash},${legacy.account},${legacyQuote.sessionDate}::date,${sql.json(legacyQuote)})`
        const legacyTerminal = stagedCheckpointFixture(legacy.request).terminals[0]
        if (legacyTerminal === undefined) throw new Error('Missing retained terminal fixture')
        yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
        VALUES (${legacyTerminal.requestId},${legacyTerminal.stage},${legacyTerminal.claimHash},
          ${legacyTerminal.terminalHash},${sql.json(legacyTerminal)})`
        const before = yield* sql`SELECT payload::text AS bytes FROM jev_staged_terminal_receipts`
        const beforeQuotes = yield* sql`SELECT payload::text AS bytes FROM inference_expense_quotes ORDER BY quote_hash`
        yield* nonDispatchEvidence
        expect(yield* sql`SELECT payload::text AS bytes FROM jev_staged_terminal_receipts`).toEqual(before)
        expect(yield* sql`SELECT payload::text AS bytes FROM inference_expense_quotes ORDER BY quote_hash`).toEqual(
          beforeQuotes,
        )
        const { request, claim, account } = legacy.alternate
        const lateAt = new Date(Date.parse(request.expiresAt) + 1).toISOString()
        const deadlineAt =
          reason === 'ORIGINAL_EXPIRY'
            ? request.expiresAt
            : new Date(Date.parse(request.observedAt) + 1_000).toISOString()
        if (reason === 'ADMISSION_EXPIRY')
          yield* sql`INSERT INTO jev_inference_work(batch_id,dispatches,admission_deadline_at,claimed_at)
            VALUES (${legacy.batchId},${sql.json(legacy.dispatches)},${deadlineAt}::timestamptz,${lateAt}::timestamptz)`
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${lateAt} WHERE account_id=${account}`
        const resolutionMaterial = {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: request.requestId,
          status: 'ABANDONED',
          abandonedAt: lateAt,
        }
        const resolution = { ...resolutionMaterial, resolutionHash: hash(resolutionMaterial) }
        if (reason === 'ORIGINAL_EXPIRY')
          yield* sql`INSERT INTO jev_evaluation_resolutions(request_id,resolution_hash,payload)
            VALUES (${request.requestId},${resolution.resolutionHash},${sql.json(resolution)})`
        const common = {
          requestId: request.requestId,
          cycleId: request.cycleId,
          receiptHash: null,
          resolutionHash: reason === 'ORIGINAL_EXPIRY' ? resolution.resolutionHash : null,
          handoffHash: null,
          model: 'jev-1.14.0',
          purpose: 'ENTRY',
          usageStatus: 'UNKNOWN_USAGE',
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          rateHash: null,
          estimatedCostPicoUsd: null,
          stageSkipHash: null,
        }
        const quote = (version: string, line: object) =>
          signed({
            schemaVersion: version,
            accountBindingHash: hash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId: account }),
            sessionDate: request.observedAt.slice(0, 10),
            line,
            rate: null,
          })
        const insertQuote = (value: ReturnType<typeof quote>, accountId = account) =>
          sql`INSERT INTO inference_expense_quotes(quote_hash,account_id,session_date,payload)
          VALUES (${value.quoteHash},${accountId},${value.sessionDate}::date,${sql.json(value)})`
        const historical = [
          quote('bayn.inference-expense-quote.v4', {
            ...common,
            stage: 'CHART',
            stageClaimHash: claim.claimHash,
            stageTerminalHash: null,
          }),
          ...(reason === 'ORIGINAL_EXPIRY'
            ? [
                quote('bayn.inference-expense-quote.v4', {
                  ...common,
                  stage: 'JEV',
                  stageClaimHash: null,
                  stageTerminalHash: null,
                }),
              ]
            : []),
        ]
        for (const value of historical) yield* insertQuote(value)
        const oldQuotes = yield* sql`SELECT payload::text AS bytes FROM inference_expense_quotes ORDER BY quote_hash`
        const material = {
          schemaVersion: 'bayn.staged-terminal-receipt.v2',
          stage: 'CHART',
          requestId: request.requestId,
          claimHash: claim.claimHash,
          recordedAt: lateAt,
          outcome: {
            status: 'NOT_DISPATCHED',
            reason,
            deadlineAt,
            checkedAt: lateAt,
          },
        }
        const insertTerminal = (value: Omit<typeof material, 'outcome'> & { readonly outcome: unknown }) => {
          const terminal = { ...value, terminalHash: hash(value) }
          return sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${request.requestId},'CHART',${claim.claimHash},${terminal.terminalHash},${sql.json(terminal)})`
        }
        for (const changed of [
          { ...material, outcome: { ...material.outcome, checkedAt: request.observedAt } },
          { ...material, outcome: { ...material.outcome, deadlineAt: lateAt } },
          { ...material, outcome: { ...material.outcome, reason: 'UNKNOWN' } },
          { ...material, outcome: { ...material.outcome, extra: 'unproven' } },
          {
            ...material,
            outcome: { ...material.outcome, deadlineAt: new Date(Date.parse(request.observedAt) + 500).toISOString() },
          },
        ])
          expect(Result.isFailure(yield* insertTerminal(changed).pipe(Effect.result))).toBe(true)
        const terminalHash = hash(material)
        const zero = {
          ...common,
          usageStatus: 'NOT_DISPATCHED',
          resolutionHash: null,
          inputTokens: '0',
          outputTokens: '0',
          cachedInputTokens: '0',
          cacheWriteInputTokens: '0',
          estimatedCostPicoUsd: '0',
          notDispatchedByTerminalHash: terminalHash,
        }
        const chart = { ...zero, stage: 'CHART', stageClaimHash: claim.claimHash, stageTerminalHash: terminalHash }
        const jev = { ...zero, stage: 'JEV', stageClaimHash: null, stageTerminalHash: null }
        const rolledBack = yield* sql
          .withTransaction(
            insertTerminal(material).pipe(Effect.andThen(Effect.fail('intentional non-dispatch rollback'))),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(rolledBack)).toBe(true)
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_staged_terminal_receipts
          WHERE request_id=${request.requestId}`,
        ).toEqual([{ count: 0 }])
        expect(
          Result.isFailure(yield* insertQuote(quote('bayn.inference-expense-quote.v5', chart)).pipe(Effect.result)),
        ).toBe(true)
        expect(
          yield* sql`SELECT bool_and(payload #>> '{line,usageStatus}'='UNKNOWN_USAGE') AS unknown
          FROM inference_expense_quotes WHERE request_id=${request.requestId}`,
        ).toEqual([{ unknown: true }])
        const paidReplacement = { ...material, requestId: legacy.request.requestId, claimHash: legacy.claim.claimHash }
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_staged_terminal_receipts(request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${legacy.request.requestId},'CHART',${legacy.claim.claimHash},${hash(paidReplacement)},
            ${sql.json({ ...paidReplacement, terminalHash: hash(paidReplacement) })})`.pipe(Effect.result),
          ),
        ).toBe(true)
        yield* insertTerminal(material)
        const { handoffHash: _handoffHash, ...readyMaterial } = entryCompletionFixture(request).handoff
        if (readyMaterial.disposition.status !== 'READY') throw new Error('Expected an executable handoff fixture')
        const changedHandoff = { ...readyMaterial, recordedAt: lateAt }
        const handoff = { ...changedHandoff, handoffHash: hash(changedHandoff) }
        const rejectedHandoff = yield* sql`INSERT INTO jev_inference_handoffs(request_id,handoff_hash,payload)
          VALUES (${request.requestId},${handoff.handoffHash},${sql.json(handoff)})`.pipe(Effect.result)
        if (Result.isSuccess(rejectedHandoff)) throw new Error('READY handoff replaced positive non-dispatch evidence')
        const handoffError = yield* Schema.decodeUnknownEffect(Schema.Struct({ message: Schema.String }))(
          rejectedHandoff.failure.reason.cause,
        )
        expect(handoffError.message).toBe('Box handoff changes its committed chart outcome')
        const needsQuotes = sql`SELECT inference_expense_source_needs_quotes(${request.requestId}) AS needed`
        expect(yield* needsQuotes).toEqual([{ needed: true }])
        expect(
          Result.isFailure(
            yield* insertQuote(quote('bayn.inference-expense-quote.v5', chart), 'foreign-account').pipe(Effect.result),
          ),
        ).toBe(true)
        const { quoteHash: _quoteHash, ...quoteMaterial } = quote('bayn.inference-expense-quote.v5', chart)
        expect(
          Result.isFailure(
            yield* insertQuote(signed({ ...quoteMaterial, sessionDate: '2099-01-01' })).pipe(Effect.result),
          ),
        ).toBe(true)
        for (const forged of [
          { ...chart, notDispatchedByTerminalHash: legacyTerminal.terminalHash },
          { ...chart, stageTerminalHash: null },
          { ...chart, inputTokens: '1' },
          { ...chart, usageStatus: 'UNKNOWN_USAGE' },
          { ...jev, stage: 'BASE_START' },
          { ...jev, notDispatchedByTerminalHash: 'f'.repeat(64) },
        ])
          expect(
            Result.isFailure(yield* insertQuote(quote('bayn.inference-expense-quote.v5', forged)).pipe(Effect.result)),
          ).toBe(true)
        expect(
          Result.isFailure(yield* insertQuote(quote('bayn.inference-expense-quote.v4', chart)).pipe(Effect.result)),
        ).toBe(true)
        yield* insertQuote(quote('bayn.inference-expense-quote.v5', chart))
        expect(yield* needsQuotes).toEqual([{ needed: true }])
        yield* insertQuote(quote('bayn.inference-expense-quote.v5', jev))
        expect(yield* needsQuotes).toEqual([{ needed: false }])
        expect(
          yield* sql`SELECT payload::text AS bytes FROM inference_expense_quotes
        WHERE payload->>'schemaVersion'='bayn.inference-expense-quote.v4' ORDER BY quote_hash`,
        ).toEqual(oldQuotes)
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([{ count: 0 }])
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts WHERE request_id=${request.requestId}`,
        ).toEqual([{ count: 0 }])
      }).pipe(Effect.provide(layer)),
    )
  },
  60_000,
)
