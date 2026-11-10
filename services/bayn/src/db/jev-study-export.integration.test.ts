import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, Path, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { exportJevStudySession } from '../jev/study-export'
import { verifyJevStudyInventory } from '../jev/study-inventory'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import { makeInferenceExpenseQuotes } from '../inference-expense'
import { PostgresClientLive } from './postgres-client'

const testUrl = process.env['BAYN_TEST_POSTGRES_URL']
const postgresTest = testUrl === undefined ? test.skip : test

postgresTest(
  'exports a complete read-only cut with pending batches and rejects overwrite or corrupt source',
  async () => {
    if (testUrl === undefined) throw new Error('PostgreSQL test URL is unavailable')
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Study export tests require a local _test database')
    const schema = `study_export_${randomUUID().replaceAll('-', '')}`
    url.searchParams.set('options', `-c search_path=${schema}`)
    const protocol = defaultJevProtocolDocument
    const native = nativeJevFixture(JevPurpose.Entry, undefined, 'jev-native-test', protocol)
    const evidence = nativeJevDecisionEvidence(native)
    const laterEntry = nativeJevDecisionEvidence(
      nativeJevFixture(JevPurpose.Entry, '2026-09-04T14:31:02.000Z', 'jev-native-test', protocol),
      false,
    )
    const plan = evidence.batchPlan
    const accountId = evidence.observation.portfolio.brokerState.account.accountId
    const sessionDate = evidence.observation.manifest.sessionDate
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const fs = yield* FileSystem.FileSystem
          const paths = yield* Path.Path
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-study-export-' })
          yield* sql.unsafe(`CREATE SCHEMA ${schema}`)
          yield* Effect.addFinalizer(() => sql.unsafe(`DROP SCHEMA ${schema} CASCADE`).pipe(Effect.orDie))
          yield* sql`CREATE TABLE autonomous_cycles (
          cycle_id text PRIMARY KEY, account_id text, execution_session_date date, strategy_name text,
          strategy_protocol_hash text, state text, decision_hash text
        )`
          yield* sql`CREATE TABLE jev_batch_plans (
          batch_id text PRIMARY KEY, cycle_id text, observation_hash text, payload jsonb
        )`
          yield* sql`CREATE TABLE jev_batch_results (batch_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE intraday_candidate_observations (content_hash text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE autonomous_cycle_shadow_decisions (
            cycle_id text, decision_hash text, document jsonb, created_at timestamptz, schema_version text
          )`
          yield* sql`CREATE TABLE autonomous_cycle_paper_closures (cycle_id text, document jsonb)`
          yield* sql`CREATE TABLE autonomous_cycle_paper_close_replans (cycle_id text, document jsonb)`
          yield* sql`CREATE TABLE intents (
            intent_id text PRIMARY KEY, account_id text, client_order_id text, cycle_id text, decision_hash text,
            symbol text, side text, quantity_atoms numeric, notional_limit_micros numeric,
            replan_generation_hash text, terminal_outcome text, created_at timestamptz, updated_at timestamptz,
            authority_generation_hash text, state text, protection jsonb
          )`
          yield* sql`CREATE TABLE broker_events (
            event_id text PRIMARY KEY, source_sequence bigint, occurred_at timestamptz, observed_at timestamptz
          )`
          yield* sql`CREATE TABLE orders (
            event_id text PRIMARY KEY, schema_version text, parent_broker_order_id text, order_type text,
            time_in_force text, limit_price_micros numeric, stop_price_micros numeric,
            broker_order_id text, client_order_id text, intent_id text, account_id text, symbol text, side text,
            quantity_atoms numeric, notional_micros numeric, filled_quantity_atoms numeric, status text
          )`
          yield* sql`CREATE TABLE fills (
            event_id text PRIMARY KEY, fill_id text, broker_order_id text, client_order_id text, intent_id text,
            account_id text, symbol text, side text, quantity_atoms numeric, price_atoms numeric, fee_micros numeric,
            source_timestamp text
          )`
          yield* sql`CREATE TABLE mutation_events (
            schema_version text, event_id text, mutation_id text, intent_id text, sequence bigint, operation text,
            event_type text, request_hash text, consistency_delay_ms integer, broker_order_id text,
            request_id text, response_status integer, response_content_hash text, routing jsonb, denial_reason text,
            occurred_at timestamptz
          )`
          yield* sql`CREATE TABLE accounting_transactions (
            schema_version text, transaction_id text, broker_event_id text, intent_id text, account_id text,
            symbol text, side text, quantity_atoms numeric, price_atoms numeric, notional_micros numeric,
            fee_micros numeric, cost_basis_micros numeric, realized_pnl_micros numeric,
            quantity_delta_atoms numeric, cost_basis_delta_micros numeric, cash_delta_micros numeric,
            ledger_plan_hash text, content_hash text, occurred_at timestamptz
          )`
          yield* sql`CREATE TABLE jev_evaluation_requests (
            request_id text PRIMARY KEY, cycle_id text, authority_generation_hash text, payload jsonb, schema_version text
          )`
          yield* sql`CREATE TABLE jev_evaluation_receipts (request_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE jev_evaluation_resolutions (request_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE jev_inference_handoffs (request_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE jev_chart_dispatch_claims (request_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE jev_chart_terminal_receipts (request_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE jev_staged_dispatch_claims (request_id text, stage text, payload jsonb)`
          yield* sql`CREATE TABLE jev_staged_terminal_receipts (request_id text, stage text, payload jsonb)`
          yield* sql`CREATE TABLE jev_staged_skip_receipts (request_id text, stage text, payload jsonb)`
          yield* sql`CREATE TABLE inference_expense_quotes (
            quote_hash text PRIMARY KEY, account_id text, session_date date, payload jsonb, verified_at timestamptz
          )`
          yield* sql`INSERT INTO autonomous_cycles VALUES (${plan.cycleId}, ${accountId}, ${sessionDate}::date,
          'jev', ${native.draft.identity.strategyProtocolHash}, 'COMPLETED', NULL)`
          // A no-batch cycle must remain in the session denominator; a foreign account must not enter it.
          yield* sql`INSERT INTO autonomous_cycles VALUES (${'b'.repeat(64)}, ${accountId}, ${sessionDate}::date,
          'jev', ${'a'.repeat(64)}, 'BLOCKED', NULL), (${'c'.repeat(64)}, 'foreign', ${sessionDate}::date,
          'jev', ${'a'.repeat(64)}, 'COMPLETED', NULL)`
          for (const batch of [evidence, laterEntry]) {
            const batchPlan = batch.batchPlan
            yield* sql`INSERT INTO jev_batch_plans VALUES (${batchPlan.batchId}, ${batchPlan.cycleId}, ${batchPlan.observationHash}, ${sql.json(batchPlan)})`
            yield* sql`INSERT INTO intraday_candidate_observations VALUES (${batchPlan.observationHash}, ${sql.json(batch.observation)})`
          }
          const pendingPath = paths.join(directory, 'pending')
          const pending = yield* exportJevStudySession(sql, accountId, sessionDate, pendingPath)
          expect(pending).toMatchObject({
            cycleCount: 2,
            batchCount: 2,
            entryBatchCount: 2,
            managementBatchCount: 0,
            pendingResultCount: 2,
            qualification: 'UNQUALIFIED',
            controllerCoverage: 'UNKNOWN',
          })
          const data = yield* fs.readFileString(paths.join(pendingPath, 'batches.ndjson'))
          expect(sha256(data)).toBe(pending.dataSha256)
          expect(new TextEncoder().encode(data).byteLength).toBe(pending.bytes)
          const lines = data
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line))
          expect(lines).toHaveLength(3)
          expect(lines[0].cycles).toHaveLength(2)
          expect(lines.slice(1).map((line) => line.batchId)).toEqual(
            [plan.batchId, laterEntry.batchPlan.batchId].sort(),
          )
          expect(lines.slice(1).every((line) => line.result === null)).toBe(true)
          const inventory = yield* Effect.fromResult(
            verifyJevStudyInventory(
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
                yield* fs.readFileString(paths.join(pendingPath, 'inventory.json')),
              ),
            ),
          )
          expect(inventory.receipt).toEqual(pending)
          expect(inventory.cycles).toEqual(lines[0].cycles)
          expect(inventory.batches).toEqual(
            lines.slice(1).map((line) => ({
              batchId: line.batchId,
              cycleId: line.cycleId,
              observationHash: line.observationHash,
              purpose: line.purpose,
              resultHash: null,
            })),
          )
          expect((yield* fs.stat(paths.join(pendingPath, 'inventory.json'))).mode & 0o777).toBe(0o600)
          expect((yield* fs.stat(paths.join(pendingPath, 'batches.ndjson'))).mode & 0o777).toBe(0o600)
          expect((yield* fs.stat(pendingPath)).mode & 0o777).toBe(0o700)
          const opportunityText = yield* fs.readFileString(paths.join(pendingPath, 'opportunities.ndjson'))
          const opportunityReceipt = JSON.parse(
            yield* fs.readFileString(paths.join(pendingPath, 'opportunities.receipt.json')),
          )
          const { receiptHash: opportunityReceiptHash, ...opportunityMaterial } = opportunityReceipt
          expect(opportunityReceiptHash).toBe(Result.getOrThrow(canonicalHashV1Result(opportunityMaterial)))
          expect(opportunityReceipt).toMatchObject({
            batchReceiptHash: pending.receiptHash,
            dataSha256: sha256(opportunityText),
            asOf: pending.asOf,
            bytes: new TextEncoder().encode(opportunityText).byteLength,
            cycleCount: 2,
            fillCount: 0,
            inferenceRequestCount: 0,
            estimatedTotalInferenceCostMicros: null,
          })
          expect(opportunityReceipt.unclaimedCandidateRequestIds.length).toBeGreaterThan(0)
          expect((yield* fs.stat(paths.join(pendingPath, 'opportunities.ndjson'))).mode & 0o777).toBe(0o600)
          expect((yield* fs.stat(paths.join(pendingPath, 'opportunities.receipt.json'))).mode & 0o777).toBe(0o600)
          expect((yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, pendingPath)))._tag).toBe(
            'Failure',
          )
          expect(yield* fs.readFileString(paths.join(pendingPath, 'batches.ndjson'))).toBe(data)
          for (const batch of [evidence, laterEntry])
            yield* sql`INSERT INTO jev_batch_results VALUES (${batch.batchPlan.batchId}, ${sql.json(batch.batchResult)})`
          const completed = yield* exportJevStudySession(
            sql,
            accountId,
            sessionDate,
            paths.join(directory, 'completed'),
          )
          expect(completed.pendingResultCount).toBe(0)
          expect(completed.dataSha256).not.toBe(pending.dataSha256)
          // Zero executed trades must not erase costs for blocked or outside-inventory requests.
          const zeroAllocation = yield* matchedCommittedDecisionFixture(
            nativeJevFixture(JevPurpose.Entry, undefined, 'jev-native-test', protocol),
            evidence,
          )
          yield* sql`UPDATE autonomous_cycles SET state = 'NO_TRADE', decision_hash = ${zeroAllocation.contentHash}
            WHERE cycle_id = ${plan.cycleId}`
          yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
            ${plan.cycleId}, ${zeroAllocation.contentHash}, ${sql.json(zeroAllocation)},
            ${zeroAllocation.createdAt}::timestamptz, ${zeroAllocation.schemaVersion}
          )`
          yield* sql`INSERT INTO autonomous_cycles VALUES
            (${'d'.repeat(64)}, ${accountId}, ${sessionDate}::date, 'another-strategy', ${plan.protocolHash}, 'BLOCKED', NULL),
            (${'f'.repeat(64)}, ${accountId}, ${sessionDate}::date, 'jev', ${plan.protocolHash}, 'BLOCKED', NULL)`
          const rates = {
            ...expenseRateFixture,
            rates: expenseRateFixture.rates.map((rate) => ({
              ...rate,
              effectiveUntil: '9999-12-31T23:59:59.999Z',
            })),
          }
          for (const key of ['b', 'd', 'f']) {
            const source = {
              ...expenseSourceFixture({
                key,
                accountId,
                observedAt: `${sessionDate}T15:00:00.000Z`,
                notDispatched: key === 'b',
              }),
              sessionDate,
            }
            yield* sql`INSERT INTO jev_evaluation_requests VALUES (
              ${source.requestId}, ${source.cycleId}, ${source.authorityGenerationHash},
              ${sql.json(source.request)}, ${source.request.schemaVersion}
            )`
            yield* sql`INSERT INTO jev_evaluation_receipts VALUES (${source.requestId}, ${sql.json(source.receipt)})`
            yield* sql`INSERT INTO jev_evaluation_resolutions VALUES (${source.requestId}, ${sql.json(source.resolution)})`
            for (const quote of Result.getOrThrow(makeInferenceExpenseQuotes(source, rates)))
              yield* sql`INSERT INTO inference_expense_quotes VALUES (
                ${quote.quoteHash}, ${accountId}, ${sessionDate}::date, ${sql.json(quote)}, ${source.asOf}::timestamptz
              )`
          }
          const noTradesPath = paths.join(directory, 'no-trades')
          yield* exportJevStudySession(sql, accountId, sessionDate, noTradesPath)
          const noTrades = JSON.parse(yield* fs.readFileString(paths.join(noTradesPath, 'opportunities.receipt.json')))
          expect(noTrades).toMatchObject({
            cycleCount: 3,
            fillCount: 0,
            intentCount: 0,
            inferenceRequestCount: 3,
            stageObligationCount: 3,
            meteredStageCount: 2,
            notDispatchedStageCount: 1,
            providerCallCount: null,
            outsideCycleInferenceRequestCount: 1,
            knownEstimatedInferenceCostPicoUsd: '84000',
            knownEstimatedInferenceCostMicros: '1',
            outsideCycleKnownEstimatedInferenceCostPicoUsd: '42000',
            dispositions: { SELECTED_ZERO_ALLOCATION: 1, NO_RECORDED_DECISION: 2 },
            invoiceReconciled: false,
            allInProfitMicros: null,
          })
          // Failure in the new companion stage cannot publish either completion receipt.
          yield* sql`UPDATE autonomous_cycle_shadow_decisions
            SET document = ${sql.json({ ...zeroAllocation, contentHash: 'f'.repeat(64) })}
            WHERE cycle_id = ${plan.cycleId}`
          const opportunityFailurePath = paths.join(directory, 'opportunity-failure')
          expect(
            (yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, opportunityFailurePath)))._tag,
          ).toBe('Failure')
          expect(
            (yield* fs.readFileString(paths.join(opportunityFailurePath, 'batches.ndjson'))).trim().split('\n'),
          ).toHaveLength(3)
          expect(yield* fs.exists(paths.join(opportunityFailurePath, 'receipt.json'))).toBe(false)
          expect(yield* fs.exists(paths.join(opportunityFailurePath, 'opportunities.receipt.json'))).toBe(false)
          expect(
            (yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, opportunityFailurePath)))._tag,
          ).toBe('Failure')
          // This write also proves the new failure path released its read-only transaction.
          yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document = ${sql.json(zeroAllocation)}
            WHERE cycle_id = ${plan.cycleId}`
          yield* sql`UPDATE intraday_candidate_observations SET payload = ${sql.json({ ...evidence.observation, observedAt: '2026-09-18T15:31:02.000Z' })}`
          const corruptPath = paths.join(directory, 'corrupt')
          expect((yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, corruptPath)))._tag).toBe(
            'Failure',
          )
          expect(yield* fs.exists(paths.join(corruptPath, 'receipt.json'))).toBe(false)
          expect(yield* fs.exists(paths.join(corruptPath, 'opportunities.receipt.json'))).toBe(false)
          // The export cannot leave its pooled connection in a read-only transaction after failure.
          yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED' WHERE cycle_id = ${plan.cycleId}`
        }),
      ).pipe(
        Effect.provide(
          PostgresClientLive({
            operationTimeoutMs: 30_000,
            postgres: { url: Redacted.make(url.toString()), tls: false, caPath: '/unused' },
          }).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    )
  },
)
