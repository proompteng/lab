import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayCycleDraft,
} from '../index'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { Authority, KillState } from '../../execution/contracts'
import { canonicalHashV1 } from '../../hash'
import type { ExecutionDecisionDocument } from '../../shadow-decision-contract'
import { intradayMomentumExecutionModel } from '../../strategy/intraday-momentum/protocol'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { CycleStore, CycleStoreLive } from '.'
import { makeCycleQueries } from './queries'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const accountId = 'paper-account-intraday-store'
const qualificationRunId = '1'.repeat(64)
const sessionDate = '2026-08-28' as const
const acquiredAt = '2026-08-28T13:00:00.000Z'
const activatedAt = '2026-08-28T14:31:00.000Z'
const blockedAt = '2026-08-28T15:00:00.000Z'
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const draft = (strategyProtocolHash = canonicalHashV1({ strategy: 'intraday-momentum', version: 1 })) => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: sessionDate,
      openAt: '2026-08-28T13:30:00.000Z',
      closeAt: '2026-08-28T20:00:00.000Z',
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId,
      strategyProtocolHash,
      accountId,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const candidate = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, executionPolicy))))
  if (!isIntradayCycleDraft(candidate)) throw new Error('expected the active intraday cycle contract')
  return candidate satisfies IntradayCycleDraft
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(config)), Layer.provideMerge(NodeServices.layer)),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

describePostgres('PostgreSQL intraday cycle store', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(resetDatabase)
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('converges concurrent acquisition on one immutable intraday cycle', async () => {
    const candidate = draft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipts = yield* Effect.all(
          [store.acquire(candidate, acquiredAt), store.acquire(candidate, acquiredAt)],
          { concurrency: 'unbounded' },
        )
        return {
          receipts,
          stored: yield* store.read(candidate.identity.cycleId),
          slot: yield* store.readAuthoritySlot({
            qualificationRunId,
            accountId,
            executionSessionDate: sessionDate,
          }),
        }
      }),
    )

    expect(result.receipts.filter(({ created }) => created)).toHaveLength(1)
    expect(result.receipts.map(({ cycle }) => cycle.identity.cycleId)).toEqual([
      candidate.identity.cycleId,
      candidate.identity.cycleId,
    ])
    expect(Option.getOrThrow(result.stored)).toMatchObject({ state: CycleState.Pending, stateVersion: 1 })
    expect(Option.getOrThrow(result.slot).identity.cycleId).toBe(candidate.identity.cycleId)
  })

  test('recovers the oldest active cycle and releases it after terminal blocking', async () => {
    const candidate = draft()
    const scope = { qualificationRunId, accountId }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        const activated = yield* store.activate(candidate.identity.cycleId, activatedAt)
        const recovered = yield* store.readOldestUnfinished(scope)
        const blocked = yield* store.block(candidate.identity.cycleId, CycleTerminalReason.DataUnavailable, blockedAt)
        const replayed = yield* store.block(candidate.identity.cycleId, CycleTerminalReason.DataUnavailable, blockedAt)
        return {
          activated,
          recovered,
          blocked,
          replayed,
          after: yield* store.readOldestUnfinished(scope),
        }
      }),
    )

    expect(result.activated).toMatchObject({ changed: true, cycle: { state: CycleState.Active, stateVersion: 2 } })
    expect(Option.getOrThrow(result.recovered).identity.cycleId).toBe(candidate.identity.cycleId)
    expect(result.blocked).toMatchObject({
      changed: true,
      cycle: {
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.DataUnavailable,
        stateVersion: 3,
      },
    })
    expect(result.replayed).toMatchObject({ changed: false, cycle: { state: CycleState.Blocked } })
    expect(Option.isNone(result.after)).toBeTrue()
  })

  test('rejects conflicting authority-slot content and invalid lifecycle transitions', async () => {
    const candidate = draft()
    const conflicting = draft('f'.repeat(64))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        const authorityConflict = yield* store.acquire(conflicting, acquiredAt).pipe(Effect.flip)
        const backwardActivation = yield* store
          .activate(candidate.identity.cycleId, '2026-08-28T12:59:59.000Z')
          .pipe(Effect.flip)
        yield* store.activate(candidate.identity.cycleId, activatedAt)
        const prematureCompletion = yield* store
          .finish(candidate.identity.cycleId, CycleState.NoTrade, blockedAt)
          .pipe(Effect.flip)
        return { authorityConflict, backwardActivation, prematureCompletion }
      }),
    )

    expect(result.authorityConflict).toMatchObject({ operation: 'acquire', failure: 'conflict' })
    expect(result.backwardActivation).toMatchObject({ operation: 'activate', failure: 'conflict' })
    expect(result.prematureCompletion).toMatchObject({ operation: 'finish', failure: 'invariant' })
  })

  test('admits persisted execution evidence only against the exact durable authority and risk context', async () => {
    const parentAuthorityGenerationHash = '1'.repeat(64)
    const authorityGenerationHash = '2'.repeat(64)
    const policyHash = 'a'.repeat(64)
    const parentAuthorityUpdatedAt = '2026-08-28T14:57:30.000Z'
    const authorityUpdatedAt = '2026-08-28T14:58:00.000Z'
    const forgedReconciledAt = '2026-08-28T14:57:00.000Z'
    const reconciledAt = '2026-08-28T14:59:00.000Z'
    const observedAt = '2026-08-28T15:00:00.000Z'
    const stateHash = '3'.repeat(64)
    const reconciliationId = '4'.repeat(64)
    const reconciliationHash = '5'.repeat(64)
    const snapshotId = '6'.repeat(64)
    const snapshotContentHash = '7'.repeat(64)
    const equityMicros = '100000000000'
    const riskContext = {
      authority: {
        schemaVersion: 'bayn.paper-authority.v1' as const,
        generationHash: authorityGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 2,
        updatedAt: authorityUpdatedAt,
      },
      authorityObservedAt: reconciledAt,
      unknownMutationCount: 1,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: equityMicros,
      peakEquityMicros: equityMicros,
    }
    const document = {
      mode: 'PAPER',
      createdAt: observedAt,
      bindings: {
        accountId,
        snapshotId,
        snapshotContentHash,
        snapshotFinalizedAt: observedAt,
        planningBrokerStateHash: stateHash,
        reconciliationId,
        reconciliationHash,
        policyHash,
        decisionMarketData: {
          schemaVersion: 'bayn.execution-market-data-binding.v2',
          snapshotId,
          contentHash: snapshotContentHash,
          observedAt,
        },
        riskContext,
      },
      deltaRisk: [{ facts: { state: { reconciliation: { reconciledAt } } } }],
    } as unknown as ExecutionDecisionDocument

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId}, ${stateHash}, ${stateHash},
            ${reconciliationHash}, 'EXACT', ${sql.json(encodeSqlJson([]))}, ${reconciledAt}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, previous_generation_hash, maximum,
            authority_version, activated_at
          ) VALUES (
            ${parentAuthorityGenerationHash}, 'bayn.authority-generation-history.v1', NULL,
            ${Authority.Observe}, 1, ${parentAuthorityUpdatedAt}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, activation_schema_version, previous_generation_hash,
            maximum, authority_version, activation_source_revision, activation_image_repository,
            activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash,
            strategy_parameter_schema_version, strategy_protocol_hash, account_id,
            broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
            risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
            research_plan_hash, activated_at
          ) VALUES (
            ${authorityGenerationHash}, 'bayn.authority-generation-history.v1',
            'bayn.paper-authority-generation.v3', ${parentAuthorityGenerationHash}, ${Authority.Execution}, 2,
            ${'3'.repeat(40)}, 'registry.example.test/lab/bayn', ${`sha256:${'4'.repeat(64)}`},
            'intraday-momentum', ${'5'.repeat(64)}, ${'6'.repeat(64)},
            'bayn.intraday-momentum.protocol.v2', ${'7'.repeat(64)}, ${accountId},
            'bayn.broker-identity.v2', ${'8'.repeat(64)}, 'alpaca', 'sandbox', ${policyHash},
            ${'9'.repeat(64)}, ${reconciliationId}, ${reconciliationHash}, ${'b'.repeat(64)},
            ${authorityUpdatedAt}
          )
        `
        yield* sql`
          INSERT INTO authority_state (
            schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
          ) VALUES (
            'bayn.paper-authority.v1', ${parentAuthorityGenerationHash}, ${Authority.Observe}, ${Authority.Observe},
            ${KillState.Clear}, NULL, 1, ${parentAuthorityUpdatedAt}
          )
        `
        yield* sql`
          UPDATE authority_state
          SET
            generation_hash = ${authorityGenerationHash},
            maximum = ${Authority.Execution},
            effective = ${Authority.Execution},
            version = 2,
            updated_at = ${authorityUpdatedAt}
          WHERE singleton
        `
        const intentId = 'c'.repeat(64)
        const riskDecisionId = 'f'.repeat(64)
        const submitMutationId = 'd'.repeat(64)
        const cancelMutationId = 'e'.repeat(64)
        const submitRequestHash = '8'.repeat(64)
        const cancelRequestHash = '9'.repeat(64)
        const brokerOrderId = 'risk-cutoff-order'
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
            decision_hash, policy_hash, account_id, client_order_id, symbol, side, order_type, time_in_force,
            quantity_micros, notional_limit_micros, state, terminal_outcome, state_version, created_at, updated_at
          ) VALUES (
            ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, NULL, 'intraday-momentum',
            ${'f'.repeat(64)}, ${'0'.repeat(64)}, ${policyHash}, ${accountId}, 'bayn-risk-cutoff-test',
            'SPY', 'BUY', 'LIMIT', 'IOC', 1000000, 1000000, 'PLANNED', NULL, 1,
            '2026-08-28T14:58:30.000Z', '2026-08-28T14:58:30.000Z'
          )
        `
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO risk_decisions (
                decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                reason_codes, decided_at, expires_at
              ) VALUES (
                ${riskDecisionId}, 'bayn.paper-risk-decision.v1', ${'b'.repeat(64)}, ${intentId},
                ${policyHash}, 'APPROVED', ARRAY[]::text[],
                '2026-08-28T14:58:31.000Z', '2099-01-01T00:00:00.000Z'
              )
            `
            yield* sql`
              UPDATE intents
              SET
                risk_decision_id = ${riskDecisionId}, state = 'APPROVED', state_version = 2,
                updated_at = '2026-08-28T14:58:31.000Z'
              WHERE intent_id = ${intentId}
            `
          }),
        )
        yield* sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-08-28T14:58:32.000Z'
          WHERE intent_id = ${intentId}
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'0'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${submitMutationId}, ${intentId}, 1,
            'SUBMIT', 'SUBMIT_STARTED', ${submitRequestHash}, 1000, NULL, NULL, NULL, NULL,
            '2026-08-28T14:58:33.000Z'
          )
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'1'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${submitMutationId}, ${intentId}, 2,
            'SUBMIT', 'SUBMIT_ACCEPTED', ${submitRequestHash}, 1000, ${brokerOrderId},
            'risk-cutoff-submit', 200, ${'a'.repeat(64)}, '2026-08-28T14:58:34.000Z'
          )
        `
        yield* sql`
          UPDATE intents
          SET state = 'ACKNOWLEDGED', state_version = 4, updated_at = '2026-08-28T14:58:35.000Z'
          WHERE intent_id = ${intentId}
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'2'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intentId}, 1,
            'CANCEL', 'CANCEL_STARTED', ${cancelRequestHash}, 1000, ${brokerOrderId}, NULL, NULL, NULL,
            '2026-08-28T14:58:36.000Z'
          )
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'3'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intentId}, 2,
            'CANCEL', 'CANCEL_ACCEPTED', ${cancelRequestHash}, 1000, ${brokerOrderId},
            'risk-cutoff-cancel', 204, ${'b'.repeat(64)}, '2026-08-28T14:58:37.000Z'
          )
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'4'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intentId}, 3,
            'CANCEL', 'RECOVERY_FOUND', ${cancelRequestHash}, 1000, ${brokerOrderId},
            'risk-cutoff-recovery', 200, ${'c'.repeat(64)}, '2026-08-28T14:58:38.000Z'
          )
        `
        yield* sql`
          UPDATE intents
          SET
            state = 'TERMINAL', terminal_outcome = 'CANCELED', state_version = 5,
            updated_at = '2026-08-28T15:00:30.000Z'
          WHERE intent_id = ${intentId}
        `
        yield* sql`
          INSERT INTO valuations (
            valuation_id, schema_version, account_id, source_hash, cash_micros,
            long_market_value_micros, short_market_value_micros, equity_micros, as_of
          ) VALUES
            (
              ${'a'.repeat(64)}, 'bayn.paper-valuation.v1', ${accountId}, ${'b'.repeat(64)},
              ${equityMicros}, 0, 0, ${equityMicros}, ${forgedReconciledAt}
            ),
            (
              ${'8'.repeat(64)}, 'bayn.paper-valuation.v1', ${accountId}, ${'9'.repeat(64)},
              ${equityMicros}, 0, 0, ${equityMicros}, ${reconciledAt}
            )
        `
        const queries = makeCycleQueries(sql)
        const missingArchiveReference = yield* queries.decisionEvidenceMatches(document)
        yield* sql`
          INSERT INTO intraday_snapshot_references (
            snapshot_id, schema_version, content_hash, observed_at, manifest
          ) VALUES (
            ${snapshotId}, 'bayn.intraday-snapshot-reference.v1', ${snapshotContentHash}, ${observedAt},
            ${sql.json({
              schemaVersion: 'bayn.intraday-market-snapshot.v1',
              snapshotId,
              contentHash: snapshotContentHash,
              observedAt,
            })}
          )
        `
        const exact = yield* queries.decisionEvidenceMatches(document)
        const unverifiedSnapshotId = 'd'.repeat(64)
        const unverifiedSnapshotContentHash = 'e'.repeat(64)
        const unverifiedArchiveReference = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: {
            ...document.bindings,
            snapshotId: unverifiedSnapshotId,
            snapshotContentHash: unverifiedSnapshotContentHash,
            decisionMarketData: {
              schemaVersion: 'bayn.execution-market-data-binding.v2',
              snapshotId: unverifiedSnapshotId,
              contentHash: unverifiedSnapshotContentHash,
              observedAt,
            },
          },
        } as unknown as ExecutionDecisionDocument)
        const forgedAuthority = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: {
            ...document.bindings,
            riskContext: {
              ...riskContext,
              authority: { ...riskContext.authority, version: riskContext.authority.version + 1 },
            },
          },
        })
        const forgedEquity = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: {
            ...document.bindings,
            riskContext: { ...riskContext, dayStartEquityMicros: (BigInt(equityMicros) + 1n).toString() },
          },
        })
        const forgedReconciliationCutoff = yield* queries.decisionEvidenceMatches({
          ...document,
          deltaRisk: [{ facts: { state: { reconciliation: { reconciledAt: forgedReconciledAt } } } }],
        } as unknown as ExecutionDecisionDocument)
        const forgedPolicyHash = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: { ...document.bindings, policyHash: 'c'.repeat(64) },
        } as unknown as ExecutionDecisionDocument)
        return {
          missingArchiveReference,
          exact,
          unverifiedArchiveReference,
          forgedAuthority,
          forgedEquity,
          forgedPolicyHash,
          forgedReconciliationCutoff,
        }
      }),
    )

    expect(result).toEqual({
      missingArchiveReference: false,
      exact: true,
      unverifiedArchiveReference: false,
      forgedAuthority: false,
      forgedEquity: false,
      forgedPolicyHash: false,
      forgedReconciliationCutoff: false,
    })
  })
})
