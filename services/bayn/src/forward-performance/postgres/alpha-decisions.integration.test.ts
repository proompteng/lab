import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from 'effect'

import { PostgresClientLive } from '../../db/postgres-client'
import { openSnapshotRows } from '../../db/snapshot-rows'
import { strictParseOptions } from '../../schemas'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { AlphaDecisionJsonRow, alphaDecisionQuery } from './alpha-decisions'
import type { TerminalCycleRow } from './model'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const hash = (n: number) => n.toString(16).padStart(64, '0')

describePostgres('Native alpha diagnostic decision selection', () => {
  test('retains active, blocked and no-trade decisions without expanding the reconciled financial set', async () => {
    const url = baynTestPostgresUrl ?? ''
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local test database')
    const runtime = ManagedRuntime.make(
      PostgresClientLive(
        { operationTimeoutMs: 5_000, postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' } },
        { maxConnections: 1, applicationName: 'bayn-alpha-decision-query-test' },
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // These minimal query-contract fixtures do not bypass production write guards.
              // Strict full-document reproduction is exercised with a real native alpha decision.
              yield* sql`CREATE TEMP TABLE reconciliations (
                account_id text, reconciliation_id text, reconciled_at timestamptz
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE authority_generations (
                generation_hash text, account_id text, qualification_run_id text, research_plan_hash text,
                protocol_hash text, strategy_protocol_hash text, strategy_parameter_schema_version text, risk_policy_hash text,
                maximum text, activated_at timestamptz,
                previous_generation_hash text, qualification_source_revision text,
                qualification_image_repository text, qualification_image_digest text,
                activation_source_revision text, activation_image_repository text, activation_image_digest text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycles (
                cycle_id text, account_id text, qualification_run_id text, strategy_protocol_hash text,
                decision_hash text, state text, created_at timestamptz, terminal_at timestamptz,
                execution_session_date date
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
                cycle_id text, decision_hash text, schema_version text, document jsonb, created_at timestamptz
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE intents (
                cycle_id text, account_id text, authority_generation_hash text
              ) ON COMMIT DROP`

              const accountId = 'alpha-query-account'
              const generation = hash(101)
              const otherGeneration = hash(102)
              const qualification = hash(103)
              const protocol = hash(104)
              const activatedAt = '2026-11-17T14:00:00.000Z'
              const createdAt = '2026-11-17T14:05:00.000Z'
              const cutoff = '2026-11-17T15:00:00.000Z'
              for (const [id, account] of [
                [generation, accountId],
                [otherGeneration, accountId],
                [hash(105), 'foreign-account'],
              ])
                yield* sql`INSERT INTO authority_generations (
                  generation_hash,account_id,research_plan_hash,strategy_protocol_hash,strategy_parameter_schema_version,risk_policy_hash,maximum,activated_at,
                  activation_source_revision,activation_image_repository,activation_image_digest
                ) VALUES (${id},${account},${qualification},${protocol},'bayn.intraday-alpha-policy.v2',${hash(114)},'PAPER',${activatedAt},
                  ${'a'.repeat(40)},'registry.example/bayn',${`sha256:${hash(106)}`})`
              yield* sql`INSERT INTO reconciliations VALUES (${accountId},${hash(107)},${cutoff})`
              const add = (
                n: number,
                state: string,
                overrides: {
                  account?: string
                  generation?: string
                  at?: string
                  version?: string
                  protocol?: string
                  terminalAt?: string
                } = {},
              ) =>
                Effect.gen(function* () {
                  const account = overrides.account ?? accountId
                  const selectedGeneration = overrides.generation ?? generation
                  const at = overrides.at ?? createdAt
                  const selectedProtocol = overrides.protocol ?? protocol
                  const document = {
                    mode: 'PAPER',
                    bindings: {
                      cycleId: hash(n),
                      accountId: account,
                      authorityGenerationHash: selectedGeneration,
                      qualificationRunId: qualification,
                      strategyProtocolHash: selectedProtocol,
                    },
                    strategyDecision: { schemaVersion: overrides.version ?? 'bayn.intraday-alpha-target.v2' },
                  }
                  yield* sql`INSERT INTO autonomous_cycles VALUES (
                  ${hash(n)},${account},${qualification},${selectedProtocol},${hash(200 + n)},${state},${at},
                  ${state === 'COMPLETED' || state === 'NO_TRADE' ? (overrides.terminalAt ?? cutoff) : null},'2026-11-17'
                )`
                  yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
                  ${hash(n)},${hash(200 + n)},'bayn.paper-cycle-decision.v2',${JSON.stringify(document)}::jsonb,${at}
                )`
                })
              yield* add(1, 'COMPLETED')
              yield* add(2, 'ACTIVE')
              yield* add(3, 'BLOCKED')
              yield* add(4, 'NO_TRADE')
              yield* add(5, 'PENDING')
              yield* add(6, 'COMPLETED', { at: '2026-11-17T13:59:59.999Z' })
              yield* add(7, 'COMPLETED', { at: '2026-11-17T15:00:00.001Z' })
              yield* add(8, 'COMPLETED', { version: 'bayn.intraday-alpha-target.v1' })
              yield* add(9, 'COMPLETED', { account: 'foreign-account', generation: hash(105) })
              yield* add(10, 'COMPLETED', { generation: otherGeneration })
              yield* add(11, 'COMPLETED', { protocol: hash(108) })
              yield* add(12, 'COMPLETED', { terminalAt: '2026-11-17T15:00:00.001Z' })
              // A foreign binding or corrupt schema prefix remains a candidate for strict rejection.
              // An intent in this generation cannot make its document pass identity verification.
              yield* sql`INSERT INTO intents VALUES (${hash(10)},${accountId},${generation})`

              const read = (
                account = accountId,
                selectedGeneration = generation,
                captured?: readonly (typeof TerminalCycleRow.Type)[],
              ) =>
                Effect.gen(function* () {
                  const rows: (typeof AlphaDecisionJsonRow.Type)[] = []
                  const consume = yield* openSnapshotRows(
                    sql,
                    alphaDecisionQuery(sql, account, selectedGeneration, captured),
                  )
                  yield* consume((input) =>
                    Schema.decodeUnknownEffect(
                      AlphaDecisionJsonRow,
                      strictParseOptions,
                    )(input).pipe(
                      Effect.tap((row) => Effect.sync(() => rows.push(row))),
                      Effect.asVoid,
                    ),
                  )
                  return rows
                })
              const rows = yield* read()
              expect(rows.map((row) => row.cycle_id)).toEqual([1, 2, 3, 4, 5, 8, 10, 12].map(hash))
              expect(rows.map((row) => row.execution_evidence_in_scope)).toEqual([
                true,
                false,
                false,
                false,
                false,
                true,
                true,
                false,
              ])
              expect(rows.every((row) => row.reconciled_at.toISOString() === cutoff)).toBe(true)
              expect(rows.every((row) => row.qualification_build === null)).toBe(true)
              expect(rows.every((row) => row.risk_policy_hash === hash(114))).toBe(true)
              expect(rows[0]?.activation_build).toEqual({
                sourceRevision: 'a'.repeat(40),
                imageRepository: 'registry.example/bayn',
                imageDigest: `sha256:${hash(106)}`,
              })
              const emptyFinancialCapture = yield* read(accountId, generation, [])
              expect(emptyFinancialCapture.map((row) => row.cycle_id)).toEqual(rows.map((row) => row.cycle_id))
              expect(emptyFinancialCapture.every((row) => !row.execution_evidence_in_scope)).toBe(true)
              const terminalCapture: typeof TerminalCycleRow.Type = {
                cycle_id: hash(1),
                account_id: accountId,
                qualification_run_id: qualification,
                strategy_name: 'jev',
                strategy_protocol_hash: protocol,
                execution_policy_hash: hash(109),
                strategy_execution_model_hash: hash(110),
                state: 'COMPLETED',
                submission_open_at: new Date(activatedAt),
                terminal_at: new Date(cutoff),
              }
              expect(
                (yield* read(accountId, generation, [terminalCapture])).map((row) => row.execution_evidence_in_scope),
              ).toEqual([true, false, false, false, false, false, false, false])
              expect(yield* read('foreign-account', generation)).toEqual([])
              expect(yield* read(accountId, hash(111))).toEqual([])
              // A later account reconciliation after a successor activation cannot move this generation's cut.
              yield* sql`INSERT INTO authority_generations (
                generation_hash,account_id,research_plan_hash,strategy_protocol_hash,maximum,activated_at,previous_generation_hash
              ) VALUES (${hash(112)},${accountId},${qualification},${protocol},'PAPER','2026-11-17T16:00:00Z',${generation})`
              yield* sql`INSERT INTO reconciliations VALUES (${accountId},${hash(113)},'2026-11-17T17:00:00Z')`
              expect(yield* read()).toEqual(rows)
              yield* sql`DELETE FROM reconciliations`
              expect(yield* read()).toEqual([])
            }),
          )
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })
})
