import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  // Native recovery owns settlement and fresh reconciliation before creating the OBSERVE successor.
  yield* sql`UPDATE authority_state state
    SET effective='OBSERVE', kill_state='ACTIVE', reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
      version=state.version+1,
      updated_at=greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
    FROM authority_generations generation
    WHERE state.generation_hash=generation.generation_hash
      AND generation.strategy_name='jev'
      AND generation.strategy_parameter_schema_version='bayn.jev.protocol.v37'
      AND state.maximum='PAPER' AND state.effective='PAPER' AND state.kill_state='CLEAR'
      AND state.reason IS NULL`
})
