import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import { Statement } from 'effect/sql'

import type { TerminalCycleRow } from './model'
import { decisionQuery } from './queries'

test('binds captured decision membership above the PostgreSQL parameter-count limit as one array', () => {
  const sql = Statement.make(
    Effect.die('Query compilation must never acquire PostgreSQL'),
    PgClient.makeCompiler(undefined, false),
    [],
    undefined,
  ) as PgClient.PgClient
  const hash = (value: number) => value.toString(16).padStart(64, '0')
  const cycles = Array.from({ length: 65_536 }, (_, index): typeof TerminalCycleRow.Type => ({
    cycle_id: hash(index),
    qualification_run_id: hash(1),
    strategy_name: 'jev',
    strategy_protocol_hash: hash(2),
    account_id: 'account',
    execution_policy_hash: hash(3),
    strategy_execution_model_hash: hash(4),
    state: 'COMPLETED',
    submission_open_at: new Date(0),
    terminal_at: new Date(1),
  }))
  const [, oneCycleParameters] = decisionQuery(sql, 'account', hash(5), cycles.slice(0, 1)).compile()
  const [, allCycleParameters] = decisionQuery(sql, 'account', hash(5), cycles).compile()
  expect(allCycleParameters).toHaveLength(oneCycleParameters.length)
  expect(allCycleParameters.length).toBeLessThan(20)
  expect(allCycleParameters.filter(Array.isArray)).toEqual([cycles.map((cycle) => cycle.cycle_id)])
})
