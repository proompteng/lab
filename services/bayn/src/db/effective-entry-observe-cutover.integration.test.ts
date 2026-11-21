import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import v38ObserveCutover from '../../migrations/0183_effective_entry_observe_cutover'
import v39ObserveCutover from '../../migrations/0186_jev114_observe_cutover'
import v40ObserveCutover from '../../migrations/0199_equity_short_observe_cutover'
import v41ObserveCutover from '../../migrations/0207_support_recovery_observe_cutover'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { reconciliationIncompleteRestrictionReason } from '../execution/authority'
import { Authority } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { restrictAuthority } from './reconciliation'
import { makeAuthorityPostgres } from './execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from './execution-store/observe-authority'
import { migrationLoader } from './migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
for (const {
  schemaVersion,
  migrationId,
  effectiveEntryObserveCutover,
  parameterHash,
  protocolHash,
  rejectionMessage,
  requiresDurableBrokerCoverage,
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
    migrationId: 207,
    effectiveEntryObserveCutover: v41ObserveCutover,
    parameterHash: '004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696',
    protocolHash: 'b97dc08473946b82b89f9e4bfae09d18c4bae4ebd8b854f5a6b2b805e35a19c9',
    rejectionMessage:
      'support-recovery OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete posted accounting, durable broker coverage and no unexpired inference claims',
    requiresDurableBrokerCoverage: true,
  },
]) {
  const behaviorHash = '76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67'
  const currentHash = 'c'.repeat(64)
  const hash = (value: string) => Result.getOrThrow(canonicalHashV1Result({ value }))

  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 2 }).pipe(
    Layer.provideMerge(NodeServices.layer),
  )

  const guardFixture = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    if (requiresDurableBrokerCoverage === true)
      yield* sql`DROP TABLE IF EXISTS public.research_capital_activation_retirements CASCADE`
    // Transaction-local tables isolate the guard predicates while executing every real migration statement.
    yield* sql.unsafe(`DO $fixture$ BEGIN
    CREATE TEMP TABLE intents(intent_id text,state text,account_id text) ON COMMIT DROP;
    CREATE TEMP TABLE autonomous_cycles(state text) ON COMMIT DROP;
    CREATE TEMP TABLE accounting_transactions(account_id text,symbol text,quantity_delta_atoms bigint,cost_basis_delta_micros bigint,broker_event_id text,transaction_id text DEFAULT 'transaction') ON COMMIT DROP;
    CREATE TEMP TABLE broker_inventory_debits(account_id text,symbol text,quantity_atoms bigint,cost_basis_micros bigint,posted boolean) ON COMMIT DROP;
    CREATE TEMP TABLE position_snapshots(account_id text,position_count integer,observed_at timestamptz,snapshot_id text) ON COMMIT DROP;
    CREATE TEMP TABLE accounting_receipts(broker_event_id text,receipt_id text) ON COMMIT DROP;
    CREATE TEMP TABLE broker_cash_settlements(account_id text,posted_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE broker_fee_match_corrections(account_id text,posted_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE broker_fee_accruals(account_id text,accrual_id text,ledger_plan_hash text,posted_at timestamptz)
      ON COMMIT DROP;
    CREATE TEMP TABLE broker_fee_accounting(account_id text,activity_id text,ledger_plan_hash text,posted_at timestamptz)
      ON COMMIT DROP;
    CREATE TEMP TABLE broker_fee_posting_acknowledgements(account_id text,source_kind text,source_id text,
      ledger_plan_hash text) ON COMMIT DROP;
    CREATE TEMP TABLE fills(event_id text) ON COMMIT DROP;
    CREATE TEMP TABLE orders(account_id text,broker_order_id text,status text,event_id text,
      broker_updated_at text DEFAULT '2026-01-01T00:00:00.000000000Z') ON COMMIT DROP;
    CREATE TEMP TABLE broker_events(event_id text,source_sequence bigint) ON COMMIT DROP;
    CREATE TEMP TABLE broker_observations(account_id text,available boolean,notification_fence_at timestamptz,
      financial_reconciliation_fence_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE broker_notification_receipts(account_id text,event_id text) ON COMMIT DROP;
    CREATE TEMP TABLE broker_source_events(account_id text,event_id text,recorded_at timestamptz,event_kind text)
      ON COMMIT DROP;
    CREATE TEMP TABLE broker_source_event_projections(account_id text,event_id text) ON COMMIT DROP;
    CREATE TEMP TABLE authority_generations(
      generation_hash text,account_id text,maximum text,strategy_name text,
      strategy_parameter_schema_version text,strategy_behavior_hash text,strategy_parameter_hash text,
      strategy_protocol_hash text,previous_generation_hash text,authority_version bigint NOT NULL DEFAULT 1,
      broker_identity_hash text NOT NULL DEFAULT 'fixture-broker',broker_provider text NOT NULL DEFAULT 'alpaca',
      broker_environment text NOT NULL DEFAULT 'sandbox'
    ) ON COMMIT DROP;
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
    INSERT INTO authority_state VALUES ('${currentHash}','PAPER','PAPER','CLEAR',NULL,17,clock_timestamp()-interval '1 second');
    INSERT INTO reconciliations VALUES ('account','EXACT',clock_timestamp(),'fresh');
  END $fixture$`)
    yield* sql`INSERT INTO authority_generations(
      generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
      strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash
    ) VALUES(${currentHash},'account','PAPER','jev',${schemaVersion},${behaviorHash},${parameterHash},${protocolHash})`
    if (requiresDurableBrokerCoverage === true)
      yield* sql.unsafe(`DO $fixture$ BEGIN
        INSERT INTO position_snapshots VALUES ('account',0,clock_timestamp()-interval '2 seconds','flat');
        INSERT INTO broker_source_events VALUES
          ('account','session',clock_timestamp()-interval '1 second','SessionReady');
        INSERT INTO broker_source_event_projections VALUES ('account','session');
        INSERT INTO broker_observations VALUES ('account',true,clock_timestamp(),clock_timestamp());
      END $fixture$`)
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
    'cashSettlements',(SELECT jsonb_agg(to_jsonb(s) ORDER BY account_id) FROM broker_cash_settlements s),
    'feeCorrections',(SELECT jsonb_agg(to_jsonb(c) ORDER BY account_id) FROM broker_fee_match_corrections c),
    'feeAccruals',(SELECT jsonb_agg(to_jsonb(a) ORDER BY account_id,accrual_id) FROM broker_fee_accruals a),
    'feeAccounting',(SELECT jsonb_agg(to_jsonb(f) ORDER BY account_id,activity_id) FROM broker_fee_accounting f),
    'feePostings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id,source_kind,source_id)
      FROM broker_fee_posting_acknowledgements p),
    'debits',(SELECT jsonb_agg(to_jsonb(d) ORDER BY account_id,symbol) FROM broker_inventory_debits d),
    'fills',(SELECT jsonb_agg(to_jsonb(f) ORDER BY event_id) FROM fills f),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY event_id) FROM orders o),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM broker_events e),
    'positions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY snapshot_id) FROM position_snapshots p),
    'observations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY account_id) FROM broker_observations o),
    'notificationReceipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY account_id,event_id) FROM broker_notification_receipts r),
    'sourceEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY account_id,event_id) FROM broker_source_events e),
    'sourceProjections',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id,event_id) FROM broker_source_event_projections p),
    'reconciliations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY reconciliation_id) FROM reconciliations r),
    'mutations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY intent_id,occurred_at) FROM mutation_events m),
    'requests',(SELECT jsonb_agg(to_jsonb(q) ORDER BY request_id) FROM jev_evaluation_requests q),
    'resolutions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM jev_evaluation_resolutions r)
  ) AS retained`
  })

  const blockers = [
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

  const durableBrokerBlockers =
    requiresDurableBrokerCoverage === true
      ? [
          {
            name: 'missing direct stream session boundary',
            seed: "UPDATE broker_source_events SET event_kind='TradeUpdate'",
          },
          {
            name: 'unprojected durable source event',
            seed: "INSERT INTO broker_source_events VALUES ('account','unprojected',clock_timestamp(),'TradeUpdate')",
          },
          {
            name: 'unavailable canonical observation',
            seed: 'UPDATE broker_observations SET available=false',
          },
          {
            name: 'notification fence behind durable source',
            seed: 'UPDATE broker_observations SET notification_fence_at=NULL',
          },
          {
            name: 'financial reconciliation fence behind durable source',
            seed: 'UPDATE broker_observations SET financial_reconciliation_fence_at=NULL',
          },
          {
            name: 'late predecessor receipt outside the durable ledger',
            seed: "INSERT INTO broker_notification_receipts VALUES ('account','late')",
          },
        ]
      : []

  const financialPostingBlockers =
    requiresDurableBrokerCoverage === true
      ? [
          {
            name: 'unposted cash settlement',
            seed: "INSERT INTO broker_cash_settlements VALUES ('account',NULL)",
          },
          {
            name: 'unposted fee match correction',
            seed: "INSERT INTO broker_fee_match_corrections VALUES ('account',NULL)",
          },
          {
            name: 'unposted fee accrual',
            seed: "INSERT INTO broker_fee_accruals VALUES ('account','accrual','plan',NULL)",
          },
          {
            name: 'posted fee accrual without acknowledgement',
            seed: "INSERT INTO broker_fee_accruals VALUES ('account','accrual','plan',clock_timestamp())",
          },
          {
            name: 'unposted broker fee activity',
            seed: "INSERT INTO broker_fee_accounting VALUES ('account','activity','plan',NULL)",
          },
          {
            name: 'posted broker fee activity without acknowledgement',
            seed: "INSERT INTO broker_fee_accounting VALUES ('account','activity','plan',clock_timestamp())",
          },
        ]
      : []

  const targetLineageRecoveryStates = [
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
    {
      name: 'clear OBSERVE recovery successor',
      seed: `INSERT INTO authority_generations(
        generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
        strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,previous_generation_hash,
        authority_version,broker_identity_hash,broker_provider,broker_environment
      ) SELECT 'observe-successor',account_id,'OBSERVE',NULL,NULL,NULL,NULL,NULL,generation_hash,
          authority_version+1,broker_identity_hash,broker_provider,broker_environment
        FROM authority_generations WHERE generation_hash='${currentHash}';
        UPDATE authority_state SET generation_hash='observe-successor',maximum='OBSERVE',effective='OBSERVE',
          kill_state='CLEAR',reason=NULL`,
    },
  ]

  const unrelatedStates = [
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
    {
      name: 'unrelated nearest PAPER ancestor',
      seed: `INSERT INTO authority_generations(
          generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
          strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,previous_generation_hash,
          authority_version,broker_identity_hash,broker_provider,broker_environment
        ) SELECT 'unrelated-paper',account_id,'PAPER','jev','bayn.jev.protocol.v42',
            strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,generation_hash,
            authority_version+1,broker_identity_hash,broker_provider,broker_environment
          FROM authority_generations WHERE generation_hash='${currentHash}';
        INSERT INTO authority_generations(
          generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
          strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,previous_generation_hash,
          authority_version,broker_identity_hash,broker_provider,broker_environment
        ) SELECT 'unrelated-observe',account_id,'OBSERVE',NULL,NULL,NULL,NULL,NULL,generation_hash,
            authority_version+1,broker_identity_hash,broker_provider,broker_environment
          FROM authority_generations WHERE generation_hash='unrelated-paper';
        UPDATE authority_state SET generation_hash='unrelated-observe',maximum='OBSERVE',effective='OBSERVE',
          kill_state='CLEAR',reason=NULL,version=3`,
    },
  ]

  const invalidObserveLineage = (
    accountId: string,
    authorityVersion: number,
    brokerIdentityHash: string,
    previousGenerationHash = currentHash,
  ) => `INSERT INTO authority_generations(
      generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
      strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,previous_generation_hash,
      authority_version,broker_identity_hash,broker_provider,broker_environment
    ) VALUES('invalid-observe','${accountId}','OBSERVE',NULL,NULL,NULL,NULL,NULL,'${previousGenerationHash}',
      ${authorityVersion},'${brokerIdentityHash}','alpaca','sandbox');
    UPDATE authority_state SET generation_hash='invalid-observe',maximum='OBSERVE',effective='OBSERVE',
      kill_state='CLEAR',reason=NULL,version=2`

  const invalidLineageStates = [
    {
      name: 'different account',
      seed: invalidObserveLineage('another-account', 2, 'fixture-broker'),
    },
    {
      name: 'different broker identity',
      seed: invalidObserveLineage('account', 2, 'another-broker'),
    },
    {
      name: 'nondecreasing authority version',
      seed: invalidObserveLineage('account', 1, 'fixture-broker'),
    },
    {
      name: 'missing predecessor',
      seed: invalidObserveLineage('account', 2, 'fixture-broker', 'missing-generation'),
    },
  ]

  const preservedStates = [...targetLineageRecoveryStates, ...unrelatedStates]
  const targetLineageRecoveryScenarios = [
    ...targetLineageRecoveryStates,
    ...reconciliationBlockers.map(({ name, seed }) => ({
      name: `clear OBSERVE: ${name}`,
      seed: `UPDATE authority_state SET maximum='OBSERVE',effective='OBSERVE'; ${seed}`,
    })),
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
          `INSERT INTO authority_generations(
             generation_hash,account_id,maximum,strategy_name,strategy_parameter_schema_version,
             strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,previous_generation_hash
           ) SELECT 'historical',account_id,maximum,strategy_name,'bayn.jev.protocol.v37',
             strategy_behavior_hash,strategy_parameter_hash,strategy_protocol_hash,NULL FROM authority_generations;
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
            if (requiresDurableBrokerCoverage === true)
              expect(
                yield* sql`SELECT account_id,retired_generation_hash,reason
                  FROM public.research_capital_activation_retirements WHERE account_id='account'`,
              ).toEqual([
                {
                  account_id: 'account',
                  retired_generation_hash: currentHash,
                  reason: 'SUPPORT_RECOVERY_V41_RETIRED',
                },
              ])
          }),
        ),
      )
    })

    test.each([
      ...blockers,
      ...reconciliationBlockers.map(({ name, seed }) => ({ name: `PAPER: ${name}`, seed })),
      ...durableBrokerBlockers,
      ...financialPostingBlockers,
    ])('$name rejects before changing authority or retained evidence', async ({ seed }) => {
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
    })

    test.each([
      ...(requiresDurableBrokerCoverage === true ? unrelatedStates : preservedStates).map(({ name, seed }) => ({
        name: `${name} with unsettled history`,
        seed: `${seed}; ${unsettledHistory}`,
      })),
      ...(requiresDurableBrokerCoverage === true
        ? []
        : reconciliationBlockers.map(({ name, seed }) => ({
            name: `clear OBSERVE: ${name}`,
            seed: `UPDATE authority_state SET maximum='OBSERVE',effective='OBSERVE'; ${seed}`,
          }))),
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

    if (requiresDurableBrokerCoverage === true) {
      test.each(targetLineageRecoveryScenarios)(
        '$name fails transactionally until the matching v41 generation is retired',
        async ({ seed }) => {
          await runtime.runPromise(
            withGuardFixture(
              `${seed}; ${unsettledHistory}`,
              Effect.gen(function* () {
                const sql = yield* PgClient.PgClient
                const before = yield* readState
                const retained = yield* readRetainedRows
                const result = yield* sql.withTransaction(effectiveEntryObserveCutover).pipe(Effect.result)
                expect(Result.isFailure(result)).toBe(true)
                if (Result.isFailure(result))
                  expect(result.failure).toMatchObject({
                    reason: {
                      cause: {
                        code: '55000',
                        message:
                          'support-recovery OBSERVE cutover requires durable v41 retirement before recovery can leave PAPER',
                      },
                    },
                  })
                expect(yield* readState).toEqual(before)
                expect(yield* readRetainedRows).toEqual(retained)
              }),
            ),
          )
        },
      )

      test.each(invalidLineageStates)('$name fails closed as invalid recovery ancestry', async ({ seed }) => {
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
                  reason: {
                    cause: {
                      code: '55000',
                      message: 'support-recovery OBSERVE cutover found invalid authority lineage',
                    },
                  },
                })
              expect(yield* readState).toEqual(before)
              expect(yield* readRetainedRows).toEqual(retained)
            }),
          ),
        )
      })
    }

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

    if (requiresDurableBrokerCoverage === true) {
      test('does not record migration 207 through repeated native OBSERVE recovery', async () => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`DROP SCHEMA public CASCADE`
            yield* sql`CREATE SCHEMA public`
            yield* PgMigrator.run({
              loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < migrationId))),
              table: 'schema_migrations',
            })
            const broker = Result.getOrThrow(
              makeBrokerIdentity({
                schemaVersion: 'bayn.broker-identity.v2',
                provider: BrokerProvider.Alpaca,
                environment: BrokerEnvironment.Sandbox,
                accountId: 'effective-entry-overlap-test',
              }),
            )
            const original = hash('effective-entry-overlap-root')
            const paper = hash('effective-entry-overlap-paper')
            const successor = hash('effective-entry-overlap-successor')
            const secondSuccessor = hash('effective-entry-overlap-second-successor')
            const thirdSuccessor = hash('effective-entry-overlap-third-successor')
            const authority = makeAuthorityPostgres(sql)
            const { ensureAuthorityGeneration: ensure } = makeObserveAuthorityInterpreter(sql, authority, broker)
            yield* ensure({ generationHash: original, maximum: Authority.Observe })
            const reconciliationId = hash('effective-entry-overlap-reconciliation')
            yield* sql`INSERT INTO position_snapshots(
              snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at
            ) VALUES(
              ${hash('effective-entry-overlap-positions')},'bayn.paper-position-snapshot.v1',${broker.accountId},
              ${hash('effective-entry-overlap-source')},${hash('effective-entry-overlap-content')},0,
              clock_timestamp()
            )`
            yield* sql`INSERT INTO reconciliations(
              reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,
              discrepancies,reconciled_at
            ) VALUES(
              ${reconciliationId},'bayn.paper-reconciliation.v1',${broker.accountId},${hash('overlap-expected')},
              ${hash('overlap-expected')},${hash('overlap-content')},'EXACT','[]'::jsonb,clock_timestamp()
            )`
            yield* sql`INSERT INTO authority_generations(
              generation_hash,schema_version,activation_schema_version,previous_generation_hash,maximum,
              authority_version,broker_identity_schema_version,broker_identity_hash,broker_provider,
              broker_environment,activation_source_revision,activation_image_repository,activation_image_digest,
              strategy_name,strategy_behavior_hash,strategy_parameter_hash,strategy_parameter_schema_version,
              account_id,risk_policy_hash,proof_plan_hash,reconciliation_id,reconciliation_content_hash,
              research_plan_hash,strategy_protocol_hash,activated_at
            ) VALUES(
              ${paper},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',${original},
              'PAPER',2,${broker.schemaVersion},${broker.identityHash},${broker.provider},${broker.environment},
              ${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},'jev',${behaviorHash},
              ${parameterHash},${schemaVersion},${broker.accountId},${hash('overlap-risk')},${hash('overlap-plan')},
              ${reconciliationId},${hash('overlap-content')},${hash('overlap-research')},${protocolHash},
              clock_timestamp()
            )`
            yield* sql`UPDATE authority_state SET generation_hash=${paper},maximum='PAPER',effective='PAPER',
              kill_state='CLEAR',reason=NULL,version=2,
              updated_at=(SELECT activated_at FROM authority_generations WHERE generation_hash=${paper})
              WHERE singleton`
            const recordExactReconciliation = (label: string) =>
              Effect.gen(function* () {
                yield* sql`INSERT INTO position_snapshots(
                  snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at
                ) VALUES(
                  ${hash(`${label}-positions`)},'bayn.paper-position-snapshot.v1',${broker.accountId},
                  ${hash(`${label}-source`)},${hash(`${label}-content`)},0,
                  greatest(clock_timestamp(),(SELECT updated_at+interval '1 millisecond' FROM authority_state WHERE singleton))
                )`
                yield* sql`INSERT INTO reconciliations(
                  reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,
                  discrepancies,reconciled_at
                ) VALUES(
                  ${hash(`${label}-reconciliation`)},'bayn.paper-reconciliation.v1',${broker.accountId},
                  ${hash(`${label}-expected`)},${hash(`${label}-expected`)},${hash(`${label}-content`)},
                  'EXACT','[]'::jsonb,
                  greatest(clock_timestamp(),(SELECT updated_at+interval '1 millisecond' FROM authority_state WHERE singleton))
                )`
              })
            const rejectMigration = Effect.fnUntraced(function* (expectedGenerationHash: string) {
              const before = yield* readState
              expect(before.generationHash).toBe(expectedGenerationHash)
              const rejected = yield* PgMigrator.run({
                loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id <= migrationId))),
                table: 'schema_migrations',
              }).pipe(Effect.result)
              expect(Result.isFailure(rejected)).toBe(true)
              if (Result.isFailure(rejected))
                expect(rejected.failure).toMatchObject({
                  kind: 'Failed',
                  cause: {
                    reason: {
                      cause: {
                        code: '55000',
                        message:
                          'support-recovery OBSERVE cutover requires durable v41 retirement before recovery can leave PAPER',
                      },
                    },
                  },
                })
              expect(yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id=${migrationId}`).toEqual(
                [],
              )
              expect(
                yield* sql`SELECT to_regclass('public.research_capital_activation_retirements') AS relation`,
              ).toEqual([{ relation: null }])
              expect(yield* readState).toEqual(before)
            })

            yield* recordExactReconciliation('effective-entry-overlap-first-recovery')
            const recovered = yield* ensure({ generationHash: successor, maximum: Authority.Observe })
            expect(recovered).toMatchObject({
              generationHash: successor,
              maximum: Authority.Observe,
              effective: Authority.Observe,
              kill: 'CLEAR',
            })
            yield* rejectMigration(successor)

            yield* restrictAuthority(sql, reconciliationIncompleteRestrictionReason, recovered.updatedAt)
            expect(yield* readState).toMatchObject({
              generationHash: successor,
              maximum: 'OBSERVE',
              effective: 'OBSERVE',
              kill: 'ACTIVE',
              reason: reconciliationIncompleteRestrictionReason,
            })
            yield* recordExactReconciliation('effective-entry-overlap-second-recovery')
            const recoveredAgain = yield* ensure({ generationHash: secondSuccessor, maximum: Authority.Observe })
            expect(recoveredAgain).toMatchObject({
              generationHash: secondSuccessor,
              maximum: Authority.Observe,
              effective: Authority.Observe,
              kill: 'CLEAR',
            })
            yield* rejectMigration(secondSuccessor)

            yield* restrictAuthority(sql, reconciliationIncompleteRestrictionReason, recoveredAgain.updatedAt)
            yield* recordExactReconciliation('effective-entry-overlap-third-recovery')
            const recoveredThird = yield* ensure({ generationHash: thirdSuccessor, maximum: Authority.Observe })
            expect(recoveredThird).toMatchObject({
              generationHash: thirdSuccessor,
              maximum: Authority.Observe,
              effective: Authority.Observe,
              kill: 'CLEAR',
            })
            yield* rejectMigration(thirdSuccessor)
          }).pipe(Effect.provide(postgres)),
        )
      }, 30_000)
    }

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
          if (requiresDurableBrokerCoverage === true) {
            const sourceRevision = '1'.repeat(40)
            const sourceEventId = hash('support-recovery-cutover-session')
            yield* sql`INSERT INTO broker_source_events(
              account_id,event_id,source_revision,received_at,event_kind,session_id,notification
            ) VALUES(
              ${broker.accountId},${sourceEventId},${sourceRevision},clock_timestamp(),
              'SessionReady','cutover-session','{}'::jsonb
            )`
            yield* sql`INSERT INTO broker_source_event_projections(
              account_id,event_id,source_revision,outcome,observed_at
            ) VALUES(${broker.accountId},${sourceEventId},${sourceRevision},'CANONICALLY_COVERED',clock_timestamp())`
            yield* sql`INSERT INTO broker_observations(
              account_id,source_revision,available,poll_started_at,observed_at,completed_at,
              snapshot_hash,state_hash,notification_fence_at,financial_reconciliation_fence_at
            ) VALUES(
              ${broker.accountId},${sourceRevision},true,clock_timestamp(),clock_timestamp(),clock_timestamp(),
              ${hash('support-recovery-snapshot')},${hash('support-recovery-state')},
              (SELECT max(recorded_at) FROM broker_source_events WHERE account_id=${broker.accountId}),
              (SELECT max(recorded_at) FROM broker_source_events WHERE account_id=${broker.accountId})
            )`
          }
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
          if (requiresDurableBrokerCoverage === true) {
            const before = yield* readState
            yield* Effect.scoped(
              Effect.gen(function* () {
                const blocker = yield* sql.reserve
                yield* blocker.executeUnprepared('BEGIN', [], undefined)
                yield* Effect.addFinalizer(() =>
                  blocker.executeUnprepared('ROLLBACK', [], undefined).pipe(Effect.ignore),
                )
                yield* blocker.executeUnprepared('LOCK TABLE intents IN ROW EXCLUSIVE MODE', [], undefined)
                const contended = yield* sql.withTransaction(effectiveEntryObserveCutover).pipe(Effect.result)
                expect(Result.isFailure(contended)).toBe(true)
                if (Result.isFailure(contended))
                  expect(contended.failure).toMatchObject({ reason: { cause: { code: '55P03' } } })
                expect(yield* readState).toEqual(before)
                yield* blocker.executeUnprepared('ROLLBACK', [], undefined)
              }),
            )
            // ACCESS SHARE is the lock held by an ordinary SELECT. The cutover must not wait behind it while
            // holding the mutation fence.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const reader = yield* sql.reserve
                yield* reader.executeUnprepared('BEGIN READ ONLY', [], undefined)
                yield* Effect.addFinalizer(() =>
                  reader.executeUnprepared('ROLLBACK', [], undefined).pipe(Effect.ignore),
                )
                yield* reader.executeUnprepared('SELECT count(*) FROM intents', [], undefined)
                yield* sql.withTransaction(effectiveEntryObserveCutover).pipe(Effect.timeout('2 seconds'))
                yield* reader.executeUnprepared('ROLLBACK', [], undefined)
              }),
            )
          } else yield* sql.withTransaction(effectiveEntryObserveCutover)
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
          const recoveredRow = yield* readState
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
          if (requiresDurableBrokerCoverage === true) {
            expect(
              yield* sql`SELECT account_id,retired_generation_hash,reason
                FROM public.research_capital_activation_retirements`,
            ).toEqual([
              {
                account_id: broker.accountId,
                retired_generation_hash: paper,
                reason: 'SUPPORT_RECOVERY_V41_RETIRED',
              },
            ])
            // Model the delayed retained request after settlement and after a process restart. Even an old binary that
            // reaches the historical INSERT directly cannot reopen PAPER; the immutable DB admission boundary wins.
            const replayedPaper = hash('effective-entry-retired-mandate-replay')
            const replay = yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,
              activation_schema_version,previous_generation_hash,maximum,authority_version,
              broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,
              activation_source_revision,activation_image_repository,activation_image_digest,strategy_name,
              strategy_behavior_hash,strategy_parameter_hash,strategy_parameter_schema_version,account_id,
              risk_policy_hash,proof_plan_hash,reconciliation_id,reconciliation_content_hash,research_plan_hash,
              strategy_protocol_hash,activated_at)
            VALUES(${replayedPaper},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
              ${successor},'PAPER',5,${broker.schemaVersion},${broker.identityHash},${broker.provider},
              ${broker.environment},${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},'jev',
              ${behaviorHash},${parameterHash},${schemaVersion},${broker.accountId},${hash('risk')},${hash('plan')},
              ${hash('effective-entry-after')},${hash('effective-entry-after')},${hash('research')},${protocolHash},
              clock_timestamp())`.pipe(Effect.result)
            expect(Result.isFailure(replay)).toBe(true)
            if (Result.isFailure(replay))
              expect(replay.failure).toMatchObject({
                reason: {
                  cause: {
                    code: '55000',
                    message: `research capital activation is retired for account ${broker.accountId}`,
                  },
                },
              })
            expect(
              yield* sql`SELECT count(*)::integer AS generations FROM authority_generations
                WHERE generation_hash=${replayedPaper}`,
            ).toEqual([{ generations: 0 }])
            expect(yield* readState).toEqual(recoveredRow)

            // Model immutable PAPER history that committed before the retirement fence existed. The history INSERT
            // trigger is the normal guard; the state trigger must independently prevent an old binary from activating
            // a dormant row after the account has recovered to clear OBSERVE.
            const dormantPaper = hash('effective-entry-retired-dormant-paper')
            yield* sql`ALTER TABLE authority_generations DISABLE TRIGGER authority_generations_research_capital_retirement`
            yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,
              activation_schema_version,previous_generation_hash,maximum,authority_version,
              broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,
              activation_source_revision,activation_image_repository,activation_image_digest,strategy_name,
              strategy_behavior_hash,strategy_parameter_hash,strategy_parameter_schema_version,account_id,
              risk_policy_hash,proof_plan_hash,reconciliation_id,reconciliation_content_hash,research_plan_hash,
              strategy_protocol_hash,activated_at)
            VALUES(${dormantPaper},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
              ${successor},'PAPER',5,${broker.schemaVersion},${broker.identityHash},${broker.provider},
              ${broker.environment},${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},'jev',
              ${behaviorHash},${parameterHash},${schemaVersion},${broker.accountId},${hash('risk')},${hash('plan')},
              ${hash('effective-entry-after')},${hash('effective-entry-after')},${hash('research')},${protocolHash},
              greatest(clock_timestamp(),(SELECT updated_at FROM authority_state)+interval '1 millisecond'))`
            yield* sql`ALTER TABLE authority_generations ENABLE TRIGGER authority_generations_research_capital_retirement`
            const stateBypass = yield* sql`UPDATE authority_state SET generation_hash=${dormantPaper},
              maximum='PAPER',effective='PAPER',kill_state='CLEAR',reason=NULL,version=5,
              updated_at=(SELECT activated_at FROM authority_generations WHERE generation_hash=${dormantPaper})
              WHERE singleton`.pipe(Effect.result)
            expect(Result.isFailure(stateBypass)).toBe(true)
            if (Result.isFailure(stateBypass))
              expect(stateBypass.failure).toMatchObject({
                reason: {
                  cause: {
                    code: '55000',
                    message: `research capital state activation is retired for account ${broker.accountId}`,
                  },
                },
              })
            expect(yield* readState).toEqual(recoveredRow)
          }
        }).pipe(Effect.provide(postgres)),
      )
    }, 30_000)
  })
}
