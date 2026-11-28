import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import v38ObserveCutover from '../../migrations/0183_effective_entry_observe_cutover'
import v39ObserveCutover from '../../migrations/0186_jev114_observe_cutover'
import v40ObserveCutover from '../../migrations/0199_equity_short_observe_cutover'
import v41ObserveCutover from '../../migrations/0212_risk_symmetry_observe_cutover'
import v42ObserveCutover from '../../migrations/0216_stop_floor_reward_risk_observe_cutover'
import v43ObserveCutover from '../../migrations/0218_v43_paper_settlement'
import v44ObserveCutover from '../../migrations/0221_v44_paper_settlement'
import v2PaperSettlement from '../../migrations/0229_intraday_alpha_v2_paper_settlement'
import { loadSharedJevProtocol } from '../strategy'
import { intradayAlphaStrategyIdentity, makeIntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Authority } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { makeAuthorityPostgres } from './execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from './execution-store/observe-authority'
import { migrationLoader } from './migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const retainedV2 = Result.getOrThrow(
  intradayAlphaStrategyIdentity(makeIntradayAlphaPolicy(Result.getOrThrow(loadSharedJevProtocol()))),
)
for (const {
  behaviorHash = '76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67',
  schemaVersion,
  migrationId,
  effectiveEntryObserveCutover,
  parameterHash,
  protocolHash,
  rejectionMessage,
  requiresFreshPositionSnapshot = false,
} of [
  {
    schemaVersion: 'bayn.jev.protocol.v38',
    migrationId: 183,
    effectiveEntryObserveCutover: v38ObserveCutover,
    parameterHash: 'fa21a9d606eed0332637937d4d46035ba649d3fef968ab39480af796f13f419b',
    protocolHash: '489e704106e73592eb03dd8daf0750cbbb157e4d257bf53b948da1449b0c2d3c',
    rejectionMessage:
      'effective-entry OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v39',
    migrationId: 186,
    effectiveEntryObserveCutover: v39ObserveCutover,
    parameterHash: 'a03aad6fdf2c2f9d958f5922e69da57fbd2b6e3575941840076b20cebd5a0c54',
    protocolHash: '769bf588ec2944657b235e12c8c43a431339eab51ee4159cd44909ceaa9fed34',
    rejectionMessage:
      'Jev 1.14 OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v40',
    migrationId: 199,
    effectiveEntryObserveCutover: v40ObserveCutover,
    parameterHash: '6b47647a539b3a35971cfbc596c0a431300cababddea3d50ea460b4308a671bb',
    protocolHash: '140d646d825c1f77d3c5e1f21c425680f64d99226d2c2aacca97f70b11675dcf',
    rejectionMessage:
      'native equity short OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v41',
    migrationId: 212,
    effectiveEntryObserveCutover: v41ObserveCutover,
    parameterHash: '004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696',
    protocolHash: 'b97dc08473946b82b89f9e4bfae09d18c4bae4ebd8b854f5a6b2b805e35a19c9',
    rejectionMessage:
      'risk-symmetry OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v42',
    migrationId: 216,
    effectiveEntryObserveCutover: v42ObserveCutover,
    parameterHash: 'c78a10a127b6d4fbfd2fa3d2a433744f02295aa9a2b47b20bacfbd9804ba8ed5',
    protocolHash: '825c8806ba7d16783fcb96fc0d12f49b1e35f03ee81d82f6990bc7b11174d339',
    rejectionMessage:
      'stop-floor reward-risk OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v43',
    migrationId: 218,
    effectiveEntryObserveCutover: v43ObserveCutover,
    parameterHash: '810fedc00003ee940f3af6982ce65357662e241ec8c43b7d89922f6766108774',
    protocolHash: 'f9eaf3c7258e7f9bb5c4f070cfbde7d119cd6cd43f1272653f713bea680da17e',
    rejectionMessage:
      'v43 PAPER settlement requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: 'bayn.jev.protocol.v44',
    migrationId: 221,
    effectiveEntryObserveCutover: v44ObserveCutover,
    parameterHash: 'ba1bf25a3c184102bb0243ee2311cd76406a952f48533d7e4bfe1dd04c80e2b3',
    protocolHash: 'a6b1d3f53ffefeb407e82c2821c7843f4ff0c952ff66ebf714d30aa24f6257f1',
    rejectionMessage:
      'v44 PAPER settlement requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
  {
    schemaVersion: retainedV2.strategy.parameterSchemaVersion,
    migrationId: 229,
    effectiveEntryObserveCutover: v2PaperSettlement,
    behaviorHash: retainedV2.strategy.behaviorHash,
    parameterHash: retainedV2.strategy.parameterHash,
    protocolHash: retainedV2.protocolHash,
    requiresFreshPositionSnapshot: true,
    rejectionMessage:
      'intraday-alpha v2 PAPER settlement requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
  },
]) {
  const hash = (value: string) => Result.getOrThrow(canonicalHashV1Result({ value }))

  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }).pipe(
    Layer.provideMerge(NodeServices.layer),
  )

  const guardFixture = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    // Transaction-local tables isolate the guard predicates while executing every real migration statement.
    yield* sql.unsafe(`DO $fixture$ BEGIN
    CREATE TEMP TABLE intents(intent_id text,state text,account_id text) ON COMMIT DROP;
    CREATE TEMP TABLE autonomous_cycles(state text) ON COMMIT DROP;
    CREATE TEMP TABLE accounting_transactions(account_id text,symbol text,quantity_delta_atoms bigint,cost_basis_delta_micros bigint,broker_event_id text,transaction_id text DEFAULT 'transaction') ON COMMIT DROP;
    CREATE TEMP TABLE broker_inventory_debits(account_id text,symbol text,quantity_atoms bigint,cost_basis_micros bigint,posted boolean) ON COMMIT DROP;
    CREATE TEMP TABLE position_snapshots(account_id text,position_count integer,observed_at timestamptz,snapshot_id text) ON COMMIT DROP;
    CREATE TEMP TABLE accounting_receipts(broker_event_id text,receipt_id text) ON COMMIT DROP;
    CREATE TEMP TABLE fills(event_id text) ON COMMIT DROP;
    CREATE TEMP TABLE orders(account_id text,broker_order_id text,status text,event_id text) ON COMMIT DROP;
    CREATE TEMP TABLE broker_events(event_id text,source_sequence bigint) ON COMMIT DROP;
    CREATE TEMP TABLE authority_generations(generation_hash text,account_id text,strategy_name text,strategy_parameter_schema_version text,strategy_behavior_hash text,strategy_parameter_hash text,strategy_protocol_hash text) ON COMMIT DROP;
    CREATE TEMP TABLE authority_state(generation_hash text,maximum text,effective text,kill_state text,reason text,version bigint,updated_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE reconciliations(account_id text,status text,reconciled_at timestamptz,reconciliation_id text) ON COMMIT DROP;
    CREATE TEMP TABLE mutation_events(intent_id text,occurred_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE jev_evaluation_requests(request_id text,payload jsonb) ON COMMIT DROP;
    CREATE TEMP TABLE jev_evaluation_resolutions(request_id text) ON COMMIT DROP;
    CREATE TEMP TABLE jev_evaluation_receipts(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_inference_handoffs(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_chart_dispatch_claims(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_chart_terminal_receipts(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE inference_expense_quotes(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_staged_dispatch_claims(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_staged_terminal_receipts(unused integer) ON COMMIT DROP;
    CREATE TEMP TABLE jev_staged_skip_receipts(unused integer) ON COMMIT DROP;
    INSERT INTO authority_state VALUES ('current','PAPER','PAPER','CLEAR',NULL,17,clock_timestamp()-interval '1 second');
    INSERT INTO reconciliations VALUES ('account','EXACT',clock_timestamp(),'fresh');
  END $fixture$`)
    yield* sql`INSERT INTO authority_generations VALUES
    ('current','account','jev',${schemaVersion},${behaviorHash},${parameterHash},${protocolHash})`
    if (requiresFreshPositionSnapshot)
      yield* sql`INSERT INTO position_snapshots VALUES ('account',0,clock_timestamp(),'initial-flat')`
  })

  const withGuardFixture = <A, E, R>(seed: string, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* guardFixture
          if (seed !== '') yield* sql.unsafe(`DO $fixture$ BEGIN ${seed}; END $fixture$`)
          return yield* body
        }),
      )
    })

  const readState = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* sql<{
      readonly generationHash: string
      readonly maximum: string
      readonly effective: string
      readonly kill: string
      readonly reason: string | null
      readonly version: string
      readonly updatedAt: string
    }>`SELECT generation_hash AS "generationHash",maximum,effective,kill_state AS kill,reason,
    version::text AS version,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM authority_state`
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('Missing fixture authority state')
    return row
  })

  const readRetainedRows = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* sql`SELECT jsonb_build_object(
    'generations',(SELECT jsonb_agg(to_jsonb(g) ORDER BY generation_hash) FROM authority_generations g),
    'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY intent_id) FROM intents i),
    'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY state) FROM autonomous_cycles c),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY broker_event_id) FROM accounting_transactions t),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY broker_event_id) FROM accounting_receipts r),
    'debits',(SELECT jsonb_agg(to_jsonb(d) ORDER BY account_id,symbol) FROM broker_inventory_debits d),
    'fills',(SELECT jsonb_agg(to_jsonb(f) ORDER BY event_id) FROM fills f),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY event_id) FROM orders o),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM broker_events e),
    'positions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY snapshot_id) FROM position_snapshots p),
    'reconciliations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY reconciliation_id) FROM reconciliations r),
    'mutations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY intent_id,occurred_at) FROM mutation_events m),
    'requests',(SELECT jsonb_agg(to_jsonb(q) ORDER BY request_id) FROM jev_evaluation_requests q),
    'resolutions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM jev_evaluation_resolutions r)
  ) AS retained`
  })

  const blockers = [
    ...(requiresFreshPositionSnapshot
      ? [
          { name: 'no broker position snapshot', seed: 'DELETE FROM position_snapshots' },
          {
            name: 'stale broker position snapshot',
            seed: "UPDATE position_snapshots SET observed_at=clock_timestamp()-interval '61 seconds'",
          },
        ]
      : []),
    { name: 'nonterminal intent', seed: "INSERT INTO intents VALUES ('intent','PLANNED','account')" },
    ...['PENDING', 'ACTIVE'].map((state) => ({
      name: `${state} cycle`,
      seed: `INSERT INTO autonomous_cycles VALUES ('${state}')`,
    })),
    {
      name: 'ledger quantity without cost',
      seed: "INSERT INTO accounting_transactions VALUES ('account','SPY',1,0,'event'); INSERT INTO accounting_receipts VALUES ('event','receipt')",
    },
    {
      name: 'ledger cost without quantity',
      seed: "INSERT INTO accounting_transactions VALUES ('account','SPY',0,1,'event'); INSERT INTO accounting_receipts VALUES ('event','receipt')",
    },
    { name: 'posted inventory debit', seed: "INSERT INTO broker_inventory_debits VALUES ('account','SPY',1,1,true)" },
    {
      name: 'latest broker position is nonflat',
      seed: "INSERT INTO position_snapshots VALUES ('account',0,clock_timestamp()-interval '1 second','old'),('account',1,clock_timestamp(),'latest')",
    },
    {
      name: 'unreceipted transaction',
      seed: "INSERT INTO accounting_transactions VALUES ('account','SPY',0,0,'event')",
    },
    { name: 'unaccounted fill', seed: "INSERT INTO fills VALUES ('event')" },
    ...['NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD'].map((status) => ({
      name: `${status} latest order`,
      seed: `INSERT INTO orders VALUES ('account','order','${status}','event'); INSERT INTO broker_events VALUES ('event',1)`,
    })),
    {
      name: 'unexpired unresolved inference claim',
      seed: "INSERT INTO jev_evaluation_requests VALUES ('request',jsonb_build_object('expiresAt',clock_timestamp()+interval '1 hour'))",
    },
  ]

  const reconciliationBlockers = [
    { name: 'missing reconciliation', seed: 'DELETE FROM reconciliations' },
    { name: 'another account reconciliation', seed: "UPDATE reconciliations SET account_id='another-account'" },
    { name: 'nonexact reconciliation', seed: "UPDATE reconciliations SET status='DISCREPANCY'" },
    { name: 'null reconciliation time', seed: 'UPDATE reconciliations SET reconciled_at=NULL' },
    {
      name: 'stale reconciliation',
      seed: "UPDATE reconciliations SET reconciled_at=clock_timestamp()-interval '61 seconds'",
    },
    {
      name: 'future reconciliation',
      seed: "UPDATE reconciliations SET reconciled_at=clock_timestamp()+interval '1 hour'",
    },
    {
      name: 'reconciliation before latest account mutation',
      seed: "UPDATE reconciliations SET reconciled_at=clock_timestamp()-interval '1 second'; INSERT INTO intents VALUES ('intent','TERMINAL','account'); INSERT INTO mutation_events VALUES ('intent',clock_timestamp())",
    },
    {
      name: 'newer nonexact reconciliation after an exact one',
      seed: "INSERT INTO reconciliations VALUES ('account','DISCREPANCY',clock_timestamp(),'newer')",
    },
  ]

  const preservedStates = [
    {
      name: 'operator hold',
      seed: "UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',reason='OPERATOR_HOLD'",
    },
    {
      name: 'unrelated system restriction',
      seed: "UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',reason='BLOCKED_RECONCILIATION_DISCREPANCY'",
    },
    {
      name: 'existing cutover restriction',
      seed: "UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER'",
    },
    { name: 'clear OBSERVE authority', seed: "UPDATE authority_state SET maximum='OBSERVE',effective='OBSERVE'" },
    { name: 'another strategy name', seed: "UPDATE authority_generations SET strategy_name='other-strategy'" },
    {
      name: 'another protocol version',
      seed: "UPDATE authority_generations SET strategy_parameter_schema_version='bayn.jev.protocol.v37'",
    },
    {
      name: 'another behavior hash',
      seed: `UPDATE authority_generations SET strategy_behavior_hash='${'0'.repeat(64)}'`,
    },
    {
      name: 'another parameter hash',
      seed: `UPDATE authority_generations SET strategy_parameter_hash='${'0'.repeat(64)}'`,
    },
    {
      name: 'another protocol hash',
      seed: `UPDATE authority_generations SET strategy_protocol_hash='${'0'.repeat(64)}'`,
    },
  ]

  const unsettledHistory = `
  INSERT INTO intents VALUES ('unresolved-intent','PLANNED','account');
  INSERT INTO autonomous_cycles VALUES ('ACTIVE');
  INSERT INTO accounting_transactions VALUES ('account','SPY',1,1,'unreceipted-event');
  INSERT INTO fills VALUES ('unaccounted-fill');
  INSERT INTO position_snapshots VALUES ('account',1,clock_timestamp(),'held-position');
  INSERT INTO broker_events VALUES ('open-order-event',1);
  INSERT INTO orders VALUES ('account','open-order','NEW','open-order-event');
  INSERT INTO jev_evaluation_requests VALUES ('unresolved-request',jsonb_build_object('expiresAt',clock_timestamp()+interval '1 hour'));
  DELETE FROM reconciliations`

  integration(`${schemaVersion} native OBSERVE cutover`, () => {
    const runtime = ManagedRuntime.make(postgres)
    beforeAll(() => {
      const parsed = new URL(url)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
        throw new Error('Effective-entry cutover tests require an isolated local _test database')
    })
    afterAll(async () => runtime.dispose())

    test('restricts only current authority, preserves retained evidence and is idempotent', async () => {
      await runtime.runPromise(
        withGuardFixture(
          `INSERT INTO authority_generations SELECT 'historical',account_id,strategy_name,'bayn.jev.protocol.v37',strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash FROM authority_generations;
         INSERT INTO intents VALUES ('intent','TERMINAL','account');
         INSERT INTO autonomous_cycles VALUES ('BLOCKED');
         INSERT INTO accounting_transactions VALUES ('account','SPY',10,100,'event');
         INSERT INTO accounting_receipts VALUES ('event','receipt');
         INSERT INTO fills VALUES ('event');
         INSERT INTO broker_inventory_debits VALUES ('account','SPY',10,100,true);
         INSERT INTO position_snapshots VALUES ('account',1,clock_timestamp()-interval '1 second','old'),('account',0,clock_timestamp(),'latest');
         INSERT INTO broker_events VALUES ('order-opened',1),('order-filled',2);
         INSERT INTO orders VALUES ('account','order','NEW','order-opened'),('account','order','FILLED','order-filled');
         INSERT INTO mutation_events VALUES ('intent',clock_timestamp()-interval '1 second');
         UPDATE authority_state SET updated_at=clock_timestamp()+interval '1 second'`,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const before = yield* readState
            const retained = yield* readRetainedRows
            yield* effectiveEntryObserveCutover
            const restricted = yield* readState
            expect(restricted).toMatchObject({
              generationHash: before.generationHash,
              maximum: 'PAPER',
              effective: 'OBSERVE',
              kill: 'ACTIVE',
              reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
              version: '18',
            })
            expect(Date.parse(restricted.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt) + 1)
            expect(yield* readRetainedRows).toEqual(retained)
            yield* effectiveEntryObserveCutover
            expect(yield* readState).toEqual(restricted)
            expect(yield* readRetainedRows).toEqual(retained)
            expect(yield* sql`SELECT count(*)::integer AS generations FROM authority_generations`).toEqual([
              { generations: 2 },
            ])
          }),
        ),
      )
    })

    test.each([...blockers, ...reconciliationBlockers.map(({ name, seed }) => ({ name: `PAPER: ${name}`, seed }))])(
      '$name rejects before changing authority or retained evidence',
      async ({ seed }) => {
        await runtime.runPromise(
          withGuardFixture(
            seed,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              const before = yield* readState
              const retained = yield* readRetainedRows
              const result = yield* sql.withTransaction(effectiveEntryObserveCutover).pipe(Effect.result)
              expect(Result.isFailure(result)).toBe(true)
              if (Result.isFailure(result))
                expect(result.failure).toMatchObject({
                  reason: { cause: { code: '55000', message: rejectionMessage } },
                })
              expect(yield* readState).toEqual(before)
              expect(yield* readRetainedRows).toEqual(retained)
            }),
          ),
        )
      },
    )

    test.each([
      ...preservedStates.map(({ name, seed }) => ({
        name: `${name} with unsettled history`,
        seed: `${seed}; ${unsettledHistory}`,
      })),
      ...reconciliationBlockers.map(({ name, seed }) => ({
        name: `clear OBSERVE: ${name}`,
        seed: `UPDATE authority_state SET maximum='OBSERVE',effective='OBSERVE'; ${seed}`,
      })),
    ])('$name remains unchanged without applying a PAPER-only guard', async ({ seed }) => {
      await runtime.runPromise(
        withGuardFixture(
          seed,
          Effect.gen(function* () {
            const before = yield* readState
            const retained = yield* readRetainedRows
            yield* effectiveEntryObserveCutover
            expect(yield* readState).toEqual(before)
            expect(yield* readRetainedRows).toEqual(retained)
          }),
        ),
      )
    })

    test.each([
      {
        name: 'expired unresolved claim',
        seed: "INSERT INTO jev_evaluation_requests VALUES ('request',jsonb_build_object('expiresAt',clock_timestamp()-interval '1 second'))",
      },
      {
        name: 'resolved unexpired claim',
        seed: "INSERT INTO jev_evaluation_requests VALUES ('request',jsonb_build_object('expiresAt',clock_timestamp()+interval '1 hour')); INSERT INTO jev_evaluation_resolutions VALUES ('request')",
      },
      {
        name: 'resolved historical claim without a current expiry codec',
        seed: "INSERT INTO jev_evaluation_requests VALUES ('request','{\"expiresAt\":\"retained-old-codec\"}'); INSERT INTO jev_evaluation_resolutions VALUES ('request')",
      },
      {
        name: 'unposted inventory debit',
        seed: "INSERT INTO broker_inventory_debits VALUES ('account','SPY',10,100,false)",
      },
      {
        name: 'unrelated account mutation after reconciliation',
        seed: "INSERT INTO intents VALUES ('intent','TERMINAL','another-account'); INSERT INTO mutation_events VALUES ('intent',clock_timestamp())",
      },
    ])('$name does not prevent a settled restriction', async ({ seed }) => {
      await runtime.runPromise(
        withGuardFixture(
          seed,
          Effect.gen(function* () {
            const retained = yield* readRetainedRows
            yield* effectiveEntryObserveCutover
            expect(yield* readState).toMatchObject({ effective: 'OBSERVE', kill: 'ACTIVE', version: '18' })
            expect(yield* readRetainedRows).toEqual(retained)
          }),
        ),
      )
    })

    test('admits an uninitialized database without inventing authority or reconciliation', async () => {
      await runtime.runPromise(
        withGuardFixture(
          'DELETE FROM authority_state; DELETE FROM authority_generations; DELETE FROM reconciliations',
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const retained = yield* readRetainedRows
            yield* effectiveEntryObserveCutover
            expect(yield* sql`SELECT * FROM authority_state`).toEqual([])
            expect(yield* readRetainedRows).toEqual(retained)
          }),
        ),
      )
    })

    test('migrated authority recovers through native OBSERVE only after fresh reconciliation', async () => {
      // Guard queries are prepared against temporary tables. Recovery uses a fresh connection to the real tables.
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < migrationId))),
            table: 'schema_migrations',
          })
          yield* sql.withTransaction(effectiveEntryObserveCutover)
          const broker = Result.getOrThrow(
            makeBrokerIdentity({
              schemaVersion: 'bayn.broker-identity.v2',
              provider: BrokerProvider.Alpaca,
              environment: BrokerEnvironment.Sandbox,
              accountId: 'effective-entry-cutover-test',
            }),
          )
          const original = hash('effective-entry-root')
          const paper = hash('effective-entry-v38-paper')
          const successor = hash('effective-entry-observe-successor')
          const authority = makeAuthorityPostgres(sql)
          const { ensureAuthorityGeneration: ensure } = makeObserveAuthorityInterpreter(sql, authority, broker)
          yield* ensure({ generationHash: original, maximum: Authority.Observe })
          const reconcile = (label: string) =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at)
              VALUES(${hash(`${label}-positions`)},'bayn.paper-position-snapshot.v1',${broker.accountId},${hash(label)},${hash(label)},0,clock_timestamp())`
              yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
              VALUES(${hash(label)},'bayn.paper-reconciliation.v1',${broker.accountId},${hash(label)},${hash(label)},${hash(label)},'EXACT','[]'::jsonb,clock_timestamp())`
            })
          yield* reconcile('effective-entry-before')
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,activation_schema_version,
          previous_generation_hash,maximum,authority_version,broker_identity_schema_version,broker_identity_hash,
          broker_provider,broker_environment,activation_source_revision,activation_image_repository,
          activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,
          strategy_parameter_schema_version,account_id,risk_policy_hash,proof_plan_hash,reconciliation_id,
          reconciliation_content_hash,research_plan_hash,strategy_protocol_hash,activated_at)
          VALUES(${paper},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
            ${original},'PAPER',2,${broker.schemaVersion},${broker.identityHash},${broker.provider},${broker.environment},
            ${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},'jev',${behaviorHash},${parameterHash},
            ${schemaVersion},${broker.accountId},${hash('risk')},${hash('plan')},${hash('effective-entry-before')},
            ${hash('effective-entry-before')},${hash('research')},${protocolHash},clock_timestamp())`
          yield* sql`UPDATE authority_state SET generation_hash=${paper},maximum='PAPER',effective='PAPER',kill_state='CLEAR',
          reason=NULL,version=2,updated_at=(SELECT activated_at FROM authority_generations WHERE generation_hash=${paper}) WHERE singleton`
          const retained =
            yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g ORDER BY generation_hash`
          yield* sql.withTransaction(effectiveEntryObserveCutover)
          const restricted = yield* readState
          expect(restricted).toMatchObject({
            generationHash: paper,
            maximum: 'PAPER',
            effective: 'OBSERVE',
            kill: 'ACTIVE',
            version: '3',
            reason: 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
          })
          expect(
            yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g ORDER BY generation_hash`,
          ).toEqual(retained)
          yield* sql.withTransaction(effectiveEntryObserveCutover)
          expect(yield* readState).toEqual(restricted)
          const premature = yield* ensure({ generationHash: successor, maximum: Authority.Observe }).pipe(Effect.result)
          expect(Result.isFailure(premature)).toBe(true)
          expect(yield* readState).toEqual(restricted)
          yield* reconcile('effective-entry-after')
          const recovered = yield* ensure({ generationHash: successor, maximum: Authority.Observe })
          expect(recovered).toMatchObject({
            generationHash: successor,
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: 'CLEAR',
            version: 4,
          })
          expect(yield* ensure({ generationHash: successor, maximum: Authority.Observe })).toEqual(recovered)
          expect(
            yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g WHERE generation_hash IN (${original},${paper}) ORDER BY generation_hash`,
          ).toEqual(retained)
          expect(
            yield* sql`SELECT previous_generation_hash,account_id,broker_identity_hash FROM authority_generations WHERE generation_hash=${successor}`,
          ).toEqual([
            {
              previous_generation_hash: paper,
              account_id: broker.accountId,
              broker_identity_hash: broker.identityHash,
            },
          ])
        }).pipe(Effect.provide(postgres)),
      )
    }, 30_000)
  })
}
