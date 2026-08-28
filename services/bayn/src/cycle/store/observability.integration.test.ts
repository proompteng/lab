import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeIntradayCycleWindow,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  isIntradayCycleDraft,
  isLegacyCycleDraft,
  type IntradayCycleDraft,
  type LegacyCycleDraft,
} from '../index'
import { CycleOperationsCondition, CycleOperationsReason, deriveCycleOperationsStatus } from '../observability'
import { PostgresClientLive } from '../../db/evidence-store'
import { migrationLoader } from '../../db/migrations'
import { Authority, KillState } from '../../execution/contracts'
import { readForwardPerformancePostgres } from '../../forward-performance/postgres'
import type { SignalSessionRow } from '../../market-data'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import type { IsoDate } from '../../types'
import { defaultOpeningDriveProtocolHash, openingDriveExecutionModel } from '../../strategy/opening-drive'
import { CycleObservability, CycleObservabilityLive } from './observability'
import { CycleStore, CycleStoreLive } from '.'

const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const postgresUrl = baynTestPostgresUrl
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const qualificationRunId = 'a'.repeat(64)
const accountId = 'paper-account-observability'
const reconciliationId = 'd'.repeat(64)
const reconciliationHash = 'e'.repeat(64)

const databaseConfig = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CycleObservabilityLive).pipe(
      Layer.provideMerge(PostgresClientLive(databaseConfig)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const signalSession = (
  sessionDate: IsoDate,
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'> => ({
  calendar_version: 'signal-XNYS-2026-v1',
  session_date: sessionDate,
  close_time: '16:00',
  timezone: 'America/New_York',
})

const makeDraft = (dedicatedAccountId = accountId): LegacyCycleDraft => {
  const executionPolicyResult = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'b'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  expect(Result.isSuccess(executionPolicyResult)).toBe(true)
  if (Result.isFailure(executionPolicyResult)) return expect.unreachable(executionPolicyResult.failure.message)
  const executionPolicy = executionPolicyResult.success

  const executionCalendarResult = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: '2026-03-09',
    openAt: '2026-03-09T13:30:00.000Z',
    closeAt: '2026-03-09T20:00:00.000Z',
  })
  expect(Result.isSuccess(executionCalendarResult)).toBe(true)
  if (Result.isFailure(executionCalendarResult)) return expect.unreachable(executionCalendarResult.failure.message)
  const executionCalendar = executionCalendarResult.success

  const identityResult = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId,
    strategyProtocolHash: 'c'.repeat(64),
    accountId: dedicatedAccountId,
    signalSessionDate: '2026-03-06',
    signalCalendarVersion: 'signal-XNYS-2026-v1',
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  expect(Result.isSuccess(identityResult)).toBe(true)
  if (Result.isFailure(identityResult)) return expect.unreachable(identityResult.failure.message)
  const windowResult = makeCycleWindow(signalSession('2026-03-06'), executionCalendar, executionPolicy)
  expect(Result.isSuccess(windowResult)).toBe(true)
  if (Result.isFailure(windowResult)) return expect.unreachable(windowResult.failure.message)
  const draftResult = makeCycleDraft(identityResult.success, windowResult.success)
  expect(Result.isSuccess(draftResult)).toBe(true)
  if (Result.isFailure(draftResult)) return expect.unreachable(draftResult.failure.message)
  if (!isLegacyCycleDraft(draftResult.success)) return expect.unreachable('expected a legacy cycle draft')
  return draftResult.success
}

const makeIntradayDraft = (dedicatedAccountId = accountId): IntradayCycleDraft => {
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  const executionCalendar = Result.getOrThrow(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-03-09',
      openAt: '2026-03-09T13:30:00.000Z',
      closeAt: '2026-03-09T20:00:00.000Z',
    }),
  )
  const identity = Result.getOrThrow(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'opening-drive-momentum',
      qualificationRunId,
      strategyProtocolHash: defaultOpeningDriveProtocolHash,
      accountId: dedicatedAccountId,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = Result.getOrThrow(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = Result.getOrThrow(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) return expect.unreachable('expected an intraday cycle draft')
  return draft
}

const seedSafetyState = (reconciledAt = '2026-03-06T21:00:00.000Z') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`
      INSERT INTO authority_generations (
        generation_hash, schema_version, previous_generation_hash, maximum,
        authority_version, activated_at
      ) VALUES (
        ${'f'.repeat(64)}, 'bayn.authority-generation-history.v1', NULL,
        'OBSERVE', 1, '2026-03-06T21:00:00.000Z'
      )
    `
    yield* sql`
    INSERT INTO authority_state (
      schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
    ) VALUES (
      'bayn.paper-authority.v1',
      ${'f'.repeat(64)},
      ${Authority.Observe},
      ${Authority.Observe},
      ${KillState.Clear},
      NULL,
      1,
      ${'2026-03-06T21:00:00.000Z'}
    )
  `
    yield* sql`
    INSERT INTO reconciliations (
      reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
      content_hash, status, discrepancies, reconciled_at
    ) VALUES (
      ${reconciliationId},
      'bayn.paper-reconciliation.v1',
      ${accountId},
      ${reconciliationHash},
      ${reconciliationHash},
      ${'1'.repeat(64)},
      'EXACT',
      ${sql.json(encodeSqlJson([]))},
      ${reconciledAt}
    )
  `
  })

const seedUnresolvedMutation = (mutationAccountId = accountId) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = '2'.repeat(64)
    yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
      decision_hash, policy_hash, account_id, client_order_id,
      symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at
    ) VALUES (
      ${intentId},
      'bayn.paper-intent.v3',
      ${'f'.repeat(64)},
      NULL,
      'risk-balanced-trend',
      ${'8'.repeat(64)},
      ${'9'.repeat(64)},
      ${'a'.repeat(64)},
      ${mutationAccountId},
      'bayn-observability-test-order',
      'SPY',
      'BUY',
      'MARKET',
      'DAY',
      1000000,
      1000000,
      'PLANNED',
      NULL,
      1,
      ${'2026-03-06T21:02:00.000Z'},
      ${'2026-03-06T21:02:00.000Z'}
    )
  `
    yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'3'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${intentId},
      1,
      'SUBMIT',
      'SUBMIT_STARTED',
      ${'5'.repeat(64)},
      1000,
      NULL,
      NULL,
      NULL,
      NULL,
      ${'2026-03-06T21:02:00.000Z'}
    )
  `
  })

const seedRepeatedUnresolvedRecovery = Effect.gen(function* () {
  yield* seedUnresolvedMutation()
  const sql = yield* PgClient.PgClient
  yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES
      (
        ${'6'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)}, 2,
        'SUBMIT', 'SUBMIT_UNKNOWN', ${'5'.repeat(64)}, 1000, NULL,
        'unknown-submit', 503, ${'7'.repeat(64)}, '2026-03-06T21:03:00.000Z'
      ),
      (
        ${'8'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)}, 3,
        'SUBMIT', 'RECOVERY_NOT_FOUND', ${'5'.repeat(64)}, 1000, NULL,
        'not-found-1', 404, ${'9'.repeat(64)}, '2026-03-06T21:08:00.000Z'
      ),
      (
        ${'a'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)}, 4,
        'SUBMIT', 'RECOVERY_UNKNOWN', ${'5'.repeat(64)}, 1000, NULL,
        'unknown-recovery', 503, ${'b'.repeat(64)}, '2026-03-06T21:13:00.000Z'
      )
  `
})

const seedAcceptedMutation = (occurredAt = '2026-03-06T21:03:00.000Z') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'6'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${'2'.repeat(64)},
      2,
      'SUBMIT',
      'SUBMIT_ACCEPTED',
      ${'5'.repeat(64)},
      1000,
      'broker-order-observability',
      'broker-request-observability',
      200,
      ${'7'.repeat(64)},
      ${occurredAt}
    )
  `
  })

const seedReopenedUnresolvedRecovery = (resolvedEventType: 'SUBMIT_ACCEPTED' | 'RECOVERY_FOUND') =>
  Effect.gen(function* () {
    yield* seedUnresolvedMutation()
    const sql = yield* PgClient.PgClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
      INSERT INTO risk_decisions (
        decision_id, schema_version, input_hash, intent_id, policy_hash,
        outcome, reason_codes, decided_at, expires_at
      ) VALUES (
        ${'1'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'0'.repeat(64)}, ${'2'.repeat(64)},
        ${'a'.repeat(64)}, 'APPROVED', ARRAY[]::text[],
        '2026-03-06T21:02:00.001Z', '2099-01-01T00:00:00.000Z'
      )
    `
        yield* sql`
      UPDATE intents
      SET risk_decision_id = ${'1'.repeat(64)}, state = 'APPROVED', state_version = 2,
        updated_at = '2026-03-06T21:02:00.002Z'
      WHERE intent_id = ${'2'.repeat(64)}
    `
        yield* sql`
      UPDATE intents
      SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-03-06T21:02:00.003Z'
      WHERE intent_id = ${'2'.repeat(64)}
    `
        yield* sql`
      INSERT INTO mutation_events (
        event_id, schema_version, mutation_id, intent_id, sequence, operation,
        event_type, request_hash, consistency_delay_ms, broker_order_id,
        request_id, response_status, response_content_hash, occurred_at
      ) VALUES (
        ${'6'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)}, 2,
        'SUBMIT', 'SUBMIT_ACCEPTED', ${'5'.repeat(64)}, 1000, 'broker-order-observability',
        'resolved-submit', 200, ${'7'.repeat(64)}, '2026-03-06T21:03:00.000Z'
      )
    `
        yield* sql`
      UPDATE intents
      SET state = 'ACKNOWLEDGED', state_version = 4, updated_at = '2026-03-06T21:03:00.000Z'
      WHERE intent_id = ${'2'.repeat(64)}
    `
      }),
    )
    if (resolvedEventType === 'RECOVERY_FOUND') {
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'8'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)}, 3,
          'SUBMIT', 'RECOVERY_FOUND', ${'5'.repeat(64)}, 1000, 'broker-order-observability',
          'recovered-submit', 200, ${'9'.repeat(64)}, '2026-03-06T21:04:00.000Z'
        )
      `
    }
    const reopenedSequence = resolvedEventType === 'RECOVERY_FOUND' ? 4 : 3
    yield* sql`
      INSERT INTO mutation_events (
        event_id, schema_version, mutation_id, intent_id, sequence, operation,
        event_type, request_hash, consistency_delay_ms, broker_order_id,
        request_id, response_status, response_content_hash, occurred_at
      ) VALUES (
        ${'b'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${'2'.repeat(64)},
        ${reopenedSequence},
        'SUBMIT', 'RECOVERY_NOT_FOUND', ${'5'.repeat(64)}, 1000, 'broker-order-observability',
        'reopened-submit', 404, ${'c'.repeat(64)}, '2026-03-06T21:12:00.000Z'
      )
    `
  })

const seedOpenRecoveryAndApprovedIntent = Effect.gen(function* () {
  yield* seedUnresolvedMutation()
  const sql = yield* PgClient.PgClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
    INSERT INTO risk_decisions (
      decision_id, schema_version, input_hash, intent_id, policy_hash,
      outcome, reason_codes, decided_at, expires_at
    ) VALUES (
      ${'1'.repeat(64)},
      'bayn.paper-risk-decision.v1',
      ${'0'.repeat(64)},
      ${'2'.repeat(64)},
      ${'a'.repeat(64)},
      'APPROVED',
      ARRAY[]::text[],
      '2026-03-06T21:02:00.001Z',
      '2099-01-01T00:00:00.000Z'
    )
  `
      yield* sql`
    UPDATE intents
    SET
      risk_decision_id = ${'1'.repeat(64)},
      state = 'APPROVED',
      state_version = 2,
      updated_at = '2026-03-06T21:02:00.002Z'
    WHERE intent_id = ${'2'.repeat(64)}
  `
      yield* sql`
    UPDATE intents
    SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-03-06T21:02:00.003Z'
    WHERE intent_id = ${'2'.repeat(64)}
  `
      yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'b'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${'2'.repeat(64)},
      2,
      'SUBMIT',
      'SUBMIT_ACCEPTED',
      ${'5'.repeat(64)},
      1000,
      'broker-order-observability',
      'broker-request-observability',
      200,
      ${'7'.repeat(64)},
      '2026-03-06T21:03:00.000Z'
    )
  `
      yield* sql`
    UPDATE intents
    SET
      state = 'ACKNOWLEDGED',
      state_version = 4,
      updated_at = '2026-03-06T21:03:00.000Z'
    WHERE intent_id = ${'2'.repeat(64)}
  `
      yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'6'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${'2'.repeat(64)},
      3,
      'SUBMIT',
      'RECOVERY_FOUND',
      ${'5'.repeat(64)},
      1000,
      'broker-order-observability',
      'broker-request-observability',
      200,
      ${'7'.repeat(64)},
      '2026-03-06T21:03:00.001Z'
    )
  `
      yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
      decision_hash, policy_hash, account_id, client_order_id,
      symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at
    ) VALUES (
      ${'c'.repeat(64)},
      'bayn.paper-intent.v3',
      ${'f'.repeat(64)},
      NULL,
      'risk-balanced-trend',
      ${'8'.repeat(64)},
      ${'9'.repeat(64)},
      ${'a'.repeat(64)},
      ${accountId},
      'bayn-observability-approved-order',
      'EFA',
      'BUY',
      'MARKET',
      'DAY',
      1000000,
      1000000,
      'PLANNED',
      NULL,
      1,
      '2026-03-06T21:03:00.000Z',
      '2026-03-06T21:03:00.000Z'
    )
  `
      yield* sql`
    INSERT INTO risk_decisions (
      decision_id, schema_version, input_hash, intent_id, policy_hash,
      outcome, reason_codes, decided_at, expires_at
    ) VALUES (
      ${'d'.repeat(64)},
      'bayn.paper-risk-decision.v1',
      ${'e'.repeat(64)},
      ${'c'.repeat(64)},
      ${'a'.repeat(64)},
      'APPROVED',
      ARRAY[]::text[],
      '2026-03-06T21:03:00.001Z',
      '2099-01-01T00:00:00.000Z'
    )
  `
      yield* sql`
    UPDATE intents
    SET
      risk_decision_id = ${'d'.repeat(64)},
      state = 'APPROVED',
      state_version = 2,
      updated_at = '2026-03-06T21:03:00.002Z'
    WHERE intent_id = ${'c'.repeat(64)}
  `
    }),
  )
})

const seedTerminalCanceledMutation = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const intentId = '2'.repeat(64)
  yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
      decision_hash, policy_hash, account_id, client_order_id,
      symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at
    ) VALUES (
      ${intentId},
      'bayn.paper-intent.v3',
      ${'f'.repeat(64)},
      NULL,
      'risk-balanced-trend',
      ${'8'.repeat(64)},
      ${'9'.repeat(64)},
      ${'a'.repeat(64)},
      ${accountId},
      'bayn-observability-test-order',
      'SPY',
      'BUY',
      'MARKET',
      'DAY',
      1000000,
      1000000,
      'PLANNED',
      NULL,
      1,
      '2026-03-06T21:02:00.000Z',
      '2026-03-06T21:02:00.000Z'
    )
  `
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO risk_decisions (
          decision_id, schema_version, input_hash, intent_id, policy_hash,
          outcome, reason_codes, decided_at, expires_at
        ) VALUES (
          ${'1'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'b'.repeat(64)}, ${intentId},
          ${'a'.repeat(64)}, 'APPROVED', ARRAY[]::text[],
          '2026-03-06T21:02:00.001Z', '2099-01-01T00:00:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET
          risk_decision_id = ${'1'.repeat(64)},
          state = 'APPROVED',
          state_version = 2,
          updated_at = '2026-03-06T21:02:00.002Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'3'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${intentId}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${'5'.repeat(64)}, 1000, NULL,
          NULL, NULL, NULL, '2026-03-06T21:02:00.003Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-03-06T21:02:00.003Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'b'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${intentId}, 2,
          'SUBMIT', 'SUBMIT_UNKNOWN', ${'5'.repeat(64)}, 1000, 'broker-order-observability',
          'mismatched-submit', 200, ${'c'.repeat(64)}, '2026-03-06T21:03:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET state = 'UNKNOWN', state_version = 4, updated_at = '2026-03-06T21:03:00.000Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'c'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'4'.repeat(64)}, ${intentId}, 3,
          'SUBMIT', 'RECOVERY_NOT_FOUND', ${'5'.repeat(64)}, 1000, 'broker-order-observability',
          'submit-not-found', 404, ${'d'.repeat(64)}, '2026-03-06T21:04:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'e'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 1,
          'CANCEL', 'CANCEL_STARTED', ${'7'.repeat(64)}, 1000, 'broker-order-observability',
          NULL, NULL, NULL, '2026-03-06T21:05:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'f'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 2,
          'CANCEL', 'CANCEL_ACCEPTED', ${'7'.repeat(64)}, 1000, 'broker-order-observability',
          'cancel-accepted', 204, ${'8'.repeat(64)}, '2026-03-06T21:06:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'0'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 3,
          'CANCEL', 'RECOVERY_FOUND', ${'7'.repeat(64)}, 1000, 'broker-order-observability',
          'cancel-terminal', 200, ${'9'.repeat(64)}, '2026-03-06T21:07:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET state = 'RECOVERED', state_version = 5, updated_at = '2026-03-06T21:07:00.000Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        UPDATE intents
        SET
          state = 'TERMINAL',
          terminal_outcome = 'CANCELED',
          state_version = 6,
          updated_at = '2026-03-06T21:07:00.000001Z'
        WHERE intent_id = ${intentId}
      `
    }),
  )
})

const seedTerminalRejectedMutation = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const intentId = '4'.repeat(64)
  const mutationId = '5'.repeat(64)
  const requestHash = '6'.repeat(64)
  yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
      decision_hash, policy_hash, account_id, client_order_id,
      symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at
    ) VALUES (
      ${intentId}, 'bayn.paper-intent.v3', ${'f'.repeat(64)}, NULL,
      'risk-balanced-trend', ${'7'.repeat(64)}, ${'8'.repeat(64)}, ${'9'.repeat(64)},
      ${accountId}, 'bayn-observability-rejected-order', 'SPY', 'BUY', 'MARKET', 'DAY',
      1000000, 1000000, 'PLANNED', NULL, 1,
      '2026-03-06T21:01:00.000Z', '2026-03-06T21:01:00.000Z'
    )
  `
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO risk_decisions (
          decision_id, schema_version, input_hash, intent_id, policy_hash,
          outcome, reason_codes, decided_at, expires_at
        ) VALUES (
          ${'a'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'b'.repeat(64)}, ${intentId},
          ${'9'.repeat(64)}, 'APPROVED', ARRAY[]::text[],
          '2026-03-06T21:01:00.001Z', '2099-01-01T00:00:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET risk_decision_id = ${'a'.repeat(64)}, state = 'APPROVED', state_version = 2,
          updated_at = '2026-03-06T21:01:00.002Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'c'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${requestHash}, 1000, NULL,
          NULL, NULL, NULL, '2026-03-06T21:02:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-03-06T21:02:00.000Z'
        WHERE intent_id = ${intentId}
      `
      yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${'d'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 2,
          'SUBMIT', 'SUBMIT_REJECTED', ${requestHash}, 1000, NULL,
          'rejected-submit', 422, ${'e'.repeat(64)}, '2026-03-06T21:03:00.000Z'
        )
      `
      yield* sql`
        UPDATE intents
        SET state = 'TERMINAL', terminal_outcome = 'REJECTED', state_version = 4,
          updated_at = '2026-03-06T21:03:00.000001Z'
        WHERE intent_id = ${intentId}
      `
    }),
  )
})

const seedOrderLifecycle = (cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = '1'.repeat(64)
    const clientOrderId = 'bayn-observability-ack-latency'
    const brokerOrderId = 'broker-observability-ack-latency'

    yield* sql`
      INSERT INTO intents (
        intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
        decision_hash, policy_hash, account_id, client_order_id,
        symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
        state, terminal_outcome, state_version, created_at, updated_at
      ) VALUES (
        ${intentId}, 'bayn.paper-intent.v3', ${'f'.repeat(64)}, NULL,
        'opening-drive-momentum', ${cycleId}, ${'2'.repeat(64)}, ${'3'.repeat(64)},
        ${accountId}, ${clientOrderId}, 'NVDA', 'BUY', 'MARKET', 'DAY',
        1000000, 1000000, 'PLANNED', NULL, 1,
        '2026-03-09T13:31:00.000Z', '2026-03-09T13:31:00.000Z'
      )
    `

    const insertOrder = (
      eventId: string,
      sourceEventId: string,
      sourceSequence: number,
      status: 'NEW' | 'FILLED',
      observedAt: string,
      filledQuantityMicros: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO broker_events (
              event_id, schema_version, content_hash, event_kind, broker, account_id,
              source_event_id, source_sequence, occurred_at, observed_at
            ) VALUES (
              ${eventId}, 'bayn.paper-broker-event.v1', ${eventId}, 'ORDER', 'ALPACA',
              ${accountId}, ${sourceEventId}, ${sourceSequence}, ${observedAt}, ${observedAt}
            )
          `
          yield* sql`
            INSERT INTO orders (
              event_id, account_id, schema_version, broker_order_id, client_order_id, intent_id, symbol,
              side, order_type, time_in_force, quantity_micros, filled_quantity_micros, status
            ) VALUES (
              ${eventId}, ${accountId}, 'bayn.paper-order.v1', ${brokerOrderId},
              ${clientOrderId}, ${intentId}, 'NVDA', 'BUY', 'MARKET', 'DAY', 1000000,
              ${filledQuantityMicros}, ${status}
            )
          `
        }),
      )

    yield* insertOrder('4'.repeat(64), 'order-acknowledged', 100, 'NEW', '2026-03-09T13:31:02.000Z', '0')
    yield* insertOrder('5'.repeat(64), 'order-filled', 101, 'FILLED', '2026-04-08T13:31:00.000Z', '1000000')
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO broker_events (
            event_id, schema_version, content_hash, event_kind, broker, account_id,
            source_event_id, source_sequence, occurred_at, observed_at
          ) VALUES (
            ${'6'.repeat(64)}, 'bayn.paper-broker-event.v1', ${'6'.repeat(64)}, 'FILL', 'ALPACA',
            ${accountId}, 'fill-after-long-recovery', 102,
            '2026-04-08T13:31:00.000Z', '2026-04-08T13:31:00.000Z'
          )
        `
        yield* sql`
          INSERT INTO fills (
            event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id, intent_id,
            symbol, side, quantity_micros, price_micros, fee_micros, source_timestamp
          ) VALUES (
            ${'6'.repeat(64)}, ${accountId}, 'bayn.paper-fill.v1', 'fill-after-long-recovery',
            ${brokerOrderId}, ${clientOrderId}, ${intentId}, 'NVDA', 'BUY', 1000000, 100000000, 0,
            '2026-04-08T13:31:00.000000000Z'
          )
        `
      }),
    )

    const insertTerminalOrder = (ordinal: '7' | '8', status: 'CANCELED' | 'EXPIRED', observedAt: string) => {
      const terminalIntentId = ordinal.repeat(64)
      const terminalClientOrderId = `bayn-observability-${status.toLowerCase()}`
      const terminalBrokerOrderId = `broker-observability-${status.toLowerCase()}`
      const terminalSymbol = ordinal === '7' ? 'AAPL' : 'MSFT'
      return sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
              decision_hash, policy_hash, account_id, client_order_id,
              symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, terminal_outcome, state_version, created_at, updated_at
            ) VALUES (
              ${terminalIntentId}, 'bayn.paper-intent.v3', ${'f'.repeat(64)}, NULL,
              'opening-drive-momentum', ${cycleId}, ${'2'.repeat(64)}, ${'3'.repeat(64)},
              ${accountId}, ${terminalClientOrderId}, ${terminalSymbol}, 'BUY', 'MARKET', 'DAY',
              1000000, 1000000, 'PLANNED', NULL, 1, ${observedAt}, ${observedAt}
            )
          `
          yield* sql`
            INSERT INTO broker_events (
              event_id, schema_version, content_hash, event_kind, broker, account_id,
              source_event_id, source_sequence, occurred_at, observed_at
            ) VALUES (
              ${terminalIntentId}, 'bayn.paper-broker-event.v1', ${terminalIntentId}, 'ORDER', 'ALPACA',
              ${accountId}, ${`order-${status.toLowerCase()}`}, ${status === 'CANCELED' ? 103 : 104},
              ${observedAt}, ${observedAt}
            )
          `
          yield* sql`
            INSERT INTO orders (
              event_id, account_id, schema_version, broker_order_id, client_order_id, intent_id, symbol,
              side, order_type, time_in_force, quantity_micros, filled_quantity_micros, status
            ) VALUES (
              ${terminalIntentId}, ${accountId}, 'bayn.paper-order.v1', ${terminalBrokerOrderId},
              ${terminalClientOrderId}, ${terminalIntentId}, ${terminalSymbol}, 'BUY', 'MARKET', 'DAY', 1000000, 0,
              ${status}
            )
          `
        }),
      )
    }

    yield* insertTerminalOrder('7', 'CANCELED', '2026-04-08T13:32:00.000Z')
    yield* insertTerminalOrder('8', 'EXPIRED', '2026-04-08T13:33:00.000Z')
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const partialFillEventId = '9'.repeat(64)
        yield* sql`
          INSERT INTO broker_events (
            event_id, schema_version, content_hash, event_kind, broker, account_id,
            source_event_id, source_sequence, occurred_at, observed_at
          ) VALUES (
            ${partialFillEventId}, 'bayn.paper-broker-event.v1', ${partialFillEventId}, 'FILL', 'ALPACA',
            ${accountId}, 'partial-fill-before-cancel', 105,
            '2026-04-08T13:31:30.000Z', '2026-04-08T13:31:30.000Z'
          )
        `
        yield* sql`
          INSERT INTO fills (
            event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id, intent_id,
            symbol, side, quantity_micros, price_micros, fee_micros, source_timestamp
          ) VALUES (
            ${partialFillEventId}, ${accountId}, 'bayn.paper-fill.v1', 'partial-fill-before-cancel',
            'broker-observability-canceled', 'bayn-observability-canceled', ${'7'.repeat(64)},
            'AAPL', 'BUY', 500000, 100000000, 0, '2026-04-08T13:31:30.000000000Z'
          )
        `
      }),
    )
  })

describePostgres('PostgreSQL cycle observability projection', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await runtime.dispose()
    runtime = makeRuntime()
    await runtime.runPromise(PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' }))
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('reads bounded current/last and safety state without changing durable counts', async () => {
    const draft = makeDraft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        const empty = yield* observability.read(qualificationRunId, accountId)
        yield* sql`
          INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES (
            ${'0'.repeat(64)}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${'1'.repeat(64)},
            '2026-03-06T21:00:01.000Z', 0, ${'2'.repeat(64)}
          )
        `
        const emptyWithPositionSnapshot = yield* observability.read(qualificationRunId, accountId)
        yield* store.acquire(draft, '2026-03-06T21:01:00.000Z')

        const current = yield* observability.read(qualificationRunId, accountId)
        yield* store.block(
          draft.identity.cycleId,
          CycleTerminalReason.MissedPublication,
          draft.window.publicationDeadlineAt,
        )
        yield* seedUnresolvedMutation()
        const blocked = yield* observability.read(qualificationRunId, accountId)
        const blockedReplay = yield* observability.read(qualificationRunId, accountId)
        const [counts] = yield* sql<{
          cycles: number
          intents: number
          mutations: number
          reconciliations: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM autonomous_cycles) AS cycles,
            (SELECT count(*)::integer FROM intents) AS intents,
            (SELECT count(*)::integer FROM mutation_events) AS mutations,
            (SELECT count(*)::integer FROM reconciliations) AS reconciliations
        `
        return { blocked, blockedReplay, counts, current, empty, emptyWithPositionSnapshot }
      }),
    )

    expect(result.empty).toMatchObject({
      current: null,
      last: null,
      reconciliation: { accountId, reconciliationId, status: 'EXACT', discrepancyCount: 0 },
      economics: {
        accounting: {
          fillCount: 0,
          transactionCount: 0,
          receiptCount: 0,
          realizedCloseCount: 0,
          unaccountedFillCount: 0,
          unreceiptedTransactionCount: 0,
          grossRealizedPnlMicros: '0',
          executionFeesMicros: '0',
          netRealizedPnlAfterExecutionFeesMicros: '0',
        },
        forwardPerformance: null,
      },
      execution: {
        decision: null,
        intentCount: 0,
        orderCount: 0,
        fillCount: 0,
        positionSnapshotObservedAt: null,
        positionCount: null,
        grossExposureMicros: null,
        netExposureMicros: null,
        unrealizedPnlMicros: null,
        accountObservedAt: null,
      },
    })
    expect(result.emptyWithPositionSnapshot.execution).toMatchObject({
      positionSnapshotObservedAt: '2026-03-06T21:00:01.000Z',
      positionCount: 0,
      grossExposureMicros: '0',
      netExposureMicros: '0',
      unrealizedPnlMicros: '0',
    })
    expect(result.current).toMatchObject({
      current: {
        cycleId: draft.identity.cycleId,
        accountId,
        phase: CycleState.Pending,
        signalSessionDate: '2026-03-06',
        executionSessionDate: '2026-03-09',
        submissionCutoffAt: draft.window.submissionCutoffAt,
      },
      last: null,
      unfinishedCycleCount: 1,
      authority: {
        generationHash: 'f'.repeat(64),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      },
      reconciliation: {
        accountId,
        reconciliationId,
        status: 'EXACT',
        discrepancyCount: 0,
      },
      mutations: {
        eventCount: 0,
        recoveryFoundCount: 0,
        approvedIntentCount: 0,
        acknowledgedIntentCount: 0,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: null,
      },
      execution: {
        decision: null,
        intentCount: 0,
        orderCount: 0,
        fillCount: 0,
      },
    })
    expect(result.blocked).toMatchObject({
      current: null,
      last: {
        cycleId: draft.identity.cycleId,
        phase: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
        terminalAt: draft.window.publicationDeadlineAt,
      },
      unfinishedCycleCount: 0,
      mutations: {
        eventCount: 1,
        recoveryFoundCount: 0,
        unresolvedCount: 1,
        oldestUnresolvedAt: '2026-03-06T21:02:00.000Z',
        latestOccurredAt: '2026-03-06T21:02:00.000Z',
      },
      execution: {
        decision: null,
        intentCount: 0,
        orderCount: 0,
        fillCount: 0,
      },
    })
    expect(result.blockedReplay).toEqual(result.blocked)
    expect(result.counts).toEqual({ cycles: 1, intents: 1, mutations: 1, reconciliations: 1 })
  })

  test('projects an intraday cycle through its execution authority session', async () => {
    const draft = makeIntradayDraft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        yield* seedSafetyState()
        yield* store.acquire(draft, '2026-03-09T13:00:00.000Z')
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.current).toMatchObject({
      cycleId: draft.identity.cycleId,
      accountId,
      phase: CycleState.Pending,
      signalSessionDate: draft.identity.executionSessionDate,
      executionSessionDate: draft.identity.executionSessionDate,
      submissionCutoffAt: draft.window.submissionCutoffAt,
    })
    expect(projection.unfinishedCycleCount).toBe(1)
  })

  test('uses broker source ordering to break tied account-snapshot timestamps', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()

        const insertAccountSnapshot = (
          eventId: string,
          sourceSequence: number,
          cashMicros: string,
          buyingPowerMicros: string,
        ) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO broker_events (
                  event_id, schema_version, content_hash, event_kind, broker, account_id,
                  source_event_id, source_sequence, occurred_at, observed_at
                ) VALUES (
                  ${eventId}, 'bayn.paper-broker-event.v1', ${eventId}, 'ACCOUNT', 'ALPACA',
                  ${accountId}, ${`account-${sourceSequence}`}, ${sourceSequence},
                  '2026-03-06T20:59:59.000Z', '2026-03-06T21:00:01.000Z'
                )
              `
              yield* sql`
                INSERT INTO account_snapshots (
                  event_id, account_id, schema_version, status, currency,
                  cash_micros, equity_micros, buying_power_micros
                ) VALUES (
                  ${eventId}, ${accountId}, 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
                  ${cashMicros}, ${cashMicros}, ${buyingPowerMicros}
                )
              `
            }),
          )

        yield* insertAccountSnapshot('f'.repeat(64), 1, '1000000', '2000000')
        yield* insertAccountSnapshot('0'.repeat(64), 2, '3000000', '4000000')
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      accountObservedAt: '2026-03-06T21:00:01.000Z',
      cashMicros: '3000000',
      equityMicros: '3000000',
      buyingPowerMicros: '4000000',
    })
  })

  test('uses durable ingestion ordering to break tied position-snapshot timestamps', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        yield* sql`
          INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES
            (
              ${'f'.repeat(64)}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${'3'.repeat(64)},
              '2026-03-06T21:00:01.000Z', 1, ${'4'.repeat(64)}
            ),
            (
              ${'0'.repeat(64)}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${'5'.repeat(64)},
              '2026-03-06T21:00:01.000Z', 0, ${'6'.repeat(64)}
            )
        `
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      positionSnapshotObservedAt: '2026-03-06T21:00:01.000Z',
      positionCount: 0,
      grossExposureMicros: '0',
      netExposureMicros: '0',
      unrealizedPnlMicros: '0',
    })
  })

  test('counts blocked nonzero target deltas before intent planning', async () => {
    const draft = makeIntradayDraft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        yield* store.acquire(draft, '2026-03-09T13:00:00.000Z')
        yield* store.activate(draft.identity.cycleId, draft.window.submissionOpenAt)
        const createdAt = new Date(Date.parse(draft.window.submissionOpenAt) + 60_000).toISOString()
        const contentHash = '7'.repeat(64)
        const snapshotId = '8'.repeat(64)
        const document = {
          schemaVersion: 'bayn.observe-shadow-decision.v1',
          mode: 'OBSERVE',
          dispatchable: false,
          contentHash,
          createdAt,
          bindings: {
            cycleId: draft.identity.cycleId,
            snapshotId,
            executionMarketData: {
              observedAt: createdAt,
              barCount: 210,
              quoteCount: 7,
              tradeCount: 7,
            },
          },
          targetPlan: {
            status: 'BLOCKED',
            reason: 'INSUFFICIENT_BUYING_POWER',
            targets: [
              {
                symbol: 'AAPL',
                currentQuantityMicros: '0',
                targetQuantityMicros: '1000000',
              },
              {
                symbol: 'SPY',
                currentQuantityMicros: '1000000',
                targetQuantityMicros: '1000000',
              },
            ],
            intentTargets: [],
          },
          orderedIntentIds: [],
          riskBlock: { reasonCodes: [] },
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO autonomous_cycle_shadow_decisions (
                cycle_id, schema_version, document, created_at
              ) VALUES (
                ${draft.identity.cycleId}, 'bayn.observe-shadow-decision.v1',
                ${sql.json(encodeSqlJson(document))}, ${createdAt}
              )
            `
            yield* sql`
              UPDATE autonomous_cycles
              SET
                snapshot_id = ${snapshotId},
                decision_hash = ${contentHash},
                state_version = state_version + 1,
                updated_at = ${createdAt}
              WHERE cycle_id = ${draft.identity.cycleId}
            `
          }),
        )
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution?.decision).toMatchObject({
      targetPlanStatus: 'BLOCKED',
      targetPlanReason: 'INSUFFICIENT_BUYING_POWER',
      targetCount: 1,
      orderedIntentCount: 0,
    })
  })

  test('counts partial fills on canceled orders and preserves order latencies wider than int32', async () => {
    const draft = makeIntradayDraft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        yield* seedSafetyState()
        yield* store.acquire(draft, '2026-03-09T13:00:00.000Z')
        yield* seedOrderLifecycle(draft.identity.cycleId)
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      orderCount: 3,
      filledOrderCount: 2,
      canceledOrderCount: 1,
      expiredOrderCount: 1,
      latestOrderAt: '2026-04-08T13:33:00.000Z',
      maximumOrderAcknowledgementLatencyMs: 2_000,
      maximumFillLatencyMs: 2_592_000_000,
    })
  })

  test('projects open-recovery pressure and approved intent backlog as queryable counts', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        yield* seedSafetyState('2026-03-06T21:04:00.000Z')
        yield* seedOpenRecoveryAndApprovedIntent
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.mutations).toEqual({
      eventCount: 3,
      recoveryFoundCount: 1,
      approvedIntentCount: 1,
      acknowledgedIntentCount: 1,
      unresolvedCount: 0,
      oldestUnresolvedAt: null,
      latestOccurredAt: '2026-03-06T21:03:00.001Z',
    })
  })

  test('isolates mutation evidence by account and rejects an explicit account-to-cycle mismatch', async () => {
    const otherAccountId = 'paper-account-unrelated'
    const otherDraft = makeDraft(otherAccountId)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        yield* seedSafetyState()
        yield* seedUnresolvedMutation(otherAccountId)

        const isolated = yield* observability.read(qualificationRunId, accountId)
        yield* store.acquire(otherDraft, '2026-03-06T21:01:00.000Z')
        const mismatch = yield* Effect.flip(observability.read(qualificationRunId, accountId))
        return { isolated, mismatch }
      }),
    )

    expect(result.isolated).toMatchObject({
      current: null,
      last: null,
      reconciliation: { accountId },
      mutations: {
        eventCount: 0,
        recoveryFoundCount: 0,
        approvedIntentCount: 0,
        acknowledgedIntentCount: 0,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: null,
      },
    })
    expect(result.mismatch).toMatchObject({
      _tag: 'CycleObservabilityError',
      operation: 'read',
      failure: 'invariant',
      message: `configured account ${accountId} differs from the projected current or last cycle`,
    })
  })

  test('keeps unresolved mutation age anchored to the first unresolved event across recovery retries', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        yield* seedSafetyState('2026-03-06T21:14:00.000Z')
        yield* seedRepeatedUnresolvedRecovery
        return yield* observability.read(qualificationRunId, accountId)
      }),
    )

    expect(projection.mutations).toMatchObject({
      eventCount: 4,
      unresolvedCount: 1,
      oldestUnresolvedAt: '2026-03-06T21:02:00.000Z',
      latestOccurredAt: '2026-03-06T21:13:00.000Z',
    })
  })

  test.each(['SUBMIT_ACCEPTED', 'RECOVERY_FOUND'] as const)(
    'resets unresolved mutation age when recovery reopens after %s',
    async (resolvedEventType) => {
      const projection = await runtime.runPromise(
        Effect.gen(function* () {
          const observability = yield* CycleObservability
          yield* seedSafetyState('2026-03-06T21:14:00.000Z')
          yield* seedReopenedUnresolvedRecovery(resolvedEventType)
          return yield* observability.read(qualificationRunId, accountId)
        }),
      )

      expect(projection.mutations).toMatchObject({
        eventCount: resolvedEventType === 'RECOVERY_FOUND' ? 4 : 3,
        unresolvedCount: 1,
        oldestUnresolvedAt: '2026-03-06T21:12:00.000Z',
        latestOccurredAt: '2026-03-06T21:12:00.000Z',
      })
    },
  )

  test('uses the canonical reconciliation-id tie-break for equal timestamps', async () => {
    const higherReconciliationId = 'f'.repeat(64)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${higherReconciliationId},
            'bayn.paper-reconciliation.v1',
            ${accountId},
            ${reconciliationHash},
            ${reconciliationHash},
            ${'2'.repeat(64)},
            'EXACT',
            ${sql.json(encodeSqlJson([]))},
            ${'2026-03-06T21:00:00.000Z'}
          )
        `
        const projection = yield* observability.read(qualificationRunId, accountId)
        const [historyLatest] = yield* sql<{ reconciliation_id: string }>`
          SELECT reconciliation_id
          FROM reconciliations
          WHERE account_id = ${accountId}
          ORDER BY reconciled_at DESC, reconciliation_id DESC
          LIMIT 1
        `
        return { historyLatest, projection }
      }),
    )

    expect(result.historyLatest?.reconciliation_id).toBe(higherReconciliationId)
    expect(result.projection.reconciliation?.reconciliationId).toBe(result.historyLatest?.reconciliation_id)
  })

  test('keeps PAPER blocked when a sub-millisecond resolved mutation follows exact reconciliation', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        yield* seedSafetyState('2026-03-06T21:02:00.000000Z')
        yield* seedUnresolvedMutation()
        yield* seedAcceptedMutation('2026-03-06T21:02:00.000500Z')
        const projected = yield* observability.read(qualificationRunId, accountId)
        if (projected.authority === null) {
          return yield* Effect.die(new Error('authority projection is unavailable'))
        }
        const paperProjection = {
          ...projected,
          authority: {
            ...projected.authority,
            maximum: Authority.Execution,
            effective: Authority.Execution,
          },
        }
        const status = deriveCycleOperationsStatus(
          paperProjection,
          Date.parse('2026-03-06T21:03:30.000Z'),
          Authority.Execution,
          {
            cycleStallThresholdMs: 300_000,
            reconciliationStaleThresholdMs: 300_000,
            unknownMutationThresholdMs: 300_000,
          },
        )
        return { projected: paperProjection, status }
      }),
    )

    expect(result.projected).toMatchObject({
      reconciliation: {
        accountId,
        status: 'EXACT',
        reconciledAt: '2026-03-06T21:02:00.000Z',
        coversLatestMutation: false,
      },
      mutations: {
        eventCount: 2,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: '2026-03-06T21:02:00.000Z',
      },
    })
    expect(result.status).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationPredatesMutation,
      reconciliationCoversLatestMutation: false,
      alerts: { reconciliationBlocked: true, unknownMutationStale: false },
    })
  })

  test('retains terminal cancel history without projecting its neutralized submit as unresolved', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState('2026-03-06T21:08:00.000Z')
        yield* seedTerminalCanceledMutation
        const projection = yield* observability.read(qualificationRunId, accountId)
        const [history] = yield* sql<{ event_count: number; mutation_count: number }>`
          SELECT
            count(*)::integer AS event_count,
            count(DISTINCT mutation_id)::integer AS mutation_count
          FROM mutation_events
          WHERE intent_id = ${'2'.repeat(64)}
        `
        return { history, projection }
      }),
    )

    expect(result.history).toEqual({ event_count: 6, mutation_count: 2 })
    expect(result.projection).toMatchObject({
      reconciliation: {
        accountId,
        reconciliationId,
        status: 'EXACT',
        coversLatestMutation: true,
      },
      mutations: {
        eventCount: 6,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: '2026-03-06T21:07:00.000Z',
      },
    })
  })

  test('forward performance rejects a reconciliation predating a terminal no-fill rejection', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState('2026-03-06T21:00:00.000Z')
        yield* seedTerminalRejectedMutation
        const evidence = yield* readForwardPerformancePostgres(sql, accountId)
        const projection = yield* observability.read(qualificationRunId, accountId)
        const [activity] = yield* sql<{ fills: number; accounting: number }>`
          SELECT
            (SELECT count(*)::integer FROM fills WHERE account_id = ${accountId}) AS fills,
            (SELECT count(*)::integer FROM accounting_transactions WHERE account_id = ${accountId}) AS accounting
        `
        return { activity, evidence, projection }
      }),
    )

    expect(result.activity).toEqual({ fills: 0, accounting: 0 })
    expect(result.evidence).toMatchObject({
      transactions: [],
      unresolvedMutationCount: 0,
      unaccountedFillCount: 0,
      postReconciliationActivityCount: 2,
    })
    expect(result.projection).toMatchObject({
      reconciliation: { coversLatestMutation: false },
      mutations: {
        eventCount: 2,
        unresolvedCount: 0,
        latestOccurredAt: '2026-03-06T21:03:00.000Z',
      },
    })
  })

  test('forward performance and cycle observability fail closed on a same-timestamp terminal mutation', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState('2026-03-06T21:03:00.000Z')
        yield* seedTerminalRejectedMutation
        const evidence = yield* readForwardPerformancePostgres(sql, accountId)
        const projection = yield* observability.read(qualificationRunId, accountId)
        return { evidence, projection }
      }),
    )

    expect(result.evidence).toMatchObject({
      transactions: [],
      unresolvedMutationCount: 0,
      unaccountedFillCount: 0,
      postReconciliationActivityCount: 1,
    })
    expect(result.projection).toMatchObject({
      reconciliation: { coversLatestMutation: false },
      mutations: {
        eventCount: 2,
        unresolvedCount: 0,
        latestOccurredAt: '2026-03-06T21:03:00.000Z',
      },
    })
  })

  test('forward performance rejects a reconciliation predating terminal no-fill cancellation history', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState('2026-03-06T21:00:00.000Z')
        yield* seedTerminalCanceledMutation
        const evidence = yield* readForwardPerformancePostgres(sql, accountId)
        const projection = yield* observability.read(qualificationRunId, accountId)
        return { evidence, projection }
      }),
    )

    expect(result.evidence).toMatchObject({
      transactions: [],
      unresolvedMutationCount: 0,
      unaccountedFillCount: 0,
      postReconciliationActivityCount: 6,
    })
    expect(result.projection).toMatchObject({
      reconciliation: { coversLatestMutation: false },
      mutations: {
        eventCount: 6,
        unresolvedCount: 0,
        latestOccurredAt: '2026-03-06T21:07:00.000Z',
      },
    })
  })
})
