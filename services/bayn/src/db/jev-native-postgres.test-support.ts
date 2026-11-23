import { DecisionConstruction } from '../decision-construction'
import { constructExecutionDecision, constructObserveShadowDecision } from '../shadow-decision'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { NodeServices } from '@effect/platform-node'
import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { OrderStatus, TerminalOutcome, TimeInForce } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { makeJevDefinition } from '../jev/decision'
import { decodeJevPortfolio, JevPurpose } from '../jev/portfolio'
import { clientOrderIdForIntentId } from '../execution/intents/domain'
import { WriterFenceLive } from '../execution/writer-fence'
import { IntentStoreLive } from '../execution/intents/postgres'
import { MutationStoreLive } from '../execution/mutations/program'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { ExecutionCycleClosureStoreLive } from './execution-cycle-closure-postgres'
import { nativeJevFixture as fixtureForAccount } from '../jev/native.test-support'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { jevBehaviorHash, defaultJevProtocolDocument } from '../jev/protocol'
import { makeRuntimeProvenanceResult } from '../contracts'
import { type ExecutionDecisionDocument } from '../shadow-decision-contract'
import {
  prepareClonedPostgres,
  type PostgresTestDatabase,
  type PostgresTestTemplate,
} from '../testing/postgres-template.test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { JevPositionStoreLive } from './jev-position-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
export const replayAccountId = `replay-${'e'.repeat(64)}`
export const premiums = Object.fromEntries(equityMarketProfile.candidateSymbols.map((symbol) => [symbol, 0.02]))
export const nativeJevFixture = (purpose: JevPurpose = JevPurpose.Entry, observedAt?: string) =>
  fixtureForAccount(purpose, observedAt, replayAccountId, defaultJevProtocolDocument, 'a'.repeat(64), premiums)
export const fixture = nativeJevFixture()

// Persist and recover retained v1 cycles with their original identity even after active composition changes.
export const retainedRuntime = {
  definition: makeJevDefinition(fixture.protocol),
  provenance: Result.getOrThrow(
    makeRuntimeProvenanceResult({
      ...fixtureRuntime.provenance,
      strategy: {
        name: 'jev',
        behaviorHash: jevBehaviorHash,
        parameterHash: Result.getOrThrow(canonicalHashV1Result(fixture.protocol)),
        parameterSchemaVersion: fixture.protocol.schemaVersion,
      },
    }),
  ),
}
export const observed = Date.parse(fixture.observation.payload.observedAt)
export const atObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(observed).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()))
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(DecisionConstruction, {
        observe: constructObserveShadowDecision,
        execution: constructExecutionDecision,
      }),
      EntryInferenceJournalLive,

      CycleStoreLive,
      CandidateObservationStoreLive,
      JevBatchStoreLive,
      JevPositionStoreLive,
      ExecutionCycleClosureStoreLive,
      IntentStoreLive,
      MutationStoreLive,
    ).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(JevEvaluationStoreLive),
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )
export const nativeInput = {
  cycleId: fixture.draft.identity.cycleId,
  authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
  protocol: fixture.protocol,
  portfolio: fixture.portfolio,
  snapshot: fixture.snapshot,
}

export const acquireEntryCycle = (at = fixture.observation.payload.observedAt) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${at} WHERE account_id = ${replayAccountId}`
    return yield* (yield* CycleStore).acquire(fixture.draft, at)
  })

export const seedManagedPosition = (
  options: {
    readonly symbol?: string
    readonly omitReceipt?: boolean
    readonly receiptAt?: string
    readonly observedAt?: string
    readonly entryDocument?: ExecutionDecisionDocument
    readonly heldMinutes?: number
    readonly nativeProtection?: 'strategy' | 'tampered'
    readonly settleEntry?: boolean
    readonly completeNativeEntry?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const managed = nativeJevFixture(JevPurpose.Manage, options.observedAt)
    let portfolio = managed.portfolio
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    if (options.symbol !== undefined) {
      const state = {
        ...portfolio.brokerState,
        positions: portfolio.brokerState.positions.map((position) => ({
          ...position,
          symbol: options.symbol ?? position.symbol,
        })),
        orders: portfolio.brokerState.orders.map((order) => ({ ...order, symbol: options.symbol ?? order.symbol })),
      }
      const hash = Result.getOrThrow(reconciledStateHash(state))
      portfolio = {
        ...portfolio,
        brokerState: { ...state, reconciliation: { ...state.reconciliation, expectedHash: hash, observedHash: hash } },
        entryFills: portfolio.entryFills.map((fill) => ({ ...fill, symbol: options.symbol ?? fill.symbol })),
        exitPolicy: {
          ...portfolio.exitPolicy,
          plans: Object.fromEntries(
            Object.values(portfolio.exitPolicy.plans).map((plan) => {
              if (plan.schemaVersion !== 'bayn.jev-funded-exit-plan.v4') throw new Error('Expected chart fixture')
              return [
                options.symbol ?? plan.levels.symbol,
                { ...plan, levels: { ...plan.levels, symbol: options.symbol ?? plan.levels.symbol } },
              ]
            }),
          ),
        },
      }
    }
    const heldMinutes = options.heldMinutes
    if (heldMinutes !== undefined)
      portfolio = {
        ...portfolio,
        entryFills: portfolio.entryFills.map((fill) => ({
          ...fill,
          occurredAt: new Date(Date.parse(managed.observation.payload.observedAt) - heldMinutes * 60_000).toISOString(),
        })),
      }
    const firstFillMs = Date.parse(portfolio.entryFills[0]?.occurredAt ?? '')
    portfolio = {
      ...portfolio,
      exitPolicy: {
        ...portfolio.exitPolicy,
        plans: Object.fromEntries(
          Object.entries(portfolio.exitPolicy.plans).map(([symbol, plan]) => {
            if (plan.schemaVersion !== 'bayn.jev-funded-exit-plan.v4') throw new Error('Expected chart fixture')
            return [
              symbol,
              {
                ...plan,
                levels: {
                  ...plan.levels,
                  sourceEndAt: new Date(Math.floor(firstFillMs / 60_000) * 60_000).toISOString(),
                  sourceStartAt: new Date(
                    Math.floor(firstFillMs / 60_000) * 60_000 - plan.levels.maximumHoldingMinutes * 60_000,
                  ).toISOString(),
                },
              },
            ]
          }),
        ),
      },
    }
    if (options.entryDocument !== undefined) {
      const entryId = options.entryDocument.orderedIntentIds[0]
      if (entryId === undefined) throw new Error('Expected an entry intent')
      const clientId = clientOrderIdForIntentId(entryId)
      const fullQuantity = options.completeNativeEntry
        ? options.entryDocument.targetPlan.intentTargets[0]?.quantityAtoms
        : undefined
      const originalQuantity = portfolio.entryFills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
      const state = {
        ...portfolio.brokerState,
        positions: portfolio.brokerState.positions.map((position) =>
          fullQuantity === undefined
            ? position
            : {
                ...position,
                quantityAtoms: fullQuantity,
                costBasisMicros: String((BigInt(position.costBasisMicros) * BigInt(fullQuantity)) / originalQuantity),
                marketValueMicros: String(
                  (BigInt(position.marketValueMicros) * BigInt(fullQuantity)) / originalQuantity,
                ),
                unrealizedPnlMicros: String(
                  (BigInt(position.unrealizedPnlMicros) * BigInt(fullQuantity)) / originalQuantity,
                ),
              },
        ),
        orders: portfolio.brokerState.orders.map((order) => ({
          ...order,
          intentId: entryId,
          clientOrderId: clientId,
          ...(fullQuantity === undefined
            ? {}
            : {
                quantityAtoms: fullQuantity,
                filledQuantityAtoms: fullQuantity,
                status: OrderStatus.Filled,
                timeInForce: TimeInForce.Day,
              }),
        })),
      }
      const hash = Result.getOrThrow(reconciledStateHash(state))
      portfolio = Result.getOrThrow(
        decodeJevPortfolio({
          ...portfolio,
          entryDecisionHash: options.entryDocument.contentHash,
          exitPolicy:
            options.entryDocument.strategyDecision?.schemaVersion === 'bayn.jev-entry-target.v7'
              ? options.entryDocument.strategyDecision.exitPolicy
              : portfolio.exitPolicy,
          entryIntentIds: [entryId],
          entryFills: portfolio.entryFills.map((fill, index) => ({
            ...fill,
            intentId: entryId,
            clientOrderId: clientId,
            ...(fullQuantity === undefined
              ? {}
              : { quantityAtoms: index === 0 ? String(BigInt(fullQuantity) - 2_000_000_000n) : '2000000000' }),
          })),
          brokerState: {
            ...state,
            reconciliation: { ...state.reconciliation, expectedHash: hash, observedHash: hash },
          },
        }),
      )
    }
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    const sql = yield* PgClient.PgClient
    const r = portfolio.brokerState.reconciliation
    const entryAt =
      options.entryDocument?.createdAt ??
      new Date(Date.parse(portfolio.entryFills[0]?.occurredAt ?? '') - 60_000).toISOString()
    const document = options.entryDocument ?? {
      schemaVersion: 'bayn.paper-cycle-decision.v2',
      mode: 'PAPER',
      dispatchable: true,
      contentHash: portfolio.entryDecisionHash,
      createdAt: entryAt,
      bindings: {
        cycleId: nativeInput.cycleId,
        accountId: r.accountId,
        strategyDecisionHash: '2'.repeat(64),
        policyHash: '3'.repeat(64),
        authorityGenerationHash: nativeInput.authorityGenerationHash,
      },
      strategyDecision: { schemaVersion: 'bayn.jev-entry-target.v7', exitPolicy: portfolio.exitPolicy },
      orderedIntentIds: portfolio.entryIntentIds,
    }
    yield* acquireEntryCycle(entryAt)
    if (options.entryDocument === undefined) yield* (yield* CycleStore).activate(nativeInput.cycleId, entryAt)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO autonomous_cycle_shadow_decisions (cycle_id, schema_version, document, created_at)
        VALUES (${nativeInput.cycleId}, ${document.schemaVersion}, ${sql.json(document)}, ${entryAt})`
        yield* sql`UPDATE autonomous_cycles SET snapshot_id = ${options.entryDocument?.bindings.snapshotId ?? managed.snapshot.manifest.snapshotId},
        decision_hash = ${portfolio.entryDecisionHash}, state_version = state_version + 1,
        updated_at = ${entryAt} WHERE cycle_id = ${nativeInput.cycleId}`
      }),
    )
    const managedReconciliationId = '1'.repeat(64)
    const brokerState = {
      ...portfolio.brokerState,
      reconciliation: { ...r, reconciliationId: managedReconciliationId },
    }
    yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
      content_hash, status, discrepancies, reconciled_at) VALUES (${managedReconciliationId}, ${r.schemaVersion}, ${r.accountId},
      ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
    for (const intentId of portfolio.entryIntentIds) {
      const levels = portfolio.exitPolicy.plans[options.symbol ?? 'AAPL']?.levels
      const boundTarget =
        options.nativeProtection === undefined ? undefined : options.entryDocument?.targetPlan.intentTargets[0]
      const boundRisk = options.nativeProtection === undefined ? undefined : options.entryDocument?.deltaRisk[0]
      const protection =
        options.nativeProtection === undefined || levels === undefined
          ? null
          : {
              _tag: 'Bracket',
              stopPriceMicros:
                options.nativeProtection === 'tampered'
                  ? (BigInt(levels.stopPriceMicros) + 1n).toString()
                  : levels.stopPriceMicros,
              stopLimitPriceMicros: levels.stopLimitPriceMicros,
              profitLimitPriceMicros: levels.profitLimitPriceMicros,
            }
      yield* sql`INSERT INTO intents (intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
        time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state, created_at, updated_at, cycle_id,
        strategy_name, decision_hash, policy_hash, authority_generation_hash, protection)
        VALUES (${intentId}, 'bayn.execution-intent.v5', ${r.accountId}, ${portfolio.entryFills[0]?.clientOrderId ?? 'entry-client'}, ${options.symbol ?? 'AAPL'}, 'BUY', 'LIMIT', ${options.symbol?.includes('/') === true ? 'IOC' : 'DAY'},
        ${boundTarget?.quantityAtoms ?? '10000000000'}, ${boundRisk?.notionalLimitMicros ?? '1000000000'}, ${boundRisk?.limitPriceMicros ?? '100000000'}, 'PLANNED', ${entryAt}, ${entryAt}, ${nativeInput.cycleId}, 'jev',
        ${document.bindings.strategyDecisionHash}, ${boundRisk === undefined ? '3'.repeat(64) : document.bindings.policyHash}, ${nativeInput.authorityGenerationHash}, ${protection === null ? null : sql.json(protection)})`
    }
    if (options.settleEntry)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const risk = options.entryDocument?.deltaRisk[0]?.evaluation.decision
          const intentId = portfolio.entryIntentIds[0]
          if (risk === undefined || intentId === undefined) throw new Error('Expected an approved entry decision')
          const approvedAt = new Date(Date.parse(risk.decidedAt) + 1).toISOString()
          yield* sql`UPDATE simulated_execution_clocks SET observed_at=${approvedAt} WHERE account_id=${replayAccountId}`
          yield* sql`INSERT INTO risk_decisions(decision_id,schema_version,input_hash,intent_id,policy_hash,
        outcome,reason_codes,decided_at,expires_at) VALUES (${risk.decisionId},${risk.schemaVersion},${risk.inputHash},
        ${intentId},${risk.policyHash},${risk.outcome},ARRAY(SELECT jsonb_array_elements_text(${sql.json(risk.reasonCodes)})),${risk.decidedAt},${risk.expiresAt})`
          yield* sql`UPDATE intents SET state='APPROVED',risk_decision_id=${risk.decisionId},
        state_version=state_version+1,updated_at=${approvedAt} WHERE intent_id=${intentId}`
          yield* sql`UPDATE intents SET state='IO_STARTED',state_version=state_version+1,
        updated_at=${new Date(Date.parse(approvedAt) + 1).toISOString()} WHERE intent_id=${intentId}`
          yield* sql`UPDATE intents SET state='TERMINAL',terminal_outcome=${TerminalOutcome.Filled},
        state_version=state_version+1,updated_at=${new Date(Date.parse(approvedAt) + 2).toISOString()} WHERE intent_id=${intentId}`
        }),
      )
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const [index, fill] of portfolio.entryFills.entries()) {
          const eventId = Result.getOrThrow(canonicalHashV1Result({ fillId: fill.fillId }))
          const notional = ((BigInt(fill.quantityAtoms) * BigInt(fill.priceAtoms)) / 1_000_000_000_000n).toString()
          yield* sql`INSERT INTO broker_events (event_id, schema_version, content_hash, event_kind, broker, account_id,
        source_event_id, source_sequence, occurred_at, observed_at) VALUES (${eventId}, 'bayn.paper-broker-event.v1',
        ${eventId}, 'FILL', 'ALPACA', ${r.accountId}, ${fill.fillId}, ${index + 1}, ${fill.occurredAt}, ${fill.occurredAt})`
          yield* sql`INSERT INTO fills (event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id,
        intent_id, symbol, side, quantity_atoms, price_atoms, fee_micros, source_timestamp)
        VALUES (${eventId}, ${r.accountId}, ${fill.schemaVersion}, ${fill.fillId}, ${fill.brokerOrderId},
        ${fill.clientOrderId}, ${fill.intentId ?? null}, ${fill.symbol}, ${fill.side}, ${fill.quantityAtoms},
        ${fill.priceAtoms}, ${fill.feeMicros}, ${fill.occurredAt.replace('Z', '000000Z')})`
          yield* sql`INSERT INTO accounting_transactions (transaction_id, schema_version, broker_event_id, intent_id, account_id,
        symbol, side, quantity_atoms, price_atoms, notional_micros, fee_micros, cost_basis_micros, realized_pnl_micros,
        quantity_delta_atoms, cost_basis_delta_micros, cash_delta_micros, ledger_plan_hash, content_hash, occurred_at)
        VALUES (${eventId}, 'bayn.accounting-transaction.v2', ${eventId}, ${fill.intentId ?? null}, ${r.accountId},
        ${fill.symbol}, ${fill.side}, ${fill.quantityAtoms}, ${fill.priceAtoms}, ${notional}, '0', ${notional}, '0',
        ${fill.quantityAtoms}, ${notional}, ${'-' + notional}, ${eventId}, ${eventId}, ${fill.occurredAt})`
          if (!options.omitReceipt || index !== 0)
            yield* sql`INSERT INTO accounting_receipts (receipt_id, schema_version, intent_id, broker_event_id,
          tigerbeetle_cluster_id, tigerbeetle_ledger, account_ids, transfer_ids, debit_micros, credit_micros,
          content_hash, recorded_at) VALUES (${eventId}, 'bayn.paper-accounting-receipt.v1', ${fill.intentId ?? null},
          ${eventId}, 1, 1, ARRAY[1,2]::numeric[], ARRAY[${index + 1}]::numeric[], ${notional}, ${notional},
          ${eventId}, ${options.receiptAt ?? fill.occurredAt})`
        }
      }),
    )
    yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${managed.observation.payload.observedAt}
      WHERE account_id = ${replayAccountId}`
    return { managed, portfolio: { ...portfolio, brokerState } }
  })

export type NativeJevPostgres = {
  readonly runtime: ReturnType<typeof makeRuntime>
  readonly restartRuntime: () => Promise<void>
  readonly makeAdditionalRuntime: () => ReturnType<typeof makeRuntime>
}

export const describeNativeJevPostgres = (defineTests: (postgres: NativeJevPostgres) => void) => {
  describePostgres('PostgreSQL native Jev execution decisions', () => {
    let template: PostgresTestTemplate
    let database: PostgresTestDatabase
    let runtime: ReturnType<typeof makeRuntime>
    beforeAll(async () => {
      template = await prepareClonedPostgres(testUrl, async (url) => {
        const schema = makeRuntime(url)
        try {
          await schema.runPromise(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* postgresMigrations
              yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
              VALUES (${replayAccountId}, ${'e'.repeat(64)}, ${fixture.draft.window.executionOpenAt})`
              yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
            VALUES (${nativeInput.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${fixture.observation.payload.observedAt})`
              const r = fixture.portfolio.brokerState.reconciliation
              yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
            VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
            }),
          )
        } finally {
          await schema.dispose()
        }
      })
    })
    beforeEach(async () => {
      database = await template.clone()
      runtime = makeRuntime(database.url)
    })
    afterEach(async () => {
      try {
        await runtime?.dispose()
      } finally {
        await database?.dispose()
      }
    })
    afterAll(async () => template?.dispose())
    defineTests({
      get runtime() {
        return runtime
      },
      async restartRuntime() {
        await runtime.dispose()
        runtime = makeRuntime(database.url)
      },
      makeAdditionalRuntime: () => makeRuntime(database.url),
    })
  })
}
