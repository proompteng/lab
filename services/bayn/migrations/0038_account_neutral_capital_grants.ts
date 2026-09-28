import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Keep the append-only table names and v1 rows as durable compatibility while allowing the neutral v2 contract.
  yield* sql`
    ALTER TABLE live_capital_grants
    DROP CONSTRAINT live_capital_grants_schema_version_check,
    DROP CONSTRAINT live_capital_grants_broker_environment_check,
    ADD CONSTRAINT live_capital_grants_schema_version_check CHECK (
      schema_version IN ('bayn.live-capital-grant.v1', 'bayn.capital-grant.v2')
    ),
    ADD CONSTRAINT live_capital_grants_broker_environment_check CHECK (
      broker_environment IN ('sandbox', 'live')
    ),
    ADD CONSTRAINT live_capital_grants_legacy_environment_check CHECK (
      schema_version <> 'bayn.live-capital-grant.v1' OR broker_environment = 'live'
    )
  `

  yield* sql`
    ALTER TABLE live_capital_grant_revocations
    DROP CONSTRAINT live_capital_grant_revocations_schema_version_check,
    ADD CONSTRAINT live_capital_grant_revocations_schema_version_check CHECK (
      schema_version IN ('bayn.live-capital-grant-revocation.v1', 'bayn.capital-grant-revocation.v2')
    )
  `
})
