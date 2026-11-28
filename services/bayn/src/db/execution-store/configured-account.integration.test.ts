import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../../broker/identity'
import { makeAuthorityPostgres } from './authority-shared'
import {
  makeObserveAuthorityInterpreter,
  previousConfiguredController,
  selectConfiguredBrokerAccount,
} from './observe-authority'
import { migrationLoader } from '../migrations'
import { Authority } from '../../execution/contracts'
import { canonicalHashV1Result, sha256 } from '../../hash'
import { activeStrategyBehaviorHash, loadActiveStrategyProtocol } from '../../strategy'
import { makeStrategyProtocolHashResult } from '../../contracts'
import { baynTestPostgresUrl } from '../../test-environment.test-support'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const broker = (accountId: string) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      environment: BrokerEnvironment.Sandbox,
      provider: BrokerProvider.Alpaca,
      accountId,
    }),
  )

integration('Configured broker account against migrated PostgreSQL', () => {
  test('requires fresh, flat predecessor evidence and creates one linked OBSERVE generation', async () => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing test PostgreSQL URL')
    const postgres = PgClient.layer({ url: Redacted.make(baynTestPostgresUrl), maxConnections: 1 }).pipe(
      Layer.provideMerge(NodeServices.layer),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })

        const from = broker('departing-paper')
        const to = broker('new-paper')
        const root = sha256('old observe generation')
        const active = sha256('old paper generation')
        const authority = makeAuthorityPostgres(sql)
        const predecessorStore = makeObserveAuthorityInterpreter(sql, authority, from)
        yield* predecessorStore.ensureAuthorityGeneration({ generationHash: root, maximum: Authority.Observe })

        const reconcile = (name: string, positionCount: number) =>
          Effect.gen(function* () {
            const digest = sha256(name)
            yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at)
              VALUES(${digest},'bayn.paper-position-snapshot.v1',${from.accountId},${digest},${digest},${positionCount},clock_timestamp())`
            yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
              VALUES(${digest},'bayn.paper-reconciliation.v1',${from.accountId},${digest},${digest},${digest},'EXACT','[]'::jsonb,clock_timestamp())`
            return digest
          })

        const opening = yield* reconcile('opening reconciliation', 0)
        const protocol = Result.getOrThrow(loadActiveStrategyProtocol())
        const strategy = {
          name: 'jev',
          behaviorHash: activeStrategyBehaviorHash,
          parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
          parameterSchemaVersion: protocol.schemaVersion,
        }
        const protocolHash = Result.getOrThrow(makeStrategyProtocolHashResult(strategy))
        const activatedAt = yield* authority.nextAuthorityInstant
        yield* sql`INSERT INTO authority_generations(
          generation_hash,schema_version,activation_schema_version,previous_generation_hash,maximum,authority_version,
          broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,activation_source_revision,
          activation_image_repository,activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,
          strategy_parameter_schema_version,account_id,risk_policy_hash,proof_plan_hash,reconciliation_id,
          reconciliation_content_hash,research_plan_hash,strategy_protocol_hash,activated_at)
          VALUES(${active},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',${root},'PAPER',2,
            ${from.schemaVersion},${from.identityHash},${from.provider},${from.environment},${'1'.repeat(40)},'registry.example/bayn',
            ${`sha256:${'2'.repeat(64)}`},${strategy.name},${strategy.behaviorHash},${strategy.parameterHash},${strategy.parameterSchemaVersion},
            ${from.accountId},${sha256('risk')},${sha256('plan')},${opening},${opening},${sha256('research')},${protocolHash},${activatedAt})`
        yield* sql`UPDATE authority_state SET generation_hash=${active},maximum='PAPER',effective='PAPER',
          kill_state='CLEAR',reason=NULL,version=2,updated_at=${activatedAt} WHERE singleton`
        yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
          VALUES (${from.identityHash}, ${sha256('controller plan')}, true, 1, 0)`

        const unchanged = yield* predecessorStore.readAuthorityState
        const select = selectConfiguredBrokerAccount(to, 120_000)
        expect(yield* selectConfiguredBrokerAccount(from, 120_000)).toBeNull()
        expect(Result.isFailure(yield* select.pipe(Effect.result))).toBe(true)
        yield* reconcile('nonflat reconciliation', 1)
        expect(Result.isFailure(yield* select.pipe(Effect.result))).toBe(true)
        yield* reconcile('settled reconciliation', 0)
        const pending = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO intents (
            intent_id, schema_version, authority_generation_hash, strategy_name, cycle_id, decision_hash, policy_hash,
            account_id, client_order_id, symbol, side, order_type, time_in_force, quantity_atoms,
            notional_limit_micros, limit_price_micros, state, created_at, updated_at
          ) VALUES (
            ${sha256('pending intent')}, 'bayn.execution-intent.v5', ${active}, 'jev',
            ${sha256('pending cycle')}, ${sha256('pending decision')}, ${sha256('pending policy')},
            ${from.accountId}, 'pending-intent', 'AAPL', 'BUY', 'LIMIT', 'DAY',
            1000000, 1000000000, 1000000000000, 'PLANNED', ${activatedAt}, ${activatedAt}
          )`
              return yield* select
            }),
          )
          .pipe(Effect.result)
        expect(pending).toMatchObject({
          _tag: 'Failure',
          failure: { message: 'the current broker account has not settled' },
        })
        expect(yield* predecessorStore.readAuthorityState).toEqual(unchanged)
        expect(yield* sql`SELECT generation_hash FROM authority_generations ORDER BY authority_version`).toEqual([
          { generation_hash: root },
          { generation_hash: active },
        ])

        expect(yield* Effect.result(selectConfiguredBrokerAccount(to, 120_000, false))).toMatchObject({
          _tag: 'Failure',
          failure: { message: 'a prefixed Restate sleeve requires its own Postgres database and broker account' },
        })
        expect(yield* predecessorStore.readAuthorityState).toEqual(unchanged)

        expect(yield* select).toBe(from.identityHash)
        expect(yield* previousConfiguredController(sql, to)).toBe(from.identityHash)
        expect(yield* previousConfiguredController(sql, from)).toBeNull()
        const targetStore = makeObserveAuthorityInterpreter(sql, authority, to)
        const selected = yield* targetStore.readOrInitializeObserveAuthority({
          generationHash: root,
          maximum: Authority.Observe,
        })
        expect(selected).toMatchObject({ maximum: 'OBSERVE', effective: 'OBSERVE', kill: 'CLEAR', version: 3 })
        expect(
          Result.isFailure(
            yield* predecessorStore
              .readOrInitializeObserveAuthority({
                generationHash: root,
                maximum: Authority.Observe,
              })
              .pipe(Effect.result),
          ),
        ).toBe(true)

        expect(yield* select).toBe(from.identityHash)
        expect(yield* targetStore.readAuthorityState).toEqual(selected)
        expect(
          yield* sql`SELECT generation_hash,previous_generation_hash,account_id,maximum
          FROM authority_generations ORDER BY authority_version`,
        ).toEqual([
          { generation_hash: root, previous_generation_hash: null, account_id: from.accountId, maximum: 'OBSERVE' },
          { generation_hash: active, previous_generation_hash: root, account_id: from.accountId, maximum: 'PAPER' },
          {
            generation_hash: selected.generationHash,
            previous_generation_hash: active,
            account_id: to.accountId,
            maximum: 'OBSERVE',
          },
        ])
      }).pipe(Effect.provide(postgres)),
    )
  }, 30_000)
})
