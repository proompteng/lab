import marketHoldingHorizonsMigration from '../../migrations/0144_market_holding_horizons'
import fundedPlanCoverageMigration from '../../migrations/0141_funded_plan_coverage'
import executableProfitLimitsMigration from '../../migrations/0143_executable_profit_limits'
import economicTradePlansMigration from '../../migrations/0140_economic_trade_plans'
import setupAndPlanMigration from '../../migrations/0137_setup_and_plan'
import completePlanChoiceMigration from '../../migrations/0133_complete_plan_choice'
import modelSelectedTradePlanMigration from '../../migrations/0131_model_selected_trade_plan'
import strategyNativeProtectionMigration from '../../migrations/0128_strategy_native_protection'
import entryBoundExitsMigration from '../../migrations/0126_entry_bound_exits'
import marketManagementJudgmentMigration from '../../migrations/0125_market_management_judgment'
import focusedJevJudgmentsMigration from '../../migrations/0124_focused_jev_judgments'
import setupActionProtocolMigration from '../../migrations/0123_setup_action_protocol'
import completedBarBenchmarksMigration from '../../migrations/0118_completed_bar_benchmarks'
import costSupportedEntryMigration from '../../migrations/0116_cost_supported_entry'
import equityHoursMigration from '../../migrations/0113_extended_equity_hours'
import capitalSizingMigration from '../../migrations/0109_capital_sizing_protocol'
import modelActionMigration from '../../migrations/0111_model_action_protocol'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import availableHistoryMigration from '../../migrations/0108_available_history_protocol'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { migrationLoader } from './migrations'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Authority } from '../execution/contracts'
import { makeAuthorityPostgres } from './execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from './execution-store/observe-authority'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10_000,
      postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )

for (const { label, id, protocol, migration } of [
  {
    label: 'market-holding-horizons',
    id: 144,
    protocol: 'bayn.jev.protocol.v21',
    migration: marketHoldingHorizonsMigration,
  },
  {
    label: 'executable-profit-limits',
    id: 143,
    protocol: 'bayn.jev.protocol.v20',
    migration: executableProfitLimitsMigration,
  },
  { label: 'funded-plan-coverage', id: 141, protocol: 'bayn.jev.protocol.v19', migration: fundedPlanCoverageMigration },
  { label: 'economic-trade-plans', id: 140, protocol: 'bayn.jev.protocol.v18', migration: economicTradePlansMigration },
  { label: 'setup-and-plan', id: 137, protocol: 'bayn.jev.protocol.v17', migration: setupAndPlanMigration },
  { label: 'complete-plan-choice', id: 133, protocol: 'bayn.jev.protocol.v16', migration: completePlanChoiceMigration },
  {
    label: 'model-selected-trade-plan',
    id: 131,
    protocol: 'bayn.jev.protocol.v15',
    migration: modelSelectedTradePlanMigration,
  },
  {
    label: 'strategy-native-protection',
    id: 128,
    protocol: 'bayn.jev.protocol.v14',
    migration: strategyNativeProtectionMigration,
  },
  { label: 'jev-native-exits', id: 126, protocol: 'bayn.jev.protocol.v13', migration: entryBoundExitsMigration },
  {
    label: 'jev-market-management',
    id: 125,
    protocol: 'bayn.jev.protocol.v12',
    migration: marketManagementJudgmentMigration,
  },
  {
    label: 'jev-focused-judgments',
    id: 124,
    protocol: 'bayn.jev.protocol.v11',
    migration: focusedJevJudgmentsMigration,
  },
  { label: 'jev-setup-action', id: 123, protocol: 'bayn.jev.protocol.v10', migration: setupActionProtocolMigration },
  { label: 'available-history', id: 108, protocol: 'bayn.jev.protocol.v4', migration: availableHistoryMigration },
  { label: 'capital-sizing', id: 109, protocol: 'bayn.jev.protocol.v5', migration: capitalSizingMigration },
  { label: 'model-action', id: 111, protocol: 'bayn.jev.protocol.v6', migration: modelActionMigration },
  { label: 'equity-hours', id: 113, protocol: 'bayn.jev.protocol.v7', migration: equityHoursMigration },
  { label: 'cost-supported-entry', id: 116, protocol: 'bayn.jev.protocol.v8', migration: costSupportedEntryMigration },
  {
    label: 'completed-bar-benchmark',
    id: 118,
    protocol: 'bayn.jev.protocol.v9',
    migration: completedBarBenchmarksMigration,
  },
]) {
  describePostgres(`${label} database cutover`, () => {
    let runtime: ReturnType<typeof makeRuntime>
    beforeAll(() => {
      const url = new URL(testUrl)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
        throw new Error('Migration tests require a local _test database')
      runtime = makeRuntime()
    })
    beforeEach(async () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(
              Effect.map((migrations) =>
                migrations.filter(([migrationId]) => migrationId < id || (id === 111 && migrationId === id)),
              ),
            ),
            table: 'schema_migrations',
          })
        }),
      ),
    )
    afterAll(async () => runtime.dispose())

    test('installs its protocol constraint on a fresh database', async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(
              Effect.map((migrations) => migrations.filter(([migrationId]) => migrationId <= id)),
            ),
            table: 'schema_migrations',
          })
          const rows = yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id=${id}`
          expect(rows).toHaveLength(1)
          const constraints = yield* sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='authority_generations'::regclass AND conname='authority_generations_strategy_contract_check'`
          expect(constraints[0]?.['definition']).toContain(protocol)
        }),
      )
    })

    if (
      id === 124 ||
      id === 125 ||
      id === 131 ||
      id === 133 ||
      id === 137 ||
      id === 140 ||
      id === 141 ||
      id === 143 ||
      id === 144
    ) {
      const retired =
        id === 144
          ? {
              protocol: 'bayn.jev.protocol.v20' as const,
              behavior: '191394ca45a010a3cc7b12b3794a8540f0495a4f7b0cb708612e8ed1d9338dc2',
              parameters: '5e4f552bb0420b98017e6a91b3df933dbb70408a51c6e13f804e1220de5700d6',
              protocolHash: 'f4a4ea1fff4aaba7ebfeb7a2a40b7a1823880f948bd8000cbb99db29187fbd5e',
            }
          : id === 143
            ? {
                protocol: 'bayn.jev.protocol.v19' as const,
                behavior: '4ab0406516dfd12e7c664834a9bc1f2fc2c07c512f9802e55b664cda963a1b52',
                parameters: '367f0cf235989e329c4974efd073db219e1efa4424fe0138c7a0eafb252c5fa2',
                protocolHash: 'faa9278528a758e00138e32486df84662e38443191aa8154ed75354daa1110b0',
              }
            : id === 141
              ? {
                  protocol: 'bayn.jev.protocol.v18' as const,
                  behavior: '8669593548424d848e8bcd2157eec5e571e9f7595315c9aea0c0ab56e214fc3b',
                  parameters: '167b5258319906743909ed89d6bb8fec7a01e4a134825cc64aa30d65a229f3be',
                  protocolHash: '03d49555af1590514bd756099f8da95495faad7645a00b4081532edf4bf0793a',
                }
              : id === 140
                ? {
                    protocol: 'bayn.jev.protocol.v17' as const,
                    behavior: 'f390ffe05a26895a4422f18cc91750ba9fab94af69bdca8f6ab809bae2338180',
                    parameters: '8319dc5fe813b2eaefc8c1ff2e9dffdde7ddab1ba2b23f1eb51e6c34a7cea25e',
                    protocolHash: '682b20d9eb4e18b5f0f5d5ab8ff9f76460ab5870c3ee2c2b0c7b477154d72d21',
                  }
                : id === 137
                  ? {
                      protocol: 'bayn.jev.protocol.v16' as const,
                      behavior: '118da7b475784ce63cb8d6636c0d469857ee36e2c7d8305e2d400f9aa47d548c',
                      parameters: '6dab28f7282460dcb9fc4551a8b6f287066ab08959e726074a2bf8e00167f8a9',
                      protocolHash: '762778f6dc4e902c85e606b0ae3c4619fcc05169b0a058248b2ea2f4eac08e86',
                    }
                  : id === 133
                    ? {
                        protocol: 'bayn.jev.protocol.v15' as const,
                        behavior: '55e0d13466d967a71e7e669021ae3dd21eb2f481a32c3de0d33bc14895ff6ccf',
                        parameters: '563596394b61aa4b68494f1854ecfc2cbeca8ead692f91a4f9b2d200ffd0ac5d',
                        protocolHash: '358241b51b40e89e43d2a0ccee695ff673ffd2ad02dd4f1c7652c8b0cbda8c59',
                      }
                    : id === 131
                      ? {
                          protocol: 'bayn.jev.protocol.v14' as const,
                          behavior: '9e6afa3accf9cb27c0ea4c00fe315aaeb70748229a668f48c57d02bce6beee29',
                          parameters: '7cf76109bc5301a4eabef41f4cf37ea531b3bb87c6b5246d74970262398936de',
                          protocolHash: 'f0060fa9df52e2a63e1c1adea08549f0c8cfdac94c8a406f621e307b4081f14e',
                        }
                      : id === 125
                        ? {
                            protocol: 'bayn.jev.protocol.v11' as const,
                            behavior: '1eb508ec119456b8ee73a0afc02b8f4dfd27728f236ca82db452c8a22c0a52af',
                            parameters: '3db1ac0d7c5fa34c8efd8f24b7bb8e72f2b4482033ebd2e1514862a27c4519f6',
                            protocolHash: '9688c8a626ae692b63462fd77cab6eeea84c3d5f2f5dce1eb7005ad87a2f0af7',
                          }
                        : {
                            protocol: 'bayn.jev.protocol.v10' as const,
                            behavior: '1a5721bc72a1dbc8e13fdc4eb27c04ad019a8ca6f6f398e4e55fd2d0c4b2ae31',
                            parameters: '6d4123a92405af4b112d7fa7dfeb1709b0937c6406aad61ebf9cf727eac4490b',
                            protocolHash: '48c1b3b1897155193973865716e23486d6d15295359e348371936c9ab4a9221d',
                          }
      test('recovers the retained prior authority through native OBSERVE after cutover', async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const broker = Result.getOrThrow(
              makeBrokerIdentity({
                schemaVersion: 'bayn.broker-identity.v2',
                provider: BrokerProvider.Alpaca,
                environment: BrokerEnvironment.Sandbox,
                accountId: 'paper-cutover',
              }),
            )
            const authority = makeAuthorityPostgres(sql)
            const observe = makeObserveAuthorityInterpreter(sql, authority, broker)
            const ensure = observe.ensureAuthorityGeneration
            if (ensure === undefined) return yield* Effect.die(new Error('Native authority interpreter is unavailable'))
            const original = 'a'.repeat(64),
              retained = 'b'.repeat(64),
              successor = 'c'.repeat(64)
            const reconciliation = 'd'.repeat(64),
              content = 'e'.repeat(64)
            yield* ensure({ generationHash: original, maximum: Authority.Observe })
            yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at) VALUES(${'f'.repeat(64)},'bayn.paper-position-snapshot.v1',${broker.accountId},${'6'.repeat(64)},${'7'.repeat(64)},0,clock_timestamp())`
            yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,
              expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
              VALUES(${reconciliation},'bayn.paper-reconciliation.v1',${broker.accountId},${content},${content},
                ${content},'EXACT','[]'::jsonb,clock_timestamp())`
            yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,activation_schema_version,
              previous_generation_hash,maximum,authority_version,broker_identity_schema_version,broker_identity_hash,
              broker_provider,broker_environment,activation_source_revision,activation_image_repository,
              activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,
              strategy_parameter_schema_version,account_id,risk_policy_hash,proof_plan_hash,reconciliation_id,
              reconciliation_content_hash,research_plan_hash,strategy_protocol_hash,activated_at)
              VALUES(${retained},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
                ${original},'PAPER',2,${broker.schemaVersion},${broker.identityHash},${broker.provider},${broker.environment},
                ${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},'jev',
                ${retired.behavior},${retired.parameters},${retired.protocol},${broker.accountId},${'3'.repeat(64)},${'4'.repeat(64)},${reconciliation},
                ${content},${'5'.repeat(64)},${retired.protocolHash},clock_timestamp())`
            yield* sql`UPDATE authority_state SET generation_hash=${retained},maximum='PAPER',effective='PAPER',
              kill_state='CLEAR',reason=NULL,version=2,updated_at=(SELECT activated_at FROM authority_generations WHERE generation_hash=${retained}) WHERE singleton`
            yield* sql.withTransaction(migration)
            expect((yield* authority.readGeneration(retained))[0]?.strategy_parameter_schema_version).toBe(
              retired.protocol,
            )
            const staleRecovery = yield* ensure({ generationHash: successor, maximum: Authority.Observe }).pipe(
              Effect.result,
            )
            expect(Result.isFailure(staleRecovery)).toBe(true)
            yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at) VALUES(${'8'.repeat(64)},'bayn.paper-position-snapshot.v1',${broker.accountId},${'9'.repeat(64)},${'0'.repeat(64)},0,clock_timestamp())`
            yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,
              expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
              VALUES(${'9'.repeat(64)},'bayn.paper-reconciliation.v1',${broker.accountId},${content},${content},
                ${content},'EXACT','[]'::jsonb,clock_timestamp())`
            const recovered = yield* ensure({ generationHash: successor, maximum: Authority.Observe })
            expect(recovered).toMatchObject({
              generationHash: successor,
              maximum: Authority.Observe,
              effective: Authority.Observe,
              kill: 'CLEAR',
            })
            expect((yield* authority.readGeneration(retained))[0]?.strategy_parameter_schema_version).toBe(
              retired.protocol,
            )
            const retiredWrite = yield* sql
              .withTransaction(
                sql`INSERT INTO authority_generations SELECT (jsonb_populate_record(NULL::authority_generations, to_jsonb(history) || jsonb_build_object('generation_hash',${'f'.repeat(64)}::text,'authority_version',999))).* FROM authority_generations history WHERE generation_hash=${retained}`,
              )
              .pipe(Effect.result)
            expect(Result.isFailure(retiredWrite)).toBe(true)
            if (Result.isFailure(retiredWrite))
              expect(retiredWrite.failure.reason.cause).toMatchObject({
                code: '23514',
                constraint: expect.stringContaining('authority_generations_strategy_'),
              })
          }),
        )
      })
    }

    if (id === 113) {
      test('upgrades an already-recorded equity-hours migration to native limit completion', async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* PgMigrator.run({
              loader: migrationLoader.pipe(
                Effect.map((migrations) => migrations.filter(([migrationId]) => migrationId <= id)),
              ),
              table: 'schema_migrations',
            })
            expect(yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id >= 113`).toEqual([
              { migration_id: 113 },
            ])
            yield* postgresMigrations
            expect(yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id = 114`).toEqual([
              { migration_id: 114 },
            ])
            const [completion] = yield* sql`SELECT
              to_regprocedure('paper_partial_ioc_entry_is_reconciled_flat(text,text,numeric,timestamptz)') IS NULL AS retired_absent,
              to_regprocedure('paper_partial_limit_entry_is_reconciled_flat(text,text,numeric,timestamptz)') IS NOT NULL AS current_present,
              paper_cycle_completion_evidence_matches(${'f'.repeat(64)}, ${'e'.repeat(64)}, clock_timestamp()) AS unbound_completed`
            expect(completion).toEqual({ retired_absent: true, current_present: true, unbound_completed: false })
          }),
        )
      })
    }

    test('refuses a held broker position without changing authority or protocol constraints', async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO position_snapshots (snapshot_id,schema_version,account_id,source_hash,
        content_hash,position_count,observed_at)
        VALUES (${'1'.repeat(64)},'bayn.paper-position-snapshot.v1','paper-cutover',${'2'.repeat(64)},
          ${'3'.repeat(64)},1,clock_timestamp())`
          const result = yield* sql.withTransaction(migration).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              reason: {
                cause: { code: '55000', message: expect.stringContaining(`${label} cutover requires`) },
              },
            })
          expect(yield* sql`SELECT position_count FROM position_snapshots`).toEqual([{ position_count: 1 }])
        }),
      )
    })

    test('recognizes a flat fee-net crypto ledger rather than treating the withheld fee as a holding', async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE accounting_transactions (
          account_id text, symbol text, quantity_delta_atoms numeric, cost_basis_delta_micros numeric,
          broker_event_id text, transaction_id text) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE accounting_receipts (broker_event_id text,receipt_id text) ON COMMIT DROP`
              yield* sql`CREATE TEMP VIEW broker_inventory_debits AS SELECT 'paper-cutover'::text AS account_id,
          'ETH/USD'::text AS symbol, 2500::numeric AS quantity_atoms, 250::numeric AS cost_basis_micros, true AS posted`
              yield* sql`INSERT INTO accounting_transactions VALUES
          ('paper-cutover','ETH/USD',1000000,100000,'buy','buy'),
          ('paper-cutover','ETH/USD',-997500,-99750,'sell','sell')`
              yield* sql`INSERT INTO accounting_receipts VALUES ('buy','buy'),('sell','sell')`
              yield* migration
              yield* sql`DROP VIEW broker_inventory_debits`
            }),
          )
        }),
      )
    })

    if (id >= 111) {
      test.each([
        { effective: 'PAPER', status: 'DISCREPANCY', reason: null, succeeds: false, changes: false },
        { effective: 'PAPER', status: 'EXACT', reason: null, succeeds: true, changes: true },
        {
          effective: 'OBSERVE',
          status: 'EXACT',
          reason: id === 111 ? 'BLOCKED_CAPITAL_SIZING_CUTOVER' : 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
          succeeds: true,
          changes: true,
        },
        ...[
          `reconciliation discrepancy ${'c'.repeat(64)}`,
          'operator hold',
          'unrecognized safety restriction',
          'reconciliation discrepancy malformed',
        ].map((reason) => ({
          effective: 'OBSERVE',
          status: 'DISCREPANCY',
          reason,
          succeeds: id < 116,
          changes: false,
        })),
        ...(id >= 116
          ? [
              {
                effective: 'OBSERVE',
                status: 'DISCREPANCY',
                reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
                succeeds: false,
                changes: false,
              },
              { effective: 'OBSERVE', status: 'EXACT', reason: 'operator hold', succeeds: true, changes: false },
            ]
          : []),
      ])(
        'protocol cutover retains non-cutover restrictions: %j',
        async ({ effective, status, reason, succeeds, changes }) => {
          await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`CREATE TEMP TABLE authority_generations (
                generation_hash text,account_id text,strategy_name text,strategy_parameter_schema_version text,
                CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK(true),
                CONSTRAINT authority_generations_strategy_contract_check CHECK(true)) ON COMMIT DROP`
                  yield* sql`CREATE TEMP TABLE authority_state (
                generation_hash text,maximum text,effective text,kill_state text,reason text,version bigint,updated_at timestamptz) ON COMMIT DROP`
                  yield* sql`CREATE TEMP TABLE reconciliations (
                account_id text,status text,reconciled_at timestamptz,reconciliation_id text,
                expected_hash text,observed_hash text,discrepancies jsonb) ON COMMIT DROP`
                  yield* sql`INSERT INTO authority_generations VALUES (${'a'.repeat(64)},'paper-cutover','jev','bayn.jev.protocol.v5')`
                  yield* sql`INSERT INTO authority_state VALUES (${'a'.repeat(64)},'PAPER',${effective},
                ${effective === 'PAPER' ? 'CLEAR' : 'ACTIVE'},${reason},1,clock_timestamp())`
                  yield* sql`INSERT INTO reconciliations (account_id,status,reconciled_at,reconciliation_id)
                VALUES ('paper-cutover',${status},clock_timestamp(),${'b'.repeat(64)})`
                  if (id >= 137) yield* sql`ALTER TABLE authority_generations ADD COLUMN maximum text DEFAULT 'PAPER'`
                  const result = yield* sql.withTransaction(migration).pipe(Effect.result)
                  if (succeeds) yield* Effect.fromResult(result)
                  expect(Result.isSuccess(result)).toBe(succeeds)
                  const [state] =
                    yield* sql`SELECT maximum,effective,kill_state,reason,version::text AS version FROM authority_state`
                  expect(state).toEqual(
                    changes
                      ? {
                          maximum: 'PAPER',
                          effective: 'OBSERVE',
                          kill_state: 'ACTIVE',
                          reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
                          version: '2',
                        }
                      : {
                          maximum: 'PAPER',
                          effective,
                          kill_state: effective === 'PAPER' ? 'CLEAR' : 'ACTIVE',
                          reason,
                          version: '1',
                        },
                  )
                }),
              )
            }),
          )
        },
      )
    }

    if (id === 116 || id === 118) {
      const retiredProtocol = id === 116 ? 'bayn.jev.protocol.v7' : 'bayn.jev.protocol.v8'
      test('retains historical Jev generations but rejects new retired protocol writes', async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`CREATE TEMP TABLE authority_generations (
              generation_hash text, account_id text, strategy_name text, strategy_parameter_schema_version text,
              CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK(true),
              CONSTRAINT authority_generations_strategy_contract_check CHECK(true)) ON COMMIT DROP`
                yield* sql`INSERT INTO authority_generations VALUES (${'a'.repeat(64)}, 'historical', 'jev', ${retiredProtocol})`
                yield* migration
                expect(yield* sql`SELECT strategy_parameter_schema_version FROM authority_generations`).toEqual([
                  { strategy_parameter_schema_version: retiredProtocol },
                ])
                const rejected = yield* sql
                  .withTransaction(
                    sql`INSERT INTO authority_generations VALUES (${'b'.repeat(64)}, 'current', 'jev', ${retiredProtocol})`,
                  )
                  .pipe(Effect.result)
                expect(Result.isFailure(rejected)).toBe(true)
                yield* sql`INSERT INTO authority_generations VALUES (${'c'.repeat(64)}, 'current', 'jev', ${protocol})`
                expect(yield* sql`SELECT count(*)::int AS count FROM authority_generations`).toEqual([{ count: 2 }])
              }),
            )
          }),
        )
      })
    }
  })
}
